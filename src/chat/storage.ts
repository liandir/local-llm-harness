import * as fs from "node:fs/promises";
import { lstatSync, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ModelFamily } from "../llm/parser/index.js";
import { migrateLegacyWorkspaceChats as migrateGuardedLegacyWorkspaceChats } from "../security/workspace/legacyChatMigration.js";
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

    try {
      await migrateGuardedLegacyWorkspaceChats({
        workspaceRoot: this.workspaceRoot,
        maxRecordBytes: MAX_STORED_CHAT_BYTES,
        publish: async (id, raw) => {
          try {
            const dest = path.join(this.dir(), `${id}.json`);
            const migrated = normalizeStoredChatRecord(JSON.parse(raw) as unknown, {
              id,
              workspaceRoot: this.workspaceRoot
            });
            if (!migrated) return false;
            // Never replace a global chat which already owns this UUID.
            return writeUtf8NoClobber(dest, encodeStoredRecord(migrated));
          } catch {
            return false;
          }
        }
      });
    } catch {
      // A linked/replaced legacy directory is untrusted input. Leave it wholly
      // untouched and continue using extension-owned global chat storage.
    }
  }
}

export function titleFromFirstMessage(s: string): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length <= 60 ? oneLine : oneLine.slice(0, 57) + "...";
}

function normalizeWorkspaceRoot(root: string): string {
  if (!root.trim()) return "";
  const resolved = path.resolve(root);
  try {
    // Resolve ordinary case aliases through the filesystem instead of using
    // unsafe string case-folding (Windows can host case-sensitive directories).
    // Do not follow a linked workspace root: the guarded workspace rejects it,
    // and it must not inherit the target workspace's private chat history.
    if (lstatSync(resolved).isSymbolicLink()) return resolved;
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
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
    // Flush the published file and, where Node supports it, its containing
    // directory. Windows exposes the former but rejects directory fsync.
    await syncPublishedEntry(destination);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

/** @internal Exported for deterministic durability-retry regression tests. */
export async function writeUtf8NoClobber(
  destination: string,
  contents: string,
  syncEntry: (path: string) => Promise<boolean> = syncPublishedEntry
): Promise<boolean> {
  const temporary = await writeDurableTemp(destination, contents);
  try {
    await fs.link(temporary, destination);
    // Delete the legacy source only after the strongest persistence barrier
    // portable Node exposes for this host has completed.
    return syncEntry(destination);
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      // A prior attempt may have published these exact bytes before its
      // durability barrier failed. Revalidate and retry the barrier so that a
      // transient failure cannot wedge migration forever. A different record
      // with the same UUID remains a strict no-clobber conflict.
      try {
        const existing = await readUtf8FileBounded(destination);
        return existing === contents ? syncEntry(destination) : false;
      } catch {
        return false;
      }
    }
    throw error;
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

async function syncContainingDirectory(destination: string): Promise<boolean> {
  let directory: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    directory = await fs.open(path.dirname(destination), "r");
    await directory.sync();
    return true;
  } catch {
    return false;
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

async function syncPublishedEntry(destination: string): Promise<boolean> {
  let published: Awaited<ReturnType<typeof fs.open>> | undefined;
  let fileSynced = false;
  try {
    // Windows requires a writable handle for FlushFileBuffers/fsync.
    published = await fs.open(destination, "r+");
    await published.sync();
    fileSynced = true;
  } catch {
    return false;
  } finally {
    await published?.close().catch(() => undefined);
  }
  const directorySynced = await syncContainingDirectory(destination);
  return directorySynced || (process.platform === "win32" && fileSynced);
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
