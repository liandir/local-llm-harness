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
    safeCommands: []
  },
  streamChat: vi.fn(),
  tokenize: vi.fn(),
  complete: vi.fn()
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
  complete: mocks.complete
}));

beforeEach(() => {
  mocks.streamChat.mockReset();
  mocks.tokenize.mockReset();
  mocks.complete.mockReset();
  mocks.tokenize.mockResolvedValue(1);
  mocks.settings.autoapproveWrites = false;
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

  it("ignores a malformed (blank-name) tool call instead of aborting the turn", async () => {
    // A qwen3 <tool_call> block whose body isn't valid JSON parses to an empty
    // name; the turn should still finish with the visible answer.
    mocks.settings.modelFamily = "qwen3";
    mocks.streamChat.mockImplementation(async function* (): AsyncGenerator<{ kind: "text"; text: string }, void, void> {
      yield { kind: "text", text: "Here is my review.<tool_call>not valid json</tool_call>" };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record: newRecord(),
      emit: e => events.push(e)
    });

    await session.sendUserMessage("review");

    expect(events.some(e => e.kind === "abort")).toBe(false);
    const answer = events
      .filter((e): e is Extract<UiEvent, { kind: "text" }> => e.kind === "text")
      .map(e => e.delta)
      .join("");
    expect(answer).toContain("Here is my review.");
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
