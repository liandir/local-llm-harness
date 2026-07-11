import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ModelFamily } from "../llm/parser/index.js";
import {
  CHAT_SCHEMA_VERSION,
  isValidChatId,
  normalizeStoredChatRecord,
  parseChatRecord,
  type ChatRecord
} from "./model.js";

export const CHATS_DIR = ".local-llm-chats";
/** Maximum UTF-8 bytes accepted from or written to one persisted chat file. */
export const MAX_STORED_CHAT_BYTES = 32 * 1024 * 1024;

export {
  CHAT_SCHEMA_VERSION,
  isValidChatId,
  migrateLegacyChatRecord,
  normalizeStoredChatRecord,
  parseChatRecord
} from "./model.js";
export type { ChatMessage, ChatRecord, Role, StoredParserEvent } from "./model.js";
export type { FileChangeSummary } from "./fileChanges.js";
export type { TodoItem } from "./todos.js";

export class ChatStorage {
  private migrated = false;

  constructor(
    private workspaceRoot: string,
    private storageRoot = path.join(os.homedir(), CHATS_DIR)
  ) {
    this.workspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
  }

  private dir(): string {
    return this.storageRoot;
  }

  async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir(), { recursive: true });
    await this.migrateWorkspaceChats();
  }

  async list(): Promise<{ id: string; title: string; updatedAt: number }[]> {
    try {
      await this.ensureDir();
      const entries = await fs.readdir(this.dir());
      const out: { id: string; title: string; updatedAt: number }[] = [];
      for (const e of entries) {
        if (!e.endsWith(".json")) continue;
        const id = e.slice(0, -5);
        if (!isValidChatId(id)) continue;
        try {
          const raw = await readUtf8FileBounded(path.join(this.dir(), e));
          const rec = this.decode(raw, id);
          if (!rec) continue;
          if (!this.belongsToWorkspace(rec)) continue;
          out.push({ id, title: rec.title, updatedAt: rec.updatedAt });
        } catch { /* skip malformed */ }
      }
      return out.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      return [];
    }
  }

  async load(id: string): Promise<ChatRecord | undefined> {
    if (!isValidChatId(id)) return undefined;
    try {
      await this.ensureDir();
      const raw = await readUtf8FileBounded(path.join(this.dir(), id + ".json"));
      const rec = this.decode(raw, id);
      if (!rec) return undefined;
      return this.belongsToWorkspace(rec) ? rec : undefined;
    } catch {
      return undefined;
    }
  }

  async save(rec: ChatRecord): Promise<void> {
    if (!isValidChatId(rec.id)) {
      throw new Error(`Invalid chat id: ${rec.id}`);
    }
    await this.ensureDir();
    rec.workspaceRoot = this.workspaceRoot;
    rec.updatedAt = Date.now();
    rec.schemaVersion = CHAT_SCHEMA_VERSION;
    const validated = parseChatRecord(rec);
    if (!validated) {
      throw new Error("Refusing to persist an invalid chat record");
    }
    await writeUtf8Atomically(
      path.join(this.dir(), rec.id + ".json"),
      encodeStoredRecord(validated)
    );
  }

  async delete(id: string): Promise<void> {
    if (!isValidChatId(id)) return;
    try {
      const rec = await this.load(id);
      if (!rec) return;
      await fs.unlink(path.join(this.dir(), id + ".json"));
    } catch { /* ignore */ }
  }

  /** Delete every chat record on disk that has zero messages. */
  async deleteEmpty(exceptId?: string): Promise<void> {
    await this.ensureDir();
    let entries: string[];
    try { entries = await fs.readdir(this.dir()); } catch { return; }
    for (const e of entries) {
      if (!e.endsWith(".json")) continue;
      const id = e.slice(0, -5);
      if (!isValidChatId(id)) continue;
      if (exceptId && id === exceptId) continue;
      try {
        const raw = await readUtf8FileBounded(path.join(this.dir(), e));
        const rec = this.decode(raw, id);
        if (!rec) continue;
        if (this.belongsToWorkspace(rec) && rec.messages.length === 0) {
          await fs.unlink(path.join(this.dir(), e));
        }
      } catch { /* skip */ }
    }
  }

  newRecord(modelFamily: ModelFamily): ChatRecord {
    const now = Date.now();
    return {
      schemaVersion: CHAT_SCHEMA_VERSION,
      id: randomUUID(),
      workspaceRoot: this.workspaceRoot,
      createdAt: now,
      updatedAt: now,
      title: "New chat",
      modelFamily,
      planMode: false,
      messages: [],
      totalTokens: 0
    };
  }

  private belongsToWorkspace(rec: ChatRecord): boolean {
    return normalizeWorkspaceRoot(rec.workspaceRoot ?? "") === this.workspaceRoot;
  }

  private decode(raw: string, id: string): ChatRecord | undefined {
    const rec = normalizeStoredChatRecord(JSON.parse(raw) as unknown, { id });
    if (!rec) return undefined;
    rec.workspaceRoot = normalizeWorkspaceRoot(rec.workspaceRoot);
    return rec;
  }

  private async migrateWorkspaceChats(): Promise<void> {
    if (this.migrated) return;
    this.migrated = true;
    const legacyDir = path.join(this.workspaceRoot, CHATS_DIR);
    if (samePath(legacyDir, this.dir())) return;

    let entries: string[];
    try { entries = await fs.readdir(legacyDir); } catch { return; }
    for (const e of entries) {
      if (!e.endsWith(".json")) continue;
      const id = e.slice(0, -5);
      if (!isValidChatId(id)) continue;
      const src = path.join(legacyDir, e);
      const dest = path.join(this.dir(), e);
      try {
        const raw = await readUtf8FileBounded(src);
        const migrated = normalizeStoredChatRecord(JSON.parse(raw) as unknown, {
          id,
          workspaceRoot: this.workspaceRoot
        });
        if (!migrated) continue;
        // Never replace a global chat which already owns this UUID. Linking a
        // fully written same-directory temp file publishes the migration in
        // one no-clobber filesystem operation.
        const created = await writeUtf8NoClobber(dest, encodeStoredRecord(migrated));
        if (!created) continue;
        await fs.unlink(src);
      } catch { /* leave problematic legacy files untouched */ }
    }
    try { await fs.rmdir(legacyDir); } catch { /* ignore non-empty legacy dirs */ }
  }
}

