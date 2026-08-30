import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeToolCallingProfile, type ToolCallingProfile } from "../llm/toolCallingProfile.js";
import type { FileChangeSummary } from "./fileChanges.js";
import { DEFAULT_THINKING_MODE, normalizeThinkingMode, type ThinkingMode } from "./thinkingMode.js";

export const CHATS_DIR = ".local-llm-chats";
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const VISION_TOKEN_RESERVE = 4096;

export type Role = "user" | "assistant" | "tool" | "system";
export type StoredToolStatus = "executed" | "failed" | "rejected";

export interface ChatAttachment {
  id: string;
  fileName: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  byteLength: number;
  extension: "jpg" | "png" | "webp";
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** Native model reasoning associated with this assistant response. */
  reasoningContent?: string;
  /** Parser events captured during this assistant turn (text, thought, toolCall, summary). */
  events?: unknown[];
  /** Tool call this message corresponds to (when role === "tool"). */
  toolCall?: {
    id?: string;
    name: string;
    argsJson: string;
    /** Final UI outcome, retained so restored summaries do not imply failed work succeeded. */
    status?: StoredToolStatus;
    /** Retains the Created/Edited distinction for write_file across reloads. */
    createsNewFile?: boolean;
  };
  /** File changes made during this assistant turn. */
  fileChanges?: FileChangeSummary[];
  /** Chat-owned image assets supplied with this user message. */
  attachments?: ChatAttachment[];
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
  toolCallingMode: ToolCallingProfile;
  planMode: boolean;
  thinkingMode: ThinkingMode;
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

  attachmentsRoot(): string {
    return path.join(this.dir(), "attachments");
  }

  attachmentPath(chatId: string, attachment: ChatAttachment): string {
    if (!isValidChatId(chatId) || !isValidAttachment(attachment)) throw new Error("Invalid attachment reference.");
    return path.join(this.attachmentsRoot(), chatId, `${attachment.id}.${attachment.extension}`);
  }

  async importAttachment(chatId: string, sourcePath: string): Promise<ChatAttachment> {
    if (!isValidChatId(chatId)) throw new Error("Invalid chat id.");
    const sourceExtension = path.extname(sourcePath).slice(1).toLowerCase();
    if (!(["jpg", "jpeg", "png", "webp"] as string[]).includes(sourceExtension)) {
      throw new Error("Choose a JPEG, PNG, or WebP image file.");
    }
    const stat = await fs.stat(sourcePath);
    if (!stat.isFile()) throw new Error("Choose an image file.");
    if (stat.size === 0) throw new Error("The selected image is empty.");
    if (stat.size > MAX_ATTACHMENT_BYTES) throw new Error("Images must be 10 MiB or smaller.");
    const bytes = await fs.readFile(sourcePath);
    if (bytes.byteLength === 0) throw new Error("The selected image is empty.");
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("Images must be 10 MiB or smaller.");
    const kind = detectImage(bytes);
    if (!kind) throw new Error("Choose a valid JPEG, PNG, or WebP image.");
    const canonicalSourceExtension = sourceExtension === "jpeg" ? "jpg" : sourceExtension;
    if (canonicalSourceExtension !== kind.extension) throw new Error("The image contents do not match its file extension.");
    const attachment: ChatAttachment = {
      id: randomUUID(),
      fileName: path.basename(sourcePath),
      mimeType: kind.mimeType,
      byteLength: bytes.byteLength,
      extension: kind.extension
    };
    const dir = path.join(this.attachmentsRoot(), chatId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.attachmentPath(chatId, attachment), bytes, { flag: "wx" });
    return attachment;
  }

