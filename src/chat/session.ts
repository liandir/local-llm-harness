import * as path from "node:path";
import * as fs from "node:fs/promises";
import {
  fetchServerContextSize,
  MalformedNativeToolCallError,
  NativeToolsUnsupportedError,
  streamChat,
  tokenize,
  type LlmMessage
} from "../llm/client.js";
import { buildSystemPrompt, coalesceSameRole, renderToolCallForPrompt } from "../llm/prompt.js";
import { loadRootAgentsMd } from "../llm/agentsMd.js";
import { makeNativeTextRecoveryParser, makeParser, type ParsedEvent } from "../llm/parser/index.js";
import { ALLOWED_TOOL_NAMES, classifyToolName } from "../tools/forbiddenTools.js";
import { checkSafeCommand, type SafeCommandEntry } from "../tools/safeCommands.js";
import {
  readFile,
  formatFileForModel,
  countLogicalLines,
  editRegionSnippet,
  looksLikeNumberedReadOutput,
  writeFile,
  createFile,
  editFile,
  previewEditFile,
  insertText,
  replaceRange,
  listDir,
  glob,
  type InsertTextArgs,
  type ReadFileArgs,
  type ReplaceRangeArgs
} from "../tools/fsTools.js";
import { assertInsideWorkspace } from "../tools/workspaceGuard.js";
import { runCommand, runProcess } from "../tools/terminalTool.js";
import { readSettings, type HarnessSettings } from "../config/settings.js";
import { ChatStorage, type ChatMessage, type ChatRecord } from "./storage.js";
import { normalizeTodos, renderTodosMarkdown, todoCounts } from "./todos.js";
import { compact, compactAvailableForMessageCount, KEEP_TAIL, MIN_COMPACT_MESSAGES, type CompactConfig } from "./compactor.js";
import { countTokens, promptTokens, recomputeTokens, truncateToTokenBudget } from "./contextTracker.js";
import { lineDiffStats, renderLineDiff } from "./diffPreview.js";
import { rememberFileWrite, summarizeFileChanges, type FileChangeSummary, type TrackedFileWrite } from "./fileChanges.js";
import { generateChatTitle } from "./chatTitle.js";
import { asOpenAiTools, toolsForMode, validateToolArguments } from "../tools/toolDefinitions.js";

/** Events the session emits to the chat webview. */
export type UiEvent =
  | { kind: "userMessage"; messageId: string; messageTs: number; text: string }
  | { kind: "turnStart"; messageId: string }
  | { kind: "text"; messageId: string; delta: string }
  | { kind: "thought"; messageId: string; delta: string }
  | { kind: "toolCallProgress"; toolId: string; messageId: string; toolName: string; path?: string; contentLines: number; added?: number; removed?: number; createsNewFile?: boolean; replacedLines?: number; startLine?: number; endLine?: number; line?: number }
  | { kind: "toolCallProposed"; toolId: string; messageId: string; toolName: string; argsJson: string; category: ToolCategory; approvalRequired: boolean; reason?: string; diffPreview?: string; createsNewFile?: boolean }
  | { kind: "toolCallResolved"; toolId: string; status: "approved" | "rejected" | "executed" | "failed"; resultPreview?: string; diffPreview?: string; added?: number; removed?: number; createsNewFile?: boolean }
  | { kind: "fileChanges"; messageId: string; changes: FileChangeSummary[] }
  | { kind: "summary"; messageId: string; text: string }
  | { kind: "planFinal"; messageId: string; markdown: string }
  | { kind: "abort"; reason: string }
  | { kind: "notice"; text: string }
  | { kind: "turnEnd"; messageId: string }
  | { kind: "tokens"; total: number; limit: number }
  | { kind: "titleChanged"; title: string; animate: boolean }
  | { kind: "chatLoaded"; record: ChatRecord }
  | { kind: "chatClosed" }
  | { kind: "compactStatus"; currentMessages: number; minMessages: number; available: boolean }
  | { kind: "compactStart"; compactId: string; source: "manual" | "auto"; beforeTokens: number; beforeMessages: number; keepTail: number }
  | { kind: "compactEnd"; compactId: string; source: "manual" | "auto"; status: "executed" | "failed"; beforeTokens: number; afterTokens?: number; beforeMessages: number; afterMessages?: number; keepTail: number; error?: string }
  | { kind: "planModeChanged"; on: boolean };

export type ToolCategory =
  | "read"      // gray, auto-approve via setting
  | "write"     // gray + approval, auto via setting
  | "todos"     // gray, no approval — UI/state only, allowed in plan mode
  | "safeCmd"   // purple, manual approval always
  | "unsafeCmd" // red, rejected tool result
  | "question"  // gray, interactive — asks the user and waits for an answer
  | "forbidden" // red, abort
  | "unknown"   // red, abort
  | "planViolation"; // red, abort

type PromptMessage = LlmMessage;

type PreparedWriteArgs =
  | { kind: "write_file"; path: string; content: string }
  | { kind: "create_file"; path: string; content: string }
  | { kind: "edit_file"; path: string; baseRevision: string; edits: { oldText: string; newText: string }[] }
  | ({ kind: "insert_text" } & InsertTextArgs)
  | ({ kind: "replace_range" } & ReplaceRangeArgs);

const WRITE_TOOL_NAMES = new Set(["write_file", "create_file", "edit_file", "insert_text", "replace_range"]);
const MAX_EMPTY_NATIVE_RETRIES = 1;
const MAX_MALFORMED_NATIVE_RETRIES = 1;
const EMPTY_NATIVE_REPAIR_NOTE =
  "[harness recovery] The previous generation ended after reasoning without a tool call or final response. " +
  "Continue from the current state by emitting one structured tool call or a final answer.";
const MALFORMED_NATIVE_REPAIR_NOTE =
  "[harness recovery] The server rejected the previous native tool call because its arguments were incomplete or invalid JSON. " +
  "Re-emit one complete structured tool call whose arguments are a valid JSON object, or answer directly.";

function isWriteToolName(name: string): boolean {
  return WRITE_TOOL_NAMES.has(name);
}

function isProcessToolName(name: string): boolean {
  return name === "run_command" || name === "run_process";
}

function toolNeedsApproval(category: ToolCategory, settings: HarnessSettings): boolean {
  switch (category) {
    case "safeCmd": return !settings.autoapproveCommands;
    case "write": return !settings.autoapproveWrites;
    case "read": return !settings.autoapproveReads;
    default: return false;
  }
}

interface PendingApproval {
  resolve(v: { approved: boolean }): void;
}

export class ChatSession {
  private record: ChatRecord;
  private pending = new Map<string, PendingApproval>();
  // ask_user_question parks the turn here until the user answers; the resolver
  // gets the chosen/typed answer, or null if the turn was cancelled first.
  private pendingQuestions = new Map<string, (answer: string | null) => void>();
  private abort: AbortController | undefined;
  private activeTurn: Promise<void> | undefined;
  private titleAbort: AbortController | undefined;
  private titleGeneration = 0;
  private pendingTitle?: {
    firstMessage: string;
    settings: HarnessSettings;
    generation: number;
    originalTitle: string;
  };
  private saveChain: Promise<void> = Promise.resolve();
  private emit: (e: UiEvent) => void;
  private storage: ChatStorage;
  private workspaceRoot: string;
  private activeFileWrites?: Map<string, TrackedFileWrite>;
  private streamingTools = new Map<string, { toolId: string; name: string }>();
  // Last time a live-stat progress frame was emitted per streaming card. The
  // parser yields a frame per token; this rate-limits the live +X/-Y updates.
  private lastProgressEmitAt = new Map<string, number>();
  // The target file's prior state, captured on the first frame of a streaming
  // write_file, so the live +X/-Y can diff the streamed body against it and the
  // card can label a brand-new file "Created file" vs an edit "Edited file".
  private streamingFileState = new Map<string, { exists: boolean; content: string }>();
  private toolDiffSources = new Map<string, TrackedFileWrite>();
  // Net line-count shift per file (abs path) from edits executed in the
  // CURRENT model response. The model emits a whole response blind — it sees
  // tool results only on the next prompt pass — so once an edit shifts a
  // file's line numbers, any later line-addressed edit to that file in the
  // same response was computed from stale numbers and must be rejected.
  // Cleared on every re-prompt (the model has fresh numbers by then).
  private staleLineEdits = new Map<string, number>();
  // Qwen may batch several edits before seeing any result. Permit one
  // line-addressed mutation per model pass, then force a re-prompt so every
  // subsequent range is based on current file contents and line numbers.
  private lineEditRanThisPass = false;
  private writeRanThisPass = false;
  // The context window the server actually runs with (llama.cpp /props); the
  // effective limit is min(configured, server). Refreshed before each request.
  private serverContextSize?: number;
  private systemPromptTokenCache?: { text: string; tokens: number };
  // Last AGENTS.md content loaded for this session. Refreshed (mtime-cached) at
  // the start of every prompt build so the sync buildPromptMessages can read it.
  private agentsMdCache?: string;
  /** Native OpenAI-style tool calls are preferred; only an explicit server rejection enables legacy text parsing. */
  private toolProtocol: "native" | "legacy" = "native";
  private completedCallIds = new Map<string, { name: string; argsJson: string }>();

  constructor(args: {
    storage: ChatStorage;
    workspaceRoot: string;
    record: ChatRecord;
    emit: (e: UiEvent) => void;
  }) {
    this.storage = args.storage;
    this.workspaceRoot = args.workspaceRoot;
    this.record = args.record;
    this.emit = args.emit;
  }

  getRecord(): ChatRecord { return this.record; }

  /** Effective context window: the smaller of the configured size and what the server actually runs with. */
  private contextLimit(): number {
    return this.serverContextSize ?? 0;
  }

  /**
   * Budget handed to the compactor. Its `limit` is the room left for the
   * message transcript AFTER reserving the system prompt (tool catalog) and a
   * small margin for generation priming — the system prompt is not a stored
   * message, so compaction must leave space for it or the assembled prompt
   * overflows even though the messages fit their own budget.
   */
  private async compactConfig(s: HarnessSettings): Promise<CompactConfig> {
    const limit = this.contextLimit();
    const sysTokens = await this.systemPromptTokens(s);
    const messageBudget = Math.max(1024, limit - sysTokens - 256);
    return {
      limit: messageBudget,
      thresholdPercent: s.autoCompactThresholdPercent,
      tailBudgetPercent: s.tailBudgetPercent,
      maxMessageTokensPercent: s.maxMessageTokensPercent,
      overheadPerMessage: s.templateOverheadTokensPerMessage
    };
  }

  /**
   * Tokens of the system prompt (tool catalog included). It is rebuilt for
   * every request but never stored as a message, so recomputeTokens cannot see
   * it — without this the ring undercounts by a fixed chunk.
   */
  private async systemPromptTokens(s: HarnessSettings): Promise<number> {
    const nativeTools = s.toolCallingMode === "native"
      || (s.toolCallingMode === "auto" && this.toolProtocol === "native");
    const text = buildSystemPrompt({
      family: this.record.modelFamily,
      planMode: this.record.planMode,
      workspaceRoot: this.workspaceRoot,
      agentsMd: await this.currentAgentsMd(),
      nativeTools
    });
    const catalog = nativeTools
      ? `\n<tools>${JSON.stringify(asOpenAiTools(toolsForMode(this.record.planMode, "native")))}</tools>`
      : "";
    const countedText = text + catalog;
    if (this.systemPromptTokenCache?.text !== countedText) {
      this.systemPromptTokenCache = { text: countedText, tokens: await tokenize(s.endpoint, `<|system|>${countedText}`) };
    }
    return this.systemPromptTokenCache.tokens;
  }

  /** Sync best-effort variant for mid-stream estimates; 0 until first computed. */
  private cachedSystemPromptTokens(): number {
    return this.systemPromptTokenCache?.tokens ?? 0;
  }