export function titleFromFirstMessage(s: string): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length <= 60 ? oneLine : oneLine.slice(0, 57) + "...";
}

function normalizeWorkspaceRoot(root: string): string {
  if (!root.trim()) return "";
  const resolved = path.resolve(root);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(a: string, b: string): boolean {
  return normalizeWorkspaceRoot(a) === normalizeWorkspaceRoot(b);
}

async function readUtf8FileBounded(file: string): Promise<string> {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_STORED_CHAT_BYTES) {
      throw new Error(`Stored chat exceeds the ${MAX_STORED_CHAT_BYTES}-byte limit`);
    }

    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= MAX_STORED_CHAT_BYTES) {
      const remaining = MAX_STORED_CHAT_BYTES + 1 - total;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > MAX_STORED_CHAT_BYTES) {
      throw new Error(`Stored chat exceeds the ${MAX_STORED_CHAT_BYTES}-byte limit`);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
  } finally {
    await handle.close();
  }
}

function encodeStoredRecord(record: ChatRecord): string {
  const encoded = JSON.stringify(record, null, 2);
  if (Buffer.byteLength(encoded, "utf8") > MAX_STORED_CHAT_BYTES) {
    throw new Error(`Refusing to persist a chat larger than ${MAX_STORED_CHAT_BYTES} bytes`);
  }
  return encoded;
}

async function writeUtf8Atomically(destination: string, contents: string): Promise<void> {
  const temporary = await writeDurableTemp(destination, contents);
  try {
    await fs.rename(temporary, destination);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

async function writeUtf8NoClobber(destination: string, contents: string): Promise<boolean> {
  const temporary = await writeDurableTemp(destination, contents);
  try {
    await fs.link(temporary, destination);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) return false;
    throw error;
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

async function writeDurableTemp(destination: string, contents: string): Promise<string> {
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${randomUUID()}.tmp`
  );
  let complete = false;
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    complete = true;
    return temporary;
  } finally {
    if (!complete) await fs.unlink(temporary).catch(() => undefined);
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === code;
}
