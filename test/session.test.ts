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
  runProcess: vi.fn()
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
  runProcess: mocks.runProcess
}));

beforeEach(() => {
  mocks.streamChat.mockReset();
  mocks.tokenize.mockReset();
  mocks.complete.mockReset();
  mocks.fetchServerContextSize.mockReset();
  mocks.runCommand.mockReset();
  mocks.runProcess.mockReset();
  mocks.tokenize.mockResolvedValue(1);
  mocks.complete.mockResolvedValue("Test chat");
  mocks.fetchServerContextSize.mockResolvedValue(32768);
  mocks.runProcess.mockResolvedValue({ exitCode: 0, stdout: "ok\n", stderr: "", truncated: false });
  mocks.settings.autoapproveWrites = false;
  mocks.settings.autoapproveCommands = false;
  mocks.settings.safeCommands = [];
  mocks.settings.modelFamily = "gemma4";
  mocks.settings.toolCallingMode = "legacy";
});

describe("ChatSession", () => {
  it("generates the first-request chat name before starting the real model turn", async () => {
    let resolveTitle: (title: string) => void = () => undefined;
    const pendingTitle = new Promise<string>(resolve => { resolveTitle = resolve; });
    mocks.complete.mockReturnValue(pendingTitle);
    mocks.streamChat.mockImplementation(async function* () {
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
    await vi.waitFor(() => expect(mocks.complete).toHaveBeenCalledTimes(1));
    expect(mocks.streamChat).not.toHaveBeenCalled();

    resolveTitle("Fix restart button");
    await turn;

    expect(mocks.complete.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.streamChat.mock.invocationCallOrder[0]);
    expect(events.findIndex(event => event.kind === "titleChanged"))
      .toBeLessThan(events.findIndex(event => event.kind === "turnStart"));
  });

  it("continues the real chat silently when best-effort naming fails", async () => {
    mocks.complete.mockRejectedValue(new Error("title request failed"));
    mocks.streamChat.mockImplementation(async function* () {
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

    expect(mocks.complete).toHaveBeenCalledTimes(1);
    expect(mocks.streamChat).toHaveBeenCalledTimes(1);
    expect(record.title).toBe("New chat");
    expect(events).not.toContainEqual(expect.objectContaining({ kind: "notice" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "turnStart" }));
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
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record,
      emit: () => undefined
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
    expect(record.messages.some(message => message.role === "tool" && message.toolCall?.name === "list_dir")).toBe(true);
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
    expect(record.messages.find(message => message.role === "tool")?.content).toContain("arguments.path is required");
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

    expect(mocks.runProcess).toHaveBeenCalledWith("npm", ["test"], "/tmp/workspace", expect.any(AbortSignal));
    expect(mocks.runCommand).not.toHaveBeenCalled();
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
    mocks.streamChat.mockImplementation(async function* (): AsyncGenerator<{ kind: "text"; text: string }, void, void> {
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
    messages: [],
    totalTokens: 0
  };
}
