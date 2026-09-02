import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ChatStorage, CHATS_DIR, isValidAttachment, isValidChatId } from "../src/chat/storage.js";

let ws: string;
let chatsRoot: string;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), "llh-storage-"));
  chatsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llh-chats-"));
});

afterEach(async () => {
  await fs.rm(ws, { recursive: true, force: true });
  await fs.rm(chatsRoot, { recursive: true, force: true });
});

describe("ChatStorage", () => {
  it("imports validated images as chat-owned assets without embedding bytes in the record", async () => {
    const storage = new ChatStorage(ws, chatsRoot);
    const rec = storage.newRecord("compat-muse-glimmer");
    const source = path.join(ws, "screen.png");
    await fs.writeFile(source, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));

    const attachment = await storage.importAttachment(rec.id, source);
    expect(attachment).toMatchObject({ fileName: "screen.png", mimeType: "image/png", extension: "png", byteLength: 11 });
    expect(isValidAttachment(attachment)).toBe(true);
    await expect(storage.attachmentDataUrl(rec.id, attachment)).resolves.toBe("data:image/png;base64,iVBORw0KGgoBAgM=");

    rec.messages.push({ role: "user", content: "describe", attachments: [attachment], ts: 1 });
    await storage.save(rec);
    const raw = await fs.readFile(path.join(chatsRoot, `${rec.id}.json`), "utf8");
    expect(raw).toContain("screen.png");
    expect(raw).not.toContain("iVBORw0KGgo");
  });

  it("rejects unsupported, oversized, and extension-mismatched attachments", async () => {
    const storage = new ChatStorage(ws, chatsRoot);
    const rec = storage.newRecord("native");
    const wrong = path.join(ws, "fake.jpg");
    await fs.writeFile(wrong, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await expect(storage.importAttachment(rec.id, wrong)).rejects.toThrow("do not match");

    const unsupported = path.join(ws, "image.gif");
    await fs.writeFile(unsupported, "GIF89a");
    await expect(storage.importAttachment(rec.id, unsupported)).rejects.toThrow("JPEG, PNG, or WebP");

    const oversized = path.join(ws, "large.png");
    await fs.writeFile(oversized, Buffer.alloc((10 * 1024 * 1024) + 1, 0));
    await expect(storage.importAttachment(rec.id, oversized)).rejects.toThrow("10 MiB");
  });

  it("imports validated clipboard image bytes into chat-owned storage", async () => {
    const storage = new ChatStorage(ws, chatsRoot);
    const rec = storage.newRecord("native");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4, 5, 6]);

    const attachment = await storage.importAttachmentBytes(rec.id, "pasted-image.png", bytes);

    expect(attachment).toMatchObject({
      fileName: "pasted-image.png",
      mimeType: "image/png",
      extension: "png",
      byteLength: bytes.byteLength
    });
    await expect(fs.readFile(storage.attachmentPath(rec.id, attachment))).resolves.toEqual(bytes);
    await expect(storage.importAttachmentBytes(rec.id, "pasted-image.jpg", bytes)).rejects.toThrow("do not match");
  });

  it("preserves multiple validated attachments when loading a chat", async () => {
    const storage = new ChatStorage(ws, chatsRoot);
    const rec = storage.newRecord("native");
    const first = await storage.importAttachmentBytes(
      rec.id,
      "first.png",
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
    );
    const second = await storage.importAttachmentBytes(
      rec.id,
      "second.jpg",
      Buffer.from([0xff, 0xd8, 0xff, 2])
    );
    rec.messages.push({ role: "user", content: "compare", attachments: [first, second], ts: 1 });
    await storage.save(rec);

    const loaded = await storage.load(rec.id);

    expect(loaded?.messages[0].attachments).toEqual([first, second]);
  });

  it("copies attachment assets on fork and removes them with their chats", async () => {
    const storage = new ChatStorage(ws, chatsRoot);
    const rec = storage.newRecord("native");
    const source = path.join(ws, "photo.jpg");
    await fs.writeFile(source, Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]));
    const attachment = await storage.importAttachment(rec.id, source);
    rec.messages.push({ role: "user", content: "look", attachments: [attachment], ts: 1 });
    await storage.save(rec);

    const forked = await storage.fork(rec);
    await expect(fs.readFile(storage.attachmentPath(forked.id, attachment))).resolves.toEqual(Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]));
    await storage.delete(rec.id);
    await expect(fs.stat(storage.attachmentPath(rec.id, attachment))).rejects.toThrow();
    await expect(fs.readFile(storage.attachmentPath(forked.id, attachment))).resolves.toBeDefined();
  });

  it("rejects chat ids that could escape the chat directory", async () => {
    const storage = new ChatStorage(ws, chatsRoot);
    await fs.writeFile(path.join(chatsRoot, "outside.json"), "{\"id\":\"outside\"}");

    await expect(storage.load("../outside")).resolves.toBeUndefined();
    await storage.delete("../outside");

    await expect(fs.readFile(path.join(chatsRoot, "outside.json"), "utf-8")).resolves.toContain("outside");
    expect(isValidChatId("../outside")).toBe(false);
  });

  it("lists only uuid-named chats for the active workspace and uses the filename as the id", async () => {
    const storage = new ChatStorage(ws, chatsRoot);
    const dir = chatsRoot;
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const otherId = "123e4567-e89b-42d3-a456-426614174001";
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify({
      id: "../../evil",
      workspaceRoot: ws,
      title: "Safe title",
      updatedAt: 10,
      messages: []
    }));
    await fs.writeFile(path.join(dir, `${otherId}.json`), JSON.stringify({
      id: otherId,
      workspaceRoot: path.join(os.tmpdir(), "other-workspace"),
      title: "Other title",
      updatedAt: 20,
      messages: []
    }));
    await fs.writeFile(path.join(dir, "not-a-chat.json"), "{}");

    await expect(storage.list()).resolves.toEqual([{ id, title: "Safe title", updatedAt: 10 }]);
    await expect(storage.load(id)).resolves.toMatchObject({ id, title: "Safe title", workspaceRoot: normalized(ws) });
    await expect(storage.load(otherId)).resolves.toBeUndefined();
  });

  it("deletes all chats for the active workspace without touching other workspaces", async () => {
    const storage = new ChatStorage(ws, chatsRoot);
    const first = storage.newRecord("compat-gemma4");
    const second = storage.newRecord("compat-gemma4");
    await storage.save(first);
    await storage.save(second);

    const otherWorkspace = path.join(os.tmpdir(), "llh-other-workspace");
    const otherStorage = new ChatStorage(otherWorkspace, chatsRoot);
    const other = otherStorage.newRecord("compat-gemma4");
    await otherStorage.save(other);

    await storage.deleteAll();

    await expect(storage.list()).resolves.toEqual([]);
    await expect(otherStorage.load(other.id)).resolves.toMatchObject({ id: other.id });
  });

  it("persists assistant file change summaries", async () => {
    const storage = new ChatStorage(ws, chatsRoot);
    const rec = storage.newRecord("compat-gemma4");
    rec.messages.push({
      role: "assistant",
      content: "Done.",
      ts: Date.now(),
      fileChanges: [
        {
          path: "src/app.ts",
          added: 2,
          removed: 1,
          diffPreview: "-\t1\t\told\n+\t\t1\tnew\n+\t\t2\tmore"
        }
      ]
    });

    await storage.save(rec);

    await expect(storage.load(rec.id)).resolves.toMatchObject({
      messages: [
        {
          role: "assistant",
          fileChanges: [
            {
              path: "src/app.ts",
              added: 2,
              removed: 1
            }
          ]
        }
      ]
    });
  });

  it("uses Default reasoning effort for new and legacy chats without a saved mode", async () => {
    const storage = new ChatStorage(ws, chatsRoot);
    expect(storage.newRecord("compat-gemma4").reasoningEffort).toBe("default");
    expect(storage.newRecord("compat-gemma4", "effort:high").reasoningEffort).toBe("effort:high");
    const id = "123e4567-e89b-42d3-a456-426614174003";
    await fs.writeFile(path.join(chatsRoot, `${id}.json`), JSON.stringify({
      id,
      workspaceRoot: ws,
      title: "Legacy chat",
      toolCallingMode: "compat-gemma4",
      planMode: false,
      messages: [],
      totalTokens: 0
    }));

    await expect(storage.load(id)).resolves.toMatchObject({ reasoningEffort: "default" });
  });

  it("migrates the previous thinking-mode names", async () => {
    const storage = new ChatStorage(ws, chatsRoot);
    const id = "123e4567-e89b-42d3-a456-426614174004";
    await fs.writeFile(path.join(chatsRoot, `${id}.json`), JSON.stringify({
      id,
      workspaceRoot: ws,
      title: "Development chat",
      toolCallingMode: "compat-gemma4",
      planMode: false,
      thinkingMode: "expert",
      messages: [],
      totalTokens: 0
    }));

    await expect(storage.load(id)).resolves.toMatchObject({ reasoningEffort: "effort:high" });
  });

  it("normalizes legacy family records into unified compatibility profiles", async () => {
    const storage = new ChatStorage(ws, chatsRoot);
    const id = "123e4567-e89b-42d3-a456-426614174005";
    await fs.writeFile(path.join(chatsRoot, `${id}.json`), JSON.stringify({
      id,
      workspaceRoot: ws,
      title: "Legacy Qwen chat",
      modelFamily: "qwen3",
      planMode: false,
      messages: [],
      totalTokens: 0
    }));

    const loaded = await storage.load(id);
    expect(loaded?.toolCallingMode).toBe("compat-qwen3");
    expect(loaded).not.toHaveProperty("modelFamily");
    if (loaded) await storage.save(loaded);
    await expect(fs.readFile(path.join(chatsRoot, `${id}.json`), "utf8"))
      .resolves.not.toContain("modelFamily");
  });

  it("forks a chat through the selected assistant response", async () => {
    const storage = new ChatStorage(ws, chatsRoot);
    const rec = storage.newRecord("compat-gemma4");
    rec.title = "Original title";
    rec.reasoningEffort = "effort:high";
    rec.messages = [
      { role: "user", content: "first", ts: 10, tokens: 1 },
      { role: "assistant", content: "first answer", ts: 11, tokens: 2 },
      { role: "user", content: "second", ts: 20, tokens: 1 },
      { role: "assistant", content: "second answer", ts: 21, tokens: 2 }
    ];

    const forked = await storage.fork(rec, 10);

    expect(forked.id).not.toBe(rec.id);
    expect(forked.title).toBe("Original title");
    expect(forked.reasoningEffort).toBe("effort:high");
    expect(forked.messages.map(message => message.content)).toEqual(["first", "first answer"]);
    expect(forked.totalTokens).toBe(3);
    await expect(storage.load(forked.id)).resolves.toMatchObject({
      messages: [{ content: "first" }, { content: "first answer" }]
    });
  });

  it("migrates legacy workspace chats into the shared chats directory", async () => {
    const storage = new ChatStorage(ws, chatsRoot);
    const legacyDir = path.join(ws, CHATS_DIR);
    const id = "123e4567-e89b-42d3-a456-426614174002";
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(path.join(legacyDir, `${id}.json`), JSON.stringify({
      id,
      title: "Legacy chat",
      updatedAt: 30,
      messages: []
    }));

    await expect(storage.list()).resolves.toEqual([{ id, title: "Legacy chat", updatedAt: 30 }]);
    await expect(fs.readFile(path.join(chatsRoot, `${id}.json`), "utf-8")).resolves.toContain("workspaceRoot");
    await expect(fs.stat(path.join(legacyDir, `${id}.json`))).rejects.toThrow();
  });
});

function normalized(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
