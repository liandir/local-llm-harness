import type { ModelFamily } from "../llm/parser/index.js";
import type { FileChangeSummary } from "./fileChanges.js";

/** Current on-disk chat schema. Unversioned records are treated as legacy v0. */
export const CHAT_SCHEMA_VERSION = 1 as const;

/**
 * Structural limits for records decoded from disk. The byte-level file limit
 * lives in `storage.ts`; these bounds also protect direct decoder callers from
 * adversarial object graphs and oversized structured-clone values.
 */
export const CHAT_RECORD_LIMITS = Object.freeze({
  workspaceRootChars: 32 * 1024,
  titleChars: 512,
  messages: 20_000,
  eventsPerMessage: 100_000,
  fileChangesPerMessage: 10_000,
  identifierChars: 256,
  pathChars: 32 * 1024,
  contentChars: 16 * 1024 * 1024
});

export type Role = "user" | "assistant" | "tool" | "system";

/** Parser event persisted for restoring an assistant turn in the webview. */
export type StoredParserEvent =
  | { kind: "text" | "thought" | "summary"; text: string; t?: number }
  | { kind: "toolCall"; name: string; argsJson: string; id?: string; t?: number }
  | {
      kind: "toolCallProgress";
      name: string;
      path?: string;
      content?: string;
      contentBytes: number;
      contentLines: number;
      startLine?: number;
      endLine?: number;
      id?: string;
      t?: number;
    }
  | { kind: "done"; t?: number };

export interface ChatMessage {
  role: Role;
  content: string;
  /** Parser events captured during this assistant turn. */
  events?: StoredParserEvent[];
  /** Tool call this result corresponds to (when role is `tool`). */
  toolCall?: { name: string; argsJson: string };
  /** File changes made during this assistant turn. */
  fileChanges?: FileChangeSummary[];
  tokens?: number;
  ts: number;
}

