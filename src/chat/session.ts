import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fetchServerContextSize, streamChat, tokenize } from "../llm/client.js";
import { buildSystemPrompt, coalesceSameRole, renderToolCallForPrompt } from "../llm/prompt.js";
import { loadRootAgentsMd } from "../llm/agentsMd.js";
import { makeParser, type ParsedEvent } from "../llm/parser/index.js";
import {
  classifyToolName,
  disabledToolReason,
  findActiveTool,
  isWriteToolName,
  toolsForMode
} from "../tools/catalog.js";
import { NO_SANDBOX_COMMAND_CAPABILITY } from "../tools/sandboxCommands.js";
import {
  formatFileForModel,
  type InsertTextArgs,
  type ReadFileArgs,
  type ReplaceRangeArgs
} from "../tools/fsTools.js";
import {
  GuardedWorkspace,
} from "../security/workspace/index.js";
import { readSettings, type HarnessSettings } from "../config/settings.js";
import { ChatStorage, titleFromFirstMessage, type ChatMessage, type ChatRecord } from "./storage.js";
import { normalizeTodos, renderTodosMarkdown, todoCounts } from "./todos.js";
import { compact, compactAvailableForMessageCount, KEEP_TAIL, MIN_COMPACT_MESSAGES, type CompactConfig } from "./compactor.js";
import { countTokens, promptTokens, recomputeTokens, truncateToTokenBudget } from "./contextTracker.js";
import { lineDiffStats } from "./diffPreview.js";
import { rememberFileWrite, summarizeFileChanges, type TrackedFileWrite } from "./fileChanges.js";
import { ReviewArtifactStore } from "./reviewArtifactStore.js";
import type { ToolCategory, UiEvent } from "./protocol.js";
import type { WorkspacePort } from "./session/ports.js";
import {
  captureToolPolicySnapshot,
  type CommandPortFactory,
  type ToolPolicySnapshot
} from "./toolPolicySnapshot.js";
import {
  commandReviewDigest,
  discardCommandTransaction,
  executeCommandTransaction,
  prepareCommandTransaction,
  type PreparedCommandTransaction
} from "./commandTransactions.js";
import {
  ApprovalCoordinator,
  type ApprovalDecision,
  type PendingApproval
} from "./approvalCoordinator.js";
import {
  describeCommittedEdit,
  editReviewDigest,
  prepareEditTransaction,
  staleLineNumbersMessage,
  toolReviewDigest,
  type PreparedEditTransaction,
  type PreparedWriteArgs
} from "./editTransactions.js";

export type { ToolCategory, UiEvent } from "./protocol.js";

type PromptMessage = { role: "system" | "user" | "assistant" | "tool"; content: string };

type SessionWorkspace = WorkspacePort;

export class ChatSession {
  private record: ChatRecord;
  private readonly approvals = new ApprovalCoordinator();
  // ask_user_question parks the turn here until the user answers; the resolver
  // gets the chosen/typed answer, or null if the turn was cancelled first.
  private pendingQuestions = new Map<string, (answer: string | null) => void>();
  private abort: AbortController | undefined;
  private activeTurn: Promise<void> | undefined;
  private activeTurnId: string | undefined;
  private emit: (e: UiEvent) => void;
  private storage: ChatStorage;
  private workspaceRoot: string;
  private workspaceCapability?: Promise<SessionWorkspace>;
  private activeFileWrites?: Map<string, TrackedFileWrite>;
  private streamingToolIds = new Map<string, string>();
  // Last time a live-stat progress frame was emitted per streaming card. The
  // parser yields a frame per token; this rate-limits the live +X/-Y updates.
  private lastProgressEmitAt = new Map<string, number>();
  private readonly reviewArtifacts = new ReviewArtifactStore(24 * 1024 * 1024, 8);
  // Tracks a run of consecutive edits to the same file so they collapse into a
  // single edit card showing one combined original→latest diff. Reset to
  // undefined whenever any other tool runs (see the snapshot in handleToolCall).
  private writeGroup?: { id: string; key: string; original: string; latest: string };
  // Net line-count shift per file (abs path) from edits executed in the
  // CURRENT model response. The model emits a whole response blind — it sees
  // tool results only on the next prompt pass — so once an edit shifts a
  // file's line numbers, any later line-addressed edit to that file in the
  // same response was computed from stale numbers and must be rejected.
  // Cleared on every re-prompt (the model has fresh numbers by then).
  private staleLineEdits = new Map<string, number>();
  // The context window the server actually runs with (llama.cpp /props); the
  // effective limit is min(configured, server). Refreshed before each request.
  private serverContextSize?: number;
  private systemPromptTokenCache?: { text: string; tokens: number };
  // Last AGENTS.md content loaded for this session. Refreshed (mtime-cached) at
  // the start of every prompt build so the sync buildPromptMessages can read it.
  private agentsMdCache?: string;
  private readonly commandPortFactory?: CommandPortFactory;
  private toolPolicy: ToolPolicySnapshot = Object.freeze({
    sandbox: NO_SANDBOX_COMMAND_CAPABILITY
  });

  constructor(args: {
    storage: ChatStorage;
    workspaceRoot: string;
    workspace?: SessionWorkspace | Promise<SessionWorkspace>;
    commandPortFactory?: CommandPortFactory;
    record: ChatRecord;
    emit: (e: UiEvent) => void;
  }) {
    this.storage = args.storage;
    this.workspaceRoot = args.workspaceRoot;
    if (args.workspace) this.workspaceCapability = Promise.resolve(args.workspace);
    this.commandPortFactory = args.commandPortFactory;
    this.record = args.record;
    this.emit = args.emit;
  }

