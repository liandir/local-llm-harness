import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ChatStorage, CHATS_DIR, isValidChatId } from "../src/chat/storage.js";

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
