import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ChatRecord } from "../src/chat/storage.js";
import type { UiEvent } from "../src/chat/session.js";

const mocks = vi.hoisted(() => ({
  settings: {
    endpoint: "http://127.0.0.1:8080",
    modelFamily: "gemma4",
    contextSize: 32768,
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
  runCommand: vi.fn()
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
  streamChat: mocks.streamChat,
  tokenize: mocks.tokenize,
  complete: mocks.complete,
  fetchServerContextSize: mocks.fetchServerContextSize
}));

vi.mock("../src/tools/terminalTool.js", () => ({
  runCommand: mocks.runCommand
}));

beforeEach(() => {
  mocks.streamChat.mockReset();
  mocks.tokenize.mockReset();
  mocks.complete.mockReset();
  mocks.fetchServerContextSize.mockReset();
  mocks.runCommand.mockReset();
  mocks.tokenize.mockResolvedValue(1);
  mocks.fetchServerContextSize.mockResolvedValue(undefined);
  mocks.settings.autoapproveWrites = false;
  mocks.settings.autoapproveCommands = false;
  mocks.settings.safeCommands = [];
  mocks.settings.modelFamily = "gemma4";
});

describe("ChatSession", () => {
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

  it("groups consecutive edits to the same file with one combined diff and cumulative stats", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "llh-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "one\ntwo\nthree\n", "utf8");
    mocks.settings.autoapproveWrites = true;

    // Two consecutive replace_range edits to a.txt, then a plain final answer.
    const responses = [
      gemmaCall("replace_range", "path:<|\"|>a.txt<|\"|>,startLine:1,endLine:1,content:<|\"|>ONE\n<|\"|>"),
      gemmaCall("replace_range", "path:<|\"|>a.txt<|\"|>,startLine:2,endLine:2,content:<|\"|>TWO\n<|\"|>"),
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
    // Both edits share one group, and the stats are cumulative (original→latest).
    expect(executed[0].groupId).toBeTruthy();
    expect(executed[1].groupId).toBe(executed[0].groupId);
    expect({ added: executed[0].added, removed: executed[0].removed }).toEqual({ added: 1, removed: 1 });
    expect({ added: executed[1].added, removed: executed[1].removed }).toEqual({ added: 2, removed: 2 });
    // The file reflects both edits.
    await expect(fs.readFile(path.join(ws, "a.txt"), "utf8")).resolves.toBe("ONE\nTWO\nthree\n");
  });

  it("starts a new edit group when another tool runs between same-file edits", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "llh-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "one\ntwo\n", "utf8");
    mocks.settings.autoapproveWrites = true;

    const responses = [
      gemmaCall("replace_range", "path:<|\"|>a.txt<|\"|>,startLine:1,endLine:1,content:<|\"|>ONE\n<|\"|>"),
      gemmaCall("read_file", "path:<|\"|>a.txt<|\"|>"),
      gemmaCall("replace_range", "path:<|\"|>a.txt<|\"|>,startLine:2,endLine:2,content:<|\"|>TWO\n<|\"|>"),
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

    const editGroups = events
      .filter(
        (e): e is Extract<UiEvent, { kind: "toolCallResolved" }> =>
          e.kind === "toolCallResolved" && e.status === "executed" && !!e.groupId
      )
      .map(e => e.groupId);
    expect(editGroups).toHaveLength(2);
    expect(editGroups[0]).not.toBe(editGroups[1]);
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
    expect(mocks.runCommand).not.toHaveBeenCalled();

    // Approving lets it run.
    session.approve(toolId, true);
    await turn;
    expect(mocks.runCommand).toHaveBeenCalledOnce();
  });

  it("feeds back a malformed tool call so the model can re-emit it", async () => {
    // A qwen3 <tool_call> block whose body isn't valid JSON (e.g. Python-style
    // quotes) parses to a blank name. The session must reject it WITH feedback
    // and re-prompt — silently dropping it ends the turn with no reply at all.
    mocks.settings.modelFamily = "qwen3";
    const responses = [
      `<tool_call>{'name': 'list_dir', 'arguments': {'path': '.'}}</tool_call>`,
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
    expect(feedback?.content).toContain("'list_dir'");
    const answer = events
      .filter((e): e is Extract<UiEvent, { kind: "text" }> => e.kind === "text")
      .map(e => e.delta)
      .join("");
    expect(answer).toContain("Recovered review.");
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

  it("warns about shifted line numbers when an edit changes the line count", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "llh-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "one\ntwo\nthree\n", "utf8");
    mocks.settings.autoapproveWrites = true;

    const responses = [
      // Replaces 1 line with 2 → everything after line 1 shifts by +1.
      gemmaCall("replace_range", "path:<|\"|>a.txt<|\"|>,startLine:1,endLine:1,content:<|\"|>ONE\nEXTRA\n<|\"|>"),
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
    expect(toolResult?.content).toContain("re-read the affected range");
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

  it("clamps the context limit to the server's actual window and warns once", async () => {
    // The user configured 32768 but the server runs with --ctx-size 8192; the
    // ring and all guards must use the smaller real window.
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
    expect(tokenEvents.every(e => e.limit <= 8192 || e.limit === 32768)).toBe(true);
    const notices = events.filter((e): e is Extract<UiEvent, { kind: "notice" }> => e.kind === "notice");
    expect(notices.filter(n => n.text.includes("8192-token context window"))).toHaveLength(1);
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
