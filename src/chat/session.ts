import * as path from "node:path";
import { streamChat } from "../llm/client.js";
import { buildSystemPrompt, coalesceSameRole, renderToolCallForPrompt } from "../llm/prompt.js";
import { makeParser, type ParsedEvent } from "../llm/parser/index.js";
import { ALLOWED_TOOL_NAMES, classifyToolName } from "../tools/forbiddenTools.js";
import { checkSafeCommand, type SafeCommandEntry } from "../tools/safeCommands.js";
import {
  readFile,
  formatFileForModel,
  writeFile,
  insertText,
  replaceRange,
  listDir,
  glob,
  type InsertTextArgs,
  type ReplaceRangeArgs
} from "../tools/fsTools.js";
import { assertInsideWorkspace } from "../tools/workspaceGuard.js";
import { runCommand } from "../tools/terminalTool.js";
import { readSettings, type HarnessSettings } from "../config/settings.js";
import { ChatStorage, titleFromFirstMessage, type ChatMessage, type ChatRecord } from "./storage.js";
import { compact, compactAvailableForMessageCount, KEEP_TAIL, MIN_COMPACT_MESSAGES } from "./compactor.js";
import { recomputeTokens } from "./contextTracker.js";
import { renderLineDiff } from "./diffPreview.js";
import { diffStats, rememberFileWrite, summarizeFileChanges, type FileChangeSummary, type TrackedFileWrite } from "./fileChanges.js";

/** Events the session emits to the chat webview. */
export type UiEvent =
  | { kind: "userMessage"; messageId: string; text: string }
  | { kind: "turnStart"; messageId: string }
  | { kind: "text"; messageId: string; delta: string }
  | { kind: "thought"; messageId: string; delta: string }
  | { kind: "toolCallProgress"; toolId: string; messageId: string; toolName: string; path?: string; contentBytes: number; contentLines: number }
  | { kind: "toolCallProposed"; toolId: string; messageId: string; toolName: string; argsJson: string; category: ToolCategory; reason?: string; diffPreview?: string }
  | { kind: "toolCallResolved"; toolId: string; status: "approved" | "rejected" | "executed" | "failed"; resultPreview?: string; diffPreview?: string; groupId?: string; added?: number; removed?: number }
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
  | "safeCmd"   // purple, manual approval always
  | "unsafeCmd" // red, rejected tool result
  | "forbidden" // red, abort
  | "unknown"   // red, abort
  | "planViolation"; // red, abort

type PromptMessage = { role: "system" | "user" | "assistant" | "tool"; content: string };

type PreparedWriteArgs =
  | { kind: "write_file"; path: string; content: string }
  | ({ kind: "insert_text" } & InsertTextArgs)
  | ({ kind: "replace_range" } & ReplaceRangeArgs);

const WRITE_TOOL_NAMES = new Set(["write_file", "insert_text", "replace_range"]);

function isWriteToolName(name: string): boolean {
  return WRITE_TOOL_NAMES.has(name);
}

interface PendingApproval {
  resolve(v: { approved: boolean }): void;
}

export class ChatSession {
  private record: ChatRecord;
  private pending = new Map<string, PendingApproval>();
  private abort: AbortController | undefined;
  private activeTurn: Promise<void> | undefined;
  private emit: (e: UiEvent) => void;
  private storage: ChatStorage;
  private workspaceRoot: string;
  private activeFileWrites?: Map<string, TrackedFileWrite>;
  private streamingToolIds = new Map<string, string>();
  private toolDiffSources = new Map<string, TrackedFileWrite>();
  // Tracks a run of consecutive edits to the same file so they collapse into a
  // single edit card showing one combined original→latest diff. Reset to
  // undefined whenever any other tool runs (see the snapshot in handleToolCall).
  private writeGroup?: { id: string; key: string; original: string; latest: string };

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

  emitLoaded(): void {
    this.emit({ kind: "chatLoaded", record: this.record });
    const s = readSettings();
    this.emit({ kind: "tokens", total: this.record.totalTokens, limit: s.contextSize });
    this.emit({ kind: "planModeChanged", on: this.record.planMode });
    this.emitCompactStatus();
  }

