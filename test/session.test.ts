import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ChatRecord } from "../src/chat/storage.js";
import type { UiEvent } from "../src/chat/session.js";

const mocks = vi.hoisted(() => ({
  MalformedNativeToolCallError: class MalformedNativeToolCallError extends Error {},
  NativeToolsUnsupportedError: class NativeToolsUnsupportedError extends Error {},
  settings: {
    endpoint: "http://127.0.0.1:8080",
    modelFamily: "gemma4",
    titlePrompt: "Summarize the user message in 2-6 words. Output ONLY the summary.",
    commitMessagePrompt: "Write a concise Git commit message.",
    toolCallingMode: "legacy",
    cappedThinkingTokens: 16384,
    autoCompact: false,
    autoCompactThresholdPercent: 80,
    autoapproveReads: true,
    autoapproveWrites: false,
    autoapproveCommands: false,
    safeCommands: [] as { match: string; description?: string }[]
  },
  streamChat: vi.fn(),
  tokenize: vi.fn(),
  complete: vi.fn(),
  fetchServerContextSize: vi.fn(),
  runCommand: vi.fn(),
  runProcess: vi.fn(),
  startCommand: vi.fn(),
  startProcess: vi.fn()
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: (key: string) => (mocks.settings as Record<string, unknown>)[key]
    }),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() }))
  },
  window: {
    createTerminal: vi.fn(() => ({ show: vi.fn(), sendText: vi.fn(), exitStatus: undefined })),
    createOutputChannel: vi.fn(() => ({ append: vi.fn(), appendLine: vi.fn() })),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn()
  },
  commands: {
    executeCommand: vi.fn()
  }
}));

vi.mock("../src/llm/client.js", () => ({
  MalformedNativeToolCallError: mocks.MalformedNativeToolCallError,
  NativeToolsUnsupportedError: mocks.NativeToolsUnsupportedError,
  streamChat: mocks.streamChat,
  tokenize: mocks.tokenize,
  complete: mocks.complete,
  fetchServerContextSize: mocks.fetchServerContextSize
}));

vi.mock("../src/tools/terminalTool.js", () => ({
  runCommand: mocks.runCommand,
  runProcess: mocks.runProcess,
  startCommand: mocks.startCommand,
  startProcess: mocks.startProcess
}));

beforeEach(() => {
  mocks.streamChat.mockReset();
  mocks.tokenize.mockReset();
  mocks.complete.mockReset();
  mocks.fetchServerContextSize.mockReset();
  mocks.runCommand.mockReset();
  mocks.runProcess.mockReset();
  mocks.startCommand.mockReset();
  mocks.startProcess.mockReset();
  mocks.tokenize.mockResolvedValue(1);
  mocks.complete.mockResolvedValue("Test chat");
  mocks.fetchServerContextSize.mockResolvedValue(32768);
  mocks.runProcess.mockResolvedValue({ exitCode: 0, stdout: "ok\n", stderr: "", truncated: false });
  mocks.startCommand.mockImplementation((command, cwd, signal, onOutput) =>
    mockCommandHandle(mocks.runCommand(command, cwd, signal, onOutput))
  );
  mocks.startProcess.mockImplementation((program, args, cwd, signal, onOutput) =>
    mockCommandHandle(mocks.runProcess(program, args, cwd, signal, onOutput))
  );
  mocks.settings.autoapproveWrites = false;
  mocks.settings.autoapproveCommands = false;
  mocks.settings.safeCommands = [];
  mocks.settings.modelFamily = "gemma4";
  mocks.settings.toolCallingMode = "legacy";
  mocks.settings.cappedThinkingTokens = 16384;
});

function mockCommandHandle(result: Promise<{ exitCode: number; stdout: string; stderr: string; truncated: boolean }>) {
  let output = { stdout: "", stderr: "", truncated: false };
  void result.then(value => { output = value; });
  return {
    result,
    snapshot: () => output,
    wait: async () => ({ running: false as const, result: await result }),
    stop: async () => result
  };
}

