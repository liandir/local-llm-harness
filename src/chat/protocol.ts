import { isValidChatId, type ChatMessage, type ChatRecord } from "./model.js";
import type { FileChangeSummary } from "./fileChanges.js";

/** JSON/structured-clone DTO aliases shared by the extension host and webviews. */
export type ChatRecordDto = ChatRecord;
export type ChatMessageDto = ChatMessage;
export interface ChatSummaryDto { id: string; title: string; updatedAt: number }
export interface OpenChatDto { id: string; title: string }
export interface ApprovalBindingDto {
  sessionId: string;
  turnId: string;
  proposalId: string;
  decisionToken: string;
  toolId: string;
  reviewDigest: string;
}

/**
 * Character limits applied before a host-bound webview message can trigger
 * extension work. They are intentionally generous for normal editor content
 * while bounding compromised-webview memory and persistence requests.
 */
export const HOST_MESSAGE_LIMITS = Object.freeze({
  type: 64,
  identifier: 256,
  title: 512,
  answer: 64 * 1024,
  endpointUrl: 8 * 1024,
  path: 32 * 1024,
  chatText: 4 * 1024 * 1024
});

export type ToolCategory =
  | "read"
  | "write"
  | "todos"
  | "safeCmd"
  | "unsafeCmd"
  | "question"
  | "forbidden"
  | "unknown"
  | "planViolation";

/** Events emitted by a chat session to the chat webview. */
export type UiEvent =
  | { kind: "userMessage"; messageId: string; text: string }
  | { kind: "turnStart"; messageId: string }
  | { kind: "text"; messageId: string; delta: string }
  | { kind: "thought"; messageId: string; delta: string }
  | { kind: "toolCallProgress"; toolId: string; messageId: string; toolName: string; path?: string; contentLines: number; added?: number; removed?: number; createsNewFile?: boolean; replacedLines?: number; groupId?: string }
  | { kind: "toolCallProposed"; toolId: string; messageId: string; toolName: string; argsJson: string; category: ToolCategory; reason?: string; diffPreview?: string; diffFormat?: "exact-v1"; groupId?: string; added?: number; removed?: number; createsNewFile?: boolean; approval?: ApprovalBindingDto }
  | { kind: "toolCallResolved"; toolId: string; status: "approved" | "rejected" | "executed" | "failed"; resultPreview?: string; diffPreview?: string; groupId?: string; added?: number; removed?: number; createsNewFile?: boolean }
  | { kind: "toolDiff"; toolId: string; diffPreview: string; diffFormat?: "exact-v1" }
  | { kind: "fileChanges"; messageId: string; changes: FileChangeSummary[] }
  | { kind: "summary"; messageId: string; text: string }
  | { kind: "planFinal"; messageId: string; markdown: string }
  | { kind: "abort"; reason: string }
  | { kind: "notice"; text: string }
  | { kind: "turnEnd"; messageId: string }
  | { kind: "tokens"; total: number; limit: number }
  | { kind: "titleChanged"; title: string; animate: boolean }
  | { kind: "chatLoaded"; record: ChatRecordDto }
  | { kind: "chatClosed" }
  | { kind: "compactStatus"; currentMessages: number; minMessages: number; available: boolean }
  | { kind: "compactStart"; compactId: string; source: "manual" | "auto"; beforeTokens: number; beforeMessages: number; keepTail: number }
  | { kind: "compactEnd"; compactId: string; source: "manual" | "auto"; status: "executed" | "failed"; beforeTokens: number; afterTokens?: number; beforeMessages: number; afterMessages?: number; keepTail: number; error?: string }
  | { kind: "planModeChanged"; on: boolean };

export type SideTab = "welcome" | "chats" | "settings";

/** Settings that the side webview is permitted to write without a dedicated flow. */
export type SideSettingUpdate =
  | { key: "modelFamily"; value: "gemma4" | "qwen3" }
  | { key: "contextSize"; value: number }
  | { key: "temperature"; value: number }
  | { key: "topK"; value: number }
  | { key: "topP"; value: number }
  | { key: "autoCompact"; value: boolean }
  | { key: "autoCompactThresholdPercent"; value: number }
  | { key: "autoapproveReads"; value: boolean }
  | { key: "autoapproveWrites"; value: boolean };

export type SideToExt =
  | { type: "ready" }
  | { type: "newChat" }
  | { type: "openChat"; id: string }
  | { type: "deleteChat"; id: string }
  | { type: "openTab"; tab: SideTab }
  | ({ type: "saveSetting" } & SideSettingUpdate)
  | { type: "validateEndpoint"; url: string }
  | { type: "editSafeCommandsJson" }
  | { type: "restoreDefaultSafeCommands" }
  | { type: "resetAllDefaults" };

