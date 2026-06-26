import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ModelFamily } from "../llm/parser/index.js";
import type { FileChangeSummary } from "./fileChanges.js";

export const CHATS_DIR = ".local-llm-chats";

export type Role = "user" | "assistant" | "tool" | "system";

export interface ChatMessage {
  role: Role;
  content: string;
  /** Parser events captured during this assistant turn (text, thought, toolCall, summary). */
  events?: unknown[];
  /** Tool call this message corresponds to (when role === "tool"). */
  toolCall?: { name: string; argsJson: string };
  /** File changes made during this assistant turn. */
  fileChanges?: FileChangeSummary[];
  tokens?: number;
  ts: number;
}

export type { FileChangeSummary };
export type { TodoItem } from "./todos.js";

export interface ChatRecord {
  id: string;
  workspaceRoot: string;
  createdAt: number;
  updatedAt: number;
  title: string;
  modelFamily: ModelFamily;
  planMode: boolean;
  messages: ChatMessage[];
  totalTokens: number;
}

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
          const raw = await fs.readFile(path.join(this.dir(), e), "utf-8");
          const rec = this.withWorkspace(JSON.parse(raw) as ChatRecord, id);
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
      const raw = await fs.readFile(path.join(this.dir(), id + ".json"), "utf-8");
      const rec = this.withWorkspace(JSON.parse(raw) as ChatRecord, id);
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
    await fs.writeFile(
      path.join(this.dir(), rec.id + ".json"),
      JSON.stringify(rec, null, 2),
      "utf-8"
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
        const raw = await fs.readFile(path.join(this.dir(), e), "utf-8");
        const rec = this.withWorkspace(JSON.parse(raw) as ChatRecord, id);
        if (this.belongsToWorkspace(rec) && rec.messages.length === 0) {
          await fs.unlink(path.join(this.dir(), e));
        }
      } catch { /* skip */ }
    }
  }

  newRecord(modelFamily: ModelFamily): ChatRecord {
    const now = Date.now();
    return {
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

  private withWorkspace(rec: ChatRecord, id: string): ChatRecord {
    return {
      ...rec,
      id,
      workspaceRoot: normalizeWorkspaceRoot(rec.workspaceRoot ?? "")
    };
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
        const raw = await fs.readFile(src, "utf-8");
        const rec = JSON.parse(raw) as ChatRecord;
        const migrated: ChatRecord = {
          ...rec,
          id,
          workspaceRoot: this.workspaceRoot
        };
        await fs.writeFile(dest, JSON.stringify(migrated, null, 2), "utf-8");
        await fs.unlink(src);
      } catch { /* leave problematic legacy files untouched */ }
    }
    try { await fs.rmdir(legacyDir); } catch { /* ignore non-empty legacy dirs */ }
  }
}

export function isValidChatId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
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