  setPlanMode(on: boolean): void {
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
      await compact(s.endpoint, this.record, ac.signal);
      await this.storage.save(this.record);
      if (options.reload) this.emit({ kind: "chatLoaded", record: this.record });
      this.emit({ kind: "tokens", total: this.record.totalTokens, limit: s.contextSize });
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
        keepTail: KEEP_TAIL
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
    for (const p of this.pending.values()) p.resolve({ approved: false });
    this.pending.clear();
  }

  approve(toolId: string, approved: boolean): void {
    const p = this.pending.get(toolId);
    if (p) {
      this.pending.delete(toolId);
      p.resolve({ approved });
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

  private async sendUserMessageLocked(text: string): Promise<void> {
    const s = readSettings();
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

    if (!(await this.prepareContextForModelRequest(s, { reload: true }))) return;

    await this.runTurn(s);
  }

  /**
   * Cheap, network-free token estimate emitted at mid-turn checkpoints
   * (thought→text transitions, tool round-trips) so the context ring
   * updates without waiting for the authoritative /tokenize call at turnEnd.
   * Cached message tokens are exact; uncached and live buffer use char/4.
   */
  private emitLiveTokenEstimate(s: HarnessSettings, liveText: string): void {
    let total = 0;
    for (const m of this.record.messages) {
      total += m.tokens ?? Math.ceil(m.content.length / 4);
    }
    if (liveText) total += Math.ceil(liveText.length / 4);
    this.emit({ kind: "tokens", total, limit: s.contextSize });
  }

  private async prepareContextForModelRequest(
    s: HarnessSettings,
    options: { reload: boolean }
  ): Promise<boolean> {
    await recomputeTokens(s.endpoint, this.record);
    this.emit({ kind: "tokens", total: this.record.totalTokens, limit: s.contextSize });
    this.emitCompactStatus();

    if (s.autoCompact && this.record.totalTokens >= autoCompactTriggerTokens(s.contextSize, s.autoCompactThresholdPercent)) {
      await this.runCompact("auto", options);
    }

    if (this.record.totalTokens >= s.contextSize) {
      this.emit({ kind: "abort", reason: contextWindowOverflowMessage(this.record.totalTokens, s.contextSize) });
      return false;
    }

    return true;
  }

  private async buildPromptMessagesForRequest(
    s: HarnessSettings,
    options: { reload: boolean }
  ): Promise<PromptMessage[] | undefined> {
    if (!(await this.prepareContextForModelRequest(s, options))) return undefined;

    let messages = this.buildPromptMessages();
    let estimatedTokens = estimatePromptTokens(messages);
    if (s.autoCompact && estimatedTokens >= autoCompactTriggerTokens(s.contextSize, s.autoCompactThresholdPercent)) {
      const compacted = await this.runCompact("auto", options);
      if (compacted) {
        messages = this.buildPromptMessages();
        estimatedTokens = estimatePromptTokens(messages);
      }
    }

    if (estimatedTokens >= s.contextSize) {
      this.emit({ kind: "abort", reason: promptOverflowMessage(estimatedTokens, s.contextSize) });
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
    message.tokens = estimateChatMessageTokens(message);
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
    const estimatedToolTokens = estimateChatMessageTokens({ role: "tool", content });
    let projectedTokens = this.record.totalTokens + estimatedToolTokens;

    if (s.autoCompact && projectedTokens >= autoCompactTriggerTokens(s.contextSize, s.autoCompactThresholdPercent)) {
      await this.runCompact("auto", { reload: false });
      projectedTokens = this.record.totalTokens + estimatedToolTokens;
    }

    if (projectedTokens >= s.contextSize) {
      return toolResultOverflowMessage(toolName, estimatedToolTokens, projectedTokens, s.contextSize);
    }

    return content;
  }

  private async runTurn(s: HarnessSettings): Promise<void> {
    this.abort = new AbortController();
    const messageId = `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const parser = makeParser(this.record.modelFamily);
      let aborted = false;
      let toolLoop = false;
      const messages = await this.buildPromptMessagesForRequest(s, { reload: false });
      if (!messages) {
        break;
      }

      try {
        for await (const chunk of streamChat(s.endpoint, { messages }, this.abort.signal)) {
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
            if (!res.continue) {
              aborted = res.abort ?? false;
              toolLoop = res.toolLoop ?? false;
              break;
            }
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
    this.emit({ kind: "tokens", total: this.record.totalTokens, limit: s.contextSize });
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
    const toolId = this.streamingToolIds.get(progressKey) ?? `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.streamingToolIds.delete(progressKey);
    // Any tool call breaks the current same-file edit run by default; only a
    // successful write to the same path re-establishes it (in the write branch).
    const priorWriteGroup = this.writeGroup;
    this.writeGroup = undefined;
    const cls = classifyToolName(e.name);
    // Blank-name calls are parse failures (invalid tool-call body, or a block
    // cut off mid-stream); they carry the raw body in argsJson. Give them a
    // readable name for the card and the replayed transcript.
    const malformed = !e.name.trim();
    const displayName = malformed ? "tool_call" : e.name;
    const argsJson = malformed ? truncateRawArgs(e.argsJson) : e.argsJson;
    let category: ToolCategory;
    let reason: string | undefined;
    let writeArgs: PreparedWriteArgs | undefined;
    let args: Record<string, unknown> = {};
    try {
      args = normalizeToolArgs(JSON.parse(e.argsJson));
    } catch {
      // JSON.parse failed — pass the raw string so normalizeToolArgs can try unwrapping
      // a stringified-JSON shape (`"{...}"`) which JSON.parse refuses at the top level.
      args = normalizeToolArgs(e.argsJson);
    }

    if (malformed) {
      // A streaming write_file card may still be tracking this very call;
      // resolve it here so the post-stream incomplete-tool check doesn't feed
      // back a second error for the same block.
      this.failUnfinishedStreamingTools();
      category = "unknown";
      reason = malformedToolCallReason();
    } else if (cls === "forbidden") {
      category = "forbidden";
      reason = `Tool "${e.name}" is forbidden in this harness (no internet/network tools).`;
    } else if (cls === "unknown") {
      category = "unknown";
      reason = unknownToolReason(e.name);
    } else if (this.record.planMode && (isWriteToolName(e.name) || e.name === "run_command")) {
      category = "planViolation";
      reason = planModeViolationReason(e.name, args);
    } else if (e.name === "run_command") {
      const cmd = String(args.command ?? "");
      const check = checkSafeCommand(cmd, s.safeCommands);
      category = check.ok ? "safeCmd" : "unsafeCmd";
      reason = check.ok ? check.reason : unsafeCommandReason(cmd, check.reason, s.safeCommands);
    } else if (isWriteToolName(e.name)) {
      category = "write";
      try {
        writeArgs = normalizeWriteToolArgs(e.name, args, e.argsJson);
        await assertInsideWorkspace(this.workspaceRoot, writeArgs.path);
      } catch (err) {
        reason = (err as Error).message;
      }
    } else {
      category = "read";
    }

    this.emit({ kind: "toolCallProposed", toolId, messageId, toolName: displayName, argsJson, category, reason });

    if (category === "unsafeCmd" || category === "unknown") {
      // Recoverable: reject this call, hand the reason back as a tool result, and
      // let the turn continue so the model can adapt (use a real tool or answer).
      const blocked = blockedToolDetails(category, displayName, argsJson, reason);
      this.emit({ kind: "toolCallResolved", toolId, status: "rejected", resultPreview: previewOf(blocked) });
      await this.appendToolResult(s, displayName, argsJson, blocked);
      return "executed";
    }

    if (category === "forbidden" || category === "planViolation") {
      const blocked = blockedToolDetails(category, displayName, argsJson, reason);
      this.emit({ kind: "toolCallResolved", toolId, status: "rejected", resultPreview: previewOf(blocked) });
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

    // Decide whether approval is needed.
    const needsApproval =
      category === "safeCmd" ||
      (category === "write" && !s.autoapproveWrites) ||
      (category === "read" && !s.autoapproveReads);

    let approved = !needsApproval;
    if (needsApproval) {
      approved = (await new Promise<{ approved: boolean }>(res => {
        this.pending.set(toolId, { resolve: res });
      })).approved;
      if (!approved) {
        const rejected = userRejectedToolDetails(e.name, e.argsJson);
        this.emit({ kind: "toolCallResolved", toolId, status: "rejected", resultPreview: previewOf(rejected) });
        await this.appendToolResult(s, e.name, e.argsJson, rejected);
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
        // replace_range. The raw bytes are kept for the diff-capture read below.
        const raw = await readFile({ workspaceRoot: this.workspaceRoot }, args as { path: string });
        result = formatFileForModel(raw);
      } else if (isWriteToolName(e.name)) {
        const effectiveWriteArgs = writeArgs ?? normalizeWriteToolArgs(e.name, args, e.argsJson);
        const absolute = await assertInsideWorkspace(this.workspaceRoot, effectiveWriteArgs.path);
        let previous = "";
        let next = "";
        let bytesWritten = 0;
        if (effectiveWriteArgs.kind === "write_file") {
          try {
            previous = await readFile({ workspaceRoot: this.workspaceRoot }, { path: effectiveWriteArgs.path });
          } catch {
            previous = "";
          }
          const r = await writeFile({ workspaceRoot: this.workspaceRoot }, effectiveWriteArgs);
          next = effectiveWriteArgs.content;
          bytesWritten = r.bytesWritten;
          result = `wrote ${bytesWritten} bytes to ${effectiveWriteArgs.path}`;
        } else if (effectiveWriteArgs.kind === "insert_text") {
          const r = await insertText({ workspaceRoot: this.workspaceRoot }, effectiveWriteArgs);
          previous = r.previous;
          next = r.next;
          bytesWritten = r.bytesWritten;
          result = `inserted ${bytesWritten} bytes into ${effectiveWriteArgs.path} before line ${effectiveWriteArgs.line}`;
        } else {
          const r = await replaceRange({ workspaceRoot: this.workspaceRoot }, effectiveWriteArgs);
          previous = r.previous;
          next = r.next;
          bytesWritten = r.bytesWritten;
          result = `replaced lines ${effectiveWriteArgs.startLine}-${effectiveWriteArgs.endLine} in ${effectiveWriteArgs.path} with ${bytesWritten} bytes`;
        }
        const displayPath = displayPathForChange(this.workspaceRoot, absolute, effectiveWriteArgs.path);
        const key = path.resolve(absolute);
        if (this.activeFileWrites) {
          rememberFileWrite(this.activeFileWrites, { key, path: displayPath, previous, next });
        }
        // Extend the run of consecutive edits to this file (or start a fresh
        // one). The card shows a single original→latest diff and cumulative
        // line stats; `original` is held from the run's first edit.
        const group = priorWriteGroup && priorWriteGroup.key === key
          ? { id: priorWriteGroup.id, key, original: priorWriteGroup.original, latest: next }
          : { id: newWriteGroupId(), key, original: previous, latest: next };
        this.writeGroup = group;
        const combinedDiff = renderLineDiff(group.original, group.latest);
        const stats = diffStats(combinedDiff);
        this.toolDiffSources.set(toolId, { path: displayPath, previous: group.original, next: group.latest });
        this.emit({
          kind: "toolCallResolved",
          toolId,
          status: "executed",
          resultPreview: previewOf(result),
          groupId: group.id,
          added: stats.added,
          removed: stats.removed
        });
        resolvedAfterExecution = true;
      } else if (e.name === "list_dir") {
        const r = await listDir({ workspaceRoot: this.workspaceRoot }, args as { path: string });
        result = JSON.stringify(r);
      } else if (e.name === "glob") {
        const r = await glob({ workspaceRoot: this.workspaceRoot }, args as { pattern: string });
        result = JSON.stringify(r);
      } else if (e.name === "run_command") {
        const r = await runCommand(String(args.command ?? ""), this.workspaceRoot, this.abort?.signal);
        result = `exit ${r.exitCode}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}${r.truncated ? "\n[output truncated]" : ""}`;
      } else {
        result = `[harness] unknown tool: ${e.name}`;
      }
    } catch (err) {
      result = `error: ${(err as Error).message}`;
      const storedResult = await this.appendToolResult(s, e.name, e.argsJson, result);
      this.emit({ kind: "toolCallResolved", toolId, status: "failed", resultPreview: previewOf(storedResult) });
      return "executed";
    }

    const storedResult = await this.appendToolResult(s, e.name, e.argsJson, result);
    if (!resolvedAfterExecution || storedResult !== result) {
      this.emit({ kind: "toolCallResolved", toolId, status: "executed", resultPreview: previewOf(storedResult) });
    }
    return "executed";
  }

  private async handleToolCallProgress(
    e: Extract<ParsedEvent, { kind: "toolCallProgress" }>,
    messageId: string
  ): Promise<void> {
    if (e.name !== "write_file") return;
    const key = streamingToolKey(messageId, e.name, e.id);
    let toolId = this.streamingToolIds.get(key);
    if (!toolId) {
      toolId = `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this.streamingToolIds.set(key, toolId);
    }
    this.emit({
      kind: "toolCallProgress",
      toolId,
      messageId,
      toolName: e.name,
      path: e.path,
      contentBytes: e.contentBytes,
      contentLines: e.contentLines
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
      this.emit({ kind: "toolCallResolved", toolId, status: "failed", resultPreview: previewOf(result) });
      await this.appendToolResult(s, "write_file", "{}", result);
    }
  }

  private buildPromptMessages(): PromptMessage[] {
    const sys = buildSystemPrompt({
      family: this.record.modelFamily,
      planMode: this.record.planMode,
      workspaceRoot: this.workspaceRoot
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

function estimateTextTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function estimateChatMessageTokens(m: Pick<ChatMessage, "role" | "content">): number {
  return estimateTextTokens(`<|${m.role}|>${m.content}`);
}

function estimatePromptTokens(messages: PromptMessage[]): number {
  return messages.reduce((total, message) => total + estimateTextTokens(`<|${message.role}|>${message.content}`), 0);
}

function contextWindowOverflowMessage(tokens: number, limit: number): string {
  return [
    `Context window guard: estimated context is ${tokens} / ${limit} tokens.`,
    `The request was not sent to the model because it would exceed the configured context size.`,
    `Compact context, reduce recent tool output, or increase the configured context size before continuing.`
  ].join("\n");
}

function promptOverflowMessage(tokens: number, limit: number): string {
  return [
    `Context window guard: estimated prompt is ${tokens} / ${limit} tokens after prompt formatting.`,
    `The request was not sent to the model because llama.cpp is likely to reject it.`,
    `Compact context, reduce recent tool output, or increase the configured context size before continuing.`
  ].join("\n");
}

function toolResultOverflowMessage(toolName: string, resultTokens: number, projectedTokens: number, limit: number): string {
  return [
    `[context guard] ${toolName} result was not added to the chat context.`,
    `Estimated tool-result tokens: ${resultTokens}. Projected context: ${projectedTokens} / ${limit} tokens.`,
    `The raw result is too large for the current context window.`,
    `Adapt by requesting a narrower file read, a more specific search, or a command with limited output.`,
    `If the full output is required, ask the user to run the command manually and paste only the relevant excerpt.`
  ].join("\n");
}

function previewOf(s: string): string {
  const oneLine = s.replace(/\s+/g, " ");
  return oneLine.length <= 200 ? oneLine : oneLine.slice(0, 197) + "...";
}

function streamingToolKey(messageId: string, name: string, id: string | undefined): string {
  return `${messageId}:${id ?? name}`;
}

function newWriteGroupId(): string {
  return `g_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function emptyTurnNotice(ranAnyTool: boolean, thought: boolean): string {
  const lead = thought
    ? "The model stopped right after thinking, without a reply."
    : ranAnyTool
      ? "The model stopped after its tool calls, without a final reply."
      : "The model ended its turn without producing a reply.";
  return `${lead} It may have stopped early (a stop-token/template mismatch on the server). Resend your message to continue. If this keeps happening, check that the Model family setting matches the served model.`;
}

function normalizeToolArgs(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("\"")) {
      try { return normalizeToolArgs(JSON.parse(trimmed)); } catch { /* fall through */ }
    }
    return {};
  }
  if (Array.isArray(value) && value.length > 0) return normalizeToolArgs(value[0]);
  if (!value || typeof value !== "object") return {};
  const obj = value as Record<string, unknown>;
  const nested = obj.arguments ?? obj.args ?? obj.input ?? obj.parameters;
  if (nested) return normalizeToolArgs(nested);
  return obj;
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

function malformedToolCallReason(): string {
  return [
    `Malformed tool call: the tool-call block could not be parsed, so nothing was executed.`,
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
  const attempted = toolName === "run_command"
    ? `Attempted command: ${String(args.command ?? "(empty command)")}`
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
    `Arguments: ${prettyArgs(argsJson)}`
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
