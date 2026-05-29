import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ChatStorage, CHATS_DIR, isValidChatId } from "../src/chat/storage.js";

let ws: string;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), "llh-storage-"));
});

afterEach(async () => {
  await fs.rm(ws, { recursive: true, force: true });
});

describe("ChatStorage", () => {
  it("rejects chat ids that could escape the chat directory", async () => {
    const storage = new ChatStorage(ws);
    await fs.writeFile(path.join(ws, "outside.json"), "{\"id\":\"outside\"}");

    await expect(storage.load("../outside")).resolves.toBeUndefined();
    await storage.delete("../outside");

    await expect(fs.readFile(path.join(ws, "outside.json"), "utf-8")).resolves.toContain("outside");
    expect(isValidChatId("../outside")).toBe(false);
  });

  it("lists only uuid-named chat files and uses the filename as the id", async () => {
    const storage = new ChatStorage(ws);
    const dir = path.join(ws, CHATS_DIR);
    const id = "123e4567-e89b-42d3-a456-426614174000";
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify({
      id: "../../evil",
      title: "Safe title",
      updatedAt: 10
    }));
    await fs.writeFile(path.join(dir, "not-a-chat.json"), "{}");

    await expect(storage.list()).resolves.toEqual([{ id, title: "Safe title", updatedAt: 10 }]);
    await expect(storage.load(id)).resolves.toMatchObject({ id, title: "Safe title" });
  });
});
