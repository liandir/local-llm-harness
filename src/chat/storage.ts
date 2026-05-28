import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ModelFamily } from "../llm/parser/index.js";

export const CHATS_DIR = ".local-llm-chats";

export type Role = "user" | "assistant" | "tool" | "system";

export interface ChatMessage {
  role: Role;
  content: string;
  /** Parser events captured during this assistant turn (text, thought, toolCall, summary). */
  events?: unknown[];
  /** Tool call this message corresponds to (when role === "tool"). */
  toolCall?: { name: string; argsJson: string };
  tokens?: number;
  ts: number;
}

export interface ChatRecord {
  id: string;
  createdAt: number;
  updatedAt: number;
  title: string;
  modelFamily: ModelFamily;
  planMode: boolean;
  messages: ChatMessage[];
  totalTokens: number;
}

export class ChatStorage {
  constructor(private workspaceRoot: string) {}

  private dir(): string {
    return path.join(this.workspaceRoot, CHATS_DIR);
  }

  async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir(), { recursive: true });
  }

  async list(): Promise<{ id: string; title: string; updatedAt: number }[]> {
    try {
      const entries = await fs.readdir(this.dir());
      const out: { id: string; title: string; updatedAt: number }[] = [];
      for (const e of entries) {
        if (!e.endsWith(".json")) continue;
        try {
          const raw = await fs.readFile(path.join(this.dir(), e), "utf-8");
          const rec = JSON.parse(raw) as ChatRecord;
          out.push({ id: rec.id, title: rec.title, updatedAt: rec.updatedAt });
        } catch { /* skip malformed */ }
      }
      return out.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      return [];
    }
  }

  async load(id: string): Promise<ChatRecord | undefined> {
    try {
      const raw = await fs.readFile(path.join(this.dir(), id + ".json"), "utf-8");
      return JSON.parse(raw) as ChatRecord;
    } catch {
      return undefined;
    }
  }

  async save(rec: ChatRecord): Promise<void> {
    await this.ensureDir();
    rec.updatedAt = Date.now();
    await fs.writeFile(
      path.join(this.dir(), rec.id + ".json"),
      JSON.stringify(rec, null, 2),
      "utf-8"
    );
  }

  async delete(id: string): Promise<void> {
    try {
      await fs.unlink(path.join(this.dir(), id + ".json"));
    } catch { /* ignore */ }
  }

  /** Delete every chat record on disk that has zero messages. */
  async deleteEmpty(exceptId?: string): Promise<void> {
    let entries: string[];
    try { entries = await fs.readdir(this.dir()); } catch { return; }
    for (const e of entries) {
      if (!e.endsWith(".json")) continue;
      const id = e.slice(0, -5);
      if (exceptId && id === exceptId) continue;
      try {
        const raw = await fs.readFile(path.join(this.dir(), e), "utf-8");
        const rec = JSON.parse(raw) as ChatRecord;
        if (rec.messages.length === 0) {
          await fs.unlink(path.join(this.dir(), e));
        }
      } catch { /* skip */ }
    }
  }

  newRecord(modelFamily: ModelFamily): ChatRecord {
    const now = Date.now();
    return {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      title: "New chat",
      modelFamily,
      planMode: false,
      messages: [],
      totalTokens: 0
    };
  }
}

export function titleFromFirstMessage(s: string): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length <= 60 ? oneLine : oneLine.slice(0, 57) + "...";
}
