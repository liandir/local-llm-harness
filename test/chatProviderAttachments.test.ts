import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type * as vscode from "vscode";
import type { ChatAttachment, ChatRecord, ChatStorage } from "../src/chat/storage.js";
import type { UiEvent } from "../src/chat/session.js";
import type { ChatToExt } from "../src/ui/messaging.js";

vi.mock("vscode", () => ({ commands: { executeCommand: vi.fn() } }));
vi.mock("../src/config/settings.js", () => ({ readSettings: () => ({ reasoningEfforts: {} }) }));
vi.mock("../src/chat/session.js", () => ({
  ChatSession: class {
    constructor(private args: { record: ChatRecord; emit: (event: UiEvent) => void }) {}
    getRecord() { return this.args.record; }
    emitLoaded() { this.args.emit({ kind: "chatLoaded", record: this.args.record }); }
  }
}));
import { ChatViewProvider } from "../src/ui/chatView/provider.js";

const attachment: ChatAttachment = {
  id: "attached-source", fileName: "source.ts", mimeType: "text/plain", extension: "ts", fileType: "ts", byteLength: 20
};
const record = (id: string, attachments?: ChatAttachment[]) => ({
  id, title: "Attachments", reasoningEffort: "default", messages: [{ role: "user", content: "Review this", ts: 1, attachments }]
}) as ChatRecord;

describe("attachment text previews", () => {
  const attachmentText = vi.fn();
  let provider: ChatViewProvider;
  let post: MockInstance<ChatViewProvider["post"]>;
  const send = (message: ChatToExt) =>
    (provider as unknown as { onMessage(message: ChatToExt): Promise<void> }).onMessage(message);
  const request = (attachmentId = attachment.id, chatId = "first") =>
    send({ type: "requestAttachmentText", attachmentId, chatId, requestId: 7 });

  beforeEach(() => {
    attachmentText.mockReset().mockResolvedValue('const text = "<script>";\n');
    const storage = { attachmentText, list: vi.fn().mockResolvedValue([]) } as unknown as ChatStorage;
    provider = new ChatViewProvider(
      { workspaceState: { get: vi.fn() } } as unknown as vscode.ExtensionContext,
      () => storage, () => "/workspace", vi.fn(), vi.fn(), vi.fn(), vi.fn()
    );
    post = vi.spyOn(provider, "post");
    provider.openChat(record("first"));
    post.mockClear();
  });

  it.each(["draft", "queued", "history"])("previews a %s attachment using its stored contents", async location => {
    if (location === "history") provider.getCurrentRecord()!.messages[0].attachments = [attachment];
    else {
      const runtime = (provider as unknown as { active: {
        pendingAttachments: Map<string, ChatAttachment>;
        queuedMessages: { id: string; text: string; attachments: ChatAttachment[] }[];
      } }).active;
      if (location === "draft") runtime.pendingAttachments.set(attachment.id, attachment);
      else runtime.queuedMessages.push({ id: "queued", text: "Next", attachments: [attachment] });
    }
    await request();
    expect(attachmentText).toHaveBeenCalledWith("first", attachment);
    expect(post).toHaveBeenCalledWith({
      type: "attachmentText", attachmentId: attachment.id, requestId: 7, text: 'const text = "<script>";\n', error: undefined
    });
  });

  it("does not read attachment IDs absent from the active chat", async () => {
    await request("../../other-chat/secret");
    expect(attachmentText).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith(expect.objectContaining({
      type: "attachmentText", requestId: 7, error: "Attachment is no longer available."
    }));
  });

  it("rejects requests from an inactive chat", async () => {
    provider.getCurrentRecord()!.messages[0].attachments = [attachment];
    await request(attachment.id, "other");
    expect(attachmentText).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "attachmentText" }));
  });

  it("reports read failures to the preview", async () => {
    provider.getCurrentRecord()!.messages[0].attachments = [attachment];
    attachmentText.mockRejectedValueOnce(new Error("File was removed."));
    await request();
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "attachmentText", requestId: 7, error: "File was removed." }));
  });

  it("discards a pending preview when the active chat changes", async () => {
    provider.getCurrentRecord()!.messages[0].attachments = [attachment];
    let finish!: (text: string) => void;
    attachmentText.mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve; }));
    const pending = request();
    provider.openChat(record("second"));
    post.mockClear();
    finish("Old chat contents");
    await pending;
    expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "attachmentText" }));
  });
});
