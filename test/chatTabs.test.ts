import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type { ChatRecord, ChatStorage } from "../src/chat/storage.js";
import type { UiEvent } from "../src/chat/session.js";
import type { ChatToExt, ExtToChat } from "../src/ui/messaging.js";

const mocks = vi.hoisted(() => ({ sessions: new Map<string, FakeSession>(), input: vi.fn(), picker: vi.fn() }));
vi.mock("vscode", () => ({
  commands: { executeCommand: vi.fn() },
  window: { showInputBox: mocks.input, showOpenDialog: mocks.picker },
  Uri: { file: (path: string) => path }
}));
vi.mock("../src/config/settings.js", () => ({ readSettings: () => ({ reasoningEfforts: {} }) }));
interface FakeSession {
  emit(event: UiEvent): void;
  cancel: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
  sent: string[];
  finish(): void;
  renameTitle: ReturnType<typeof vi.fn>;
}
vi.mock("../src/chat/session.js", () => ({
  ChatSession: class implements FakeSession {
    sent: string[] = [];
    private finishTurn?: () => void;
    private active = false;
    emit: (event: UiEvent) => void;
    cancel = vi.fn(() => this.finish());
    shutdown = vi.fn(async () => { this.cancel(); });
    renameTitle = vi.fn(async (title: string) => { this.args.record.title = title; });
    constructor(private args: { record: ChatRecord; emit: (event: UiEvent) => void }) {
      this.emit = args.emit;
      mocks.sessions.set(args.record.id, this);
    }
    getRecord() { return this.args.record; }
    emitLoaded() { this.emit({ kind: "chatLoaded", record: this.args.record }); }
    refreshMemoryVisibility() {}
    isTurnActive() { return this.active; }
    async sendUserMessage(text: string) {
      this.active = true;
      this.sent.push(text);
      this.emit({ kind: "turnPreparing", reason: "server" });
      await new Promise<void>(resolve => { this.finishTurn = resolve; });
      this.active = false;
      this.emit({ kind: "turnEnd", messageId: this.args.record.id });
    }
    finish() { this.finishTurn?.(); }
  }
}));
import { ChatViewProvider } from "../src/ui/chatView/provider.js";

const record = (id: string) => ({ id, title: id, messages: [], reasoningEffort: "default", mode: "act" } as unknown as ChatRecord);
function setup() {
  const storage = { list: vi.fn().mockResolvedValue([]), load: vi.fn(), save: vi.fn(), delete: vi.fn(), deleteAll: vi.fn(), deleteAttachment: vi.fn(), importAttachment: vi.fn(), importAttachmentBytes: vi.fn(), attachmentPath: (id: string) => `/workspace/${id}/image.png` };
  const provider = new ChatViewProvider(
    { workspaceState: { get: vi.fn() } } as unknown as vscode.ExtensionContext,
    () => storage as unknown as ChatStorage, () => "/workspace", vi.fn(), vi.fn(), vi.fn(), vi.fn()
  );
  const posted: ExtToChat[] = [];
  (provider as unknown as { view: unknown }).view = { webview: { postMessage: (message: ExtToChat) => posted.push(message), asWebviewUri: (path: string) => path } };
  const send = (message: ChatToExt) => (provider as unknown as { onMessage(message: ChatToExt): Promise<void> }).onMessage(message);
  const snapshot = () => [...posted].reverse().find(message => "type" in message && message.type === "chatSnapshot") as Extract<ExtToChat, { type: "chatSnapshot" }>;
  return { provider, storage, posted, send, snapshot };
}
beforeEach(() => { mocks.sessions.clear(); vi.clearAllMocks(); });