export type ExtToSide =
  | { type: "settings"; settings: Record<string, unknown> }
  | { type: "chats"; chats: ChatSummaryDto[] }
  | { type: "focusTab"; tab: SideTab }
  | { type: "endpointValidation"; ok: boolean; error?: string; resolved?: string[] }
  | { type: "settingSaved"; key: string; ok: boolean; error?: string }
  | { type: "openTabs"; tabs: OpenChatDto[] };

export type ChatToExt =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "cancel" }
  | { type: "approveTool"; approval: ApprovalBindingDto; approved: boolean }
  | { type: "answerQuestion"; toolId: string; answer: string }
  | { type: "togglePlanMode" }
  | { type: "compactNow" }
  | { type: "compactInterruptAndRun" }
  | { type: "newChat" }
  | { type: "openChats" }
  | { type: "openSettings" }
  | { type: "setAutoApproveWrites"; on: boolean }
  | { type: "acceptPlan" }
  | { type: "openFile"; path: string; line?: number }
  | { type: "reviewFile"; path: string }
  | { type: "reviewWorkspaceChanges" }
  | { type: "requestToolDiff"; toolId: string }
  | { type: "renameChat"; title: string }
  | { type: "deleteCurrent" };

export type ExtToChat = UiEvent | {
  type: "settings";
  autoapproveWrites: boolean;
  planMode: boolean;
  autoCompact: boolean;
  autoCompactThresholdPercent: number;
};

/** Parse an untrusted message entering the extension host from the chat webview. */
export function parseChatToExt(raw: unknown): ChatToExt | undefined {
  if (
    !isObject(raw)
    || !hasOwn(raw, "type")
    || !isBoundedString(raw.type, HOST_MESSAGE_LIMITS.type, false, true)
  ) return undefined;
  switch (raw.type) {
    case "ready":
    case "cancel":
    case "togglePlanMode":
    case "compactNow":
    case "compactInterruptAndRun":
    case "newChat":
    case "openChats":
    case "openSettings":
    case "acceptPlan":
    case "reviewWorkspaceChanges":
    case "deleteCurrent":
      return hasExactKeys(raw, ["type"]) ? { type: raw.type } : undefined;
    case "send":
      return exactBoundedStringMessage(raw, "text", HOST_MESSAGE_LIMITS.chatText)
        ? { type: "send", text: raw.text }
        : undefined;
    case "approveTool":
      if (!hasExactKeys(raw, ["type", "approval", "approved"]) || typeof raw.approved !== "boolean") {
        return undefined;
      }
      {
        const approval = parseApprovalBinding(raw.approval);
        return approval ? { type: "approveTool", approval, approved: raw.approved } : undefined;
      }
    case "answerQuestion":
      return hasExactKeys(raw, ["type", "toolId", "answer"])
        && isBoundedString(raw.toolId, HOST_MESSAGE_LIMITS.identifier, false, true)
        && isBoundedString(raw.answer, HOST_MESSAGE_LIMITS.answer, true)
        ? { type: "answerQuestion", toolId: raw.toolId, answer: raw.answer }
        : undefined;
    case "setAutoApproveWrites":
      return hasExactKeys(raw, ["type", "on"]) && typeof raw.on === "boolean"
        ? { type: "setAutoApproveWrites", on: raw.on }
        : undefined;
    case "openFile": {
      if (
        !hasOnlyKeys(raw, ["type", "path", "line"])
        || !hasOwn(raw, "path")
        || !isBoundedString(raw.path, HOST_MESSAGE_LIMITS.path, false, true)
      ) return undefined;
      if (raw.line !== undefined && !isIntegerInRange(raw.line, 1, Number.MAX_SAFE_INTEGER)) return undefined;
      return raw.line === undefined
        ? { type: "openFile", path: raw.path }
        : { type: "openFile", path: raw.path, line: raw.line };
    }
    case "reviewFile":
      return exactBoundedStringMessage(raw, "path", HOST_MESSAGE_LIMITS.path, false, true)
        ? { type: "reviewFile", path: raw.path }
        : undefined;
    case "requestToolDiff":
      return exactBoundedStringMessage(raw, "toolId", HOST_MESSAGE_LIMITS.identifier, false, true)
        ? { type: "requestToolDiff", toolId: raw.toolId }
        : undefined;
    case "renameChat":
      return exactBoundedStringMessage(raw, "title", HOST_MESSAGE_LIMITS.title, true, true)
        ? { type: "renameChat", title: raw.title }
        : undefined;
    default:
      return undefined;
  }
}