  /**
   * Load (mtime-cached) the project's root AGENTS.md and remember it for the
   * sync buildPromptMessages. Called ahead of every prompt build via
   * systemPromptTokens, so the cached value matches what is actually sent.
   */
  private async currentAgentsMd(): Promise<string | undefined> {
    this.agentsMdCache = await loadRootAgentsMd(this.workspaceRoot);
    return this.agentsMdCache;
  }

  /** Sync accessor for the value loaded by the most recent currentAgentsMd call. */
  private cachedAgentsMd(): string | undefined {
    return this.agentsMdCache;
  }

  private async refreshServerContextSize(s: HarnessSettings): Promise<boolean> {
    const serverCtx = await fetchServerContextSize(s.endpoint);
    if (serverCtx === undefined) return false;
    this.serverContextSize = serverCtx;
    return true;
  }

  emitLoaded(): void {
    this.emit({ kind: "chatLoaded", record: this.record });
    if (this.serverContextSize !== undefined) {
      this.emit({ kind: "tokens", total: this.record.totalTokens + this.cachedSystemPromptTokens(), limit: this.contextLimit() });
    }
    this.emit({ kind: "planModeChanged", on: this.record.planMode });
    this.emitCompactStatus();
  }

  setPlanMode(on: boolean): void {
    this.record.planMode = on;
    this.emit({ kind: "planModeChanged", on });
    void this.saveRecord();
  }

  async renameTitle(title: string): Promise<void> {
    const next = title.trim();
    if (!next || next === this.record.title) return;
    this.cancelPendingTitle();
    this.record.title = next;
    await this.saveRecord();
  }

  async compactNow(source: "manual" | "auto" = "manual"): Promise<void> {
    await this.runCompact(source, { reload: true });
  }