describe("independent chat tabs", () => {
  it("reuses the current live session without reloading or cancelling it", async () => {
    const { provider, posted } = setup();
    provider.openChat(record("a"));
    const a = mocks.sessions.get("a")!;
    a.emit({ kind: "turnPreparing", reason: "server" });
    posted.length = 0;
    await provider.openChatById("a");
    provider.openChat(record("a"));
    expect(mocks.sessions.size).toBe(1);
    expect(a.cancel).not.toHaveBeenCalled();
    expect(posted.filter(message => !("type" in message && message.type === "recentChats"))).toEqual([]);
  });

  it("restores streamed text, approvals and accounting without leaking background events", async () => {
    const { provider, posted, snapshot } = setup();
    provider.openChat(record("a"));
    const a = mocks.sessions.get("a")!;
    a.emit({ kind: "turnPreparing", reason: "server" });
    a.emit({ kind: "text", messageId: "response", delta: "hello" });
    provider.openChat(record("b"));
    posted.length = 0;
    a.emit({ kind: "text", messageId: "response", delta: " world" });
    a.emit({ kind: "toolCallProposed", toolId: "approval-a", messageId: "response", toolName: "write_file", argsJson: "{}", category: "write", approvalRequired: true });
    a.emit({ kind: "tokens", total: 123, limit: 4096 });
    expect(posted).toEqual([]);
    await provider.openChatById("a");
    expect(snapshot().busy).toBe(true);
    expect(snapshot().events).toContainEqual({ kind: "text", messageId: "response", delta: "hello world" });
    expect(snapshot().events).toContainEqual(expect.objectContaining({ kind: "toolCallProposed", toolId: "approval-a" }));
    expect(snapshot().events).toContainEqual({ kind: "tokens", total: 123, limit: 4096 });
    expect(a.cancel).not.toHaveBeenCalled();
  });

  it("runs and drains each queue independently and cancels only the visible chat", async () => {
    const { provider, send } = setup();
    provider.openChat(record("a"));
    const first = send({ type: "send", text: "A", chatId: "a" });
    await send({ type: "queueMessage", id: "qa", text: "A follow-up", chatId: "a" });
    provider.openChat(record("b"));
    const second = send({ type: "send", text: "B", chatId: "b" });
    const a = mocks.sessions.get("a")!, b = mocks.sessions.get("b")!;
    expect(provider.getTabs().filter(tab => tab.running)).toHaveLength(2);
    a.finish();
    await vi.waitFor(() => expect(a.sent).toEqual(["A", "A follow-up"]));
    expect(b.sent).toEqual(["B"]);
    await send({ type: "cancel", chatId: "b" });
    await second;
    expect(a.cancel).not.toHaveBeenCalled();
    expect(b.cancel).toHaveBeenCalledOnce();
    expect(provider.getTabs().find(tab => tab.id === "a")?.running).toBe(true);
    a.finish();
    await first;
    expect(provider.getTabs().some(tab => tab.running)).toBe(false);
  });

  it("keeps a closed tab running, retains its draft, and reopens the same session", async () => {
    const { provider, send, snapshot } = setup();
    provider.openChat(record("a"));
    const turn = send({ type: "send", text: "work" });
    await send({ type: "saveDraft", text: "next request", chatId: "a" });
    provider.closeTab("a");
    expect(provider.getCurrentRecord()).toBeUndefined();
    expect(provider.getTabs()).toContainEqual({ id: "a", title: "a", running: true, open: false });
    await provider.openChatById("a");
    expect(snapshot().draft).toBe("next request");
    const a = mocks.sessions.get("a")!;
    expect(a.cancel).not.toHaveBeenCalled();
    a.finish(); await turn;
  });

  it("rejects late actions addressed to the previous chat and restores drafts after ready", async () => {
    const { provider, send, snapshot } = setup();
    provider.openChat(record("a"));
    provider.openChat(record("b"));
    await send({ type: "cancel", chatId: "a" });
    await send({ type: "send", text: "wrong chat", chatId: "a" });
    await send({ type: "saveDraft", text: "draft A", chatId: "a" });
    expect(mocks.sessions.get("b")!.sent).toEqual([]);
    expect(mocks.sessions.get("b")!.cancel).not.toHaveBeenCalled();
    await provider.openChatById("a");
    await send({ type: "ready" });
    expect(snapshot().draft).toBe("draft A");
  });

  it("sanitizes transcript snapshots just like initial loads", async () => {
    const { provider, snapshot } = setup();
    provider.openChat({ ...record("a"), contextMessages: [{ role: "system", content: "private model context", ts: 1 }], memorySelection: [] });
    const event = snapshot().events.find(event => "kind" in event && event.kind === "chatLoaded") as Extract<UiEvent, { kind: "chatLoaded" }>;
    expect(event.record.contextMessages).toBeUndefined();
    expect(event.record.memorySelection).toBeUndefined();
    expect(event.contextMessageCount).toBe(1);
  });

  it("renames a live background chat through its session without changing the active chat", async () => {
    const { provider, snapshot } = setup();
    provider.openChat(record("a"));
    provider.openChat(record("b"));
    await provider.renameChat("a", "Renamed A");
    expect(mocks.sessions.get("a")!.renameTitle).toHaveBeenCalledWith("Renamed A");
    expect(provider.getCurrentRecord()?.id).toBe("b");
    await provider.openChatById("a");
    expect(snapshot().events).toContainEqual({ kind: "titleChanged", title: "Renamed A", animate: false });
  });

  it("waits for shutdown before deletion and ignores late events", async () => {
    const { provider, posted } = setup();
    provider.openChat(record("a"));
    const a = mocks.sessions.get("a")!;
    let finish!: () => void;
    a.shutdown.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const removed = provider.removeChat("a");
    let done = false;
    void removed.then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    posted.length = 0;
    a.emit({ kind: "text", messageId: "late", delta: "late" });
    expect(posted).toEqual([]);
    finish(); await removed;
    expect(provider.getTabs()).toEqual([]);
  });

  it("shuts down all workspace sessions, including closed running tabs", async () => {
    const { provider } = setup();
    provider.openChat(record("a"));
    mocks.sessions.get("a")!.emit({ kind: "turnPreparing", reason: "server" });
    provider.closeTab("a");
    provider.openChat(record("b"));
    await provider.closeAll();
    for (const session of mocks.sessions.values()) expect(session.shutdown).toHaveBeenCalledOnce();
    expect(provider.getCurrentRecord()).toBeUndefined();
    expect(provider.getTabs()).toEqual([]);
  });

  it("imports pasted text without a suffix and completes a pasted file batch", async () => {
    const { provider, storage, send, posted } = setup();
    provider.openChat(record("a"));
    storage.importAttachmentBytes.mockImplementation(async (_chatId, fileName, bytes) => ({
      id: fileName, fileName, byteLength: bytes.length, mimeType: "text/plain", extension: "txt"
    }));
    await send({ type: "pasteText", chatId: "a", text: "a".repeat(10000) });
    expect(storage.importAttachmentBytes).toHaveBeenCalledWith("a", "Pasted text", Buffer.from("a".repeat(10000)));
    posted.length = 0;
    await send({ type: "pasteAttachments", chatId: "a", files: [
      { fileName: "main.ts", dataUrl: "data:video/mp2t;base64,Y29kZQ==" },
      { fileName: "notes.md", dataUrl: "data:text/markdown;base64,bm90ZXM=" }
    ] });
    expect(storage.importAttachmentBytes).toHaveBeenCalledWith("a", "main.ts", Buffer.from("code"));
    expect(storage.importAttachmentBytes).toHaveBeenCalledWith("a", "notes.md", Buffer.from("notes"));
    expect(posted.filter(m => "type" in m && m.type === "attachmentSelected")).toHaveLength(2);
    expect(posted.at(-1)).toEqual({ type: "attachmentImportState", pending: false });
  });

  it("rejects oversized text and malformed pasted data before importing files", async () => {
    const { provider, storage, send, posted } = setup();
    provider.openChat(record("a"));
    await send({ type: "pasteText", text: "a".repeat(1024 * 1024 + 1) });
    expect(posted).toContainEqual(expect.objectContaining({ type: "attachmentPasteFailed", error: expect.stringContaining("1 MiB") }));
    await send({ type: "pasteAttachments", files: [{ fileName: "file.txt", dataUrl: "data:text/plain;base64,%%%=" }] });
    expect(storage.importAttachmentBytes).not.toHaveBeenCalled();
    expect(posted.at(-1)).toEqual({ type: "attachmentImportState", pending: false });
  });

  it("keeps an attachment picker tied to its source chat after switching tabs", async () => {
    const { provider, storage, send, posted } = setup();
    provider.openChat(record("a"));
    let pick!: (uris: { fsPath: string }[]) => void;
    mocks.picker.mockReturnValue(new Promise(resolve => { pick = resolve; }));
    storage.importAttachment.mockResolvedValue({ id: "image", fileName: "image.png", mimeType: "image/png" });
    const attaching = send({ type: "selectAttachment", chatId: "a" });
    provider.openChat(record("b"));
    posted.length = 0;
    pick([{ fsPath: "/tmp/image.png" }]); await attaching;
    expect(storage.importAttachment).toHaveBeenCalledWith("a", "/tmp/image.png");
    expect(posted.some(message => "type" in message && message.type === "attachmentSelected")).toBe(false);
    await provider.openChatById("a");
    expect(posted).toContainEqual(expect.objectContaining({ type: "attachmentSelected", attachment: expect.objectContaining({ id: "image", previewUri: "/workspace/a/image.png" }) }));
  });

  it("blocks reopening a source until its pending deletion finishes", async () => {
    const { provider, storage } = setup();
    provider.openChat(record("a"));
    let finish!: () => void;
    storage.delete.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    const deletion = provider.removeChat("a");
    await vi.waitFor(() => expect(storage.delete).toHaveBeenCalledWith("a"));
    await provider.openChatById("a");
    expect(storage.load).not.toHaveBeenCalled();
    expect(provider.getCurrentRecord()).toBeUndefined();
    finish(); await deletion;
  });

  it("prevents new sessions from racing a workspace-wide deletion", async () => {
    const { provider, storage } = setup();
    provider.openChat(record("a"));
    let finish!: () => void;
    storage.deleteAll.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    const deletion = provider.clearChats();
    await vi.waitFor(() => expect(storage.deleteAll).toHaveBeenCalled());
    provider.openChat(record("b"));
    expect(provider.getCurrentRecord()).toBeUndefined();
    expect(provider.isClearingWorkspace()).toBe(true);
    finish(); await deletion;
    expect(provider.isClearingWorkspace()).toBe(false);
  });

  it("accepts rapid navigation even when the second click carries the previous chat ID", async () => {
    const { provider, send } = setup();
    provider.openChat(record("a"));
    provider.openChat(record("b"));
    provider.openChat(record("c"));
    await provider.openChatById("a");
    await send({ type: "openChat", id: "b", chatId: "a" });
    await send({ type: "openChat", id: "c", chatId: "a" });
    expect(provider.getCurrentRecord()?.id).toBe("c");
  });

  it("does not activate a slow earlier open request after a newer selection", async () => {
    const { provider, storage } = setup();
    let load!: (record: ChatRecord) => void;
    storage.load.mockReturnValue(new Promise<ChatRecord>(resolve => { load = resolve; }));
    const slow = provider.openChatById("a");
    provider.openChat(record("b"));
    load(record("a")); await slow;
    expect(provider.getCurrentRecord()?.id).toBe("b");
  });
});