function parseApprovalBinding(value: unknown): ApprovalBindingDto | undefined {
  if (!isObject(value) || !hasExactKeys(value, [
    "sessionId",
    "turnId",
    "proposalId",
    "decisionToken",
    "toolId",
    "reviewDigest"
  ])) return undefined;
  if (
    !isUuid(value.sessionId) ||
    !isUuid(value.turnId) ||
    !isUuid(value.proposalId) ||
    !isUuid(value.decisionToken) ||
    !isBoundedString(value.toolId, HOST_MESSAGE_LIMITS.identifier, false, true) ||
    typeof value.reviewDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.reviewDigest)
  ) return undefined;
  return {
    sessionId: value.sessionId,
    turnId: value.turnId,
    proposalId: value.proposalId,
    decisionToken: value.decisionToken,
    toolId: value.toolId,
    reviewDigest: value.reviewDigest
  };
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** Parse an untrusted message entering the extension host from the side webview. */
export function parseSideToExt(raw: unknown): SideToExt | undefined {
  if (
    !isObject(raw)
    || !hasOwn(raw, "type")
    || !isBoundedString(raw.type, HOST_MESSAGE_LIMITS.type, false, true)
  ) return undefined;
  switch (raw.type) {
    case "ready":
    case "newChat":
    case "editSafeCommandsJson":
    case "restoreDefaultSafeCommands":
    case "resetAllDefaults":
      return hasExactKeys(raw, ["type"]) ? { type: raw.type } : undefined;
    case "openChat":
    case "deleteChat":
      return hasExactKeys(raw, ["type", "id"]) && typeof raw.id === "string" && isValidChatId(raw.id)
        ? { type: raw.type, id: raw.id }
        : undefined;
    case "openTab":
      return hasExactKeys(raw, ["type", "tab"]) && isSideTab(raw.tab)
        ? { type: "openTab", tab: raw.tab }
        : undefined;
    case "validateEndpoint":
      return exactBoundedStringMessage(raw, "url", HOST_MESSAGE_LIMITS.endpointUrl, false, true)
        ? { type: "validateEndpoint", url: raw.url }
        : undefined;
    case "saveSetting":
      return parseSideSetting(raw);
    default:
      return undefined;
  }
}

function parseSideSetting(raw: Record<string, unknown>): SideToExt | undefined {
  if (!hasExactKeys(raw, ["type", "key", "value"]) || typeof raw.key !== "string") return undefined;
  const value = raw.value;
  switch (raw.key) {
    case "modelFamily":
      return value === "gemma4" || value === "qwen3"
        ? { type: "saveSetting", key: "modelFamily", value }
        : undefined;
    case "contextSize":
      return isIntegerInRange(value, 1, Number.MAX_SAFE_INTEGER)
        ? { type: "saveSetting", key: "contextSize", value }
        : undefined;
    case "temperature":
      return isNumberInRange(value, 0, 2)
        ? { type: "saveSetting", key: "temperature", value }
        : undefined;
    case "topK":
      return isIntegerInRange(value, 0, Number.MAX_SAFE_INTEGER)
        ? { type: "saveSetting", key: "topK", value }
        : undefined;
    case "topP":
      return isNumberInRange(value, 0, 1)
        ? { type: "saveSetting", key: "topP", value }
        : undefined;
    case "autoCompact":
    case "autoapproveReads":
    case "autoapproveWrites":
      return typeof value === "boolean" ? { type: "saveSetting", key: raw.key, value } : undefined;
    case "autoCompactThresholdPercent":
      return isIntegerInRange(value, 50, 95)
        ? { type: "saveSetting", key: "autoCompactThresholdPercent", value }
        : undefined;
    default:
      // endpoint, safeCommands, and command approval have dedicated or disabled flows.
      return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(raw: Record<string, unknown>, allowed: readonly string[]): boolean {
  if (Object.keys(raw).length !== allowed.length) return false;
  return allowed.every(key => Object.prototype.hasOwnProperty.call(raw, key));
}

function hasOnlyKeys(raw: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(raw).every(key => keys.has(key));
}

function hasOwn(raw: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(raw, key);
}

function exactBoundedStringMessage<K extends string>(
  raw: Record<string, unknown>,
  key: K,
  maxLength: number,
  allowEmpty = false,
  rejectNul = false
): raw is Record<"type" | K, string> {
  return hasExactKeys(raw, ["type", key])
    && isBoundedString(raw[key], maxLength, allowEmpty, rejectNul);
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

function isSideTab(value: unknown): value is SideTab {
  return value === "welcome" || value === "chats" || value === "settings";
}

function isNumberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return isNumberInRange(value, min, max) && Number.isSafeInteger(value);
}
