import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  ChatStorage,
  CHATS_DIR,
  isValidChatId,
  MAX_STORED_CHAT_BYTES,
  writeUtf8NoClobber
} from "../src/chat/storage.js";

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

  it("persists assistant file change summaries", async () => {
    const storage = new ChatStorage(ws, chatsRoot);
    const rec = storage.newRecord("gemma4");
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

  it("does not associate a linked workspace root with the target's chat history", async () => {
    const targetStorage = new ChatStorage(ws, chatsRoot);
    const record = targetStorage.newRecord("gemma4");
    record.title = "Target-only chat";
    await targetStorage.save(record);

    const linked = `${ws}-linked`;
    await fs.symlink(ws, linked, process.platform === "win32" ? "junction" : "dir");
    try {
      const linkedStorage = new ChatStorage(linked, chatsRoot);
      await expect(linkedStorage.list()).resolves.toEqual([]);
    } finally {
      await fs.unlink(linked).catch(() => undefined);
    }
  });

  it("atomically replaces records without leaving temporary files", async () => {
    const storage = new ChatStorage(ws, chatsRoot);
    const rec = storage.newRecord("gemma4");
    rec.title = "First";
    await storage.save(rec);
    rec.title = "Second";
    await storage.save(rec);

    await expect(storage.load(rec.id)).resolves.toMatchObject({ title: "Second" });
    await expect(fs.readdir(chatsRoot)).resolves.toEqual([`${rec.id}.json`]);
  });

  it("recovers an identical no-clobber publication after a transient sync failure", async () => {
    const destination = path.join(chatsRoot, "durability-retry.json");
    const contents = "durable contents";
    let syncAttempts = 0;
    const sync = async (): Promise<boolean> => ++syncAttempts > 1;

    await expect(writeUtf8NoClobber(destination, contents, sync)).resolves.toBe(false);
    await expect(fs.readFile(destination, "utf8")).resolves.toBe(contents);
    await expect(writeUtf8NoClobber(destination, contents, sync)).resolves.toBe(true);
    expect(syncAttempts).toBe(2);
    await expect(fs.readdir(chatsRoot)).resolves.toEqual(["durability-retry.json"]);
  });

  it("rejects an oversized stored record before reading its contents", async () => {
    const storage = new ChatStorage(ws, chatsRoot);
    const id = "123e4567-e89b-42d3-a456-426614174003";
    const file = path.join(chatsRoot, `${id}.json`);
    await fs.writeFile(file, "");
    await fs.truncate(file, MAX_STORED_CHAT_BYTES + 1);

    await expect(storage.load(id)).resolves.toBeUndefined();
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

  it("never overwrites a global chat when a legacy migration id conflicts", async () => {
    const storage = new ChatStorage(ws, chatsRoot);
    const legacyDir = path.join(ws, CHATS_DIR);
    const id = "123e4567-e89b-42d3-a456-426614174004";
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(path.join(chatsRoot, `${id}.json`), JSON.stringify({
      id,
      workspaceRoot: ws,
      title: "Existing global chat",
      updatedAt: 40,
      messages: []
    }));
    const legacyFile = path.join(legacyDir, `${id}.json`);
    await fs.writeFile(legacyFile, JSON.stringify({
      id,
      title: "Conflicting legacy chat",
      updatedAt: 50,
      messages: []
    }));

    await expect(storage.list()).resolves.toEqual([{
      id,
      title: "Existing global chat",
      updatedAt: 40
    }]);
    await expect(fs.readFile(legacyFile, "utf8")).resolves.toContain("Conflicting legacy chat");
  });

  it("does not follow a linked legacy chat directory", async () => {
    const storage = new ChatStorage(ws, chatsRoot);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "llh-legacy-outside-"));
    const legacyLink = path.join(ws, CHATS_DIR);
    const id = "123e4567-e89b-42d3-a456-426614174005";
    const outsideFile = path.join(outside, `${id}.json`);
    await fs.writeFile(outsideFile, JSON.stringify({
      id,
      title: "Outside chat",
      updatedAt: 60,
      messages: []
    }));
    await fs.symlink(outside, legacyLink, process.platform === "win32" ? "junction" : "dir");
    try {
      await expect(storage.list()).resolves.toEqual([]);
      await expect(fs.readFile(outsideFile, "utf8")).resolves.toContain("Outside chat");
      await expect(fs.stat(path.join(chatsRoot, `${id}.json`))).rejects.toThrow();
    } finally {
      await fs.rm(legacyLink, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("does not migrate or delete a hardlinked legacy chat file", async () => {
    const storage = new ChatStorage(ws, chatsRoot);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "llh-legacy-hardlink-"));
    const legacyDir = path.join(ws, CHATS_DIR);
    const id = "123e4567-e89b-42d3-a456-426614174006";
    const outsideFile = path.join(outside, `${id}.json`);
    await fs.mkdir(legacyDir);
    await fs.writeFile(outsideFile, JSON.stringify({
      id,
      title: "Hardlinked chat",
      updatedAt: 70,
      messages: []
    }));
    const legacyFile = path.join(legacyDir, `${id}.json`);
    await fs.link(outsideFile, legacyFile);
    try {
      await expect(storage.list()).resolves.toEqual([]);
      await expect(fs.readFile(outsideFile, "utf8")).resolves.toContain("Hardlinked chat");
      await expect(fs.readFile(legacyFile, "utf8")).resolves.toContain("Hardlinked chat");
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

function normalized(p: string): string {
  return path.resolve(p);
}