  getRecord(): ChatRecord { return this.record; }

  private workspace(): Promise<SessionWorkspace> {
    this.workspaceCapability ??= GuardedWorkspace.create(this.workspaceRoot);
    return this.workspaceCapability;
  }

  private workspaceSignal(): AbortSignal {
    return this.abort?.signal ?? new AbortController().signal;
  }

  /** Effective context window: the smaller of the configured size and what the server actually runs with. */
  private contextLimit(s: HarnessSettings): number {
    return Math.min(s.contextSize, this.serverContextSize ?? Number.POSITIVE_INFINITY);
  }

  /**
   * Budget handed to the compactor. Its `limit` is the room left for the
   * message transcript AFTER reserving the system prompt (tool catalog) and a
   * small margin for generation priming — the system prompt is not a stored
   * message, so compaction must leave space for it or the assembled prompt
   * overflows even though the messages fit their own budget.
   */
  private async compactConfig(s: HarnessSettings): Promise<CompactConfig> {
    const limit = this.contextLimit(s);
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
    const text = buildSystemPrompt({
      family: this.record.modelFamily,
      planMode: this.record.planMode,
      workspaceRoot: this.workspaceRoot,
      agentsMd: await this.currentAgentsMd(),
      sandboxCapability: this.toolPolicy.sandbox
    });
    if (this.systemPromptTokenCache?.text !== text) {
      this.systemPromptTokenCache = { text, tokens: await tokenize(s.endpoint, `<|system|>${text}`) };
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
    this.agentsMdCache = await loadRootAgentsMd(this.workspace(), this.workspaceSignal());
    return this.agentsMdCache;
  }

  /** Sync accessor for the value loaded by the most recent currentAgentsMd call. */
  private cachedAgentsMd(): string | undefined {
    return this.agentsMdCache;
  }

  private async refreshServerContextSize(s: HarnessSettings): Promise<void> {
    const serverCtx = await fetchServerContextSize(s.endpoint);
    if (serverCtx === undefined) return;
    if (serverCtx < s.contextSize && this.serverContextSize !== serverCtx) {
      this.emit({
        kind: "notice",
        text: `The llama.cpp server reports a ${serverCtx}-token context window, smaller than the configured ${s.contextSize}. Using ${serverCtx} for context tracking and compaction.`
      });
    }
    this.serverContextSize = serverCtx;
  }

  emitLoaded(): void {
    this.emit({ kind: "chatLoaded", record: this.record });
    const s = readSettings();
    this.emit({ kind: "tokens", total: this.record.totalTokens + this.cachedSystemPromptTokens(), limit: this.contextLimit(s) });
    this.emit({ kind: "planModeChanged", on: this.record.planMode });
    this.emitCompactStatus();
  }

  setPlanMode(on: boolean): void {
    if (this.activeTurn) {
      this.emit({
        kind: "notice",
        text: "Plan mode cannot change during an active turn. Cancel or wait for the turn to finish first."
      });
      return;
    }
    this.record.planMode = on;
    this.emit({ kind: "planModeChanged", on });
    void this.storage.save(this.record);
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
    await recomputeTokens(s.endpoint, this.record);
    const before = this.record.totalTokens;
    const beforeMessages = this.record.messages.length;
    const compactId = `compact_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const ac = new AbortController();
    this.emit({ kind: "compactStart", compactId, source, beforeTokens: before, beforeMessages, keepTail: KEEP_TAIL });
    try {
      const cfg = await this.compactConfig(s);
      const { keptTail } = await compact(s.endpoint, this.record, ac.signal, cfg);
      await this.storage.save(this.record);
      if (options.reload) this.emit({ kind: "chatLoaded", record: this.record });
      this.emit({ kind: "tokens", total: this.record.totalTokens + this.cachedSystemPromptTokens(), limit: this.contextLimit(s) });
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
    this.approvals.cancelAll();
    for (const resolve of this.pendingQuestions.values()) resolve(null);
    this.pendingQuestions.clear();
  }

  approve(decision: ApprovalDecision): boolean {
    return this.approvals.decide(decision);
  }

  hasPendingInteraction(): boolean {
    return this.approvals.hasPending || this.pendingQuestions.size > 0;
  }

  hasActiveTurn(): boolean {
    return this.activeTurn !== undefined;
  }

  answerQuestion(toolId: string, answer: string): void {
    const resolve = this.pendingQuestions.get(toolId);
    if (resolve) {
      this.pendingQuestions.delete(toolId);
      resolve(answer);
    }
  }

  requestToolDiff(toolId: string): void {
    const artifact = this.reviewArtifacts.get(toolId);
    if (!artifact) return;
    this.emit({
      kind: "toolDiff",
      toolId,
      diffPreview: artifact.text,
      diffFormat: artifact.format
    });
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

  private async sendUserMessageLocked(text: string): Promise<void> {
    const s = readSettings();
    this.abort = new AbortController();
    try {
      if (this.record.messages.length === 0) {
        this.record.modelFamily = s.modelFamily;
        this.record.title = titleFromFirstMessage(text);
        this.emit({ kind: "titleChanged", title: this.record.title, animate: true });
      }
      const ts = Date.now();
      this.record.messages.push({ role: "user", content: text, ts });
      await this.storage.save(this.record);
      this.emit({ kind: "userMessage", messageId: `u_${ts}`, text });
      this.emitCompactStatus();

      this.toolPolicy = await captureToolPolicySnapshot(
        s,
        this.commandPortFactory,
        this.abort.signal
      );
      if (!(await this.prepareContextForModelRequest(s, { reload: true }))) return;

      const turnId = randomUUID();
      this.activeTurnId = turnId;
      await this.runTurn(s);
    } finally {
      this.activeTurnId = undefined;
      this.toolPolicy = Object.freeze({ sandbox: NO_SANDBOX_COMMAND_CAPABILITY });
      this.abort = undefined;
    }
  }

  /**
   * Cheap, network-free token estimate emitted at mid-turn checkpoints
   * (thought→text transitions, tool round-trips) so the context ring
   * updates without waiting for the authoritative /tokenize call at turnEnd.
   * Cached message tokens are exact; uncached and live buffer use char/4.
   */
  private emitLiveTokenEstimate(s: HarnessSettings, liveText: string): void {
    let total = this.cachedSystemPromptTokens();
    for (const m of this.record.messages) {
      total += m.tokens ?? Math.ceil(m.content.length / 4);
    }
    if (liveText) total += Math.ceil(liveText.length / 4);
    this.emit({ kind: "tokens", total, limit: this.contextLimit(s) });
  }

  private async prepareContextForModelRequest(
    s: HarnessSettings,
    options: { reload: boolean }
  ): Promise<boolean> {
    await this.refreshServerContextSize(s);
    await recomputeTokens(s.endpoint, this.record);
    const sysTokens = await this.systemPromptTokens(s);
    const limit = this.contextLimit(s);
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
    options: { reload: boolean }
  ): Promise<PromptMessage[] | undefined> {
    if (!(await this.prepareContextForModelRequest(s, options))) return undefined;

    const limit = this.contextLimit(s);
    let messages = this.buildPromptMessages();
    // Count the tokens of the prompt that is ACTUALLY sent (system prompt +
    // re-rendered tool calls + wrapped results), not the sum of stored
    // messages, using llama.cpp's tokenizer. This is the number the server
    // sees, so the guard no longer passes while the server overflows.
    let promptTok = await promptTokens(s.endpoint, messages, s.templateOverheadTokensPerMessage);
    if (s.autoCompact && promptTok >= autoCompactTriggerTokens(limit, s.autoCompactThresholdPercent)) {
      const compacted = await this.runCompact("auto", options);
      if (compacted) {
        messages = this.buildPromptMessages();
        promptTok = await promptTokens(s.endpoint, messages, s.templateOverheadTokensPerMessage);
      }
    }

    this.emit({ kind: "tokens", total: promptTok, limit });
    if (promptTok >= limit) {
      this.emit({ kind: "abort", reason: promptOverflowMessage(promptTok, limit) });
      return undefined;
    }

    return messages;
  }

  private async appendToolResult(
    s: HarnessSettings,
    toolName: string,
    argsJson: string,
    content: string
  ): Promise<string> {
    const guardedContent = await this.prepareToolResultForContext(s, toolName, content);
    const message: ChatMessage = {
      role: "tool",
      content: guardedContent,
      toolCall: { name: toolName, argsJson },
      ts: Date.now()
    };
    // Exact count via /tokenize — a char/4 estimate here becomes the permanent
    // cached count (recomputeTokens skips already-counted messages), and tool
    // results are the largest messages, so under-counting them is what let the
    // context silently overrun and hard-abort.
    message.tokens = await countTokens(s.endpoint, `<|tool|>${guardedContent}`);
    this.record.messages.push(message);
    this.record.totalTokens += message.tokens;
    await this.storage.save(this.record);
    this.emitLiveTokenEstimate(s, "");
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
    const limit = this.contextLimit(s);
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
    if (!this.abort) throw new Error("Cannot run a model turn without a cancellation scope.");
    const messageId = `m_${randomUUID()}`;
    this.emit({ kind: "turnStart", messageId });

    let assistantBuf = "";
    let thoughtBuf = "";
    let ranAnyTool = false;
    // Events stamped with a wall-clock time so the webview can restore real
    // "Thought for Ns" / "Worked for Ns" durations after a reload.
    const turnEvents: (ParsedEvent & { t?: number })[] = [];
    const fileWrites = new Map<string, TrackedFileWrite>();
    this.activeFileWrites = fileWrites;
    this.streamingToolIds.clear();
    this.lastProgressEmitAt.clear();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const parser = makeParser(this.record.modelFamily);
      let aborted = false;
      let toolLoop = false;
      // Every pass re-prompts with the previous pass's tool results, so the
      // model has current line numbers again — reset the staleness tracking.
      this.staleLineEdits.clear();
      const messages = await this.buildPromptMessagesForRequest(s, { reload: false });
      if (!messages) {
        break;
      }

      try {
        for await (const chunk of streamChat(
          s.endpoint,
          { messages, temperature: s.temperature, top_k: s.topK, top_p: s.topP },
          this.abort.signal
        )) {
          if (chunk.kind === "thought") {
            thoughtBuf += chunk.text;
            const events: ParsedEvent[] = [{ kind: "thought", text: chunk.text }];
            await this.handleEvents(events, messageId, s);
            turnEvents.push(...events.map(e => ({ ...e, t: Date.now() })));
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
          const events = parser.feed(chunk.text);
          const continueAfter = await this.handleEvents(events, messageId, s);
          let sawToolInBatch = false;
          for (const e of events) {
            const prev = turnEvents[turnEvents.length - 1];
            if (prev?.kind === "thought" && e.kind !== "thought" && e.kind !== "done") {
              this.emitLiveTokenEstimate(s, assistantBuf + thoughtBuf);
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
          const tail = parser.end();
          const continueAfterTail = await this.handleEvents(tail, messageId, s);
          let sawToolInTail = false;
          for (const e of tail) {
            const prev = turnEvents[turnEvents.length - 1];
            if (prev?.kind === "thought" && e.kind !== "thought" && e.kind !== "done") {
              this.emitLiveTokenEstimate(s, assistantBuf + thoughtBuf);
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
        this.emit({ kind: "abort", reason: (e as Error).message });
        aborted = true;
      }

      // The model truncated mid-tool-call (an unclosed write_file the parser
      // dropped). Feed the error back as a tool result and re-prompt so the
      // agent can re-emit the call, instead of stopping with a dead red card.
      if (!aborted && this.streamingToolIds.size > 0) {
        await this.feedBackIncompleteStreamingTools(s);
        toolLoop = true;
      }

      // If a tool ran this iteration, the LLM needs another pass; otherwise we are done.
      if (aborted) break;
      if (toolLoop) {
        ranAnyTool = true;
        // Only visible assistant text belongs in prompt history. Thought-only
        // turns are UI state; replaying them as empty assistant messages can
        // be interpreted by thinking-enabled servers as response prefill.
        if (assistantBuf.trim()) {
          this.record.messages.push({
            role: "assistant",
            content: assistantBuf,
            events: turnEvents.splice(0),
            ts: Date.now()
          });
        }
        assistantBuf = "";
        thoughtBuf = "";
        turnEvents.length = 0;
        await this.storage.save(this.record);
        this.emitLiveTokenEstimate(s, "");
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
        this.emit({ kind: "notice", text: emptyTurnNotice(ranAnyTool, !!thoughtBuf.trim()) });
      }
      if (fileChanges.length > 0) {
        this.emit({ kind: "fileChanges", messageId, changes: fileChanges });
      }
      break;
    }

    this.activeFileWrites = undefined;
    this.failUnfinishedStreamingTools();
    await this.storage.save(this.record);
    await recomputeTokens(s.endpoint, this.record);
    this.emit({ kind: "tokens", total: this.record.totalTokens + this.cachedSystemPromptTokens(), limit: this.contextLimit(s) });
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
    const progressKey = streamingToolKey(messageId, e.name, e.id);
    const toolId = this.streamingToolIds.get(progressKey) ?? `t_${randomUUID()}`;
    this.streamingToolIds.delete(progressKey);
    // Any tool call breaks the current same-file edit run by default; only a
    // successful write to the same path re-establishes it (in the write branch).
    const priorWriteGroup = this.writeGroup;
    this.writeGroup = undefined;
    const sandboxCapability = this.toolPolicy.sandbox;
    const cls = classifyToolName(e.name, sandboxCapability);
    const activeTool = findActiveTool(e.name, sandboxCapability);
    const availableNames: ReadonlySet<string> = new Set(
      toolsForMode(this.record.planMode, sandboxCapability).map(tool => tool.name)
    );
    // Blank-name calls are parse failures (invalid tool-call body, or a block
    // cut off mid-stream); they carry the raw body in argsJson. Give them a
    // readable name for the card and the replayed transcript.
    const malformed = !e.name.trim();
    const displayName = malformed ? "tool_call" : e.name;
    let argsJson = malformed ? truncateRawArgs(e.argsJson) : e.argsJson;
    let category: ToolCategory;
    let reason: string | undefined;
    let writeArgs: PreparedWriteArgs | undefined;
    let editTransaction: PreparedEditTransaction | undefined;
    let writeKey: string | undefined;
    let proposedGroupId: string | undefined;
    let proposedAdded: number | undefined;
    let proposedRemoved: number | undefined;
    let questionArgs: { question: string; suggestions: string[] } | undefined;
    let commandTransaction: PreparedCommandTransaction | undefined;
    let args: Record<string, unknown> = {};
    // Set when the call packed several argument objects into one array —
    // applying just the first (the old behavior) silently dropped the rest
    // while the model believed they all ran.
    let multiArgsIssue: string | undefined;
    try {
      args = normalizeToolArgs(JSON.parse(e.argsJson));
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

    if (malformed) {
      // A streaming write_file card may still be tracking this very call;
      // resolve it here so the post-stream incomplete-tool check doesn't feed
      // back a second error for the same block.
      this.failUnfinishedStreamingTools();
      category = "unknown";
      reason = malformedToolCallReason(availableNames);
    } else if (cls === "disabled") {
      // Compatibility parsers still recognize legacy command calls so they
      // reach this fail-closed branch instead of being ignored or executed.
      category = "forbidden";
      reason = disabledToolReason(e.name, sandboxCapability);
    } else if (cls === "forbidden") {
      category = "forbidden";
      reason = `Tool "${e.name}" is forbidden in this harness (no internet/network tools).`;
    } else if (cls === "unknown") {
      category = "unknown";
      reason = unknownToolReason(e.name, availableNames);
    } else if (this.record.planMode && activeTool && !activeTool.availableInPlanMode) {
      category = "planViolation";
      reason = planModeViolationReason(e.name, args, activeTool.category);
    } else if (activeTool?.category === "todos") {
      category = "todos";
    } else if (activeTool?.category === "question") {
      category = "question";
      try {
        questionArgs = normalizeAskUserQuestionArgs(args, e.argsJson);
        // Hand the card/composer a clean, normalized payload to render.
        argsJson = JSON.stringify(questionArgs);
      } catch (err) {
        reason = (err as Error).message;
      }
    } else if (activeTool?.category === "write") {
      category = "write";
      try {
        writeArgs = normalizeWriteToolArgs(e.name, args, e.argsJson);
        argsJson = JSON.stringify(canonicalWriteArgs(writeArgs));
        const workspace = await this.workspace();
        const candidate = await prepareEditTransaction(
          workspace,
          writeArgs,
          this.workspaceSignal()
        );
        writeKey = path.resolve(path.join(workspace.root, ...candidate.edit.path.split("/")));
        if (writeArgs.kind !== "write_file") {
          const shift = this.staleLineEdits.get(writeKey);
          if (shift !== undefined && shift !== 0) {
            workspace.discardEdit(candidate.edit);
            throw new Error(staleLineNumbersMessage(e.name, candidate.edit.path, shift));
          }
        }
        editTransaction = candidate;
        // Group only when the reviewed base is byte-continuous with the prior
        // harness edit. External changes start a new attribution segment.
        if (
          priorWriteGroup &&
          priorWriteGroup.key === writeKey &&
          priorWriteGroup.latest === candidate.edit.previous
        ) {
          proposedGroupId = priorWriteGroup.id;
          const stats = lineDiffStats(priorWriteGroup.original, candidate.edit.next);
          proposedAdded = stats.added;
          proposedRemoved = stats.removed;
        } else {
          proposedAdded = candidate.review.added;
          proposedRemoved = candidate.review.removed;
        }
      } catch (err) {
        if (editTransaction) {
          (await this.workspace()).discardEdit(editTransaction.edit);
          editTransaction = undefined;
          writeKey = undefined;
          proposedGroupId = undefined;
          proposedAdded = undefined;
          proposedRemoved = undefined;
        }
        reason = (err as Error).message;
      }
    } else if (activeTool?.category === "read") {
      category = "read";
    } else if (activeTool?.category === "command") {
      category = "safeCmd";
      try {
        const commands = this.toolPolicy.commands;
        if (!commands) {
          throw new Error("The verified sandbox command capability is no longer available.");
        }
        commandTransaction = await prepareCommandTransaction(
          commands,
          sandboxCapability,
          e.argsJson,
          this.workspaceSignal()
        );
        argsJson = commandTransaction.argsJson;
      } catch (error) {
        reason = (error as Error).message;
      }
    } else {
      // Classification and lookup are deliberately derived from the same
      // catalog. Keep a fail-closed fallback in case that invariant regresses.
      category = "unknown";
      reason = unknownToolReason(e.name, availableNames);
    }

    const approvalSetting = activeTool?.approvalPolicy.kind === "configurable"
      ? activeTool.approvalPolicy.setting
      : undefined;
    const needsApproval = approvalSetting !== undefined && !s[approvalSetting];
    const canRequestApproval = needsApproval &&
      !multiArgsIssue &&
      !reason &&
      (category === "read" || category === "write" || category === "safeCmd");
    let pendingApproval: PendingApproval | undefined;
    if (canRequestApproval) {
      const turnId = this.activeTurnId;
      if (!turnId) throw new Error("Cannot create an approval outside an active turn.");
      try {
        pendingApproval = this.approvals.create(
          toolId,
          turnId,
          scope => commandTransaction
            ? commandReviewDigest(scope, commandTransaction)
            : editTransaction
              ? editReviewDigest(scope, editTransaction)
              : toolReviewDigest(scope, displayName, argsJson)
        );
      } catch (error) {
        if (editTransaction) (await this.workspace()).discardEdit(editTransaction.edit);
        if (commandTransaction) discardCommandTransaction(commandTransaction);
        throw error;
      }
    }

    this.emit({
      kind: "toolCallProposed",
      toolId,
      messageId,
      toolName: displayName,
      argsJson,
      category,
      reason,
      groupId: proposedGroupId,
      diffPreview: editTransaction?.review.text,
      diffFormat: editTransaction ? "exact-v1" : undefined,
      reviewPreview: commandTransaction?.review.text,
      reviewFormat: commandTransaction?.review.format,
      commandDisplay: commandTransaction?.commandDisplay,
      added: proposedAdded,
      removed: proposedRemoved,
      createsNewFile: editTransaction?.edit.created,
      approval: pendingApproval?.binding
    });

    // A multi-object argument array is recoverable but must not half-execute:
    // fail the call with the explanation instead of applying only part of it.
    // update_todos is exempt — a bare array IS its natural shape (handled below).
    if (
      multiArgsIssue &&
      (category === "read" || category === "write" || category === "safeCmd" || category === "question")
    ) {
      if (commandTransaction) discardCommandTransaction(commandTransaction);
      const result = `error: ${multiArgsIssue}`;
      this.emit({ kind: "toolCallResolved", toolId, status: "failed", resultPreview: result });
      await this.appendToolResult(s, displayName, argsJson, result);
      return "executed";
    }

    if (category === "unknown") {
      // Recoverable: reject this call, hand the reason back as a tool result, and
      // let the turn continue so the model can adapt (use a real tool or answer).
      // Error results are sent whole — the card shows them in a scrollable
      // bubble, so a one-line preview would just hide the explanation.
      const blocked = blockedToolDetails(category, displayName, argsJson, reason);
      this.emit({ kind: "toolCallResolved", toolId, status: "rejected", resultPreview: blocked });
      await this.appendToolResult(s, displayName, argsJson, blocked);
      return "executed";
    }

    if (category === "forbidden" || category === "planViolation") {
      if (commandTransaction) discardCommandTransaction(commandTransaction);
      const blocked = blockedToolDetails(category, displayName, argsJson, reason);
      this.emit({ kind: "toolCallResolved", toolId, status: "rejected", resultPreview: blocked });
      this.emit({ kind: "abort", reason: blocked });
      await this.appendToolResult(s, displayName, argsJson, blocked);
      return "aborted";
    }

    if (category === "write" && reason) {
      const result = `error: ${reason}`;
      this.emit({ kind: "toolCallResolved", toolId, status: "failed", resultPreview: result });
      await this.appendToolResult(s, e.name, e.argsJson, result);
      return "executed";
    }

    if (category === "safeCmd" && reason) {
      if (commandTransaction) discardCommandTransaction(commandTransaction);
      const result = `error: ${reason}`;
      this.emit({ kind: "toolCallResolved", toolId, status: "failed", resultPreview: result });
      await this.appendToolResult(s, e.name, argsJson, result);
      return "executed";
    }

    if (category === "question") {
      if (reason || !questionArgs) {
        const result = `error: ${reason ?? "ask_user_question requires a question and at least two suggestions."}`;
        this.emit({ kind: "toolCallResolved", toolId, status: "failed", resultPreview: result });
        await this.appendToolResult(s, e.name, e.argsJson, result);
        return "executed";
      }
      // Park the turn until the user answers (or the turn is cancelled).
      const answer = await new Promise<string | null>(res => {
        this.pendingQuestions.set(toolId, res);
      });
      if (answer === null) {
        const note = "[ask_user_question dismissed] The user did not answer the question.";
        this.emit({ kind: "toolCallResolved", toolId, status: "rejected", resultPreview: note });
        await this.appendToolResult(s, e.name, e.argsJson, note);
        return "aborted";
      }
      const result = `the user has answered your question: "${answer}"`;
      this.emit({ kind: "toolCallResolved", toolId, status: "executed", resultPreview: result });
      await this.appendToolResult(s, e.name, e.argsJson, result);
      return "executed";
    }

    if (pendingApproval) {
      const approved = await pendingApproval.decision;
      if (!approved) {
        if (editTransaction) (await this.workspace()).discardEdit(editTransaction.edit);
        if (commandTransaction) discardCommandTransaction(commandTransaction);
        const rejected = userRejectedToolDetails(e.name, argsJson);
        this.emit({ kind: "toolCallResolved", toolId, status: "rejected", resultPreview: rejected });
        await this.appendToolResult(s, e.name, argsJson, rejected);
        return "aborted";
      }
      this.emit({ kind: "toolCallResolved", toolId, status: "approved" });
    }

    // Execute.
    let result: string;
    let resolvedAfterExecution = false;
    try {
      if (e.name === "run_command") {
        if (!commandTransaction) {
          throw new Error("The sandbox command was not prepared for execution.");
        }
        result = await executeCommandTransaction(commandTransaction, this.workspaceSignal());
      } else if (e.name === "read_file") {
        // Number the lines so the model can address them with insert_text /
        // replace_range. For a range read the numbers are the lines' real
        // positions in the file, and a header reports how much was not shown.
        const readArgs = normalizeReadFileArgs(args, e.argsJson);
        const r = await (await this.workspace()).readFile(readArgs, this.workspaceSignal());
        const numbered = formatFileForModel(r.content, Math.max(1, r.startLine));
        result = r.startLine > 1 || r.endLine < r.totalLines
          ? `[lines ${r.startLine}-${r.endLine} of ${r.totalLines}]\n${numbered}`
          : numbered;
      } else if (isWriteToolName(e.name)) {
        if (!writeArgs || !editTransaction || !writeKey) {
          throw new Error("The edit was not prepared for approval and cannot be executed.");
        }
        const workspace = await this.workspace();
        const committed = await workspace.commitEdit(editTransaction.edit, this.workspaceSignal());
        const previous = committed.previous;
        const next = committed.next;
        const description = describeCommittedEdit(writeArgs, editTransaction.edit);
        result = description.result;
        // Track this response's cumulative shift for the file. write_file
        // resets it: the model just supplied the full content, so numbers
        // derived from that content are current again.
        this.staleLineEdits.set(
          writeKey,
          writeArgs.kind === "write_file"
            ? 0
            : (this.staleLineEdits.get(writeKey) ?? 0) + description.lineDelta
        );
        const displayPath = editTransaction.edit.path;
        if (this.activeFileWrites) {
          rememberFileWrite(this.activeFileWrites, {
            key: writeKey,
            path: displayPath,
            previous,
            next,
            diffPreview: editTransaction.review.text
          });
        }
        // Extend the run of consecutive edits to this file (or start a fresh
        // one). The card shows a single original→latest diff and cumulative
        // line stats; `original` is held from the run's first edit.
        const group = priorWriteGroup &&
          priorWriteGroup.key === writeKey &&
          priorWriteGroup.latest === previous
          ? { id: priorWriteGroup.id, key: writeKey, original: priorWriteGroup.original, latest: next }
          : { id: newWriteGroupId(), key: writeKey, original: previous, latest: next };
        this.writeGroup = group;
        const stats = group.original === previous
          ? { added: editTransaction.review.added, removed: editTransaction.review.removed }
          : lineDiffStats(group.original, group.latest);
        // The on-demand diff is per CALL (this edit's previous→next), not the
        // run's combined diff: the expanded group card renders each step with
        // its own diff. The heading's cumulative ±stats still come from the
        // whole run (original→latest) via the resolve event below.
        this.reviewArtifacts.set(toolId, {
          text: editTransaction.review.text,
          format: "exact-v1"
        });
        this.emit({
          kind: "toolCallResolved",
          toolId,
          status: "executed",
          resultPreview: previewOf(result),
          diffPreview: editTransaction.review.text,
          groupId: group.id,
          added: stats.added,
          removed: stats.removed,
          createsNewFile: editTransaction.edit.created
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
        const listArgs = normalizeListDirArgs(args, e.argsJson);
        const r = await (await this.workspace()).listDirectory(
          listArgs.path,
          this.workspaceSignal()
        );
        result = JSON.stringify(r.map(entry => ({
          name: entry.name,
          type: entry.type === "directory" ? "dir" : entry.type
        })));
      } else if (e.name === "glob") {
        const globArgs = normalizeGlobArgs(args, e.argsJson);
        const r = await (await this.workspace()).glob(
          globArgs.pattern,
          globArgs.maxResults,
          this.workspaceSignal()
        );
        result = JSON.stringify(r);
      } else {
        result = `[harness] unknown tool: ${e.name}`;
      }
    } catch (err) {
      if (commandTransaction) discardCommandTransaction(commandTransaction);
      if (this.abort?.signal.aborted) {
        const cancelled = "[cancelled] Tool execution stopped before it committed.";
        this.emit({ kind: "toolCallResolved", toolId, status: "rejected", resultPreview: cancelled });
        return "aborted";
      }
      result = `error: ${(err as Error).message}`;
      const storedResult = await this.appendToolResult(s, e.name, argsJson, result);
      this.emit({ kind: "toolCallResolved", toolId, status: "failed", resultPreview: storedResult });
      return "executed";
    }

    const storedResult = await this.appendToolResult(s, e.name, argsJson, result);
    if (!resolvedAfterExecution || storedResult !== result) {
      // list_dir and glob render their result as a vertical file list in the
      // card, so the UI needs the whole (bounded) result, not a one-line preview.
      const keepsFullResult = e.name === "list_dir" || e.name === "glob" || e.name === "run_command";
      const resultPreview = e.name === "run_command"
        ? result
        : keepsFullResult
          ? storedResult
          : previewOf(storedResult);
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
    let toolId = this.streamingToolIds.get(key);
    if (!toolId) {
      toolId = `t_${randomUUID()}`;
      this.streamingToolIds.set(key, toolId);
    }
    // The card must appear on the first emitted frame; after that, rate-limit
    // so progress isn't recomputed on every streamed token.
    const now = Date.now();
    const firstEmit = !this.lastProgressEmitAt.has(toolId);
    if (!firstEmit && now - (this.lastProgressEmitAt.get(toolId) ?? 0) < PROGRESS_THROTTLE_MS) {
      return;
    }
    this.lastProgressEmitAt.set(toolId, now);
    // Do not read or stat the target while a write call is only streaming. The
    // guarded preflight obtains prior state once the complete call is available.
    const stats = liveWriteStats(e);
    this.emit({
      kind: "toolCallProgress",
      toolId,
      messageId,
      toolName: e.name,
      path: e.path,
      contentLines: e.contentLines,
      added: stats.added,
      removed: stats.removed,
      replacedLines: e.name === "replace_range" ? replacedLineCount(e.startLine, e.endLine) : undefined,
      groupId: undefined
    });
  }

  private failUnfinishedStreamingTools(): void {
    if (this.streamingToolIds.size === 0) return;
    for (const toolId of this.streamingToolIds.values()) {
      this.emit({
        kind: "toolCallResolved",
        toolId,
        status: "failed",
        resultPreview: "error: incomplete write_file tool call"
      });
    }
    this.streamingToolIds.clear();
  }

  /**
   * Mark each orphaned streaming write_file card failed AND append the error as
   * a tool result, so the next prompt pass tells the model its call was cut off
   * and it can re-emit it (rather than the turn silently ending).
   */
  private async feedBackIncompleteStreamingTools(s: HarnessSettings): Promise<void> {
    const toolIds = [...this.streamingToolIds.values()];
    this.streamingToolIds.clear();
    const result =
      "error: incomplete write_file tool call — the call was cut off before it finished " +
      "streaming and was not executed. Re-emit the complete write_file call, or use " +
      "insert_text / replace_range for a smaller, localized edit.";
    for (const toolId of toolIds) {
      this.emit({ kind: "toolCallResolved", toolId, status: "failed", resultPreview: result });
      await this.appendToolResult(s, "write_file", "{}", result);
    }
  }

  private buildPromptMessages(): PromptMessage[] {
    const sys = buildSystemPrompt({
      family: this.record.modelFamily,
      planMode: this.record.planMode,
      workspaceRoot: this.workspaceRoot,
      agentsMd: this.cachedAgentsMd(),
      sandboxCapability: this.toolPolicy.sandbox
    });
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
}

function autoCompactTriggerTokens(contextSize: number, thresholdPercent: number): number {
  return Math.max(1, Math.floor(contextSize * (thresholdPercent / 100)));
}

function contextWindowOverflowMessage(tokens: number, limit: number): string {
  return [
    `Context window guard: context is ${tokens} / ${limit} tokens.`,
    `The request was not sent to the model because it would exceed the context window.`,
    `Compact context, reduce recent tool output, or increase the configured context size before continuing.`
  ].join("\n");
}

function promptOverflowMessage(tokens: number, limit: number): string {
  return [
    `Context window guard: the rendered prompt is ${tokens} / ${limit} tokens.`,
    `The request was not sent to the model because llama.cpp would reject it.`,
    `Compact context, reduce recent tool output, or increase the configured context size before continuing.`
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
 *  - insert_text / write_file: every streamed line is provisionally an addition.
 *  - replace_range: removes the whole target range, adds the streamed lines.
 * Exact diff stats and create/overwrite status replace these estimates when
 * the complete call is prepared, before any manual approval is offered.
 */
function liveWriteStats(
  e: Extract<ParsedEvent, { kind: "toolCallProgress" }>
): { added: number; removed: number } {
  const added = e.contentLines;
  if (e.name === "insert_text") return { added, removed: 0 };
  if (e.name === "replace_range") return { added, removed: replacedLineCount(e.startLine, e.endLine) ?? 0 };
  return { added, removed: 0 };
}

function replacedLineCount(startLine?: number, endLine?: number): number | undefined {
  if (startLine === undefined || endLine === undefined || endLine < startLine) return undefined;
  return endLine - startLine + 1;
}

function newWriteGroupId(): string {
  return `g_${randomUUID()}`;
}

function emptyTurnNotice(ranAnyTool: boolean, thought: boolean): string {
  const lead = thought
    ? "The model stopped right after thinking, without a reply."
    : ranAnyTool
      ? "The model stopped after its tool calls, without a final reply."
      : "The model ended its turn without producing a reply.";
  return `${lead} It may have stopped early (a stop-token/template mismatch on the server). Resend your message to continue. If this keeps happening, check that the Model family setting matches the served model.`;
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
  const nested = obj.arguments ?? obj.args ?? obj.input ?? obj.parameters;
  if (nested) return normalizeToolArgs(nested);
  return obj;
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
  if (toolName === "insert_text") {
    return { kind: "insert_text", ...normalizeInsertTextArgs(args, rawArgsJson) };
  }
  if (toolName === "replace_range") {
    return { kind: "replace_range", ...normalizeReplaceRangeArgs(args, rawArgsJson) };
  }
  throw new Error(`Unknown write tool: ${toolName}`);
}

/** Stable, minimal argument shape displayed to the user and replayed to the model. */
function canonicalWriteArgs(args: PreparedWriteArgs): Record<string, unknown> {
  if (args.kind === "write_file") {
    return { path: args.path, content: args.content };
  }
  if (args.kind === "insert_text") {
    return { path: args.path, line: args.line, text: args.text };
  }
  return {
    path: args.path,
    startLine: args.startLine,
    endLine: args.endLine,
    content: args.content
  };
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
  return { path: pathValue, line, text: textValue };
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
  return { path: pathValue, startLine, endLine, content: contentValue };
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

function normalizeListDirArgs(
  args: Record<string, unknown>,
  rawArgsJson?: string
): { path: string } {
  const normalized = normalizeToolArgs(args);
  const pathValue = normalized.path
    ?? normalized.directory
    ?? normalized.dir
    ?? normalized.folder;
  if (typeof pathValue !== "string" || pathValue.trim() === "") {
    throw new Error(buildToolArgsError("list_dir", "path", normalized, rawArgsJson, "path, directory, dir"));
  }
  return { path: pathValue };
}

function normalizeGlobArgs(
  args: Record<string, unknown>,
  rawArgsJson?: string
): { pattern: string; maxResults?: number } {
  const normalized = normalizeToolArgs(args);
  const patternValue = normalized.pattern ?? normalized.glob ?? normalized.query;
  if (typeof patternValue !== "string" || patternValue.trim() === "") {
    throw new Error(buildToolArgsError("glob", "pattern", normalized, rawArgsJson, "pattern, glob"));
  }
  const maxValue = normalized.maxResults ?? normalized.max_results ?? normalized.limit;
  return {
    pattern: patternValue,
    maxResults: typeof maxValue === "number" && Number.isFinite(maxValue) ? maxValue : undefined
  };
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

// Raw bodies of unparseable calls can be huge (a cut-off write_file); cap what
// is shown on the card and replayed back into context.
const MAX_MALFORMED_ARGS_CHARS = 1500;

function truncateRawArgs(raw: string): string {
  if (raw.length <= MAX_MALFORMED_ARGS_CHARS) return raw;
  return raw.slice(0, MAX_MALFORMED_ARGS_CHARS) + "\n…[truncated]";
}

function malformedToolCallReason(allowedNames: ReadonlySet<string>): string {
  return [
    `Malformed tool call: the tool-call block could not be parsed, so nothing was executed.`,
    `Its body was not a valid tool call, or the block was cut off before it was closed.`,
    `Re-emit the complete tool call as a single valid block in the tool-call format described in the system prompt, or answer directly if no tool is needed.`,
    `Available tools: ${[...allowedNames].join(", ")}.`
  ].join("\n");
}

function unknownToolReason(name: string, allowedNames: ReadonlySet<string>): string {
  return [
    `Unknown tool "${name}". This harness has no tool by that name.`,
    `Available tools: ${[...allowedNames].join(", ")}.`,
    `Re-issue the request using one of these tools, or answer directly if no tool is needed.`,
    `Do not retry the same unknown tool name.`
  ].join("\n");
}

function planModeViolationReason(
  toolName: string,
  args: Record<string, unknown>,
  category: string
): string {
  const attempted = category === "write"
    ? `Attempted edit path: ${String(args.path ?? args.file_path ?? args.filePath ?? "(missing path)")}`
    : `The requested capability category was ${category}.`;
  return [
    `In plan mode, "${toolName}" is not allowed.`,
    attempted,
    `Plan mode may still use read-only tools: read_file, list_dir, and glob.`,
    `Accept the plan and turn plan mode off before writing files.`
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
