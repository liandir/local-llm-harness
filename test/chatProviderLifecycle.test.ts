import { describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type { ChatRecord, ChatStorage } from "../src/chat/storage.js";
import type { UiEvent } from "../src/chat/session.js";

const mocks = vi.hoisted(() => ({
  sessions: [] as { cancel: ReturnType<typeof vi.fn>; emit: (event: UiEvent) => void }[]
}));
vi.mock("vscode", () => ({ commands: { executeCommand: vi.fn() } }));
vi.mock("../src/config/settings.js", () => ({ readSettings: () => ({ reasoningEfforts: {} }) }));
vi.mock("../src/chat/session.js", () => ({
  ChatSession: class {
    cancel = vi.fn();
    async shutdown() { this.cancel(); }
    constructor(private args: { record: ChatRecord; emit: (event: UiEvent) => void }) {
      mocks.sessions.push({ cancel: this.cancel, emit: args.emit });
    }
    getRecord() { return this.args.record; }
    emitLoaded() { this.args.emit({ kind: "chatLoaded", record: this.args.record }); }
  }
}));
import { ChatViewProvider } from "../src/ui/chatView/provider.js";

describe("chat provider lifecycle", () => {
  it("sends the full transcript and context count without duplicating model history in the webview", () => {
    const provider = new ChatViewProvider(
      {} as vscode.ExtensionContext, () => undefined, () => "/workspace",
      vi.fn(), vi.fn(), vi.fn(), vi.fn()
    );
    const postMessage = vi.fn();
    const state = provider as unknown as { view: { webview: { postMessage: typeof postMessage } } };
    state.view = { webview: { postMessage } };
    const record = {
      messages: [{ role: "user", content: "original prompt", ts: 1 }],
      contextMessages: [
        { role: "system", content: "model-only summary", ts: 2 },
        { role: "assistant", content: "recent response", ts: 3 }
      ]
    } as ChatRecord;
    provider.post({ kind: "chatLoaded", record });
    const payload = postMessage.mock.calls[0][0];
    expect(payload.contextMessageCount).toBe(2);
    expect(payload.record.messages[0].content).toBe("original prompt");
    expect(payload.record.contextMessages).toBeUndefined();
    expect(record.contextMessages).toHaveLength(2);
  });

  it("cancels the old session, clears queued messages, and ignores late events", async () => {
    const opened = vi.fn();
    const storage = { list: vi.fn().mockResolvedValue([]) } as unknown as ChatStorage;
    const provider = new ChatViewProvider(
      { workspaceState: { get: vi.fn() } } as unknown as vscode.ExtensionContext,
      () => storage, () => "/workspace", vi.fn(), opened, vi.fn(), vi.fn()
    );
    const post = vi.spyOn(provider, "post");
    const record = { id: "first", messages: [], reasoningEffort: "default" } as unknown as ChatRecord;
    provider.openChat(record);
    const old = mocks.sessions.at(-1)!;
    // Seed a queued follow-up while the old turn is active.
    const state = provider as unknown as { queuedMessages: { id: string; text: string }[] };
    state.queuedMessages.push({ id: "queued", text: "old workspace task" });
    await provider.closeAll();
    expect(old.cancel).toHaveBeenCalledOnce();
    expect(provider.getCurrentRecord()).toBeUndefined();
    expect(state.queuedMessages).toEqual([]);
    expect(post).toHaveBeenCalledWith({ kind: "chatClosed" });
    provider.openChat({ ...record, id: "second" });
    post.mockClear();
    opened.mockClear();
    old.emit({ kind: "chatLoaded", record });
    expect(post).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
    expect(provider.getCurrentRecord()?.id).toBe("second");
  });
});