  private async runCompact(source: "manual" | "auto", options: { reload: boolean }): Promise<boolean> {
    if (!compactAvailableForMessageCount(this.record.messages.length)) {
      this.emitCompactStatus();
      return false;
    }
    const s = readSettings();
    if (!(await this.refreshServerContextSize(s))) {
      this.emit({ kind: "notice", text: "Could not read the server context length from llama.cpp /props. Save a valid endpoint in Settings and try again." });
      return false;
    }
    await recomputeTokens(s.endpoint, this.record);
    const before = this.record.totalTokens;
    const beforeMessages = this.record.messages.length;
    const compactId = `compact_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const ac = new AbortController();
    this.emit({ kind: "compactStart", compactId, source, beforeTokens: before, beforeMessages, keepTail: KEEP_TAIL });
    try {
      const cfg = await this.compactConfig(s);
      const { keptTail } = await compact(s.endpoint, this.record, ac.signal, cfg);
      await this.saveRecord();
      if (options.reload) this.emit({ kind: "chatLoaded", record: this.record });
      this.emit({ kind: "tokens", total: this.record.totalTokens + this.cachedSystemPromptTokens(), limit: this.contextLimit() });
      this.emitCompactStatus();
      this.emit({
        kind: "compactEnd",
        compactId,
        source,
        status: "executed",
        beforeTokens: before,
        afterTokens: this.record.totalTokens,
        beforeMessages,
        afterMessages: this.record.messages.length,
        keepTail: keptTail
      });
      return true;
    } catch (err) {
      this.emit({
        kind: "compactEnd",
        compactId,
        source,
        status: "failed",
        beforeTokens: before,
        beforeMessages,
        keepTail: KEEP_TAIL,
        error: (err as Error).message
      });
      return false;
    }
  }

  async compactAfterInterrupt(): Promise<void> {
    this.cancel();
    const turn = this.activeTurn;
    if (turn) await turn.catch(() => undefined);
    await this.compactNow("manual");
  }

  cancel(): void {
    this.abort?.abort();
    this.cancelPendingTitle();
    for (const p of this.pending.values()) p.resolve({ approved: false });
    this.pending.clear();
    for (const resolve of this.pendingQuestions.values()) resolve(null);
    this.pendingQuestions.clear();
  }

  private saveRecord(): Promise<void> {
    const save = this.saveChain.then(() => this.storage.save(this.record));
    this.saveChain = save.catch(() => undefined);
    return save;
  }

  approve(toolId: string, approved: boolean): void {
    const p = this.pending.get(toolId);
    if (p) {
      this.pending.delete(toolId);
      p.resolve({ approved });
    }
  }

  answerQuestion(toolId: string, answer: string): void {
    const resolve = this.pendingQuestions.get(toolId);
    if (resolve) {
      this.pendingQuestions.delete(toolId);
      resolve(answer);
    }
  }

  requestToolDiff(toolId: string): void {
    const change = this.toolDiffSources.get(toolId);
    if (!change) return;
    const diffPreview = change.diffPreview ?? renderLineDiff(change.previous, change.next);
    change.diffPreview = diffPreview;
    this.emit({ kind: "toolCallResolved", toolId, status: "executed", diffPreview });
  }

  async sendUserMessage(text: string): Promise<void> {
    if (this.activeTurn) {
      this.emit({ kind: "notice", text: "A chat turn is already running. Wait for it to finish or cancel it before sending another message." });
      return;
    }

    const turn = this.sendUserMessageLocked(text);
    this.activeTurn = turn;
    try {
      await turn;
    } finally {
      if (this.activeTurn === turn) this.activeTurn = undefined;
    }
  }

  async editUserMessage(messageTs: number, text: string): Promise<void> {
    if (this.activeTurn) {
      this.emit({ kind: "notice", text: "Wait for the current response to finish before editing an earlier message." });
      return;
    }

    const turn = this.editUserMessageLocked(messageTs, text);
    this.activeTurn = turn;
    try {
      await turn;
    } finally {
      if (this.activeTurn === turn) this.activeTurn = undefined;
    }
  }

  private async sendUserMessageLocked(text: string): Promise<void> {
    const s = readSettings();
    const isFirstMessage = this.record.messages.length === 0;
    if (isFirstMessage) {
      this.record.modelFamily = s.modelFamily;
    }
    const ts = Date.now();
    this.record.messages.push({ role: "user", content: text, ts });
    await this.saveRecord();
    this.emit({ kind: "userMessage", messageId: `u_${ts}`, messageTs: ts, text });
    this.emitCompactStatus();

    if (isFirstMessage) this.queueTitleGeneration(text, s);

    if (!(await this.prepareContextForModelRequest(s, { reload: true }))) return;

    await this.runTurn(s);
  }

  private async editUserMessageLocked(messageTs: number, text: string): Promise<void> {
    const index = this.record.messages.findIndex(
      message => message.role === "user" && message.ts === messageTs
    );
    if (index < 0) {
      this.emit({ kind: "notice", text: "That message is no longer present in this chat." });
      return;
    }

    const edited = this.record.messages[index];
    edited.content = text;
    delete edited.tokens;
    this.record.messages = this.record.messages.slice(0, index + 1);
    this.record.totalTokens = this.record.messages.reduce(
      (total, message) => total + (message.tokens ?? 0),
      0
    );
    this.toolDiffSources.clear();
    await this.saveRecord();
    this.emit({ kind: "chatLoaded", record: this.record });

    const s = readSettings();
    if (index === 0) this.queueTitleGeneration(text, s);
    if (!(await this.prepareContextForModelRequest(s, { reload: true }))) return;
    await this.runTurn(s);
  }

  private queueTitleGeneration(firstMessage: string, settings: HarnessSettings): void {
    this.cancelPendingTitle();
    this.pendingTitle = {
      firstMessage,
      settings,
      generation: this.titleGeneration,
      originalTitle: this.record.title
    };
  }

  /**
   * Start auxiliary naming only after the real completion has been accepted.
   * The chat therefore reaches llama.cpp's queue first when every slot is busy,
   * while servers with spare slots can decode the title in parallel.
   */
  private startPendingTitle(): void {
    const pending = this.pendingTitle;
    if (!pending) return;
    this.pendingTitle = undefined;
    const controller = new AbortController();
    this.titleAbort = controller;
    void generateChatTitle(pending.firstMessage, pending.settings, controller.signal)
      .then(async title => {
        if (
          !title
          || controller.signal.aborted
          || pending.generation !== this.titleGeneration
          || this.record.title !== pending.originalTitle
          || this.record.messages[0]?.role !== "user"
          || this.record.messages[0].content !== pending.firstMessage
        ) return;
        this.record.title = title;
        await this.saveRecord();
        if (pending.generation !== this.titleGeneration) return;
        this.emit({ kind: "titleChanged", title, animate: true });
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.titleAbort === controller) this.titleAbort = undefined;
      });
  }

  private cancelPendingTitle(): void {
    this.titleGeneration++;
    this.pendingTitle = undefined;
    this.titleAbort?.abort();
    this.titleAbort = undefined;
  }

  /**
   * Cheap, network-free token estimate emitted at mid-turn checkpoints
   * (thought→text transitions, tool round-trips) so the context ring
   * updates without waiting for the authoritative /tokenize call at turnEnd.
   * Cached message tokens are exact; uncached and live buffer use char/4.
   */
  private emitLiveTokenEstimate(liveText: string): void {
    let total = this.cachedSystemPromptTokens();
    for (const m of this.record.messages) {
      total += m.tokens ?? Math.ceil((m.content.length + (m.reasoningContent?.length ?? 0)) / 4);
    }
    if (liveText) total += Math.ceil(liveText.length / 4);
    this.emit({ kind: "tokens", total, limit: this.contextLimit() });
  }

  private async prepareContextForModelRequest(
    s: HarnessSettings,
    options: { reload: boolean }
  ): Promise<boolean> {
    if (!(await this.refreshServerContextSize(s))) {
      this.emit({ kind: "abort", reason: "The LLM server is unavailable or its /props response is invalid. Check that llama.cpp is running, then verify the endpoint in Settings and try again." });
      return false;
    }
    await recomputeTokens(s.endpoint, this.record);
    const sysTokens = await this.systemPromptTokens(s);
    const limit = this.contextLimit();
    this.emit({ kind: "tokens", total: this.record.totalTokens + sysTokens, limit });
    this.emitCompactStatus();

    if (s.autoCompact && this.record.totalTokens + sysTokens >= autoCompactTriggerTokens(limit, s.autoCompactThresholdPercent)) {
      await this.runCompact("auto", options);
    }

    if (this.record.totalTokens + sysTokens >= limit) {
      this.emit({ kind: "abort", reason: contextWindowOverflowMessage(this.record.totalTokens + sysTokens, limit) });
      return false;
    }

    return true;
  }

  private async buildPromptMessagesForRequest(
    s: HarnessSettings,
    options: { reload: boolean; nativeRepairNote?: string }
  ): Promise<PromptMessage[] | undefined> {
    if (!(await this.prepareContextForModelRequest(s, options))) return undefined;

    const limit = this.contextLimit();
    let messages = this.buildPromptMessages();
    if (options.nativeRepairNote) messages = withNativeRepair(messages, options.nativeRepairNote);
    // Count the tokens of the prompt that is ACTUALLY sent (system prompt +
    // re-rendered tool calls + wrapped results), not the sum of stored
    // messages, using llama.cpp's tokenizer. This is the number the server
    // sees, so the guard no longer passes while the server overflows.
    let promptTok = await promptTokens(s.endpoint, this.messagesForTokenCount(messages), s.templateOverheadTokensPerMessage);
    if (s.autoCompact && promptTok >= autoCompactTriggerTokens(limit, s.autoCompactThresholdPercent)) {
      const compacted = await this.runCompact("auto", options);
      if (compacted) {
        messages = this.buildPromptMessages();
        if (options.nativeRepairNote) messages = withNativeRepair(messages, options.nativeRepairNote);
        promptTok = await promptTokens(s.endpoint, this.messagesForTokenCount(messages), s.templateOverheadTokensPerMessage);
      }
    }

    this.emit({ kind: "tokens", total: promptTok, limit });
    if (promptTok >= limit) {
      this.emit({ kind: "abort", reason: promptOverflowMessage(promptTok, limit) });
      return undefined;
    }

    return messages;
  }

  private messagesForTokenCount(messages: PromptMessage[]): PromptMessage[] {
    if (this.toolProtocol !== "native") return messages;
    return [
      ...messages,
      {
        role: "system",
        content: `<tools>${JSON.stringify(asOpenAiTools(toolsForMode(this.record.planMode, "native")))}</tools>`
      }
    ];
  }

  private async appendToolResult(
    s: HarnessSettings,
    toolName: string,
    argsJson: string,
    content: string,
    callId?: string
  ): Promise<string> {
    const guardedContent = await this.prepareToolResultForContext(s, toolName, content);
    const message: ChatMessage = {
      role: "tool",
      content: guardedContent,
      toolCall: { id: callId ?? newToolCallId(), name: toolName, argsJson },
      ts: Date.now()
    };
    // Exact count via /tokenize — a char/4 estimate here becomes the permanent
    // cached count (recomputeTokens skips already-counted messages), and tool
    // results are the largest messages, so under-counting them is what let the
    // context silently overrun and hard-abort.
    message.tokens = await countTokens(s.endpoint, `<|tool|>${guardedContent}`);
    this.record.messages.push(message);
    if (callId) this.completedCallIds.set(callId, { name: toolName, argsJson });
    this.record.totalTokens += message.tokens;
    await this.saveRecord();
    this.emitLiveTokenEstimate("");
    this.emitCompactStatus();
    return guardedContent;
  }

  private async prepareToolResultForContext(
    s: HarnessSettings,
    toolName: string,
    content: string
  ): Promise<string> {
    await recomputeTokens(s.endpoint, this.record);
    const sysTokens = await this.systemPromptTokens(s);
    const limit = this.contextLimit();
    const overhead = s.templateOverheadTokensPerMessage;
    const toolTokens = await countTokens(s.endpoint, `<|tool|>${content}`);
    let projectedTokens = this.record.totalTokens + sysTokens + toolTokens + overhead;

    if (s.autoCompact && projectedTokens >= autoCompactTriggerTokens(limit, s.autoCompactThresholdPercent)) {
      await this.runCompact("auto", { reload: false });
      projectedTokens = this.record.totalTokens + sysTokens + toolTokens + overhead;
    }

    // A single result may never exceed its per-message cap, nor the room that
    // is actually left after the rest of the context. If it would, middle-
    // truncate it (with a marker) so the turn continues instead of aborting.
    const perMsgCap = Math.max(256, Math.floor((limit * s.maxMessageTokensPercent) / 100));
    const remaining = limit - (this.record.totalTokens + sysTokens + overhead) - 64;
    const budget = Math.min(perMsgCap, remaining);
    if (toolTokens > budget) {
      const r = await truncateToTokenBudget(s.endpoint, content, Math.max(128, budget));
      return `${r.text}\n[context guard] ${toolName} output was truncated to fit the context window. ` +
        `Request a narrower read (read_file with startLine/endLine), a more specific search, or a command with limited output for the full detail.`;
    }

    return content;
  }

  private async runTurn(s: HarnessSettings): Promise<void> {
    if (s.toolCallingMode === "legacy") this.toolProtocol = "legacy";
    else if (s.toolCallingMode === "native") this.toolProtocol = "native";
    this.abort = new AbortController();
    const messageId = `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.emit({ kind: "turnStart", messageId });

    let assistantBuf = "";
    let thoughtBuf = "";
    let finishReason: string | undefined;
    let ranAnyTool = false;
    let emptyNativeRetries = 0;
    let malformedNativeRetries = 0;
    let nativeRepairNote: string | undefined;
    this.completedCallIds.clear();
    // Events stamped with a wall-clock time so the webview can restore real
    // "Thought for Ns" / "Worked for Ns" durations after a reload.
    const turnEvents: (ParsedEvent & { t?: number })[] = [];
    const fileWrites = new Map<string, TrackedFileWrite>();
    this.activeFileWrites = fileWrites;
    this.streamingTools.clear();
    this.lastProgressEmitAt.clear();
    this.streamingFileState.clear();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      finishReason = undefined;
      const parser = makeParser(this.record.modelFamily);
      const nativeTextRecovery = this.toolProtocol === "native"
        ? makeNativeTextRecoveryParser()
        : undefined;
      const nativeThoughtRecovery = this.toolProtocol === "native"
        ? makeNativeTextRecoveryParser()
        : undefined;
      let aborted = false;
      let toolLoop = false;
      // Every pass re-prompts with the previous pass's tool results, so the
      // model has current line numbers again — reset the staleness tracking.
      this.staleLineEdits.clear();
      this.lineEditRanThisPass = false;
      this.writeRanThisPass = false;
      const messages = await this.buildPromptMessagesForRequest(s, {
        reload: false,
        nativeRepairNote
      });
      nativeRepairNote = undefined;
      if (!messages) {
        break;
      }

      try {
        for await (const chunk of streamChat(
          s.endpoint,
          {
            messages,
            temperature: s.temperature,
            top_k: s.topK,
            top_p: s.topP,
            tools: this.toolProtocol === "native" ? asOpenAiTools(toolsForMode(this.record.planMode, "native")) : undefined,
            tool_choice: "auto",
            parallel_tool_calls: false,
            onResponseAccepted: () => this.startPendingTitle()
          },
          this.abort.signal
        )) {
          if (chunk.kind === "thought") {
            // Qwen can leak the same template-native function envelope through
            // reasoning_content as well as visible content. Preserve all
            // ordinary recovery-parser text as thought, but execute an exact
            // function XML envelope through the normal guarded tool path.
            const events: ParsedEvent[] = nativeThoughtRecovery
              ? asThoughtEvents(nativeThoughtRecovery.feed(chunk.text))
              : [{ kind: "thought", text: chunk.text }];
            const continueAfter = await this.handleEvents(events, messageId, s);
            let sawToolInBatch = false;
            for (const e of events) {
              if (e.kind === "toolCall") sawToolInBatch = true;
              if (!sawToolInBatch && e.kind === "thought") thoughtBuf += e.text;
              if (e.kind !== "toolCallProgress") turnEvents.push({ ...e, t: Date.now() });
            }
            if (!continueAfter.continue) {
              aborted = continueAfter.abort ?? false;
              toolLoop = continueAfter.toolLoop ?? false;
              break;
            }
            continue;
          }
          if (chunk.kind === "toolCall") {
            // Structured tool call from the server (--jinja templates).
            const ev: ParsedEvent = { kind: "toolCall", name: chunk.name, argsJson: chunk.argsJson, id: chunk.id };
            const res = await this.handleEvents([ev], messageId, s);
            turnEvents.push({ ...ev, t: Date.now() });
            if (res.abort) {
              aborted = true;
              break;
            }
            if (res.toolLoop) toolLoop = true;
            // Keep consuming: llama.cpp flushes ALL structured tool calls at
            // the end of the stream, so breaking here (as the text path does)
            // would silently drop every call after the first. The stream is
            // effectively over at this point; reading on costs nothing.
            continue;
          }
          if (chunk.kind === "toolCallProgress") {
            const ev: ParsedEvent = {
              kind: "toolCallProgress",
              name: chunk.name,
              path: chunk.path,
              content: chunk.content,
              contentBytes: chunk.contentBytes,
              contentLines: chunk.contentLines,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              id: chunk.id
            };
            await this.handleEvents([ev], messageId, s);
            continue;
          }
          if (chunk.kind === "finish") {
            finishReason = chunk.reason;
            continue;
          }
          // Native mode normally executes only the protocol's `tool_calls`
          // channel. Qwen3-Coder can intermittently leak its own exact
          // <tool_call><function=...> template dialect through content;
          // recover only that envelope, while leaving JSON examples and other
          // tool-looking prose as visible data.
          const events: ParsedEvent[] = this.toolProtocol === "native"
            ? (nativeTextRecovery?.feed(chunk.text) ?? [{ kind: "text", text: chunk.text }])
            : parser.feed(chunk.text);
          const continueAfter = await this.handleEvents(events, messageId, s);
          let sawToolInBatch = false;
          for (const e of events) {
            const prev = turnEvents[turnEvents.length - 1];
            if (prev?.kind === "thought" && e.kind !== "thought" && e.kind !== "done") {
              this.emitLiveTokenEstimate(assistantBuf + thoughtBuf);
            }
            if (e.kind === "toolCall") sawToolInBatch = true;
            if (!sawToolInBatch && e.kind === "text") assistantBuf += e.text;
            if (!sawToolInBatch && e.kind === "thought") thoughtBuf += e.text;
            if (e.kind !== "toolCallProgress") turnEvents.push({ ...e, t: Date.now() });
          }
          if (!continueAfter.continue) {
            aborted = continueAfter.abort ?? false;
            toolLoop = continueAfter.toolLoop ?? false;
            break;
          }
        }
        if (!aborted) {
          const tail = this.toolProtocol === "native"
            ? [
                ...asThoughtEvents(nativeThoughtRecovery?.end() ?? []).filter(event => event.kind !== "done"),
                ...(nativeTextRecovery?.end() ?? [{ kind: "done" } as ParsedEvent])
              ]
            : parser.end();
          const continueAfterTail = await this.handleEvents(tail, messageId, s);
          let sawToolInTail = false;
          for (const e of tail) {
            const prev = turnEvents[turnEvents.length - 1];
            if (prev?.kind === "thought" && e.kind !== "thought" && e.kind !== "done") {
              this.emitLiveTokenEstimate(assistantBuf + thoughtBuf);
            }
            if (e.kind === "toolCall") sawToolInTail = true;
            if (!sawToolInTail && e.kind === "text") assistantBuf += e.text;
            if (!sawToolInTail && e.kind === "thought") thoughtBuf += e.text;
            if (e.kind !== "toolCallProgress") turnEvents.push({ ...e, t: Date.now() });
          }
          aborted = continueAfterTail.abort ?? false;
          toolLoop = toolLoop || (continueAfterTail.toolLoop ?? false);
        }
      } catch (e) {
        if (
          e instanceof NativeToolsUnsupportedError
          && this.toolProtocol === "native"
          && s.toolCallingMode === "auto"
        ) {
          this.toolProtocol = "legacy";
          this.emit({
            kind: "notice",
            text: "This llama.cpp server rejected native tool calling. Using the configured legacy model adapter for this chat; start llama-server with --jinja and a tool-aware chat template to enable structured calls."
          });
          continue;
        }
        if (
          e instanceof MalformedNativeToolCallError
          && this.toolProtocol === "native"
          && malformedNativeRetries < MAX_MALFORMED_NATIVE_RETRIES
        ) {
          malformedNativeRetries++;
          nativeRepairNote = MALFORMED_NATIVE_REPAIR_NOTE;
          console.warn(
            `[harness] server rejected native tool-call JSON; retry=${malformedNativeRetries}/${MAX_MALFORMED_NATIVE_RETRIES}`
          );
          this.emit({
            kind: "notice",
            text: `The server rejected malformed native tool arguments. Retrying once with a format correction (${malformedNativeRetries}/${MAX_MALFORMED_NATIVE_RETRIES})…`
          });
          assistantBuf = "";
          thoughtBuf = "";
          this.emitLiveTokenEstimate("");
          continue;
        }
        this.emit({ kind: "abort", reason: (e as Error).message });
        aborted = true;
      }

      // The model truncated mid-tool-call (an unclosed write_file the parser
      // dropped). Feed the error back as a tool result and re-prompt so the
      // agent can re-emit the call, instead of stopping with a dead red card.
      if (!aborted && this.streamingTools.size > 0) {
        await this.feedBackIncompleteStreamingTools(s);
        toolLoop = true;
      }

      // If a tool ran this iteration, the LLM needs another pass; otherwise we are done.
      if (aborted) break;
      if (toolLoop) {
        ranAnyTool = true;
        // Native interleaved-thinking models require the reasoning that led to
        // a tool call to be replayed on that same assistant tool-call message.
        // It is stored after the tool results in our execution-oriented record
        // and moved back beside the calls by buildNativePromptMessages.
        if (assistantBuf.trim() || (this.toolProtocol === "native" && thoughtBuf.trim())) {
          this.record.messages.push({
            role: "assistant",
            content: assistantBuf,
            reasoningContent: this.toolProtocol === "native" ? thoughtBuf || undefined : undefined,
            events: turnEvents.splice(0),
            ts: Date.now()
          });
        }
        assistantBuf = "";
        thoughtBuf = "";
        turnEvents.length = 0;
        await this.saveRecord();
        this.emitLiveTokenEstimate("");
        continue;
      }
      if (
        this.toolProtocol === "native"
        && !assistantBuf.trim()
        && thoughtBuf.trim()
        && emptyNativeRetries < MAX_EMPTY_NATIVE_RETRIES
      ) {
        emptyNativeRetries++;
        nativeRepairNote = EMPTY_NATIVE_REPAIR_NOTE;
        console.warn(
          `[harness] native empty turn after reasoning; retry=${emptyNativeRetries}/${MAX_EMPTY_NATIVE_RETRIES} ` +
          `finish_reason=${finishReason ?? "none"}`
        );
        this.emit({
          kind: "notice",
          text: `The model stopped after thinking without a reply. Retrying native continuation (${emptyNativeRetries}/${MAX_EMPTY_NATIVE_RETRIES})…`
        });
        thoughtBuf = "";
        this.emitLiveTokenEstimate("");
        continue;
      }
      // Done — flush the final assistant message, or report an empty turn.
      const fileChanges = summarizeFileChanges(fileWrites.values());
      if (assistantBuf.trim()) {
        if (this.record.planMode) {
          this.emit({ kind: "planFinal", messageId, markdown: assistantBuf });
        } else {
          this.emit({ kind: "summary", messageId, text: extractSummary(assistantBuf) });
        }
        const assistantMessage: ChatMessage = {
          role: "assistant",
          content: assistantBuf,
          reasoningContent: this.toolProtocol === "native" ? thoughtBuf || undefined : undefined,
          events: turnEvents,
          ts: Date.now()
        };
        if (fileChanges.length > 0) assistantMessage.fileChanges = fileChanges;
        this.record.messages.push(assistantMessage);
      } else {
        // The model ended its turn with no visible reply — it stopped after
        // thinking, emitted an incomplete tool call, or hit a stop-token /
        // template mismatch. Surface it instead of leaving silent, unfinished
        // work; the diagnostic line helps pin which case it was.
        console.warn(
          `[harness] empty turn: ranAnyTool=${ranAnyTool} thoughtChars=${thoughtBuf.trim().length} events=[${turnEvents.map(e => e.kind).join(",")}]`
        );
        this.emit({
          kind: "notice",
          text: emptyTurnNotice(ranAnyTool, !!thoughtBuf.trim(), finishReason, emptyNativeRetries > 0)
        });
      }
      if (fileChanges.length > 0) {
        this.emit({ kind: "fileChanges", messageId, changes: fileChanges });
      }
      break;
    }