describe("ChatSession", () => {
  it("labels only the first model request after loading chat history as context loading", async () => {
    mocks.streamChat.mockImplementation(async function* () {
      yield { kind: "text", text: "answer" };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    record.messages.push(
      { role: "user", content: "Earlier question", ts: 1 },
      { role: "assistant", content: "Earlier answer", ts: 2 }
    );
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: event => events.push(event)
    });

    await session.sendUserMessage("Continue the old chat");
    expect(events.filter(event => event.kind === "turnPreparing" && event.reason === "context")).toHaveLength(1);

    const secondTurnStart = events.length;
    await session.sendUserMessage("Continue again");
    expect(events.slice(secondTurnStart)).not.toContainEqual({ kind: "turnPreparing", reason: "context" });
    expect(events.slice(secondTurnStart)).toContainEqual({ kind: "turnPreparing", reason: "server" });
  });

  it("generates the first-request chat name in parallel after the real request is accepted", async () => {
    let resolveTitle: (title: string) => void = () => undefined;
    const pendingTitle = new Promise<string>(resolve => { resolveTitle = resolve; });
    let resolveAnswer: () => void = () => undefined;
    const pendingAnswer = new Promise<void>(resolve => { resolveAnswer = resolve; });
    mocks.complete.mockReturnValue(pendingTitle);
    mocks.streamChat.mockImplementation(async function* (_endpoint: string, request: { onResponseAccepted?: () => void }) {
      request.onResponseAccepted?.();
      await pendingAnswer;
      yield { kind: "text", text: "real answer" };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record: newRecord(),
      emit: event => events.push(event)
    });

    const turn = session.sendUserMessage("Fix the restart button behavior");
    await vi.waitFor(() => expect(mocks.streamChat).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(mocks.complete).toHaveBeenCalledTimes(1));
    expect(mocks.streamChat.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.complete.mock.invocationCallOrder[0]);

    // Finishing the chat must not wait for the still-pending title request.
    resolveAnswer();
    await turn;
    expect(events).toContainEqual(expect.objectContaining({ kind: "turnEnd" }));
    expect(events).not.toContainEqual(expect.objectContaining({ kind: "titleChanged" }));

    resolveTitle("Fix restart button");
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      kind: "titleChanged",
      title: "Fix restart button"
    })));
    expect(events.findIndex(event => event.kind === "titleChanged"))
      .toBeGreaterThan(events.findIndex(event => event.kind === "turnEnd"));
  });

  it("continues the real chat silently when best-effort naming fails", async () => {
    mocks.complete.mockRejectedValue(new Error("title request failed"));
    mocks.streamChat.mockImplementation(async function* (_endpoint: string, request: { onResponseAccepted?: () => void }) {
      request.onResponseAccepted?.();
      yield { kind: "text", text: "real answer" };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const record = newRecord();
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: event => events.push(event)
    });

    await session.sendUserMessage("Fix the restart button behavior");

    await vi.waitFor(() => expect(mocks.complete).toHaveBeenCalledTimes(1));
    expect(mocks.streamChat).toHaveBeenCalledTimes(1);
    expect(record.title).toBe("New chat");
    expect(events).not.toContainEqual(expect.objectContaining({ kind: "notice" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "turnStart" }));
  });

  it("identifies title generation while a model continuation is pending", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "llh-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "hello\n", "utf8");
    mocks.settings.toolCallingMode = "native";
    let resolveTitle: (title: string) => void = () => undefined;
    mocks.complete.mockReturnValue(new Promise<string>(resolve => { resolveTitle = resolve; }));
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* (
      _endpoint: string,
      request: { onResponseAccepted?: () => void }
    ) {
      request.onResponseAccepted?.();
      if (pass++ === 0) {
        yield { kind: "toolCall", name: "read_file", argsJson: '{"path":"a.txt"}', id: "call_title_wait" };
      } else {
        yield { kind: "text", text: "done" };
      }
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record: newRecord(),
      emit: event => events.push(event)
    });

    await session.sendUserMessage("Read the file");

    const resolvedIndex = events.findIndex(event =>
      event.kind === "toolCallResolved" && event.status === "executed"
    );
    const answerIndex = events.findIndex(event => event.kind === "text");
    expect(events.slice(resolvedIndex + 1, answerIndex))
      .toContainEqual({ kind: "turnPreparing", reason: "title" });

    resolveTitle("Read file");
    await vi.waitFor(() =>
      expect(events).toContainEqual({ kind: "titleGenerationFinished" })
    );
  });

  it("uses native tool schemas and replays calls/results with their protocol id", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "llh-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "hello\n", "utf8");
    mocks.settings.toolCallingMode = "native";
    const requests: Array<Record<string, unknown>> = [];
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* (_endpoint: string, request: Record<string, unknown>) {
      requests.push(request);
      if (pass++ === 0) {
        yield { kind: "thought", text: "I need to inspect the requested file." };
        yield { kind: "toolCall", name: "read_file", argsJson: '{"path":"a.txt"}', id: "call_read_1" };
      } else {
        yield { kind: "text", text: "done" };
      }
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record,
      emit: event => events.push(event)
    });
    await session.sendUserMessage("read it");

    expect((requests[0].tools as Array<{ function: { name: string } }>).some(tool => tool.function.name === "read_file")).toBe(true);
    const replay = requests[1].messages as Array<Record<string, unknown>>;
    expect(replay).toContainEqual(expect.objectContaining({
      role: "assistant",
      reasoning_content: "I need to inspect the requested file.",
      tool_calls: [expect.objectContaining({ id: "call_read_1" })]
    }));
    expect(replay).toContainEqual(expect.objectContaining({
      role: "tool",
      name: "read_file",
      tool_call_id: "call_read_1",
      content: expect.stringMatching(/^\[revision sha256:[a-f0-9]{64}\]\n1\thello$/)
    }));
    expect(events[0]).toEqual({ kind: "turnPreparing", reason: "server" });
    const userMessageIndex = events.findIndex(event => event.kind === "userMessage");
    const workStartedIndex = events.findIndex(event => event.kind === "turnWorkStarted");
    const turnStartIndex = events.findIndex(event => event.kind === "turnStart");
    expect(workStartedIndex).toBeGreaterThan(userMessageIndex);
    expect(turnStartIndex).toBeGreaterThan(workStartedIndex);
    expect(events[workStartedIndex]).toEqual(expect.objectContaining({
      kind: "turnWorkStarted",
      messageId: (events[turnStartIndex] as Extract<UiEvent, { kind: "turnStart" }>).messageId,
      startedAt: expect.any(Number)
    }));
    const resolvedIndex = events.findIndex(event =>
      event.kind === "toolCallResolved" && event.status === "executed"
    );
    const answerIndex = events.findIndex(event => event.kind === "text");
    expect(events.slice(resolvedIndex + 1, answerIndex)).toContainEqual({ kind: "turnPreparing", reason: "server" });
  });

  it("applies mode changes made during a turn only to the next user message", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "llh-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "hello\n", "utf8");
    mocks.settings.toolCallingMode = "native";
    const requests: Array<{
      thinking_budget_tokens?: number;
      chat_template_kwargs?: { enable_thinking: boolean };
      tools?: Array<{ function: { name: string } }>;
    }> = [];
    let releaseFirstRequest = (): void => undefined;
    const firstRequestGate = new Promise<void>(resolve => { releaseFirstRequest = resolve; });
    mocks.streamChat.mockImplementation(async function* (_endpoint: string, request: typeof requests[number]) {
      requests.push(request);
      if (requests.length === 1) {
        await firstRequestGate;
        yield { kind: "toolCall", name: "read_file", argsJson: '{"path":"a.txt"}', id: "call_read_modes" };
      } else {
        yield { kind: "text", text: "done" };
      }
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    record.thinkingMode = "unlimited";
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record,
      emit: () => undefined
    });

    const firstTurn = session.sendUserMessage("read it");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    session.setPlanMode(true);
    session.setThinkingMode("instant");
    releaseFirstRequest();
    await firstTurn;
    await session.sendUserMessage("now use the new modes");

    expect(requests).toHaveLength(3);
    for (const request of requests.slice(0, 2)) {
      expect(request.thinking_budget_tokens).toBeUndefined();
      expect(request.chat_template_kwargs).toBeUndefined();
      expect(request.tools?.some(tool => tool.function.name === "create_file")).toBe(true);
    }
    expect(requests[2].thinking_budget_tokens).toBe(0);
    expect(requests[2].chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(requests[2].tools?.some(tool => tool.function.name === "create_file")).toBe(false);
  });

  it("persists successful file-creation metadata for restored tool labels", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "llh-session-"));
    mocks.settings.toolCallingMode = "native";
    mocks.settings.autoapproveWrites = true;
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* () {
      if (pass++ === 0) {
        yield {
          kind: "toolCall",
          name: "create_file",
          argsJson: '{"path":"new.txt","content":"hello\\n"}',
          id: "call_create_1"
        };
      } else {
        yield { kind: "text", text: "done" };
      }
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record,
      emit: () => undefined
    });

    await session.sendUserMessage("create it");

    const toolResult = record.messages.find(message => message.role === "tool");
    expect(toolResult?.toolCall).toEqual(expect.objectContaining({
      name: "create_file",
      status: "executed",
      createsNewFile: true
    }));
  });

  it.each([
    ["instant", 0],
    ["capped", 12345],
    ["unlimited", undefined]
  ] as const)("maps %s intelligence mode to the expected reasoning budget", async (mode, expectedBudget) => {
    mocks.settings.toolCallingMode = "native";
    mocks.settings.cappedThinkingTokens = 12345;
    let request: Record<string, unknown> | undefined;
    mocks.streamChat.mockImplementation(async function* (_endpoint: string, value: Record<string, unknown>) {
      request = value;
      yield { kind: "text", text: "done" };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    record.thinkingMode = mode;
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: () => undefined
    });

    await session.sendUserMessage("answer briefly");

    if (expectedBudget === undefined) {
      expect(request?.thinking_budget_tokens).toBeUndefined();
    } else {
      expect(request).toHaveProperty("thinking_budget_tokens", expectedBudget);
    }
    expect(request?.chat_template_kwargs).toEqual(mode === "instant" ? { enable_thinking: false } : undefined);
  });

  it("warns when the server still emits reasoning in Instant mode", async () => {
    mocks.settings.toolCallingMode = "native";
    mocks.streamChat.mockImplementation(async function* () {
      yield { kind: "thought", text: "unexpected reasoning" };
      yield { kind: "text", text: "done" };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    record.thinkingMode = "instant";
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: event => events.push(event)
    });

    await session.sendUserMessage("answer instantly");

    expect(events).toContainEqual(expect.objectContaining({
      kind: "notice",
      text: expect.stringContaining("fixed server value overrides per-request budgets")
    }));
  });

  it("folds compacted context into the initial native system message", async () => {
    mocks.settings.toolCallingMode = "native";
    const requests: Array<Record<string, unknown>> = [];
    mocks.streamChat.mockImplementation(async function* (_endpoint: string, request: Record<string, unknown>) {
      requests.push(request);
      yield { kind: "text", text: "continuing" };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    record.messages.push(
      { role: "system", content: "[context summary]\nGOAL: refactor Game.tsx", ts: Date.now() },
      { role: "assistant", content: "I will create the refactored file.", ts: Date.now() }
    );
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: () => undefined
    });

    await session.sendUserMessage("please continue");

    const messages = requests[0].messages as Array<{ role: string; content: string }>;
    expect(messages.filter(message => message.role === "system")).toHaveLength(1);
    expect(messages[0]).toEqual(expect.objectContaining({
      role: "system",
      content: expect.stringContaining("[context summary]\nGOAL: refactor Game.tsx")
    }));
    expect(messages).toContainEqual(expect.objectContaining({ role: "user", content: "please continue" }));
  });

  it("adds a user turn when a compacted native tail contains only tool history", async () => {
    mocks.settings.toolCallingMode = "native";
    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    record.messages.push(
      { role: "system", content: "[context summary]\nGOAL: finish the refactor", ts: 1 },
      {
        role: "tool",
        content: "tests passed",
        toolCall: { id: "call_test_1", name: "run_command", argsJson: '{"command":"npm test"}' },
        ts: 2
      }
    );
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: () => undefined
    });

    const messages = (session as unknown as {
      buildNativePromptMessages(systemPrompt: string): Array<{ role: string; content: string }>;
    }).buildNativePromptMessages("system prompt");

    expect(messages.map(message => message.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(messages[1].content).toBe("Continue the task described in the conversation context above.");
    expect(messages[0].content).toContain("[context summary]\nGOAL: finish the refactor");
  });

  it("falls back to legacy syntax only after an explicit native-tools rejection", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "llh-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "hello\n", "utf8");
    mocks.settings.toolCallingMode = "auto";
    const requests: Array<Record<string, unknown>> = [];
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* (_endpoint: string, request: Record<string, unknown>) {
      requests.push(request);
      if (pass++ === 0) throw new mocks.NativeToolsUnsupportedError("tools param requires --jinja flag");
      if (pass === 2) yield { kind: "text", text: gemmaCall("read_file", 'path:<|"|>a.txt<|"|>') };
      else yield { kind: "text", text: "done" };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record: newRecord(),
      emit: event => events.push(event)
    });
    await session.sendUserMessage("read it");

    expect(requests[0].tools).toBeDefined();
    expect(requests[1].tools).toBeUndefined();
    expect(events.some(event => event.kind === "notice" && event.text.includes("legacy model adapter"))).toBe(true);
    expect(events.some(event => event.kind === "toolCallResolved" && event.status === "executed")).toBe(true);
  });

  it("sanitizes legacy argument text before replaying it through native tool calls", async () => {
    mocks.settings.toolCallingMode = "native";
    const requests: Array<Record<string, unknown>> = [];
    mocks.streamChat.mockImplementation(async function* (_endpoint: string, request: Record<string, unknown>) {
      requests.push(request);
      yield { kind: "text", text: "done" };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    record.messages.push(
      { role: "user", content: "old request", ts: 1 },
      {
        role: "tool",
        content: "error: malformed legacy call",
        toolCall: { id: "old_bad", name: "read_file", argsJson: '{"path":"cut-off' },
        ts: 2
      },
      {
        role: "tool",
        content: "old result",
        toolCall: { id: "old_wrapped", name: "list_dir", argsJson: '"{\\"path\\":\\"src\\"}"' },
        ts: 3
      }
    );
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: () => undefined
    });
    await session.sendUserMessage("continue");

    const assistant = (requests[0].messages as Array<Record<string, unknown>>)
      .find(message => Array.isArray(message.tool_calls));
    const calls = assistant?.tool_calls as Array<{ function: { arguments: string } }>;
    expect(calls[0].function.arguments).toBe("{}");
    expect(calls[1].function.arguments).toBe('{"path":"src"}');
  });

  it("retries one server-side native argument parse failure without falling back to legacy", async () => {
    mocks.settings.toolCallingMode = "native";
    const requests: Array<Record<string, unknown>> = [];
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* (_endpoint: string, request: Record<string, unknown>) {
      requests.push(request);
      if (pass++ === 0) {
        throw new mocks.MalformedNativeToolCallError("Failed to parse tool call arguments as JSON");
      }
      yield { kind: "text", text: "recovered" };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record: newRecord(),
      emit: event => events.push(event)
    });
    await session.sendUserMessage("continue");

    expect(requests).toHaveLength(2);
    expect(requests.every(request => request.tools !== undefined)).toBe(true);
    const retryMessages = requests[1].messages as Array<{ role: string; content: string }>;
    expect(retryMessages.at(-1)?.content).toContain("valid JSON object");
    expect(events.some(event => event.kind === "notice" && event.text.includes("malformed native tool arguments"))).toBe(true);
    expect(events.some(event => event.kind === "abort")).toBe(false);
  });

  it("never executes tool-looking assistant text in native mode", async () => {
    mocks.settings.toolCallingMode = "native";
    mocks.settings.modelFamily = "qwen3";
    mocks.streamChat.mockImplementation(async function* () {
      yield { kind: "text", text: '<tool_call>{"name":"read_file","arguments":{"path":"secret.txt"}}</tool_call>' };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: event => events.push(event)
    });
    await session.sendUserMessage("show text");

    expect(record.messages.some(message => message.role === "tool")).toBe(false);
    expect(events.filter(event => event.kind === "toolCallProposed")).toHaveLength(0);
    expect(events.some(event => event.kind === "text" && event.delta.includes("<tool_call>"))).toBe(true);
  });

  it("recovers Qwen3-Coder function XML leaked through native content", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "llh-session-"));
    await fs.mkdir(path.join(ws, "src"));
    mocks.settings.toolCallingMode = "native";
    mocks.settings.modelFamily = "qwen3";
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* () {
      if (pass++ === 0) {
        yield { kind: "text", text: "Looking now. <tool_ca" };
        yield { kind: "text", text: "ll><function=list_dir><parameter=path>src</parameter></function></tool_call>" };
      } else {
        yield { kind: "text", text: "done" };
      }
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record,
      emit: event => events.push(event)
    });
    await session.sendUserMessage("inspect src");

    expect(events).toContainEqual(expect.objectContaining({
      kind: "toolCallProposed",
      toolName: "list_dir"
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "toolCallResolved",
      status: "executed"
    }));
    expect(record.messages.some(message =>
      message.role === "tool" &&
      message.toolCall?.name === "list_dir" &&
      message.toolCall.status === "executed"
    )).toBe(true);
    expect(record.messages.at(-1)?.content).toBe("done");
  });

  it("recovers native function XML after an answered question regardless of the stored family", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "llh-session-"));
    await fs.mkdir(path.join(ws, "src"));
    mocks.settings.toolCallingMode = "native";
    // Native transport is family-independent. A chat created before the user
    // switched to Qwen can retain this value and must still recover the
    // server-template dialect from content.
    mocks.settings.modelFamily = "gemma4";
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* () {
      if (pass++ === 0) {
        yield {
          kind: "toolCall",
          name: "ask_user_question",
          argsJson: JSON.stringify({
            question: "What should I review?",
            suggestions: ["Review src", "Review all files"]
          }),
          id: "call_question"
        };
      } else if (pass === 2) {
        yield {
          kind: "thought",
          text: "Exploring now.\n<tool_call><function=list_dir> <parameter=path> . </parameter> </function> </tool_call>"
        };
      } else {
        yield { kind: "text", text: "done" };
      }
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record,
      emit: event => events.push(event)
    });
    const turn = session.sendUserMessage("ask me first");
    await vi.waitFor(() => {
      expect(events.some(event => event.kind === "toolCallProposed" && event.toolName === "ask_user_question")).toBe(true);
    });
    const question = events.find(
      (event): event is Extract<UiEvent, { kind: "toolCallProposed" }> =>
        event.kind === "toolCallProposed" && event.toolName === "ask_user_question"
    );
    expect(question).toBeDefined();
    session.answerQuestion(question!.toolId, "Review all files");
    await turn;

    expect(events).toContainEqual(expect.objectContaining({
      kind: "toolCallProposed",
      toolName: "list_dir"
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "toolCallResolved",
      status: "executed"
    }));
    expect(record.messages.some(message => message.role === "tool" && message.toolCall?.name === "list_dir")).toBe(true);
    expect(record.messages.at(-1)?.content).toBe("done");
    expect(events.some(event => event.kind === "thought" && event.delta.includes("Exploring now."))).toBe(true);
    expect(events.some(event => event.kind === "thought" && event.delta.includes("<tool_call>"))).toBe(false);
  });

  it("strictly validates native arguments instead of applying legacy aliases", async () => {
    mocks.settings.toolCallingMode = "native";
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* () {
      if (pass++ === 0) {
        yield { kind: "toolCall", name: "read_file", argsJson: '{"file_path":"a.txt"}', id: "call_bad_args" };
      } else {
        yield { kind: "text", text: "done" };
      }
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: event => events.push(event)
    });
    await session.sendUserMessage("read");

    expect(events.some(event => event.kind === "toolCallResolved" && event.status === "failed")).toBe(true);
    const failedResult = record.messages.find(message => message.role === "tool");
    expect(failedResult?.content).toContain("arguments.path is required");
    expect(failedResult?.toolCall?.status).toBe("failed");
  });

  it("does not execute the same structured call id twice", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "llh-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "hello\n", "utf8");
    mocks.settings.toolCallingMode = "native";
    mocks.streamChat.mockImplementation(async function* () {
      yield { kind: "toolCall", name: "read_file", argsJson: '{"path":"a.txt"}', id: "duplicate_id" };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record,
      emit: event => events.push(event)
    });
    await session.sendUserMessage("read");

    expect(record.messages.filter(message => message.role === "tool")).toHaveLength(1);
    expect(events.some(event => event.kind === "abort" && event.reason.includes("Duplicate tool call id"))).toBe(true);
  });

  it("executes native command arguments without using the legacy shell tool", async () => {
    mocks.settings.toolCallingMode = "native";
    mocks.settings.autoapproveCommands = true;
    mocks.settings.safeCommands = [{ match: "npm test", description: "tests" }];
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* () {
      if (pass++ === 0) {
        yield { kind: "toolCall", name: "run_process", argsJson: '{"program":"npm","args":["test"]}', id: "call_process_1" };
      } else {
        yield { kind: "text", text: "done" };
      }
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record: newRecord(),
      emit: event => events.push(event)
    });
    await session.sendUserMessage("test");

    expect(mocks.runProcess).toHaveBeenCalledWith(
      "npm",
      ["test"],
      "/tmp/workspace",
      expect.any(AbortSignal),
      expect.any(Function)
    );
    expect(mocks.runCommand).not.toHaveBeenCalled();
  });

  it("yields a long-running process and lets the model wait for it", async () => {
    mocks.settings.toolCallingMode = "native";
    mocks.settings.autoapproveCommands = true;
    mocks.settings.safeCommands = [{ match: "npm test", description: "tests" }];
    const finalResult = { exitCode: 0, stdout: "started\ndone\n", stderr: "", truncated: false };
    let output = { stdout: "started\n", stderr: "", truncated: false };
    let resolveResult = (_value: typeof finalResult): void => undefined;
    const result = new Promise<typeof finalResult>(resolve => { resolveResult = resolve; });
    let waits = 0;
    mocks.startProcess.mockReturnValue({
      result,
      snapshot: () => output,
      wait: vi.fn(async () => {
        if (waits++ === 0) return { running: true as const, output };
        output = finalResult;
        resolveResult(finalResult);
        return { running: false as const, result: finalResult };
      }),
      stop: vi.fn(async () => finalResult)
    });

    const events: UiEvent[] = [];
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* () {
      if (pass++ === 0) {
        yield { kind: "toolCall", name: "run_process", argsJson: '{"program":"npm","args":["test"]}', id: "call_job_start" };
      } else if (pass === 2) {
        const started = events.find(
          (event): event is Extract<UiEvent, { kind: "toolCallResolved" }> =>
            event.kind === "toolCallResolved" && event.processRunning === true
        );
        yield { kind: "toolCall", name: "wait_process", argsJson: JSON.stringify({ job_id: started?.processJobId, wait_ms: 100 }), id: "call_job_wait" };
      } else {
        yield { kind: "text", text: "done" };
      }
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: event => events.push(event)
    });
    await session.sendUserMessage("run and wait");

    expect(record.messages.filter(message => message.role === "tool")).toHaveLength(2);
    expect(record.messages[record.messages.length - 2].content).toContain("finished (exit 0)");
    const waitProposal = events.find(
      (event): event is Extract<UiEvent, { kind: "toolCallProposed" }> =>
        event.kind === "toolCallProposed" && event.toolName === "wait_process"
    );
    expect(waitProposal).toMatchObject({ category: "process", approvalRequired: false });
  });

  it("lets the user stop a yielded process and records the update for the model", async () => {
    mocks.settings.toolCallingMode = "native";
    mocks.settings.autoapproveCommands = true;
    mocks.settings.safeCommands = [{ match: "npm test", description: "tests" }];
    const stoppedResult = { exitCode: -1, stdout: "started\n", stderr: "", truncated: false };
    let resolveResult = (_value: typeof stoppedResult): void => undefined;
    const result = new Promise<typeof stoppedResult>(resolve => { resolveResult = resolve; });
    const stop = vi.fn(async () => {
      resolveResult(stoppedResult);
      return stoppedResult;
    });
    mocks.startProcess.mockReturnValue({
      result,
      snapshot: () => ({ stdout: "started\n", stderr: "", truncated: false }),
      wait: vi.fn(async () => ({ running: true as const, output: { stdout: "started\n", stderr: "", truncated: false } })),
      stop
    });
    let releaseFinal = (): void => undefined;
    const finalGate = new Promise<void>(resolve => { releaseFinal = resolve; });
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* () {
      if (pass++ === 0) {
        yield { kind: "toolCall", name: "run_process", argsJson: '{"program":"npm","args":["test"]}', id: "call_user_stop" };
      } else {
        await finalGate;
        yield { kind: "text", text: "process started" };
      }
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: event => events.push(event)
    });
    const turn = session.sendUserMessage("start it");
    await vi.waitFor(() => expect(events.some(
      event => event.kind === "toolCallResolved" && event.processRunning === true
    )).toBe(true));
    const jobId = events.find(
      (event): event is Extract<UiEvent, { kind: "toolCallResolved" }> =>
        event.kind === "toolCallResolved" && event.processRunning === true
    )?.processJobId;

    await session.stopProcessFromUser(jobId!);
    releaseFinal();
    await turn;

    expect(stop).toHaveBeenCalledOnce();
    const userStopResult = [...record.messages].reverse().find(message => message.toolCall?.name === "stop_process");
    expect(userStopResult?.content).toContain("stopped by the user");
    expect(events).toContainEqual(expect.objectContaining({
      kind: "processJobState",
      jobId,
      running: false
    }));
  });

  it("stops every yielded process after the model's final answer and before turn end", async () => {
    mocks.settings.toolCallingMode = "native";
    mocks.settings.autoapproveCommands = true;
    mocks.settings.safeCommands = [{ match: "npm test", description: "tests" }];
    const stoppedResult = { exitCode: -1, stdout: "started\n", stderr: "", truncated: false };
    let resolveResult = (_value: typeof stoppedResult): void => undefined;
    const result = new Promise<typeof stoppedResult>(resolve => { resolveResult = resolve; });
    const stop = vi.fn(async () => {
      resolveResult(stoppedResult);
      return stoppedResult;
    });
    mocks.startProcess.mockReturnValue({
      result,
      snapshot: () => ({ stdout: "started\n", stderr: "", truncated: false }),
      wait: vi.fn(async () => ({ running: true as const, output: { stdout: "started\n", stderr: "", truncated: false } })),
      stop
    });
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* () {
      if (pass++ === 0) {
        yield { kind: "toolCall", name: "run_process", argsJson: '{"program":"npm","args":["test"]}', id: "call_auto_stop" };
      } else {
        yield { kind: "text", text: "final answer" };
      }
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record: newRecord(),
      emit: event => events.push(event)
    });

    await session.sendUserMessage("start it");

    expect(stop).toHaveBeenCalledOnce();
    const answerIndex = events.map(event => event.kind).lastIndexOf("text");
    const stoppedIndex = events.findIndex(event =>
      event.kind === "processJobState" && event.resultPreview?.includes("model response completed")
    );
    const turnEndIndex = events.findIndex(event => event.kind === "turnEnd");
    expect(stoppedIndex).toBeGreaterThan(answerIndex);
    expect(turnEndIndex).toBeGreaterThan(stoppedIndex);
  });

  it("uses the read revision for a native atomic edit", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "llh-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "one\ntwo\n", "utf8");
    mocks.settings.toolCallingMode = "native";
    mocks.settings.autoapproveWrites = true;
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* (_endpoint: string, request: { messages: Array<{ role: string; content: string }> }) {
      if (pass++ === 0) {
        yield { kind: "toolCall", name: "read_file", argsJson: '{"path":"a.txt"}', id: "call_read_edit" };
      } else if (pass === 2) {
        const readResult = [...request.messages].reverse().find(message => message.role === "tool")?.content ?? "";
        const revision = /\[revision (sha256:[a-f0-9]{64})\]/.exec(readResult)?.[1];
        expect(revision).toBeTruthy();
        yield {
          kind: "toolCall",
          name: "edit_file",
          argsJson: JSON.stringify({
            path: "a.txt",
            baseRevision: revision,
            edits: [{ oldText: "two", newText: "TWO" }]
          }),
          id: "call_edit_1"
        };
      } else {
        yield { kind: "text", text: "done" };
      }
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record: newRecord(),
      emit: event => events.push(event)
    });
    await session.sendUserMessage("edit it");

    await expect(fs.readFile(path.join(ws, "a.txt"), "utf8")).resolves.toBe("one\nTWO\n");
    const proposal = events.find(
      (event): event is Extract<UiEvent, { kind: "toolCallProposed" }> =>
        event.kind === "toolCallProposed" && event.toolName === "edit_file"
    );
    expect(proposal?.diffPreview).toMatch(/^-\t.*\ttwo$/m);
    expect(proposal?.diffPreview).toMatch(/^\+\t.*\tTWO$/m);
  });

  it("executes native replace_range and insert_text edits with approval diffs", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "llh-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "one\ntwo\n", "utf8");
    mocks.settings.toolCallingMode = "native";
    mocks.settings.autoapproveWrites = true;
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* () {
      if (pass++ === 0) {
        yield {
          kind: "toolCall",
          name: "replace_range",
          argsJson: JSON.stringify({
            path: "a.txt",
            startLine: 2,
            endLine: 2,
            expectedContent: "two",
            content: "TWO\n"
          }),
          id: "call_replace_native"
        };
      } else if (pass === 2) {
        yield {
          kind: "toolCall",
          name: "insert_text",
          argsJson: JSON.stringify({
            path: "a.txt",
            line: 2,
            expectedLine: "TWO",
            text: "middle\n"
          }),
          id: "call_insert_native"
        };
      } else {
        yield { kind: "text", text: "done" };
      }
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record: newRecord(),
      emit: event => events.push(event)
    });
    await session.sendUserMessage("edit it with line tools");

    await expect(fs.readFile(path.join(ws, "a.txt"), "utf8")).resolves.toBe("one\nmiddle\nTWO\n");
    const proposals = events.filter(
      (event): event is Extract<UiEvent, { kind: "toolCallProposed" }> => event.kind === "toolCallProposed"
    );
    const replaceProposal = proposals.find(event => event.toolName === "replace_range");
    const insertProposal = proposals.find(event => event.toolName === "insert_text");
    expect(replaceProposal?.diffPreview).toMatch(/^-\t.*\ttwo$/m);
    expect(replaceProposal?.diffPreview).toMatch(/^\+\t.*\tTWO$/m);
    expect(insertProposal?.diffPreview).toMatch(/^\+\t.*\tmiddle$/m);
  });

  it("ignores a second send while a turn is already active", async () => {
    let releaseStream: () => void = () => undefined;
    const streamReleased = new Promise<void>(resolve => { releaseStream = resolve; });
    const streamStarted = new Promise<void>(resolve => {
      mocks.streamChat.mockImplementation(async function* (): AsyncGenerator<{ kind: "text"; text: string }, void, void> {
        resolve();
        await streamReleased;
        yield { kind: "text", text: "done" };
      });
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const storage = { save: vi.fn(async () => undefined) };
    const session = new ChatSession({
      storage: storage as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: e => events.push(e)
    });

    const firstTurn = session.sendUserMessage("first");
    await streamStarted;
    await session.sendUserMessage("second");

    const userMessagesDuringTurn = record.messages
      .filter(m => m.role === "user")
      .map(m => m.content);
    releaseStream();
    await firstTurn;

    expect(userMessagesDuringTurn).toEqual(["first"]);
    expect(events).toContainEqual({
      kind: "notice",
      text: "A chat turn is already running. Wait for it to finish or cancel it before sending another message."
    });
  });

  it("edits a user turn, removes everything after it, and regenerates", async () => {
    const answers = ["first answer", "second answer", "regenerated answer"];
    mocks.streamChat.mockImplementation(async function* (_endpoint: string, request: { onResponseAccepted?: () => void }): AsyncGenerator<{ kind: "text"; text: string }, void, void> {
      request.onResponseAccepted?.();
      yield { kind: "text", text: answers.shift() ?? "" };
    });
    mocks.complete.mockResolvedValue("Edit earlier request");

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const storage = { save: vi.fn(async () => undefined) };
    const session = new ChatSession({
      storage: storage as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: event => events.push(event)
    });

    await session.sendUserMessage("first request");
    const firstUserTs = record.messages.find(message => message.role === "user")!.ts;
    await session.sendUserMessage("second request");
    await session.editUserMessage(firstUserTs, "edited first request");

    expect(record.messages.map(message => [message.role, message.content])).toEqual([
      ["user", "edited first request"],
      ["assistant", "regenerated answer"]
    ]);
    expect(events.some(event => event.kind === "chatLoaded")).toBe(true);
    expect(events).toContainEqual({
      kind: "titleChanged",
      title: "Edit earlier request",
      animate: true
    });
  });

  it("keeps consecutive edits to the same file as separate items with per-call stats", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "llh-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "one\ntwo\nthree\n", "utf8");
    mocks.settings.autoapproveWrites = true;

    // Two consecutive replace_range edits to a.txt, then a plain final answer.
    const responses = [
      gemmaCall("replace_range", "path:<|\"|>a.txt<|\"|>,startLine:1,endLine:1,expectedContent:<|\"|>one<|\"|>,content:<|\"|>ONE\n<|\"|>"),
      gemmaCall("replace_range", "path:<|\"|>a.txt<|\"|>,startLine:2,endLine:2,expectedContent:<|\"|>two<|\"|>,content:<|\"|>TWO\n<|\"|>"),
      "all done"
    ];
    let call = 0;
    mocks.streamChat.mockImplementation(async function* (): AsyncGenerator<{ kind: "text"; text: string }, void, void> {
      yield { kind: "text", text: responses[Math.min(call++, responses.length - 1)] };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record: newRecord(),
      emit: e => events.push(e)
    });

    await session.sendUserMessage("edit it");

    const executed = events.filter(
      (e): e is Extract<UiEvent, { kind: "toolCallResolved" }> =>
        e.kind === "toolCallResolved" && e.status === "executed"
    );
    expect(executed).toHaveLength(2);
    expect(executed[0].toolId).not.toBe(executed[1].toolId);
    expect({ added: executed[0].added, removed: executed[0].removed }).toEqual({ added: 1, removed: 1 });
    expect({ added: executed[1].added, removed: executed[1].removed }).toEqual({ added: 1, removed: 1 });
    // The file reflects both edits.
    await expect(fs.readFile(path.join(ws, "a.txt"), "utf8")).resolves.toBe("ONE\nTWO\nthree\n");

    const proposed = events.filter(
      (e): e is Extract<UiEvent, { kind: "toolCallProposed" }> => e.kind === "toolCallProposed"
    );
    expect(proposed).toHaveLength(2);
    expect(proposed[0].toolId).not.toBe(proposed[1].toolId);
  });

  it("keeps a re-edit's streaming progress on its own item", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "llh-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "one\ntwo\nthree\n", "utf8");
    mocks.settings.autoapproveWrites = true;

    const responses = [
      gemmaCall("replace_range", "path:<|\"|>a.txt<|\"|>,startLine:1,endLine:1,expectedContent:<|\"|>one<|\"|>,content:<|\"|>ONE\n<|\"|>"),
      gemmaCall("replace_range", "path:<|\"|>a.txt<|\"|>,startLine:2,endLine:2,expectedContent:<|\"|>two<|\"|>,content:<|\"|>TWO\n<|\"|>"),
      "all done"
    ];
    let call = 0;
    mocks.streamChat.mockImplementation(async function* (): AsyncGenerator<{ kind: "text"; text: string }, void, void> {
      yield { kind: "text", text: responses[Math.min(call++, responses.length - 1)] };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record: newRecord(),
      emit: e => events.push(e)
    });

    await session.sendUserMessage("edit it twice");

    const progressEvents = events
      .filter((e): e is Extract<UiEvent, { kind: "toolCallProgress" }> => e.kind === "toolCallProgress")
    expect(progressEvents.length).toBeGreaterThanOrEqual(2);
    expect(new Set(progressEvents.map(e => e.toolId)).size).toBeGreaterThanOrEqual(2);
  });

  it("keeps same-file edits separate when another tool runs between them", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "llh-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "one\ntwo\n", "utf8");
    mocks.settings.autoapproveWrites = true;

    const responses = [
      gemmaCall("replace_range", "path:<|\"|>a.txt<|\"|>,startLine:1,endLine:1,expectedContent:<|\"|>one<|\"|>,content:<|\"|>ONE\n<|\"|>"),
      gemmaCall("read_file", "path:<|\"|>a.txt<|\"|>"),
      gemmaCall("replace_range", "path:<|\"|>a.txt<|\"|>,startLine:2,endLine:2,expectedContent:<|\"|>two<|\"|>,content:<|\"|>TWO\n<|\"|>"),
      "done"
    ];
    let call = 0;
    mocks.streamChat.mockImplementation(async function* (): AsyncGenerator<{ kind: "text"; text: string }, void, void> {
      yield { kind: "text", text: responses[Math.min(call++, responses.length - 1)] };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record: newRecord(),
      emit: e => events.push(e)
    });

    await session.sendUserMessage("edit, read, edit");

    const edits = events
      .filter(
        (e): e is Extract<UiEvent, { kind: "toolCallResolved" }> =>
          e.kind === "toolCallResolved" && e.status === "executed" && e.added !== undefined
      );
    expect(edits).toHaveLength(2);
    expect(edits[0].toolId).not.toBe(edits[1].toolId);
  });

  it("auto-approves a safe-listed command when autoapproveCommands is on", async () => {
    mocks.settings.safeCommands = [{ match: "npm test", description: "Run tests" }];
    mocks.settings.autoapproveCommands = true;
    mocks.runCommand.mockImplementation(async (
      _command: string,
      _cwd: string,
      _signal?: AbortSignal,
      onOutput?: (output: { stdout: string; stderr: string; truncated: boolean }) => void
    ) => {
      onOutput?.({ stdout: "streamed", stderr: "", truncated: false });
      return { exitCode: 0, stdout: "streamed\nok", stderr: "", truncated: false };
    });

    const responses = [
      gemmaCall("run_command", "command:<|\"|>npm test<|\"|>"),
      "done"
    ];
    let call = 0;
    mocks.streamChat.mockImplementation(async function* (): AsyncGenerator<{ kind: "text"; text: string }, void, void> {
      yield { kind: "text", text: responses[Math.min(call++, responses.length - 1)] };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: e => events.push(e)
    });

    await session.sendUserMessage("run tests");

    // The command was offered as safeCmd and ran without an approval round-trip.
    expect(mocks.runCommand).toHaveBeenCalledOnce();
    const proposed = events.find(
      (e): e is Extract<UiEvent, { kind: "toolCallProposed" }> => e.kind === "toolCallProposed"
    );
    expect(proposed?.category).toBe("safeCmd");
    expect(proposed?.approvalRequired).toBe(false);
    expect(events.some(e => e.kind === "toolCallResolved" && e.status === "approved")).toBe(false);
    expect(events.some(e => e.kind === "toolCallResolved" && e.status === "executed")).toBe(true);
    const outputIndex = events.findIndex(e => e.kind === "toolCallOutput");
    const resolvedIndex = events.findIndex(e => e.kind === "toolCallResolved" && e.status === "executed");
    expect(outputIndex).toBeGreaterThan(-1);
    expect(events[outputIndex]).toEqual(expect.objectContaining({
      kind: "toolCallOutput",
      resultPreview: expect.stringContaining("streamed")
    }));
    expect(outputIndex).toBeLessThan(resolvedIndex);
    expect(events[resolvedIndex]).toEqual(expect.objectContaining({
      kind: "toolCallResolved",
      resultPreview: expect.stringContaining("streamed\nok")
    }));
    expect(record.messages.find(message => message.role === "tool")?.content)
      .toContain("streamed\nok");
  });

  it("still requires approval for a safe-listed command when autoapproveCommands is off", async () => {
    mocks.settings.safeCommands = [{ match: "npm test", description: "Run tests" }];
    mocks.settings.autoapproveCommands = false;
    mocks.runCommand.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "", truncated: false });

    const responses = [
      gemmaCall("run_command", "command:<|\"|>npm test<|\"|>"),
      "done"
    ];
    let call = 0;
    mocks.streamChat.mockImplementation(async function* (): AsyncGenerator<{ kind: "text"; text: string }, void, void> {
      yield { kind: "text", text: responses[Math.min(call++, responses.length - 1)] };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    let resolveProposed: (id: string) => void = () => undefined;
    const proposedId = new Promise<string>(r => { resolveProposed = r; });
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record: newRecord(),
      emit: e => {
        events.push(e);
        if (e.kind === "toolCallProposed") resolveProposed(e.toolId);
      }
    });

    const turn = session.sendUserMessage("run tests");
    // The turn blocks awaiting approval: the call was proposed but not executed.
    const toolId = await proposedId;
    const proposed = events.find(
      (e): e is Extract<UiEvent, { kind: "toolCallProposed" }> => e.kind === "toolCallProposed"
    );
    expect(proposed?.category).toBe("safeCmd");
    expect(proposed?.approvalRequired).toBe(true);
    expect(mocks.runCommand).not.toHaveBeenCalled();

    // Approving lets it run.
    session.approve(toolId, true);
    await turn;
    expect(mocks.runCommand).toHaveBeenCalledOnce();
  });

  it("requires explicit approval for an unlisted command even when command auto-approval is on", async () => {
    mocks.settings.safeCommands = [{ match: "npm test", description: "Run tests" }];
    mocks.settings.autoapproveCommands = true;
    mocks.runCommand.mockResolvedValue({ exitCode: 0, stdout: "published", stderr: "", truncated: false });

    const responses = [
      gemmaCall("run_command", "command:<|\"|>npm publish<|\"|>"),
      "done"
    ];
    let call = 0;
    mocks.streamChat.mockImplementation(async function* (): AsyncGenerator<{ kind: "text"; text: string }, void, void> {
      yield { kind: "text", text: responses[Math.min(call++, responses.length - 1)] };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    let resolveProposed: (id: string) => void = () => undefined;
    const proposedId = new Promise<string>(resolve => { resolveProposed = resolve; });
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record: newRecord(),
      emit: event => {
        events.push(event);
        if (event.kind === "toolCallProposed") resolveProposed(event.toolId);
      }
    });

    const turn = session.sendUserMessage("publish it");
    const toolId = await proposedId;
    const proposed = events.find(
      (event): event is Extract<UiEvent, { kind: "toolCallProposed" }> => event.kind === "toolCallProposed"
    );
    expect(proposed?.category).toBe("command");
    expect(proposed?.approvalRequired).toBe(true);
    expect(mocks.runCommand).not.toHaveBeenCalled();

    session.approve(toolId, true);
    await turn;
    expect(mocks.runCommand).toHaveBeenCalledWith(
      "npm publish",
      "/tmp/workspace",
      expect.any(AbortSignal),
      expect.any(Function)
    );
  });

  it("does not execute an unlisted command when the user rejects it", async () => {
    mocks.settings.safeCommands = [];
    mocks.settings.autoapproveCommands = true;
    mocks.streamChat.mockImplementation(async function* () {
      yield { kind: "toolCall", name: "run_process", argsJson: '{"program":"npm","args":["publish"]}', id: "call_unlisted" };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    let resolveProposed: (id: string) => void = () => undefined;
    const proposedId = new Promise<string>(resolve => { resolveProposed = resolve; });
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record: newRecord(),
      emit: event => {
        events.push(event);
        if (event.kind === "toolCallProposed") resolveProposed(event.toolId);
      }
    });

    const turn = session.sendUserMessage("publish it");
    const toolId = await proposedId;
    session.approve(toolId, false);
    await turn;

    expect(mocks.runProcess).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      kind: "toolCallResolved",
      toolId,
      status: "rejected"
    }));
  });

  it("feeds back a malformed tool call so the model can re-emit it", async () => {
    // An irreparable qwen3 <tool_call> body parses to a blank name. The session must reject it WITH feedback
    // and re-prompt — silently dropping it ends the turn with no reply at all.
    mocks.settings.modelFamily = "qwen3";
    const responses = [
      `<tool_call>{"name":"list_dir","arguments":{"path":???}}</tool_call>`,
      "Recovered review."
    ];
    let call = 0;
    mocks.streamChat.mockImplementation(async function* (): AsyncGenerator<{ kind: "text"; text: string }, void, void> {
      yield { kind: "text", text: responses[Math.min(call++, responses.length - 1)] };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: e => events.push(e)
    });

    await session.sendUserMessage("review");

    expect(events.some(e => e.kind === "abort")).toBe(false);
    expect(events.some(e => e.kind === "toolCallResolved" && e.status === "rejected")).toBe(true);
    // The failure is stored as a tool result quoting the raw block, so the
    // next pass tells the model what went wrong.
    const feedback = record.messages.find(m => m.role === "tool");
    expect(feedback?.content).toContain("Malformed tool call");
    expect(feedback?.content).toContain("Parser detail:");
    expect(feedback?.content).toContain("???");
    const answer = events
      .filter((e): e is Extract<UiEvent, { kind: "text" }> => e.kind === "text")
      .map(e => e.delta)
      .join("");
    expect(answer).toContain("Recovered review.");
  });

  it("labels an orphaned malformed Qwen edit with its actual streamed tool name", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "llh-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "old\n", "utf8");
    mocks.settings.modelFamily = "qwen3";
    mocks.settings.autoapproveWrites = true;
    const responses = [
      `<tool_call>{"name":"replace_range","arguments":{"path":"a.txt","startLine":1,"endLine":1,"expectedContent":"old","content":"const x = "broken";\n"}}</tool_call>`,
      "Recovered after malformed edit."
    ];
    let call = 0;
    mocks.streamChat.mockImplementation(async function* (): AsyncGenerator<{ kind: "text"; text: string }, void, void> {
      yield { kind: "text", text: responses[Math.min(call++, responses.length - 1)] };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record: newRecord(),
      emit: event => events.push(event)
    });

    await session.sendUserMessage("edit it");

    const failures = events.filter(
      (event): event is Extract<UiEvent, { kind: "toolCallResolved" }> => event.kind === "toolCallResolved"
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ status: "rejected" });
    expect(failures[0].resultPreview).toContain("Malformed tool call");
    expect(failures[0].resultPreview).toContain("Parser detail:");
    expect(failures[0].resultPreview).not.toContain("incomplete write_file");
    const proposed = events.find(
      (event): event is Extract<UiEvent, { kind: "toolCallProposed" }> => event.kind === "toolCallProposed"
    );
    expect(proposed?.toolName).toBe("replace_range");
    await expect(fs.readFile(path.join(ws, "a.txt"), "utf8")).resolves.toBe("old\n");
  });

  it("rejects an edit that omits its required old-content precondition", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "llh-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "one\ntwo\n", "utf8");
    mocks.settings.autoapproveWrites = true;
    const responses = [
      gemmaCall("replace_range", "path:<|\"|>a.txt<|\"|>,startLine:1,endLine:1,content:<|\"|>ONE\n<|\"|>"),
      "Recovered without applying the unsafe edit."
    ];
    let call = 0;
    mocks.streamChat.mockImplementation(async function* (): AsyncGenerator<{ kind: "text"; text: string }, void, void> {
      yield { kind: "text", text: responses[Math.min(call++, responses.length - 1)] };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record,
      emit: () => undefined
    });

    await session.sendUserMessage("edit safely");

    await expect(fs.readFile(path.join(ws, "a.txt"), "utf8")).resolves.toBe("one\ntwo\n");
    const feedback = record.messages.find(m => m.role === "tool");
    expect(feedback?.content).toContain("expectedContent safety precondition");
  });

  it("feeds back a tool call cut off before its closing tag (qwen3)", async () => {
    // The model emitted a read-only tool call but the stream ended before
    // </tool_call>. Previously this was dropped silently and the turn ended
    // with the "model stopped after its tool calls" notice.
    mocks.settings.modelFamily = "qwen3";
    const responses = [
      `<tool_call>{"name":"read_file","arguments":{"path":"src/ma`,
      "Recovered after the cut-off."
    ];
    let call = 0;
    mocks.streamChat.mockImplementation(async function* (): AsyncGenerator<{ kind: "text"; text: string }, void, void> {
      yield { kind: "text", text: responses[Math.min(call++, responses.length - 1)] };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record: newRecord(),
      emit: e => events.push(e)
    });

    await session.sendUserMessage("review the codebase");

    expect(events.some(e => e.kind === "abort")).toBe(false);
    expect(events.some(e => e.kind === "notice")).toBe(false);
    const answer = events
      .filter((e): e is Extract<UiEvent, { kind: "text" }> => e.kind === "text")
      .map(e => e.delta)
      .join("");
    expect(answer).toContain("Recovered after the cut-off.");
  });

  it("executes an unclosed tool call whose body is complete JSON (qwen3)", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "llh-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "hello\n", "utf8");
    mocks.settings.modelFamily = "qwen3";
    // Only the closing </tool_call> tag was cut off; the call itself is whole.
    const responses = [
      `<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}`,
      "The file says hello."
    ];
    let call = 0;
    mocks.streamChat.mockImplementation(async function* (): AsyncGenerator<{ kind: "text"; text: string }, void, void> {
      yield { kind: "text", text: responses[Math.min(call++, responses.length - 1)] };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record,
      emit: e => events.push(e)
    });

    await session.sendUserMessage("read it");

    const toolResult = record.messages.find(m => m.role === "tool");
    expect(toolResult?.toolCall?.name).toBe("read_file");
    expect(toolResult?.content).toContain("hello");
    const answer = events
      .filter((e): e is Extract<UiEvent, { kind: "text" }> => e.kind === "text")
      .map(e => e.delta)
      .join("");
    expect(answer).toContain("The file says hello.");
  });

  it("feeds back a truncated (incomplete) write_file call and re-prompts", async () => {
    mocks.settings.modelFamily = "gemma4";
    mocks.settings.autoapproveWrites = true;
    // First pass opens a write_file and streams content but never closes the
    // tool-call block (the model was cut off). Second pass answers.
    const responses = [
      `<|tool_call>call:write_file{path:<|"|>a.txt<|"|>,content:<|"|>partial conten`,
      "Recovered after the cut-off."
    ];
    let call = 0;
    mocks.streamChat.mockImplementation(async function* (): AsyncGenerator<{ kind: "text"; text: string }, void, void> {
      yield { kind: "text", text: responses[Math.min(call++, responses.length - 1)] };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record: newRecord(),
      emit: e => events.push(e)
    });

    await session.sendUserMessage("write it");

    // The incomplete call is reported as failed and the model gets another pass.
    expect(events.some(e => e.kind === "toolCallResolved" && e.status === "failed")).toBe(true);
    expect(events.some(e => e.kind === "abort")).toBe(false);
    const answer = events
      .filter((e): e is Extract<UiEvent, { kind: "text" }> => e.kind === "text")
      .map(e => e.delta)
      .join("");
    expect(answer).toContain("Recovered after the cut-off.");
  });

  it("notifies the user when a turn ends with no visible reply", async () => {
    mocks.settings.modelFamily = "qwen3";
    // The model only thinks, then stops — no answer text, no tool.
    mocks.streamChat.mockImplementation(async function* (): AsyncGenerator<{ kind: "text"; text: string }, void, void> {
      yield { kind: "text", text: "<think>I won't actually answer.</think>" };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: e => events.push(e)
    });

    await session.sendUserMessage("hi");

    expect(events.some(e => e.kind === "notice")).toBe(true);
    expect(events.some(e => e.kind === "summary")).toBe(false);
    // No empty assistant message is persisted (thought-only turns are UI state).
    expect(record.messages.some(m => m.role === "assistant")).toBe(false);
  });

  it("includes the server finish reason in a thought-only notice", async () => {
    mocks.settings.toolCallingMode = "native";
    mocks.streamChat.mockImplementation(async function* () {
      yield { kind: "thought" as const, text: "I should call a tool." };
      yield { kind: "finish" as const, reason: "stop" };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record: newRecord(),
      emit: e => events.push(e)
    });

    await session.sendUserMessage("hi");

    const notice = events.find(
      (e): e is Extract<UiEvent, { kind: "notice" }> =>
        e.kind === "notice" && e.text.includes("finish_reason")
    );
    expect(notice?.text).toContain('finish_reason="stop"');
    expect(events.some(event => event.kind === "notice" && event.text.includes("Retrying native continuation"))).toBe(true);
    expect(events.some(event => event.kind === "notice" && event.text.includes("retry was already attempted"))).toBe(true);
    expect(mocks.streamChat).toHaveBeenCalledTimes(2);
  });

  it("retries one native reasoning-only stop with an ephemeral repair note", async () => {
    mocks.settings.toolCallingMode = "native";
    mocks.settings.modelFamily = "qwen3";
    const requests: Array<Record<string, unknown>> = [];
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* (_endpoint: string, request: Record<string, unknown>) {
      requests.push(request);
      if (pass++ === 0) {
        yield { kind: "thought", text: "I should inspect the workspace." };
        yield { kind: "finish", reason: "stop" };
      } else {
        yield { kind: "text", text: "Recovered answer." };
      }
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: event => events.push(event)
    });
    await session.sendUserMessage("inspect it");

    expect(requests).toHaveLength(2);
    const retryMessages = requests[1].messages as Array<{ role: string; content: string }>;
    expect(retryMessages.at(-1)?.content).toContain("[harness recovery]");
    expect(retryMessages.at(-1)?.content).toContain("structured tool call or a final answer");
    expect(events.some(event => event.kind === "notice" && event.text.includes("Retrying native continuation"))).toBe(true);
    expect(events.some(event => event.kind === "summary" && event.text === "Recovered answer.")).toBe(true);
    expect(record.messages.at(-1)?.content).toBe("Recovered answer.");
  });

  it("warns about shifted line numbers when an edit changes the line count", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "llh-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "one\ntwo\nthree\n", "utf8");
    mocks.settings.autoapproveWrites = true;

    const responses = [
      // Replaces 1 line with 2 → everything after line 1 shifts by +1.
      gemmaCall("replace_range", "path:<|\"|>a.txt<|\"|>,startLine:1,endLine:1,expectedContent:<|\"|>one<|\"|>,content:<|\"|>ONE\nEXTRA\n<|\"|>"),
      "done"
    ];
    let call = 0;
    mocks.streamChat.mockImplementation(async function* (): AsyncGenerator<{ kind: "text"; text: string }, void, void> {
      yield { kind: "text", text: responses[Math.min(call++, responses.length - 1)] };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record,
      emit: () => undefined
    });

    await session.sendUserMessage("edit");

    const toolResult = record.messages.find(m => m.role === "tool");
    expect(toolResult?.content).toContain("replaced lines 1-1 in a.txt");
    expect(toolResult?.content).toContain("after line 1 have shifted by +1");
    // The result echoes the updated region with fresh numbers so the model
    // sees the edit's effect without a re-read.
    expect(toolResult?.content).toContain("Updated region with current line numbers");
    expect(toolResult?.content).toContain("1\tONE");
    expect(toolResult?.content).toContain("2\tEXTRA");
    expect(toolResult?.content).toContain("3\ttwo");
  });

  it("rejects a same-reply line edit after an earlier edit shifted the file's line count", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "llh-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "one\ntwo\nthree\n", "utf8");
    mocks.settings.autoapproveWrites = true;

    // Both calls arrive in ONE model response: the model computed both from the
    // pre-edit read, but the first edit (+1 line) shifts everything below it.
    const responses = [
      gemmaCall("replace_range", "path:<|\"|>a.txt<|\"|>,startLine:1,endLine:1,expectedContent:<|\"|>one<|\"|>,content:<|\"|>ONE\nEXTRA\n<|\"|>")
        + gemmaCall("replace_range", "path:<|\"|>a.txt<|\"|>,startLine:3,endLine:3,expectedContent:<|\"|>three<|\"|>,content:<|\"|>THREE\n<|\"|>"),
      "done"
    ];
    let call = 0;
    mocks.streamChat.mockImplementation(async function* (): AsyncGenerator<{ kind: "text"; text: string }, void, void> {
      yield { kind: "text", text: responses[Math.min(call++, responses.length - 1)] };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record,
      emit: () => undefined
    });

    await session.sendUserMessage("edit");

    // Only the first edit landed; the second was refused, not mistargeted.
    await expect(fs.readFile(path.join(ws, "a.txt"), "utf8")).resolves.toBe("ONE\nEXTRA\ntwo\nthree\n");
    const toolResults = record.messages.filter(m => m.role === "tool").map(m => m.content);
    expect(toolResults[1]).toContain("stale");
    expect(toolResults[1]).toContain("NOT applied");
  });

  it("defers a same-reply follow-up line edit even when the first kept the same line count", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "llh-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "one\ntwo\nthree\n", "utf8");
    mocks.settings.autoapproveWrites = true;

    // Even a same-size first replacement forces a tool-result round trip before
    // another line-addressed edit, keeping the protocol simple for small models.
    const responses = [
      gemmaCall("replace_range", "path:<|\"|>a.txt<|\"|>,startLine:1,endLine:1,expectedContent:<|\"|>one<|\"|>,content:<|\"|>ONE\n<|\"|>")
        + gemmaCall("replace_range", "path:<|\"|>a.txt<|\"|>,startLine:3,endLine:3,expectedContent:<|\"|>three<|\"|>,content:<|\"|>THREE\n<|\"|>"),
      "done"
    ];
    let call = 0;
    mocks.streamChat.mockImplementation(async function* (): AsyncGenerator<{ kind: "text"; text: string }, void, void> {
      yield { kind: "text", text: responses[Math.min(call++, responses.length - 1)] };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record,
      emit: () => undefined
    });

    await session.sendUserMessage("edit");

    await expect(fs.readFile(path.join(ws, "a.txt"), "utf8")).resolves.toBe("ONE\ntwo\nthree\n");
    const toolResults = record.messages.filter(m => m.role === "tool").map(m => m.content);
    expect(toolResults[1]).toContain("only one insert_text or replace_range call");
  });

  it("refuses edit content that pastes read_file's line-number prefixes back", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "llh-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "one\ntwo\nthree\n", "utf8");
    mocks.settings.autoapproveWrites = true;

    const responses = [
      gemmaCall("replace_range", "path:<|\"|>a.txt<|\"|>,startLine:2,endLine:3,expectedContent:<|\"|>two\nthree<|\"|>,content:<|\"|>2\tTWO\n3\tTHREE\n<|\"|>"),
      "done"
    ];
    let call = 0;
    mocks.streamChat.mockImplementation(async function* (): AsyncGenerator<{ kind: "text"; text: string }, void, void> {
      yield { kind: "text", text: responses[Math.min(call++, responses.length - 1)] };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record,
      emit: () => undefined
    });

    await session.sendUserMessage("edit");

    // Nothing was written; the model is told to resend without the prefixes.
    await expect(fs.readFile(path.join(ws, "a.txt"), "utf8")).resolves.toBe("one\ntwo\nthree\n");
    const toolResult = record.messages.find(m => m.role === "tool");
    expect(toolResult?.content).toContain("line-number prefixes");
    expect(toolResult?.content).toContain("nothing was written");
  });

  it("returns real line numbers and a range header for ranged read_file calls", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "llh-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "one\ntwo\nthree\nfour\n", "utf8");
    mocks.settings.modelFamily = "qwen3";
    // snake_case range keys, as local models commonly emit them.
    const responses = [
      `<tool_call>{"name":"read_file","arguments":{"path":"a.txt","start_line":2,"end_line":3}}</tool_call>`,
      "Read the middle."
    ];
    let call = 0;
    mocks.streamChat.mockImplementation(async function* (): AsyncGenerator<{ kind: "text"; text: string }, void, void> {
      yield { kind: "text", text: responses[Math.min(call++, responses.length - 1)] };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record,
      emit: e => events.push(e)
    });

    await session.sendUserMessage("read lines 2-3");

    const toolResult = record.messages.find(m => m.role === "tool");
    expect(toolResult?.content).toBe("[lines 2-3 of 4]\n2\ttwo\n3\tthree");
  });

  it("uses the context window reported by the server", async () => {
    mocks.fetchServerContextSize.mockResolvedValue(8192);
    mocks.streamChat.mockImplementation(async function* (): AsyncGenerator<{ kind: "text"; text: string }, void, void> {
      yield { kind: "text", text: "hi there" };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record: newRecord(),
      emit: e => events.push(e)
    });

    await session.sendUserMessage("hello");

    const tokenEvents = events.filter((e): e is Extract<UiEvent, { kind: "tokens" }> => e.kind === "tokens");
    expect(tokenEvents.some(e => e.limit === 8192)).toBe(true);
    expect(tokenEvents.every(e => e.limit === 8192)).toBe(true);
    const notices = events.filter((e): e is Extract<UiEvent, { kind: "notice" }> => e.kind === "notice");
    expect(notices.filter(n => n.text.includes("context window"))).toHaveLength(0);
  });

  it("does not start generation when server metadata has no context length", async () => {
    mocks.fetchServerContextSize.mockResolvedValue(undefined);
    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record: newRecord(),
      emit: event => events.push(event)
    });

    await session.sendUserMessage("hello");

    expect(mocks.streamChat).not.toHaveBeenCalled();
    expect(events.some(event =>
      event.kind === "abort"
      && event.reason.includes("server is unavailable")
      && event.reason.includes("/props")
    )).toBe(true);
  });

  it("counts the system prompt toward context usage", async () => {
    // tokenize returns 100 for the system prompt and 1 for everything else;
    // the emitted totals must include that fixed overhead.
    mocks.tokenize.mockImplementation(async (_endpoint: string, text: string) =>
      text.startsWith("<|system|>") ? 100 : 1
    );
    mocks.streamChat.mockImplementation(async function* (): AsyncGenerator<{ kind: "text"; text: string }, void, void> {
      yield { kind: "text", text: "hi" };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record: newRecord(),
      emit: e => events.push(e)
    });

    await session.sendUserMessage("hello");

    const tokenEvents = events.filter((e): e is Extract<UiEvent, { kind: "tokens" }> => e.kind === "tokens");
    expect(tokenEvents.some(e => e.total >= 100)).toBe(true);
  });

  it("runs update_todos without approval and feeds the checklist back to the model", async () => {
    mocks.settings.modelFamily = "qwen3";
    // autoapprove is off for writes/commands; update_todos must still run, since
    // it is side-effect-free and never routed through approval.
    const todos = [
      { content: "Step one", status: "completed" },
      { content: "Step two", status: "in_progress" },
      { content: "Step three", status: "pending" }
    ];
    const responses = [
      `<tool_call>{"name":"update_todos","arguments":{"todos":${JSON.stringify(todos)}}}</tool_call>`,
      "Tracked."
    ];
    let call = 0;
    mocks.streamChat.mockImplementation(async function* (): AsyncGenerator<{ kind: "text"; text: string }, void, void> {
      yield { kind: "text", text: responses[Math.min(call++, responses.length - 1)] };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: e => events.push(e)
    });

    await session.sendUserMessage("plan it");

    const proposed = events.find(
      (e): e is Extract<UiEvent, { kind: "toolCallProposed" }> => e.kind === "toolCallProposed"
    );
    expect(proposed?.category).toBe("todos");
    // Never asked for approval, never rejected/aborted.
    expect(events.some(e => e.kind === "toolCallResolved" && e.status === "approved")).toBe(false);
    expect(events.some(e => e.kind === "abort")).toBe(false);
    expect(events.some(e => e.kind === "toolCallResolved" && e.status === "executed")).toBe(true);
    // The tool result fed back to the model carries the current checklist.
    const toolResult = record.messages.find(m => m.role === "tool" && m.toolCall?.name === "update_todos");
    expect(toolResult?.content).toContain("todos updated (1/3 completed)");
    expect(toolResult?.content).toContain("- [x] Step one");
    expect(toolResult?.content).toContain("- [ ] Step two (in progress)");
  });

  it("feeds an unknown tool name back and lets the model recover instead of aborting", async () => {
    mocks.settings.modelFamily = "qwen3";
    const responses = [
      `<tool_call>{"name":"search_files","arguments":{}}</tool_call>`,
      "Recovered answer."
    ];
    let call = 0;
    mocks.streamChat.mockImplementation(async function* (): AsyncGenerator<{ kind: "text"; text: string }, void, void> {
      yield { kind: "text", text: responses[Math.min(call++, responses.length - 1)] };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record: newRecord(),
      emit: e => events.push(e)
    });

    await session.sendUserMessage("go");

    expect(events.some(e => e.kind === "abort")).toBe(false);
    const rejected = events.filter(
      e => e.kind === "toolCallResolved" && e.status === "rejected"
    );
    expect(rejected).toHaveLength(1);
    // The turn continued past the bad call and the model answered.
    const answer = events
      .filter((e): e is Extract<UiEvent, { kind: "text" }> => e.kind === "text")
      .map(e => e.delta)
      .join("");
    expect(answer).toContain("Recovered answer.");
  });
});

/** Build a native Gemma tool-call block: `<|tool_call>call:NAME{BODY}<tool_call|>`. */
function gemmaCall(name: string, body: string): string {
  return `<|tool_call>call:${name}{${body}}<tool_call|>`;
}

function newRecord(): ChatRecord {
  return {
    id: "123e4567-e89b-42d3-a456-426614174000",
    workspaceRoot: "/tmp/workspace",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    title: "New chat",
    modelFamily: "gemma4",
    planMode: false,
    thinkingMode: "capped",
    messages: [],
    totalTokens: 0
  };
}