export interface ChatRecord {
  schemaVersion: typeof CHAT_SCHEMA_VERSION;
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

export interface ChatRecordOverrides {
  /** The filename is authoritative when records are loaded from disk. */
  id?: string;
  /** Used only when moving a record out of the old workspace-local directory. */
  workspaceRoot?: string;
}

/** Decode only the current, fully versioned schema. Unknown fields fail closed. */
export function parseChatRecord(raw: unknown, overrides: ChatRecordOverrides = {}): ChatRecord | undefined {
  return decodeRecord(raw, overrides, false);
}

/**
 * Migrate the historical unversioned schema to the current schema.
 *
 * Legacy records must still contain a title, update timestamp, and message list.
 * Fields that did not exist in early releases receive deterministic defaults.
 */
export function migrateLegacyChatRecord(
  raw: unknown,
  overrides: ChatRecordOverrides = {}
): ChatRecord | undefined {
  return decodeRecord(raw, overrides, true);
}

/** Decode a stored record, explicitly dispatching current v1 and legacy v0. */
export function normalizeStoredChatRecord(
  raw: unknown,
  overrides: ChatRecordOverrides = {}
): ChatRecord | undefined {
  if (!isObject(raw)) return undefined;
  if (raw.schemaVersion === CHAT_SCHEMA_VERSION) return parseChatRecord(raw, overrides);
  if (raw.schemaVersion === undefined || raw.schemaVersion === 0) {
    return migrateLegacyChatRecord(raw, overrides);
  }
  return undefined;
}

export function isValidChatId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

const RECORD_KEYS = [
  "schemaVersion", "id", "workspaceRoot", "createdAt", "updatedAt", "title",
  "modelFamily", "planMode", "messages", "totalTokens"
] as const;
const LEGACY_RECORD_KEYS = RECORD_KEYS;
const MESSAGE_KEYS = ["role", "content", "events", "toolCall", "fileChanges", "tokens", "ts"] as const;

function decodeRecord(
  raw: unknown,
  overrides: ChatRecordOverrides,
  legacy: boolean
): ChatRecord | undefined {
  if (!isObject(raw) || !hasOnlyKeys(raw, legacy ? LEGACY_RECORD_KEYS : RECORD_KEYS)) return undefined;
  if (!legacy && raw.schemaVersion !== CHAT_SCHEMA_VERSION) return undefined;
  if (legacy && raw.schemaVersion !== undefined && raw.schemaVersion !== 0) return undefined;

  const id = overrides.id ?? raw.id;
  const workspaceRoot = overrides.workspaceRoot ?? raw.workspaceRoot;
  if (typeof id !== "string" || !isValidChatId(id)) return undefined;
  if (
    !isBoundedString(workspaceRoot, CHAT_RECORD_LIMITS.workspaceRootChars, false, true)
    || workspaceRoot.trim().length === 0
  ) return undefined;
  if (!isBoundedString(raw.title, CHAT_RECORD_LIMITS.titleChars, true, true) || !isFiniteInteger(raw.updatedAt, 0)) {
    return undefined;
  }
  if (!Array.isArray(raw.messages) || raw.messages.length > CHAT_RECORD_LIMITS.messages) return undefined;

  const messages: ChatMessage[] = [];
  for (const entry of raw.messages) {
    const message = parseChatMessage(entry);
    if (!message) return undefined;
    messages.push(message);
  }

  const createdAt = legacy && raw.createdAt === undefined ? raw.updatedAt : raw.createdAt;
  const modelFamily = legacy && raw.modelFamily === undefined ? "gemma4" : raw.modelFamily;
  const planMode = legacy && raw.planMode === undefined ? false : raw.planMode;
  const totalTokens = legacy && raw.totalTokens === undefined ? 0 : raw.totalTokens;
  if (!isFiniteInteger(createdAt, 0)) return undefined;
  if (modelFamily !== "gemma4" && modelFamily !== "qwen3") return undefined;
  if (typeof planMode !== "boolean" || !isFiniteInteger(totalTokens, 0)) return undefined;

  return {
    schemaVersion: CHAT_SCHEMA_VERSION,
    id,
    workspaceRoot,
    createdAt,
    updatedAt: raw.updatedAt,
    title: raw.title,
    modelFamily,
    planMode,
    messages,
    totalTokens
  };
}

function parseChatMessage(raw: unknown): ChatMessage | undefined {
  if (!isObject(raw) || !hasOnlyKeys(raw, MESSAGE_KEYS)) return undefined;
  if (
    !isRole(raw.role)
    || !isBoundedString(raw.content, CHAT_RECORD_LIMITS.contentChars, true)
    || !isFiniteInteger(raw.ts, 0)
  ) return undefined;

  const message: ChatMessage = { role: raw.role, content: raw.content, ts: raw.ts };
  if (raw.tokens !== undefined) {
    if (!isFiniteInteger(raw.tokens, 0)) return undefined;
    message.tokens = raw.tokens;
  }
  if (raw.toolCall !== undefined) {
    if (!isObject(raw.toolCall) || !hasOnlyKeys(raw.toolCall, ["name", "argsJson"])) return undefined;
    if (
      !isBoundedString(raw.toolCall.name, CHAT_RECORD_LIMITS.identifierChars, true, true)
      || !isBoundedString(raw.toolCall.argsJson, CHAT_RECORD_LIMITS.contentChars, true)
    ) return undefined;
    message.toolCall = { name: raw.toolCall.name, argsJson: raw.toolCall.argsJson };
  }
  if (raw.events !== undefined) {
    if (!Array.isArray(raw.events) || raw.events.length > CHAT_RECORD_LIMITS.eventsPerMessage) return undefined;
    const events: StoredParserEvent[] = [];
    for (const entry of raw.events) {
      const event = parseStoredEvent(entry);
      if (!event) return undefined;
      events.push(event);
    }
    message.events = events;
  }
  if (raw.fileChanges !== undefined) {
    if (!Array.isArray(raw.fileChanges) || raw.fileChanges.length > CHAT_RECORD_LIMITS.fileChangesPerMessage) {
      return undefined;
    }
    const changes: FileChangeSummary[] = [];
    for (const entry of raw.fileChanges) {
      const change = parseFileChange(entry);
      if (!change) return undefined;
      changes.push(change);
    }
    message.fileChanges = changes;
  }
  return message;
}

function parseStoredEvent(raw: unknown): StoredParserEvent | undefined {
  if (!isObject(raw) || typeof raw.kind !== "string") return undefined;
  const t = raw.t;
  if (t !== undefined && !isFiniteInteger(t, 0)) return undefined;

  if (raw.kind === "text" || raw.kind === "thought" || raw.kind === "summary") {
    if (
      !hasOnlyKeys(raw, ["kind", "text", "t"])
      || !isBoundedString(raw.text, CHAT_RECORD_LIMITS.contentChars, true)
    ) return undefined;
    return t === undefined ? { kind: raw.kind, text: raw.text } : { kind: raw.kind, text: raw.text, t };
  }
  if (raw.kind === "toolCall") {
    if (!hasOnlyKeys(raw, ["kind", "name", "argsJson", "id", "t"])) return undefined;
    if (
      !isBoundedString(raw.name, CHAT_RECORD_LIMITS.identifierChars, true, true)
      || !isBoundedString(raw.argsJson, CHAT_RECORD_LIMITS.contentChars, true)
      || !optionalBoundedString(raw.id, CHAT_RECORD_LIMITS.identifierChars, true)
    ) return undefined;
    const event: Extract<StoredParserEvent, { kind: "toolCall" }> = {
      kind: "toolCall",
      name: raw.name,
      argsJson: raw.argsJson
    };
    if (raw.id !== undefined) event.id = raw.id;
    if (t !== undefined) event.t = t;
    return event;
  }
  if (raw.kind === "toolCallProgress") {
    if (!hasOnlyKeys(raw, [
      "kind", "name", "path", "content", "contentBytes", "contentLines",
      "startLine", "endLine", "id", "t"
    ])) return undefined;
    if (
      !isBoundedString(raw.name, CHAT_RECORD_LIMITS.identifierChars, true, true)
      || !isFiniteInteger(raw.contentBytes, 0)
      || !isFiniteInteger(raw.contentLines, 0)
    ) {
      return undefined;
    }
    if (
      !optionalBoundedString(raw.path, CHAT_RECORD_LIMITS.pathChars, true)
      || !optionalBoundedString(raw.content, CHAT_RECORD_LIMITS.contentChars)
      || !optionalBoundedString(raw.id, CHAT_RECORD_LIMITS.identifierChars, true)
    ) return undefined;
    if (!optionalInteger(raw.startLine, 1) || !optionalInteger(raw.endLine, 1)) return undefined;
    const event: Extract<StoredParserEvent, { kind: "toolCallProgress" }> = {
      kind: "toolCallProgress",
      name: raw.name,
      contentBytes: raw.contentBytes,
      contentLines: raw.contentLines
    };
    if (raw.path !== undefined) event.path = raw.path;
    if (raw.content !== undefined) event.content = raw.content;
    if (raw.startLine !== undefined) event.startLine = raw.startLine;
    if (raw.endLine !== undefined) event.endLine = raw.endLine;
    if (raw.id !== undefined) event.id = raw.id;
    if (t !== undefined) event.t = t;
    return event;
  }
  if (raw.kind === "done" && hasOnlyKeys(raw, ["kind", "t"])) {
    return t === undefined ? { kind: "done" } : { kind: "done", t };
  }
  return undefined;
}

function parseFileChange(raw: unknown): FileChangeSummary | undefined {
  if (!isObject(raw) || !hasOnlyKeys(raw, ["path", "added", "removed", "diffPreview"])) return undefined;
  if (
    !isBoundedString(raw.path, CHAT_RECORD_LIMITS.pathChars, false, true)
    || !isBoundedString(raw.diffPreview, CHAT_RECORD_LIMITS.contentChars, true)
  ) return undefined;
  if (!isFiniteInteger(raw.added, 0) || !isFiniteInteger(raw.removed, 0)) return undefined;
  return { path: raw.path, added: raw.added, removed: raw.removed, diffPreview: raw.diffPreview };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(raw: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(raw).every(key => keys.has(key));
}

function isRole(value: unknown): value is Role {
  return value === "user" || value === "assistant" || value === "tool" || value === "system";
}

function isFiniteInteger(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function optionalInteger(value: unknown, minimum: number): value is number | undefined {
  return value === undefined || isFiniteInteger(value, minimum);
}

function isBoundedString(
  value: unknown,
  maxLength: number,
  allowEmpty: boolean,
  rejectNul = false
): value is string {
  return typeof value === "string"
    && (allowEmpty || value.length > 0)
    && value.length <= maxLength
    && (!rejectNul || !value.includes("\0"));
}

function optionalBoundedString(
  value: unknown,
  maxLength: number,
  rejectNul = false
): value is string | undefined {
  return value === undefined || isBoundedString(value, maxLength, true, rejectNul);
}