  async attachmentDataUrl(chatId: string, attachment: ChatAttachment): Promise<string> {
    const bytes = await fs.readFile(this.attachmentPath(chatId, attachment));
    const kind = detectImage(bytes);
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES || !kind
        || kind.extension !== attachment.extension || kind.mimeType !== attachment.mimeType) {
      throw new Error("Stored image attachment is invalid.");
    }
    return `data:${attachment.mimeType};base64,${bytes.toString("base64")}`;
  }

  async deleteAttachment(chatId: string, attachment: ChatAttachment): Promise<void> {
    try { await fs.unlink(this.attachmentPath(chatId, attachment)); } catch { /* already absent */ }
  }

  async pruneAttachments(rec: ChatRecord): Promise<void> {
    if (!isValidChatId(rec.id)) return;
    const keep = new Set(rec.messages.flatMap(message => message.attachments ?? []).map(item => `${item.id}.${item.extension}`));
    const dir = path.join(this.attachmentsRoot(), rec.id);
    let entries: string[];
    try { entries = await fs.readdir(dir); } catch { return; }
    await Promise.all(entries.filter(entry => !keep.has(entry)).map(async entry => {
      if (/^[0-9a-f-]+\.(?:jpg|png|webp)$/i.test(entry)) {
        try { await fs.unlink(path.join(dir, entry)); } catch { /* ignore races */ }
      }
    }));
    try { await fs.rmdir(dir); } catch { /* retained files or already absent */ }
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
      await fs.rm(path.join(this.attachmentsRoot(), id), { recursive: true, force: true });
    } catch { /* ignore */ }
  }

  /** Delete every chat belonging to this storage instance's workspace. */
  async deleteAll(): Promise<void> {
    const chats = await this.list();
    await Promise.all(chats.map(chat => this.delete(chat.id)));
  }

  /** Clone a conversation through the response to one user message. */
  async fork(rec: ChatRecord, throughUserMessageTs?: number): Promise<ChatRecord> {
    let end = rec.messages.length;
    if (throughUserMessageTs !== undefined) {
      const userIndex = rec.messages.findIndex(
        message => message.role === "user" && message.ts === throughUserMessageTs
      );
      if (userIndex >= 0) {
        const nextUser = rec.messages.findIndex(
          (message, index) => index > userIndex && message.role === "user"
        );
        end = nextUser >= 0 ? nextUser : rec.messages.length;
      }
    }

    const forked = this.newRecord(rec.toolCallingMode);
    forked.title = rec.title;
    forked.planMode = rec.planMode;
    forked.thinkingMode = normalizeThinkingMode(rec.thinkingMode);
    forked.messages = structuredClone(rec.messages.slice(0, end));
    forked.totalTokens = forked.messages.reduce(
      (total, message) => total + (message.tokens ?? 0),
      0
    );
    try {
      for (const attachment of forked.messages.flatMap(message => message.attachments ?? [])) {
        const destDir = path.join(this.attachmentsRoot(), forked.id);
        await fs.mkdir(destDir, { recursive: true });
        await fs.copyFile(this.attachmentPath(rec.id, attachment), this.attachmentPath(forked.id, attachment));
      }
      await this.save(forked);
    } catch (error) {
      await fs.rm(path.join(this.attachmentsRoot(), forked.id), { recursive: true, force: true });
      throw error;
    }
    return forked;
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
          await fs.rm(path.join(this.attachmentsRoot(), id), { recursive: true, force: true });
        }
      } catch { /* skip */ }
    }
  }

  newRecord(toolCallingMode: ToolCallingProfile, thinkingMode: ThinkingMode = DEFAULT_THINKING_MODE): ChatRecord {
    const now = Date.now();
    return {
      id: randomUUID(),
      workspaceRoot: this.workspaceRoot,
      createdAt: now,
      updatedAt: now,
      title: "New chat",
      toolCallingMode,
      planMode: false,
      thinkingMode,
      messages: [],
      totalTokens: 0
    };
  }

  private belongsToWorkspace(rec: ChatRecord): boolean {
    return normalizeWorkspaceRoot(rec.workspaceRoot ?? "") === this.workspaceRoot;
  }

  private withWorkspace(rec: ChatRecord, id: string): ChatRecord {
    const legacy = rec as ChatRecord & { modelFamily?: unknown; toolCallingMode?: unknown };
    const current = { ...legacy };
    delete (current as { modelFamily?: unknown }).modelFamily;
    const messages = Array.isArray(rec.messages) ? rec.messages.map(message => {
      const attachments = Array.isArray(message.attachments)
        ? message.attachments.filter(isValidAttachment).slice(0, 1)
        : undefined;
      return attachments?.length ? { ...message, attachments } : { ...message, attachments: undefined };
    }) : [];
    return {
      ...current,
      id,
      workspaceRoot: normalizeWorkspaceRoot(rec.workspaceRoot ?? ""),
      toolCallingMode: normalizeToolCallingProfile(legacy.toolCallingMode, legacy.modelFamily),
      thinkingMode: normalizeThinkingMode(rec.thinkingMode),
      messages
    } as ChatRecord;
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
        const rec = this.withWorkspace(JSON.parse(raw) as ChatRecord, id);
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

export function isValidAttachment(value: unknown): value is ChatAttachment {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ChatAttachment>;
  return typeof item.id === "string"
    && isValidChatId(item.id)
    && typeof item.fileName === "string"
    && item.fileName.length > 0
    && item.fileName === path.basename(item.fileName)
    && (item.mimeType === "image/jpeg" || item.mimeType === "image/png" || item.mimeType === "image/webp")
    && (item.extension === "jpg" || item.extension === "png" || item.extension === "webp")
    && ((item.mimeType === "image/jpeg" && item.extension === "jpg")
      || (item.mimeType === "image/png" && item.extension === "png")
      || (item.mimeType === "image/webp" && item.extension === "webp"))
    && Number.isInteger(item.byteLength)
    && (item.byteLength ?? 0) > 0
    && (item.byteLength ?? 0) <= MAX_ATTACHMENT_BYTES;
}

function detectImage(bytes: Uint8Array): Pick<ChatAttachment, "mimeType" | "extension"> | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return { mimeType: "image/png", extension: "png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
      && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") {
    return { mimeType: "image/webp", extension: "webp" };
  }
  return undefined;
}

export function titleFromFirstMessage(s: string): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  const words = oneLine.split(" ").filter(Boolean).slice(0, 6);
  if (words.length === 1) return `${words[0]} chat`;
  const fallback = words.join(" ");
  return fallback || "New chat";
}

function normalizeWorkspaceRoot(root: string): string {
  if (!root.trim()) return "";
  const resolved = path.resolve(root);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(a: string, b: string): boolean {
  return normalizeWorkspaceRoot(a) === normalizeWorkspaceRoot(b);
}