    this.activeFileWrites = undefined;
    this.failUnfinishedStreamingTools();
    await this.saveRecord();
    await recomputeTokens(s.endpoint, this.record);
    this.emit({ kind: "tokens", total: this.record.totalTokens + this.cachedSystemPromptTokens(), limit: this.contextLimit() });
    this.emitCompactStatus();
    this.emit({ kind: "turnEnd", messageId });
  }

  private emitCompactStatus(): void {
    const currentMessages = this.record.messages.length;
    this.emit({
      kind: "compactStatus",
      currentMessages,
      minMessages: MIN_COMPACT_MESSAGES,
      available: compactAvailableForMessageCount(currentMessages)
    });
  }

  /** Returns { continue, abort?, toolLoop? } */
  private async handleEvents(
    events: ParsedEvent[],
    messageId: string,
    s: HarnessSettings
  ): Promise<{ continue: boolean; abort?: boolean; toolLoop?: boolean }> {
    let toolLoop = false;
    for (const e of events) {
      if (e.kind === "text") {
        // Suppress any text emitted after a tool call in this batch: it was
        // generated before the tool results existed and is superseded by the
        // next pass.
        if (e.text && !toolLoop) this.emit({ kind: "text", messageId, delta: e.text });
      } else if (e.kind === "thought") {
        if (e.text && !toolLoop) this.emit({ kind: "thought", messageId, delta: e.text });
      } else if (e.kind === "toolCallProgress") {
        await this.handleToolCallProgress(e, messageId);
      } else if (e.kind === "toolCall") {
        const verdict = await this.handleToolCall(e, messageId, s);
        if (verdict === "aborted") {
          return { continue: false, abort: true, toolLoop };
        }
        // Keep going so every tool call in this batch runs (don't drop the rest).
        toolLoop = true;
      } else if (e.kind === "done") {
        return { continue: false, toolLoop };
      }
    }
    // If any tool ran, stop reading and re-prompt with the results.
    if (toolLoop) return { continue: false, toolLoop: true };
    return { continue: true };
  }

  private async handleToolCall(
    e: Extract<ParsedEvent, { kind: "toolCall" }>,
    messageId: string,
    s: HarnessSettings
  ): Promise<"executed" | "aborted"> {
    if (e.id) {
      const completed = this.completedCallIds.get(e.id);
      if (completed) {
        const detail = completed.name === e.name && completed.argsJson === e.argsJson
          ? `Duplicate tool call id "${e.id}" was ignored; that exact call already completed.`
          : `Tool call id collision for "${e.id}" was rejected; the id was already used by another call.`;
        this.emit({ kind: "abort", reason: detail });
        return "aborted";
      }
    }
    // A blank-name call is the parser's representation of malformed or
    // truncated JSON. Its earlier streaming-progress frames can still have
    // identified the intended write tool, so attach the parse failure to that
    // card instead of leaving an "incomplete edit" card plus a second generic
    // tool_call card for the same model output.
    const malformed = !e.name.trim();
    const progressKey = streamingToolKey(messageId, e.name, e.id);
    let streamingToolKeyToDelete = progressKey;
    let streamingTool = this.streamingTools.get(progressKey);
    if (!streamingTool && malformed && this.record.modelFamily === "qwen3" && this.streamingTools.size === 1) {
      const soleStreamingTool = this.streamingTools.entries().next().value as
        [string, { toolId: string; name: string }] | undefined;
      if (soleStreamingTool) {
        streamingToolKeyToDelete = soleStreamingTool[0];
        streamingTool = soleStreamingTool[1];
      }
    }
    const toolId = streamingTool?.toolId ?? `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.streamingTools.delete(streamingToolKeyToDelete);
    const cls = classifyToolName(e.name);
    const availableToolNames = new Set(
      toolsForMode(this.record.planMode, this.toolProtocol).map(tool => tool.name)
    );
    // Blank-name calls are parse failures (invalid tool-call body, or a block
    // cut off mid-stream); they carry the raw body in argsJson. Give them a
    // readable name for the card and the replayed transcript.
    const displayName = malformed ? (streamingTool?.name ?? "tool_call") : e.name;
    let argsJson = malformed ? truncateRawArgs(e.argsJson) : e.argsJson;
    let category: ToolCategory;
    let reason: string | undefined;
    let writeArgs: PreparedWriteArgs | undefined;
    let proposedCreatesNewFile: boolean | undefined;
    let proposedDiffPreview: string | undefined;
    let questionArgs: { question: string; suggestions: string[] } | undefined;
    let args: Record<string, unknown> = {};
    let parsedArgs: unknown;
    let validationError: string | undefined;
    // Set when the call packed several argument objects into one array —
    // applying just the first (the old behavior) silently dropped the rest
    // while the model believed they all ran.
    let multiArgsIssue: string | undefined;
    try {
      parsedArgs = JSON.parse(e.argsJson);
      args = normalizeToolArgs(parsedArgs);
    } catch (err) {
      if (err instanceof MultipleToolArgsError) {
        multiArgsIssue = err.message;
      } else {
        // JSON.parse failed — pass the raw string so normalizeToolArgs can try unwrapping
        // a stringified-JSON shape (`"{...}"`) which JSON.parse refuses at the top level.
        try {
          args = normalizeToolArgs(e.argsJson);
        } catch (err2) {
          if (err2 instanceof MultipleToolArgsError) multiArgsIssue = err2.message;
        }
      }
    }
    if (!malformed && cls === "allowed" && this.toolProtocol === "native") {
      validationError = parsedArgs === undefined
        ? "arguments must be valid JSON."
        : validateToolArguments(e.name, parsedArgs);
    }

    if (malformed) {
      // A streaming write_file card may still be tracking this very call;
      // resolve it here so the post-stream incomplete-tool check doesn't feed
      // back a second error for the same block.
      this.failUnfinishedStreamingTools();
      category = "unknown";
      reason = malformedToolCallReason(e.parseError);
    } else if (cls === "forbidden") {
      category = "forbidden";
      reason = `Tool "${e.name}" is forbidden in this harness (no internet/network tools).`;
    } else if (cls === "unknown") {
      category = "unknown";
      reason = unknownToolReason(e.name);
    } else if (this.record.planMode && (isWriteToolName(e.name) || isProcessToolName(e.name))) {
      category = "planViolation";
      reason = planModeViolationReason(e.name, args);
    } else if (!availableToolNames.has(e.name)) {
      category = "unknown";
      reason = `Tool "${e.name}" is not available in ${this.toolProtocol} ${this.record.planMode ? "plan" : "act"} mode.`;
    } else if (e.name === "update_todos") {
      category = "todos";
    } else if (e.name === "ask_user_question") {
      category = "question";
      try {
        questionArgs = normalizeAskUserQuestionArgs(args, e.argsJson);
        // Hand the card/composer a clean, normalized payload to render.
        argsJson = JSON.stringify(questionArgs);
      } catch (err) {
        reason = (err as Error).message;
      }
    } else if (isProcessToolName(e.name)) {
      const cmd = e.name === "run_process" ? processCommandLine(args) : String(args.command ?? "");
      const check = checkSafeCommand(cmd, s.safeCommands);
      category = check.ok ? "safeCmd" : "unsafeCmd";
      reason = check.ok ? check.reason : unsafeCommandReason(cmd, check.reason, s.safeCommands);
    } else if (isWriteToolName(e.name)) {
      category = "write";
      try {
        writeArgs = normalizeWriteToolArgs(e.name, args, e.argsJson);
        const absolute = await assertInsideWorkspace(this.workspaceRoot, writeArgs.path);
        if (writeArgs.kind === "write_file") {
          try {
            await fs.stat(absolute);
            proposedCreatesNewFile = false;
          } catch {
            proposedCreatesNewFile = true;
          }
        } else if (writeArgs.kind === "create_file") {
          try {
            await fs.stat(absolute);
            throw new Error(`create_file refused to overwrite existing path ${writeArgs.path}; read it and use edit_file.`);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          proposedCreatesNewFile = true;
          proposedDiffPreview = renderLineDiff("", writeArgs.content);
        } else if (writeArgs.kind === "edit_file") {
          const preview = await previewEditFile({ workspaceRoot: this.workspaceRoot }, writeArgs);
          proposedDiffPreview = renderLineDiff(preview.previous, preview.next);
        }
      } catch (err) {
        reason = (err as Error).message;
      }
    } else {
      category = "read";
    }

    // Include the decision in the first UI event. If the webview had to infer
    // it from a transient `pending` status, auto-approved tools would briefly
    // mount approval controls before their execution result arrived.
    const approvalRequired = toolNeedsApproval(category, s);
    this.emit({
      kind: "toolCallProposed",
      toolId,
      messageId,
      toolName: displayName,
      argsJson,
      category,
      approvalRequired,
      reason,
      diffPreview: proposedDiffPreview,
      createsNewFile: proposedCreatesNewFile
    });

    if (validationError) {
      const result = `error: invalid ${e.name} arguments: ${validationError}`;
      this.emit({ kind: "toolCallResolved", toolId, status: "failed", resultPreview: result });
      await this.appendToolResult(s, e.name, e.argsJson, result, e.id);
      return "executed";
    }

    // A multi-object argument array is recoverable but must not half-execute:
    // fail the call with the explanation instead of applying only part of it.
    // update_todos is exempt — a bare array IS its natural shape (handled below).
    if (
      multiArgsIssue &&
      (category === "read" || category === "write" || category === "safeCmd" ||
        category === "unsafeCmd" || category === "question")
    ) {
      const result = `error: ${multiArgsIssue}`;
      this.emit({ kind: "toolCallResolved", toolId, status: "failed", resultPreview: result });
      await this.appendToolResult(s, displayName, argsJson, result, e.id);
      return "executed";
    }

    if (category === "unsafeCmd" || category === "unknown") {
      // Recoverable: reject this call, hand the reason back as a tool result, and
      // let the turn continue so the model can adapt (use a real tool or answer).
      // Error results are sent whole — the card shows them in a scrollable
      // bubble, so a one-line preview would just hide the explanation.
      const blocked = blockedToolDetails(category, displayName, argsJson, reason);
      this.emit({ kind: "toolCallResolved", toolId, status: "rejected", resultPreview: blocked });
      await this.appendToolResult(s, displayName, argsJson, blocked, e.id);
      return "executed";
    }

    if (category === "forbidden" || category === "planViolation") {
      const blocked = blockedToolDetails(category, displayName, argsJson, reason);
      this.emit({ kind: "toolCallResolved", toolId, status: "rejected", resultPreview: blocked });
      this.emit({ kind: "abort", reason: blocked });
      await this.appendToolResult(s, displayName, argsJson, blocked, e.id);
      return "aborted";
    }

    if (category === "write" && reason) {
      const result = `error: ${reason}`;
      this.emit({ kind: "toolCallResolved", toolId, status: "failed", resultPreview: result });
      await this.appendToolResult(s, e.name, e.argsJson, result, e.id);
      return "executed";
    }

    if (category === "question") {
      if (reason || !questionArgs) {
        const result = `error: ${reason ?? "ask_user_question requires a question and at least two suggestions."}`;
        this.emit({ kind: "toolCallResolved", toolId, status: "failed", resultPreview: result });
        await this.appendToolResult(s, e.name, e.argsJson, result, e.id);
        return "executed";
      }
      // Park the turn until the user answers (or the turn is cancelled).
      const answer = await new Promise<string | null>(res => {
        this.pendingQuestions.set(toolId, res);
      });
      if (answer === null) {
        const note = "[ask_user_question dismissed] The user did not answer the question.";
        this.emit({ kind: "toolCallResolved", toolId, status: "rejected", resultPreview: note });
        await this.appendToolResult(s, e.name, e.argsJson, note, e.id);
        return "aborted";
      }
      const result = `the user has answered your question: "${answer}"`;
      this.emit({ kind: "toolCallResolved", toolId, status: "executed", resultPreview: result });
      await this.appendToolResult(s, e.name, e.argsJson, result, e.id);
      return "executed";
    }

    // Decide whether approval is needed. Auto-approve only ever skips the dialog
    // for already-permitted categories: a command must still match the safe-list
    // to reach `safeCmd` here — unsafe commands are rejected upstream regardless.
    if (approvalRequired) {
      const { approved } = await new Promise<{ approved: boolean }>(res => {
        this.pending.set(toolId, { resolve: res });
      });
      if (!approved) {
        const rejected = userRejectedToolDetails(e.name, e.argsJson);
        this.emit({ kind: "toolCallResolved", toolId, status: "rejected", resultPreview: rejected });
        await this.appendToolResult(s, e.name, e.argsJson, rejected, e.id);
        return "aborted";
      }
      this.emit({ kind: "toolCallResolved", toolId, status: "approved" });
    }

    // Execute.
    let result: string;
    let resolvedAfterExecution = false;
    try {
      if (e.name === "read_file") {
        // Number the lines so the model can address them with insert_text /
        // replace_range. For a range read the numbers are the lines' real
        // positions in the file, and a header reports how much was not shown.
        const readArgs = normalizeReadFileArgs(args, e.argsJson);
        const r = await readFile({ workspaceRoot: this.workspaceRoot }, readArgs);
        const numbered = formatFileForModel(r.content, Math.max(1, r.startLine));
        const rendered = r.startLine > 1 || r.endLine < r.totalLines
          ? `[lines ${r.startLine}-${r.endLine} of ${r.totalLines}]\n${numbered}`
          : numbered;
        result = this.toolProtocol === "native" ? `[revision ${r.revision}]\n${rendered}` : rendered;
      } else if (isWriteToolName(e.name)) {
        const effectiveWriteArgs = writeArgs ?? normalizeWriteToolArgs(e.name, args, e.argsJson);
        const absolute = await assertInsideWorkspace(this.workspaceRoot, effectiveWriteArgs.path);
        const key = path.resolve(absolute);
        if (this.toolProtocol === "native" && this.writeRanThisPass) {
          throw new Error(
            `${e.name} was NOT applied: native mutations are serialized one per model response. ` +
            `Wait for the preceding tool result and retry against the current file revision.`
          );
        }
        // Line-addressed edits are computed from numbers the model read BEFORE
        // this response; if an earlier edit in the same response already shifted
        // this file's line count, those numbers no longer address the same lines.
        if (effectiveWriteArgs.kind === "insert_text" || effectiveWriteArgs.kind === "replace_range") {
          if (this.lineEditRanThisPass) {
            throw new Error(
              `${e.name} was NOT applied: only one insert_text or replace_range call may run per model response. ` +
              `Later ranges may be stale; use the preceding edit result's current line numbers, or re-read the target before retrying.`
            );
          }
          const shift = this.staleLineEdits.get(key);
          if (shift !== undefined && shift !== 0) {
            throw new Error(staleLineNumbersMessage(e.name, effectiveWriteArgs.path, shift));
          }
        }
        // Catch read_file output pasted back with its NN<tab> display prefixes
        // before it is written into the file.
        const editBody = effectiveWriteArgs.kind === "insert_text"
          ? effectiveWriteArgs.text
          : effectiveWriteArgs.kind === "edit_file"
            ? effectiveWriteArgs.edits.map(edit => edit.newText).join("\n")
            : effectiveWriteArgs.content;
        const expectedFirstLine = effectiveWriteArgs.kind === "insert_text"
          ? effectiveWriteArgs.line
          : effectiveWriteArgs.kind === "replace_range"
            ? effectiveWriteArgs.startLine
            : undefined;
        if (looksLikeNumberedReadOutput(editBody, expectedFirstLine)) {
          throw new Error(numberedPrefixMessage(e.name));
        }
        let previous = "";
        let next = "";
        let bytesWritten = 0;
        // True only when write_file creates a file that didn't exist — drives
        // the "Created file" vs "Edited file" label (an overwrite is an edit).
        let createsNewFile = false;
        if (effectiveWriteArgs.kind === "write_file") {
          try {
            previous = (await readFile({ workspaceRoot: this.workspaceRoot }, { path: effectiveWriteArgs.path })).content;
          } catch {
            previous = "";
            createsNewFile = true;
          }
          const r = await writeFile({ workspaceRoot: this.workspaceRoot }, effectiveWriteArgs);
          next = effectiveWriteArgs.content;
          bytesWritten = r.bytesWritten;
          result = `wrote ${bytesWritten} bytes to ${effectiveWriteArgs.path}; the file now has ${countLogicalLines(next)} lines`;
        } else if (effectiveWriteArgs.kind === "create_file") {
          previous = "";
          const r = await createFile({ workspaceRoot: this.workspaceRoot }, effectiveWriteArgs);
          next = effectiveWriteArgs.content;
          bytesWritten = r.bytesWritten;
          createsNewFile = true;
          result = `created ${effectiveWriteArgs.path} with ${bytesWritten} bytes and ${countLogicalLines(next)} lines`;
        } else if (effectiveWriteArgs.kind === "edit_file") {
          const r = await editFile({ workspaceRoot: this.workspaceRoot }, effectiveWriteArgs);
          previous = r.previous;
          next = r.next;
          bytesWritten = r.bytesWritten;
          result = `edited ${effectiveWriteArgs.path} atomically; the file now has ${countLogicalLines(next)} lines`;
        } else if (effectiveWriteArgs.kind === "insert_text") {
          const r = await insertText({ workspaceRoot: this.workspaceRoot }, effectiveWriteArgs);
          previous = r.previous;
          next = r.next;
          bytesWritten = r.bytesWritten;
          const insertedLines = Math.max(1, countLogicalLines(next) - countLogicalLines(previous));
          result = `inserted ${bytesWritten} bytes into ${effectiveWriteArgs.path} before line ${effectiveWriteArgs.line}`
            + autoBreakNotes(r)
            + lineShiftNote(`at and after line ${effectiveWriteArgs.line}`, r.previous, r.next)
            + editResultSnippet(next, effectiveWriteArgs.line, insertedLines);
        } else {
          const r = await replaceRange({ workspaceRoot: this.workspaceRoot }, effectiveWriteArgs);
          previous = r.previous;
          next = r.next;
          bytesWritten = r.bytesWritten;
          const replacedCount = effectiveWriteArgs.endLine - effectiveWriteArgs.startLine + 1;
          const regionLines = replacedCount + countLogicalLines(next) - countLogicalLines(previous);
          result = `replaced lines ${effectiveWriteArgs.startLine}-${effectiveWriteArgs.endLine} in ${effectiveWriteArgs.path} with ${bytesWritten} bytes`
            + autoBreakNotes(r)
            + lineShiftNote(`after line ${effectiveWriteArgs.endLine}`, r.previous, r.next)
            + editResultSnippet(next, effectiveWriteArgs.startLine, regionLines);
        }
        // Track this response's cumulative shift for the file. write_file
        // resets it: the model just supplied the full content, so numbers
        // derived from that content are current again.
        this.staleLineEdits.set(
          key,
          effectiveWriteArgs.kind === "write_file" || effectiveWriteArgs.kind === "create_file"
            ? 0
            : (this.staleLineEdits.get(key) ?? 0) + (countLogicalLines(next) - countLogicalLines(previous))
        );
        if (effectiveWriteArgs.kind === "insert_text" || effectiveWriteArgs.kind === "replace_range") {
          this.lineEditRanThisPass = true;
        }
        this.writeRanThisPass = true;
        const displayPath = displayPathForChange(this.workspaceRoot, absolute, effectiveWriteArgs.path);
        if (this.activeFileWrites) {
          rememberFileWrite(this.activeFileWrites, { key, path: displayPath, previous, next });
        }
        const stats = lineDiffStats(previous, next);
        this.toolDiffSources.set(toolId, { path: displayPath, previous, next });
        this.emit({
          kind: "toolCallResolved",
          toolId,
          status: "executed",
          resultPreview: previewOf(result),
          added: stats.added,
          removed: stats.removed,
          createsNewFile
        });
        resolvedAfterExecution = true;
      } else if (e.name === "update_todos") {
        // A bare array is a natural shape for todos, but normalizeToolArgs
        // either rejects it (multi-element) or unwraps a single element into
        // the wrong shape — hand normalizeTodos the raw parse in that case.
        const todos = normalizeTodos(todoArgsSource(e.argsJson, args));
        const { done, total } = todoCounts(todos);
        result = total === 0
          ? "todos cleared"
          : `todos updated (${done}/${total} completed)\n${renderTodosMarkdown(todos)}`;
      } else if (e.name === "list_dir") {
        const r = await listDir({ workspaceRoot: this.workspaceRoot }, args as { path: string });
        result = JSON.stringify(r);
      } else if (e.name === "glob") {
        const r = await glob({ workspaceRoot: this.workspaceRoot }, args as { pattern: string });
        result = JSON.stringify(r);
      } else if (e.name === "run_command") {
        const r = await runCommand(String(args.command ?? ""), this.workspaceRoot, this.abort?.signal);
        result = `exit ${r.exitCode}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}${r.truncated ? "\n[output truncated]" : ""}`;
      } else if (e.name === "run_process") {
        const processArgs = normalizeProcessArgs(args);
        const r = await runProcess(processArgs.program, processArgs.args, this.workspaceRoot, this.abort?.signal);
        result = `exit ${r.exitCode}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}${r.truncated ? "\n[output truncated]" : ""}`;
      } else {
        result = `[harness] unknown tool: ${e.name}`;
      }
    } catch (err) {
      result = `error: ${(err as Error).message}`;
      const storedResult = await this.appendToolResult(s, e.name, e.argsJson, result, e.id);
      this.emit({ kind: "toolCallResolved", toolId, status: "failed", resultPreview: storedResult });
      return "executed";
    }

    const storedResult = await this.appendToolResult(s, e.name, e.argsJson, result, e.id);
    if (!resolvedAfterExecution || storedResult !== result) {
      // list_dir and glob render their result as a vertical file list in the
      // card, so the UI needs the whole (bounded) result, not a one-line preview.
      const showsFileList = e.name === "list_dir" || e.name === "glob";
      const resultPreview = showsFileList ? storedResult : previewOf(storedResult);
      this.emit({ kind: "toolCallResolved", toolId, status: "executed", resultPreview });
    }
    return "executed";
  }

  private async handleToolCallProgress(
    e: Extract<ParsedEvent, { kind: "toolCallProgress" }>,
    messageId: string
  ): Promise<void> {
    if (!isWriteToolName(e.name)) return;
    const key = streamingToolKey(messageId, e.name, e.id);
    let streamingTool = this.streamingTools.get(key);
    if (!streamingTool) {
      streamingTool = {
        toolId: `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: e.name
      };
      this.streamingTools.set(key, streamingTool);
    }
    const toolId = streamingTool.toolId;
    // Snapshot the target's prior state once the path resolves (write_file only:
    // edits always target an existing file). Used for the live +X/-Y and the
    // Write/Edit label; retried on later frames if the path was still partial.
    if (!this.streamingFileState.has(toolId)) {
      const state = await this.readStreamingTarget(e.name, e.path);
      if (state) this.streamingFileState.set(toolId, state);
    }
    // The card must appear on the first emitted frame; after that, rate-limit
    // so the live stat isn't recomputed on every streamed token.
    const now = Date.now();
    const firstEmit = !this.lastProgressEmitAt.has(toolId);
    if (!firstEmit && now - (this.lastProgressEmitAt.get(toolId) ?? 0) < PROGRESS_THROTTLE_MS) {
      return;
    }
    this.lastProgressEmitAt.set(toolId, now);
    const fileState = this.streamingFileState.get(toolId);
    const stats = liveWriteStats(e, fileState);
    this.emit({
      kind: "toolCallProgress",
      toolId,
      messageId,
      toolName: e.name,
      path: e.path,
      contentLines: e.contentLines,
      added: stats.added,
      removed: stats.removed,
      createsNewFile: e.name === "write_file" && fileState !== undefined && !fileState.exists,
      replacedLines: e.name === "replace_range" ? replacedLineCount(e.startLine, e.endLine) : undefined,
      startLine: e.startLine,
      endLine: e.endLine,
      line: e.line
    });
  }

  /**
   * The target's prior content/existence, for the live write stats and label.
   * Only write_file needs the old content; edits always target an existing file,
   * so they return a cheap placeholder. Returns undefined (retry next frame) if
   * the path hasn't streamed enough to resolve inside the workspace yet.
   */
  private async readStreamingTarget(
    name: string,
    pathArg?: string
  ): Promise<{ exists: boolean; content: string } | undefined> {
    if (!pathArg) return undefined;
    try {
      await assertInsideWorkspace(this.workspaceRoot, pathArg);
    } catch {
      return undefined;
    }
    if (name !== "write_file") return { exists: true, content: "" };
    try {
      const content = (await readFile({ workspaceRoot: this.workspaceRoot }, { path: pathArg })).content;
      return { exists: true, content };
    } catch {
      return { exists: false, content: "" };
    }
  }

  private failUnfinishedStreamingTools(): void {
    if (this.streamingTools.size === 0) return;
    for (const { toolId, name } of this.streamingTools.values()) {
      this.emit({
        kind: "toolCallResolved",
        toolId,
        status: "failed",
        resultPreview: `error: incomplete ${name} tool call`
      });
    }
    this.streamingTools.clear();
  }

  /**
   * Mark each orphaned streaming edit card failed AND append a tool-specific
   * error, so the next prompt pass can re-emit it rather than silently ending.
   */
  private async feedBackIncompleteStreamingTools(s: HarnessSettings): Promise<void> {
    const tools = [...this.streamingTools.values()];
    this.streamingTools.clear();
    for (const { toolId, name } of tools) {
      const result =
        `error: incomplete ${name} tool call — the call was cut off before it finished ` +
        `streaming and was not executed. Re-emit the complete ${name} call` +
        (name === "write_file" ? ", or use insert_text / replace_range for a smaller, localized edit." : ".");
      this.emit({ kind: "toolCallResolved", toolId, status: "failed", resultPreview: result });
      await this.appendToolResult(s, name, "{}", result);
    }
  }

  private buildPromptMessages(): PromptMessage[] {
    const sys = buildSystemPrompt({
      family: this.record.modelFamily,
      planMode: this.record.planMode,
      workspaceRoot: this.workspaceRoot,
      agentsMd: this.cachedAgentsMd(),
      nativeTools: this.toolProtocol === "native"
    });
    if (this.toolProtocol === "native") return this.buildNativePromptMessages(sys);
    const msgs: { role: "system" | "user" | "assistant" | "tool"; content: string }[] = [
      { role: "system", content: sys }
    ];
    for (const m of this.record.messages) {
      if (m.role === "tool") {
        const name = m.toolCall?.name ?? "tool";
        const call = renderToolCallForPrompt(this.record.modelFamily, name, m.toolCall?.argsJson ?? "{}");
        const last = msgs[msgs.length - 1];
        if (last?.role === "assistant") {
          last.content = `${last.content.trimEnd()}\n${call}`;
        } else {
          msgs.push({ role: "assistant", content: call });
        }
        msgs.push({ role: "user", content: `[${name} result]\n${m.content}` });
      } else if (m.role === "assistant" && !m.content.trim()) {
        continue;
      } else {
        msgs.push({ role: m.role as "user" | "assistant" | "system", content: m.content });
      }
    }
    // The tool replay above should keep assistant/tool-result exchanges alternating.
    // Coalescing is retained only as a final guard for odd restored transcripts.
    return coalesceSameRole(msgs);
  }

  private buildNativePromptMessages(systemPrompt: string): PromptMessage[] {
    // Compaction stores its summary as a leading system message. Native chat
    // templates commonly permit exactly one system message, at index zero, so
    // fold any leading stored system context into the harness prompt instead
    // of replaying it as a second system message.
    const storedSystemContext: string[] = [];
    let transcriptStart = 0;
    while (this.record.messages[transcriptStart]?.role === "system") {
      storedSystemContext.push(this.record.messages[transcriptStart].content);
      transcriptStart++;
    }
    const initialSystemContent = [systemPrompt, ...storedSystemContext]
      .filter(content => content.trim())
      .join("\n\n");
    const messages: PromptMessage[] = [{ role: "system", content: initialSystemContent }];
    for (let index = transcriptStart; index < this.record.messages.length; index++) {
      const stored = this.record.messages[index];
      if (stored.role !== "tool") {
        if (stored.role !== "assistant" || stored.content.trim()) {
          messages.push({
            role: stored.role,
            content: stored.content,
            reasoning_content: stored.role === "assistant" ? stored.reasoningContent : undefined
          });
        }
        continue;
      }

      const toolMessages: ChatMessage[] = [];
      while (index < this.record.messages.length && this.record.messages[index].role === "tool") {
        toolMessages.push(this.record.messages[index]);
        index++;
      }

      // Visible preamble from a tool-call pass is stored after its tool results.
      // Move only an assistant record that actually captured tool-call events.
      const following = this.record.messages[index];
      const assistantRecord = following?.role === "assistant" && messageContainsToolCall(following)
        ? following
        : null;
      if (assistantRecord === null) index--;

      const calls = toolMessages.map((message, callIndex) => {
        const toolCall = message.toolCall;
        return {
          id: toolCall?.id ?? `restored_${index}_${callIndex}`,
          type: "function" as const,
          function: {
            name: toolCall?.name ?? "tool",
            arguments: canonicalNativeArguments(toolCall?.argsJson)
          }
        };
      });
      messages.push({
        role: "assistant",
        content: assistantRecord?.content ?? "",
        reasoning_content: assistantRecord?.reasoningContent,
        tool_calls: calls
      });
      toolMessages.forEach((message, callIndex) => {
        messages.push({
          role: "tool",
          name: message.toolCall?.name,
          tool_call_id: calls[callIndex].id,
          content: message.content
        });
      });
    }
    return messages;
  }
}

function messageContainsToolCall(message: ChatMessage): boolean {
  return Array.isArray(message.events)
    && message.events.some(event => !!event && typeof event === "object" && (event as { kind?: unknown }).kind === "toolCall");
}

function asThoughtEvents(events: ParsedEvent[]): ParsedEvent[] {
  return events.map(event => event.kind === "text"
    ? { kind: "thought", text: event.text }
    : event);
}

function withNativeRepair(messages: PromptMessage[], note: string): PromptMessage[] {
  const repaired = messages.map(message => ({ ...message }));
  for (let index = repaired.length - 1; index >= 0; index--) {
    const message = repaired[index];
    if (message.role === "tool" || message.role === "user") {
      message.content = `${message.content}\n\n${note}`;
      return repaired;
    }
  }
  repaired.push({ role: "user", content: note });
  return repaired;
}

function canonicalNativeArguments(raw: string | undefined): string {
  let value: unknown = raw ?? {};
  // Some legacy adapters stored a JSON object as a JSON-encoded string. Peel
  // those wrappers, but never replay arbitrary or truncated text through the
  // native protocol: llama.cpp parses historical arguments strictly.
  for (let depth = 0; depth < 3 && typeof value === "string"; depth++) {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return "{}";
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "{}";
  return JSON.stringify(value);
}

function newToolCallId(): string {
  return `call_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function autoCompactTriggerTokens(contextSize: number, thresholdPercent: number): number {
  return Math.max(1, Math.floor(contextSize * (thresholdPercent / 100)));
}

function contextWindowOverflowMessage(tokens: number, limit: number): string {
  return [
    `Context window guard: context is ${tokens} / ${limit} tokens.`,
    `The request was not sent to the model because it would exceed the context window.`,
    `Compact context, reduce recent tool output, or restart llama.cpp with a larger --ctx-size before continuing.`
  ].join("\n");
}

function promptOverflowMessage(tokens: number, limit: number): string {
  return [
    `Context window guard: the rendered prompt is ${tokens} / ${limit} tokens.`,
    `The request was not sent to the model because llama.cpp would reject it.`,
    `Compact context, reduce recent tool output, or restart llama.cpp with a larger --ctx-size before continuing.`
  ].join("\n");
}

function previewOf(s: string): string {
  const oneLine = s.replace(/\s+/g, " ");
  return oneLine.length <= 200 ? oneLine : oneLine.slice(0, 197) + "...";
}

function streamingToolKey(messageId: string, name: string, id: string | undefined): string {
  return `${messageId}:${id ?? name}`;
}

// Rate-limit for the live +X/-Y stat updates streamed to the card heading.
const PROGRESS_THROTTLE_MS = 60;

/**
 * The live +added/-removed shown in the card heading as a write streams:
 *  - insert_text / create_file / new write_file: every streamed line is an addition.
 *  - replace_range: removes the whole target range, adds the streamed lines.
 *  - edit_file: the first streamed newText is shown as provisional additions.
 *  - write_file over an existing file: diff the streamed body against the old
 *    file's prefix of the same length (Myers, via lineDiffStats) so a shift
 *    doesn't read as a wall of changes. All of these converge to the exact diff
 *    recomputed when the call resolves.
 */
function liveWriteStats(
  e: Extract<ParsedEvent, { kind: "toolCallProgress" }>,
  fileState: { exists: boolean; content: string } | undefined
): { added: number; removed: number } {
  const added = e.contentLines;
  if (e.name === "insert_text") return { added, removed: 0 };
  if (e.name === "create_file" || e.name === "edit_file") return { added, removed: 0 };
  if (e.name === "replace_range") return { added, removed: replacedLineCount(e.startLine, e.endLine) ?? 0 };
  if (!fileState || !fileState.exists) return { added, removed: 0 };
  const streamed = e.content ?? "";
  const streamedLineCount = streamed === "" ? 0 : streamed.split(/\r\n|\r|\n/).length;
  const oldPrefix = fileState.content.split(/\r\n|\r|\n/).slice(0, streamedLineCount).join("\n");
  return lineDiffStats(oldPrefix, streamed);
}

function replacedLineCount(startLine?: number, endLine?: number): number | undefined {
  if (startLine === undefined || endLine === undefined || endLine < startLine) return undefined;
  return endLine - startLine + 1;
}

function emptyTurnNotice(
  ranAnyTool: boolean,
  thought: boolean,
  finishReason?: string,
  retried = false
): string {
  const lead = thought
    ? "The model stopped right after thinking, without a reply."
    : ranAnyTool
      ? "The model stopped after its tool calls, without a final reply."
      : "The model ended its turn without producing a reply.";
  const diagnostic = finishReason ? ` The server reported finish_reason="${finishReason}".` : "";
  const retry = retried ? " A native continuation retry was already attempted." : "";
  return `${lead}${diagnostic}${retry} It may have stopped early (a stop-token/template mismatch on the server). Resend your message to continue. If this keeps happening, check that the Model family setting matches the served model.`;
}

/**
 * The call packed several argument objects into one array. Executing just the
 * first (and silently dropping the rest) would desync the model's beliefs from
 * the file system, so this is surfaced as a distinct, recoverable error.
 */
class MultipleToolArgsError extends Error {
  constructor(count: number) {
    super(
      `received ${count} separate argument objects in a single tool call. ` +
        `Each tool call takes exactly one JSON object of arguments — emit one tool call per action instead.`
    );
    this.name = "MultipleToolArgsError";
  }
}

function normalizeToolArgs(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("\"")) {
      try { return normalizeToolArgs(JSON.parse(trimmed)); } catch (err) {
        if (err instanceof MultipleToolArgsError) throw err;
        /* fall through */
      }
    }
    return {};
  }
  if (Array.isArray(value)) {
    if (value.length > 1) throw new MultipleToolArgsError(value.length);
    if (value.length === 1) return normalizeToolArgs(value[0]);
    return {};
  }
  if (!value || typeof value !== "object") return {};
  const obj = value as Record<string, unknown>;
  // Unwrap compatibility envelopes only when they are actually envelopes.
  // A real tool parameter named `args` (run_process) must remain intact.
  const keys = Object.keys(obj);
  const wrapper = ["arguments", "args", "input", "parameters"].find(key =>
    key in obj && (keys.length === 1 || (key === "arguments" && keys.every(name => name === "name" || name === "arguments")))
  );
  if (wrapper) return normalizeToolArgs(obj[wrapper]);
  return obj;
}

function normalizeProcessArgs(args: Record<string, unknown>): { program: string; args: string[] } {
  const program = args.program;
  const argv = args.args;
  if (typeof program !== "string" || !/^[A-Za-z0-9_./+-]+$/.test(program)) {
    throw new Error("run_process.program must be a non-empty executable name without whitespace.");
  }
  if (!Array.isArray(argv) || argv.some(value => typeof value !== "string" || /[\0\r\n]/.test(value))) {
    throw new Error("run_process.args must be an array of strings without control characters.");
  }
  return { program, args: argv as string[] };
}

function processCommandLine(args: Record<string, unknown>): string {
  const program = typeof args.program === "string" ? args.program : "";
  const argv = Array.isArray(args.args) ? args.args.filter(value => typeof value === "string") : [];
  return [program, ...argv].join(" ").trim();
}

/**
 * Argument source for update_todos: a bare (multi-element) array of todos is a
 * legitimate shape that normalizeToolArgs cannot represent, so fall back to
 * the raw JSON parse whenever it yields an array; otherwise use the already-
 * normalized record (which correctly unwraps `{arguments: {todos: [...]}}`).
 */
function todoArgsSource(argsJson: string, normalized: Record<string, unknown>): unknown {
  try {
    const parsed: unknown = JSON.parse(argsJson);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* fall through to the normalized record */ }
  return normalized;
}

function normalizeWriteToolArgs(toolName: string, args: Record<string, unknown>, rawArgsJson?: string): PreparedWriteArgs {
  if (toolName === "write_file") {
    return { kind: "write_file", ...normalizeWriteFileArgs(args, rawArgsJson) };
  }
  if (toolName === "create_file") {
    return { kind: "create_file", ...normalizeWriteFileArgs(args, rawArgsJson) };
  }
  if (toolName === "edit_file") {
    const path = args.path;
    const baseRevision = args.baseRevision;
    const edits = args.edits;
    if (typeof path !== "string" || typeof baseRevision !== "string" || !Array.isArray(edits)) {
      throw new Error("edit_file requires path, baseRevision, and an edits array.");
    }
    return {
      kind: "edit_file",
      path,
      baseRevision,
      edits: edits as { oldText: string; newText: string }[]
    };
  }
  if (toolName === "insert_text") {
    return { kind: "insert_text", ...normalizeInsertTextArgs(args, rawArgsJson) };
  }
  if (toolName === "replace_range") {
    return { kind: "replace_range", ...normalizeReplaceRangeArgs(args, rawArgsJson) };
  }
  throw new Error(`Unknown write tool: ${toolName}`);
}

function normalizeWriteFileArgs(args: Record<string, unknown>, rawArgsJson?: string): { path: string; content: string } {
  const normalized = normalizeToolArgs(args);
  const recovered = rawArgsJson ? recoverWriteFileArgsFromRaw(rawArgsJson) : {};
  const pathValue = normalized.path
    ?? normalized.file_path
    ?? normalized.filePath
    ?? normalized.filepath
    ?? normalized.filename
    ?? normalized.fileName
    ?? normalized.file
    ?? recovered.path;
  const contentValue = normalized.content
    ?? normalized.text
    ?? normalized.contents
    ?? normalized.body
    ?? normalized.new_content
    ?? normalized.newContent
    ?? normalized.value
    ?? recovered.content;
  if (typeof pathValue !== "string" || pathValue.trim() === "") {
    throw new Error(buildWriteArgsError("path", normalized, rawArgsJson, "path, file_path, filePath, filename"));
  }
  if (typeof contentValue !== "string") {
    throw new Error(buildWriteArgsError("string content", normalized, rawArgsJson, "content, contents, text, body"));
  }
  return { path: pathValue, content: contentValue };
}

function normalizeInsertTextArgs(args: Record<string, unknown>, rawArgsJson?: string): InsertTextArgs {
  const normalized = normalizeToolArgs(args);
  const pathValue = normalized.path
    ?? normalized.file_path
    ?? normalized.filePath
    ?? normalized.filepath
    ?? normalized.filename
    ?? normalized.fileName
    ?? normalized.file;
  const lineValue = normalized.line
    ?? normalized.lineNumber
    ?? normalized.line_number
    ?? normalized.beforeLine
    ?? normalized.before_line;
  const textValue = normalized.text
    ?? normalized.content
    ?? normalized.insert
    ?? normalized.value;
  const expectedLineValue = normalized.expectedLine
    ?? normalized.expected_line
    ?? normalized.currentLine
    ?? normalized.current_line
    ?? normalized.anchor;
  if (typeof pathValue !== "string" || pathValue.trim() === "") {
    throw new Error(buildToolArgsError("insert_text", "path", normalized, rawArgsJson, "path, file_path, filePath, filename"));
  }
  const line = normalizeLineNumber(lineValue);
  if (line === undefined) {
    throw new Error(buildToolArgsError("insert_text", "integer line", normalized, rawArgsJson, "line, lineNumber, line_number"));
  }
  if (typeof textValue !== "string") {
    throw new Error(buildToolArgsError("insert_text", "string text", normalized, rawArgsJson, "text, content, insert, value"));
  }
  if (typeof expectedLineValue !== "string") {
    throw new Error(buildToolArgsError(
      "insert_text",
      "string expectedLine safety precondition",
      normalized,
      rawArgsJson,
      "expectedLine"
    ));
  }
  return { path: pathValue, line, expectedLine: expectedLineValue, text: textValue };
}

function normalizeReplaceRangeArgs(args: Record<string, unknown>, rawArgsJson?: string): ReplaceRangeArgs {
  const normalized = normalizeToolArgs(args);
  const pathValue = normalized.path
    ?? normalized.file_path
    ?? normalized.filePath
    ?? normalized.filepath
    ?? normalized.filename
    ?? normalized.fileName
    ?? normalized.file;
  const startValue = normalized.startLine
    ?? normalized.start_line
    ?? normalized.start
    ?? normalized.fromLine
    ?? normalized.from_line;
  const endValue = normalized.endLine
    ?? normalized.end_line
    ?? normalized.end
    ?? normalized.toLine
    ?? normalized.to_line;
  const contentValue = normalized.content
    ?? normalized.text
    ?? normalized.replacement
    ?? normalized.value;
  const expectedContentValue = normalized.expectedContent
    ?? normalized.expected_content
    ?? normalized.oldContent
    ?? normalized.old_content
    ?? normalized.currentContent
    ?? normalized.current_content;
  if (typeof pathValue !== "string" || pathValue.trim() === "") {
    throw new Error(buildToolArgsError("replace_range", "path", normalized, rawArgsJson, "path, file_path, filePath, filename"));
  }
  const startLine = normalizeLineNumber(startValue);
  const endLine = normalizeLineNumber(endValue);
  if (startLine === undefined) {
    throw new Error(buildToolArgsError("replace_range", "integer startLine", normalized, rawArgsJson, "startLine, start_line, start"));
  }
  if (endLine === undefined) {
    throw new Error(buildToolArgsError("replace_range", "integer endLine", normalized, rawArgsJson, "endLine, end_line, end"));
  }
  if (typeof contentValue !== "string") {
    throw new Error(buildToolArgsError("replace_range", "string content", normalized, rawArgsJson, "content, text, replacement, value"));
  }
  if (typeof expectedContentValue !== "string") {
    throw new Error(buildToolArgsError(
      "replace_range",
      "string expectedContent safety precondition",
      normalized,
      rawArgsJson,
      "expectedContent"
    ));
  }
  return { path: pathValue, startLine, endLine, expectedContent: expectedContentValue, content: contentValue };
}

export function normalizeAskUserQuestionArgs(
  args: Record<string, unknown>,
  rawArgsJson?: string
): { question: string; suggestions: string[] } {
  const normalized = normalizeToolArgs(args);
  const questionValue = normalized.question ?? normalized.prompt ?? normalized.text ?? normalized.q;
  if (typeof questionValue !== "string" || questionValue.trim() === "") {
    throw new Error(buildToolArgsError("ask_user_question", "question", normalized, rawArgsJson, "question"));
  }
  const suggestions = normalizeSuggestionList(
    normalized.suggestions ?? normalized.options ?? normalized.choices ?? normalized.answers
  );
  if (suggestions.length < 2) {
    throw new Error(
      `ask_user_question requires at least 2 distinct non-empty suggestions; received ${suggestions.length}. ` +
        `Provide a "suggestions" array of 2-3 short strings — the user can also type their own answer.`
    );
  }
  return { question: questionValue.trim(), suggestions };
}

function normalizeSuggestionList(value: unknown): string[] {
  let list = value;
  if (typeof list === "string") {
    const trimmed = list.trim();
    if (trimmed.startsWith("[")) {
      try { list = JSON.parse(trimmed); } catch { /* fall through to single-value handling */ }
    }
  }
  const raw = Array.isArray(list) ? list : list === undefined || list === null ? [] : [list];
  const out: string[] = [];
  for (const item of raw) {
    const text =
      typeof item === "string" ? item.trim()
      : typeof item === "number" || typeof item === "boolean" ? String(item)
      : "";
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

function normalizeReadFileArgs(args: Record<string, unknown>, rawArgsJson?: string): ReadFileArgs {
  const normalized = normalizeToolArgs(args);
  const pathValue = normalized.path
    ?? normalized.file_path
    ?? normalized.filePath
    ?? normalized.filepath
    ?? normalized.filename
    ?? normalized.fileName
    ?? normalized.file;
  if (typeof pathValue !== "string" || pathValue.trim() === "") {
    throw new Error(buildToolArgsError("read_file", "path", normalized, rawArgsJson, "path, file_path, filePath, filename"));
  }
  const out: ReadFileArgs = { path: pathValue };
  const startRaw = normalized.startLine
    ?? normalized.start_line
    ?? normalized.start
    ?? normalized.fromLine
    ?? normalized.from_line
    ?? normalized.firstLine
    ?? normalized.first_line;
  const endRaw = normalized.endLine
    ?? normalized.end_line
    ?? normalized.end
    ?? normalized.toLine
    ?? normalized.to_line
    ?? normalized.lastLine
    ?? normalized.last_line;
  // A range key that was sent but does not parse is an error — silently
  // reading the whole file instead could blow the context the model was
  // trying to protect.
  if (startRaw !== undefined && startRaw !== null) {
    const startLine = normalizeLineNumber(startRaw);
    if (startLine === undefined) {
      throw new Error(buildToolArgsError("read_file", "integer startLine", normalized, rawArgsJson, "startLine, start_line, start"));
    }
    out.startLine = startLine;
  }
  if (endRaw !== undefined && endRaw !== null) {
    const endLine = normalizeLineNumber(endRaw);
    if (endLine === undefined) {
      throw new Error(buildToolArgsError("read_file", "integer endLine", normalized, rawArgsJson, "endLine, end_line, end"));
    }
    out.endLine = endLine;
  }
  return out;
}

function normalizeLineNumber(value: unknown): number | undefined {
  const n = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : NaN;
  return Number.isInteger(n) ? n : undefined;
}

function recoverWriteFileArgsFromRaw(raw: string): { path?: string; content?: string } {
  return {
    path: extractRawStringField(raw, ["path", "file_path", "filePath", "filepath", "filename", "fileName", "file"]),
    content: extractRawStringField(raw, ["content", "text", "contents", "body", "new_content", "newContent", "value"])
  };
}

function extractRawStringField(raw: string, keys: string[]): string | undefined {
  const allKeys = [
    "path", "file_path", "filePath", "filepath", "filename", "fileName", "file",
    "content", "text", "contents", "body", "new_content", "newContent", "value"
  ];
  const keyPattern = keys.map(escapeRegex).join("|");
  const startRe = new RegExp(`["'](${keyPattern})["']\\s*:\\s*["']`);
  const start = startRe.exec(raw);
  if (!start || start.index === undefined) return undefined;
  const valueStart = start.index + start[0].length;
  const nextFieldRe = new RegExp(`,\\s*["'](?:${allKeys.map(escapeRegex).join("|")})["']\\s*:`, "g");
  nextFieldRe.lastIndex = valueStart;
  const next = nextFieldRe.exec(raw);
  const valueEnd = next?.index ?? raw.lastIndexOf("}");
  const end = valueEnd > valueStart ? valueEnd : raw.length;
  let value = raw.slice(valueStart, end).trim();
  if (value.endsWith(",")) value = value.slice(0, -1).trimEnd();
  if (value.endsWith("\"") || value.endsWith("'")) value = value.slice(0, -1);
  return unescapeJsonishString(value);
}

function unescapeJsonishString(value: string): string {
  try {
    return JSON.parse(`"${value.replace(/\r?\n/g, "\\n")}"`);
  } catch {
    return value
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, "\"")
      .replace(/\\\\/g, "\\");
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildWriteArgsError(
  needed: string,
  normalized: Record<string, unknown>,
  rawArgsJson: string | undefined,
  expectedKeys: string
): string {
  return buildToolArgsError("write_file", needed, normalized, rawArgsJson, expectedKeys);
}

function buildToolArgsError(
  toolName: string,
  needed: string,
  normalized: Record<string, unknown>,
  rawArgsJson: string | undefined,
  expectedKeys: string
): string {
  const keys = Object.keys(normalized).join(", ") || "(none)";
  const raw = rawArgsJson ? rawArgsJson.slice(0, 400) : "";
  const rawHint = raw
    ? `\nRaw input received: ${raw}${rawArgsJson && rawArgsJson.length > 400 ? "..." : ""}`
    : "";
  return `${toolName} requires a ${needed}. Detected keys after normalization: ${keys}. Expected one of: ${expectedKeys}.${rawHint}`;
}

/**
 * Line-addressed edits that add or remove lines shift every number below the
 * edit. Without an explicit warning in the tool result, small models keep
 * using numbers from the pre-edit read and land follow-up edits on the wrong
 * lines.
 */
function lineShiftNote(where: string, previous: string, next: string): string {
  const delta = countLogicalLines(next) - countLogicalLines(previous);
  if (delta === 0) return "";
  const sign = delta > 0 ? `+${delta}` : `${delta}`;
  return `. Line numbers ${where} have shifted by ${sign}; numbers from earlier reads are stale there — use the updated region below for any follow-up edit to this file.`;
}

/** Notes for line breaks the edit tools auto-added to keep lines separate. */
function autoBreakNotes(r: { addedLeadingBreak?: boolean; addedTrailingBreak?: boolean }): string {
  const notes: string[] = [];
  if (r.addedLeadingBreak) {
    notes.push("the file did not end with a line break, so one was added before the inserted text to start it on its own line");
  }
  if (r.addedTrailingBreak) {
    notes.push("the text did not end with a line break, so one was added to keep the following line separate");
  }
  return notes.length > 0 ? `. Note: ${notes.join("; ")}` : "";
}

/**
 * The model-facing echo of what the file looks like after an edit. This is the
 * model's only view of its edit's effect — without it a mistargeted edit goes
 * unnoticed, and the fresh numbering is what makes safe follow-up edits
 * possible without a re-read.
 */
function editResultSnippet(next: string, regionStart: number, regionLines: number): string {
  return `\nUpdated region with current line numbers (the number-tab prefixes are display-only, not file content):\n`
    + editRegionSnippet(next, regionStart, regionLines);
}

function staleLineNumbersMessage(toolName: string, filePath: string, shift: number): string {
  const sign = shift > 0 ? `+${shift}` : `${shift}`;
  return [
    `line numbers in ${filePath} are stale: an earlier edit in this same reply already changed the file's line count by ${sign}.`,
    `This ${toolName} call was NOT applied because its line numbers were computed before that edit.`,
    `Use the updated line numbers shown in the earlier edit's result (or re-read the range), then re-emit this edit.`
  ].join(" ");
}

function numberedPrefixMessage(toolName: string): string {
  return [
    `the ${toolName} content looks like read_file output pasted back with its line-number prefixes (lines starting with a number and a tab).`,
    `Those prefixes are display-only and are not part of the file, so nothing was written.`,
    `Re-emit the call with the code itself, without the number-tab prefixes.`
  ].join(" ");
}

function displayPathForChange(workspaceRoot: string, absolute: string, requested: string): string {
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(absolute));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return requested;
  return relative;
}

function unsafeCommandReason(
  command: string,
  checkReason: string | undefined,
  safeCommands: SafeCommandEntry[]
): string {
  const configured = safeCommands.length === 0
    ? "No safe commands are configured."
    : "Configured safe-command patterns:\n" + safeCommands
      .map((entry, i) => `${i + 1}. ${entry.match}${entry.description ? ` — ${entry.description}` : ""}`)
      .join("\n");
  return [
    `Command rejected before execution: ${command || "(empty command)"}`,
    checkReason ?? "Command did not match the safe-command allow-list.",
    configured,
    `Do not retry the same command unchanged.`,
    `If an allowed command can provide enough information, adapt and call that instead.`,
    `If no allowed command can do what you need, ask the user to run the command manually and paste the relevant output.`
  ].join("\n");
}

// Raw bodies of unparseable calls can be huge (a cut-off write_file); cap what
// is shown on the card and replayed back into context.
const MAX_MALFORMED_ARGS_CHARS = 1500;

function truncateRawArgs(raw: string): string {
  if (raw.length <= MAX_MALFORMED_ARGS_CHARS) return raw;
  return raw.slice(0, MAX_MALFORMED_ARGS_CHARS) + "\n…[truncated]";
}

function malformedToolCallReason(parseError?: string): string {
  return [
    `Malformed tool call: the tool-call block could not be parsed, so nothing was executed.`,
    ...(parseError ? [`Parser detail: ${parseError}`] : []),
    `Its body was not a valid tool call, or the block was cut off before it was closed.`,
    `Re-emit the complete tool call as a single valid block in the tool-call format described in the system prompt, or answer directly if no tool is needed.`,
    `Available tools: ${[...ALLOWED_TOOL_NAMES].join(", ")}.`
  ].join("\n");
}

function unknownToolReason(name: string): string {
  return [
    `Unknown tool "${name}". This harness has no tool by that name.`,
    `Available tools: ${[...ALLOWED_TOOL_NAMES].join(", ")}.`,
    `Re-issue the request using one of these tools, or answer directly if no tool is needed.`,
    `Do not retry the same unknown tool name.`
  ].join("\n");
}

function planModeViolationReason(toolName: string, args: Record<string, unknown>): string {
  const attempted = isProcessToolName(toolName)
    ? `Attempted command: ${toolName === "run_process" ? processCommandLine(args) : String(args.command ?? "(empty command)")}`
    : `Attempted edit path: ${String(args.path ?? args.file_path ?? args.filePath ?? "(missing path)")}`;
  return [
    `In plan mode, "${toolName}" is not allowed.`,
    attempted,
    `Plan mode may still use read-only tools: read_file, list_dir, and glob.`,
    `Accept the plan and turn plan mode off before writing files or running commands.`
  ].join("\n");
}

function blockedToolDetails(
  category: ToolCategory,
  toolName: string,
  argsJson: string,
  reason: string | undefined
): string {
  return [
    `[blocked: ${category}] ${reason ?? "Tool call rejected."}`,
    `Tool: ${toolName}`,
    `Arguments: ${prettyArgs(argsJson)}`
  ].join("\n");
}

function userRejectedToolDetails(toolName: string, argsJson: string): string {
  return [
    "[rejected by user]",
    `Tool: ${toolName}`,
    `Arguments: ${prettyArgs(argsJson)}`,
    "The user declined this exact action. Do not retry it unchanged.",
    "Ask what they want instead, or take a different approach that respects the rejection."
  ].join("\n");
}

function prettyArgs(argsJson: string): string {
  try {
    return JSON.stringify(JSON.parse(argsJson), null, 2);
  } catch {
    return argsJson || "{}";
  }
}

function extractSummary(text: string): string {
  const paragraphs = text.trim().split(/\n\s*\n/);
  return paragraphs[paragraphs.length - 1] ?? text;
}
