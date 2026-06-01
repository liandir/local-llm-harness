import * as path from "node:path";
import { streamChat } from "../llm/client.js";
import { buildSystemPrompt, coalesceSameRole, renderToolCallForPrompt } from "../llm/prompt.js";
import { makeParser, type ParsedEvent } from "../llm/parser/index.js";
import { classifyToolName } from "../tools/forbiddenTools.js";
import { checkSafeCommand, type SafeCommandEntry } from "../tools/safeCommands.js";
import { readFile, writeFile, listDir, glob } from "../tools/fsTools.js";
import { assertInsideWorkspace } from "../tools/workspaceGuard.js";
import { runCommand } from "../tools/terminalTool.js";
import { readSettings, type HarnessSettings } from "../config/settings.js";
import { ChatStorage, titleFromFirstMessage, type ChatMessage, type ChatRecord } from "./storage.js";
import { compact, compactAvailableForMessageCount, MIN_COMPACT_MESSAGES } from "./compactor.js";
import { recomputeTokens } from "./contextTracker.js";
import { renderLineDiff } from "./diffPreview.js";
import { rememberFileWrite, summarizeFileChanges, type FileChangeSummary, type TrackedFileWrite } from "./fileChanges.js";

/** Events the session emits to the chat webview. */
export type UiEvent =
  | { kind: "userMessage"; messageId: string; text: string }
  | { kind: "turnStart"; messageId: string }
  | { kind: "text"; messageId: string; delta: string }
  | { kind: "thought"; messageId: string; delta: string }
  | { kind: "toolCallProposed"; toolId: string; messageId: string; toolName: string; argsJson: string; category: ToolCategory; reason?: string; diffPreview?: string }
  | { kind: "toolCallResolved"; toolId: string; status: "approved" | "rejected" | "executed" | "failed"; resultPreview?: string }
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
  | { kind: "planModeChanged"; on: boolean };

export type ToolCategory =
  | "read"      // gray, auto-approve via setting
  | "write"     // gray + approval, auto via setting
  | "safeCmd"   // purple, manual approval always
  | "unsafeCmd" // red, abort
  | "forbidden" // red, abort
  | "unknown"   // red, abort
  | "planViolation"; // red, abort

interface PendingApproval {
  resolve(v: { approved: boolean }): void;
}

export class ChatSession {
  private record: ChatRecord;
  private pending = new Map<string, PendingApproval>();
  private abort: AbortController | undefined;
  private emit: (e: UiEvent) => void;
  private storage: ChatStorage;
  private workspaceRoot: string;
  private activeFileWrites?: Map<string, TrackedFileWrite>;

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
    if (!compactAvailableForMessageCount(this.record.messages.length)) {
      this.emitCompactStatus();
      return;
    }
    const s = readSettings();
    const before = this.record.totalTokens;
    const ac = new AbortController();
    await compact(s.endpoint, this.record, ac.signal);
    await this.storage.save(this.record);
    this.emit({ kind: "chatLoaded", record: this.record });
    this.emit({ kind: "tokens", total: this.record.totalTokens, limit: s.contextSize });
    this.emitCompactStatus();
    const pct = Math.round((this.record.totalTokens / Math.max(1, s.contextSize)) * 100);
    const label = source === "auto" ? "Auto-compacted context" : "Compacted context";
    this.emit({ kind: "notice", text: `${label}: ${before} -> ${this.record.totalTokens} tokens (${pct}%).` });
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

  async sendUserMessage(text: string): Promise<void> {
    const s = readSettings();
    if (this.record.messages.length === 0) {
      this.record.title = titleFromFirstMessage(text);
      this.emit({ kind: "titleChanged", title: this.record.title, animate: true });
    }
    const ts = Date.now();
    this.record.messages.push({ role: "user", content: text, ts });
    await this.storage.save(this.record);
    this.emit({ kind: "userMessage", messageId: `u_${ts}`, text });
    this.emitCompactStatus();

    if (s.autoCompact) {
      await recomputeTokens(s.endpoint, this.record);
      if (this.record.totalTokens > s.autoCompactThreshold) {
        await this.compactNow("auto");
      }
    }

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

  private async runTurn(s: HarnessSettings): Promise<void> {
    this.abort = new AbortController();
    const messageId = `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.emit({ kind: "turnStart", messageId });

    let assistantBuf = "";
    let thoughtBuf = "";
    // Events stamped with a wall-clock time so the webview can restore real
    // "Thought for Ns" / "Worked for Ns" durations after a reload.
    const turnEvents: (ParsedEvent & { t?: number })[] = [];
    const fileWrites = new Map<string, TrackedFileWrite>();
    this.activeFileWrites = fileWrites;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const parser = makeParser(this.record.modelFamily);
      const messages = this.buildPromptMessages(s);

      let aborted = false;
      let toolLoop = false;
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
            const ev: ParsedEvent = { kind: "toolCall", name: chunk.name, argsJson: chunk.argsJson };
            const res = await this.handleEvents([ev], messageId, s);
            turnEvents.push({ ...ev, t: Date.now() });
            if (!res.continue) {
              aborted = res.abort ?? false;
              toolLoop = res.toolLoop ?? false;
              break;
            }
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
            turnEvents.push({ ...e, t: Date.now() });
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
            turnEvents.push({ ...e, t: Date.now() });
          }
          aborted = continueAfterTail.abort ?? false;
          toolLoop = toolLoop || (continueAfterTail.toolLoop ?? false);
        }
      } catch (e) {
        this.emit({ kind: "abort", reason: (e as Error).message });
        aborted = true;
      }

      // If a tool ran this iteration, the LLM needs another pass; otherwise we are done.
      if (aborted) break;
      if (toolLoop) {
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
      // Done — flush final assistant message.
      if (assistantBuf || thoughtBuf || turnEvents.length > 0) {
        const fileChanges = summarizeFileChanges(fileWrites.values());
        if (this.record.planMode) {
          this.emit({ kind: "planFinal", messageId, markdown: assistantBuf });
        } else if (assistantBuf.trim()) {
          this.emit({ kind: "summary", messageId, text: extractSummary(assistantBuf) });
        }
        if (assistantBuf.trim()) {
          const assistantMessage: ChatMessage = {
            role: "assistant",
            content: assistantBuf,
            events: turnEvents,
            ts: Date.now()
          };
          if (fileChanges.length > 0) {
            assistantMessage.fileChanges = fileChanges;
          }
          this.record.messages.push(assistantMessage);
          if (fileChanges.length > 0) {
            this.emit({ kind: "fileChanges", messageId, changes: fileChanges });
          }
        }
      }
      break;
    }

    this.activeFileWrites = undefined;
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
    const toolId = `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const cls = classifyToolName(e.name);
    let category: ToolCategory;
    let reason: string | undefined;
    let diffPreview: string | undefined;
    let args: Record<string, unknown> = {};
    try {
      args = normalizeToolArgs(JSON.parse(e.argsJson));
    } catch {
      // JSON.parse failed — pass the raw string so normalizeToolArgs can try unwrapping
      // a stringified-JSON shape (`"{...}"`) which JSON.parse refuses at the top level.
      args = normalizeToolArgs(e.argsJson);
    }

    if (cls === "forbidden") {
      category = "forbidden";
      reason = `Tool "${e.name}" is forbidden in this harness (no internet/network tools).`;
    } else if (cls === "unknown") {
      category = "unknown";
      reason = `Unknown tool "${e.name}".`;
    } else if (this.record.planMode && (e.name === "write_file" || e.name === "run_command")) {
      category = "planViolation";
      reason = planModeViolationReason(e.name, args);
    } else if (e.name === "run_command") {
      const cmd = String(args.command ?? "");
      const check = checkSafeCommand(cmd, s.safeCommands);
      category = check.ok ? "safeCmd" : "unsafeCmd";
      reason = check.ok ? check.reason : unsafeCommandReason(cmd, check.reason, s.safeCommands);
    } else if (e.name === "write_file") {
      category = "write";
      try {
        const writeArgs = normalizeWriteFileArgs(args, e.argsJson);
        diffPreview = await writeDiffPreview(this.workspaceRoot, writeArgs.path, writeArgs.content);
      } catch (err) {
        reason = (err as Error).message;
      }
    } else {
      category = "read";
    }

    this.emit({ kind: "toolCallProposed", toolId, messageId, toolName: e.name, argsJson: e.argsJson, category, reason, diffPreview });

    if (category === "forbidden" || category === "unknown" || category === "unsafeCmd" || category === "planViolation") {
      const blocked = blockedToolDetails(category, e.name, e.argsJson, reason);
      this.emit({ kind: "toolCallResolved", toolId, status: "rejected", resultPreview: previewOf(blocked) });
      this.emit({ kind: "abort", reason: blocked });
      this.record.messages.push({
        role: "tool",
        content: blocked,
        toolCall: { name: e.name, argsJson: e.argsJson },
        ts: Date.now()
      });
      await this.storage.save(this.record);
      return "aborted";
    }

    if (category === "write" && reason) {
      const result = `error: ${reason}`;
      this.emit({ kind: "toolCallResolved", toolId, status: "failed", resultPreview: result });
      this.record.messages.push({
        role: "tool",
        content: result,
        toolCall: { name: e.name, argsJson: e.argsJson },
        ts: Date.now()
      });
      await this.storage.save(this.record);
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
        this.record.messages.push({
          role: "tool",
          content: rejected,
          toolCall: { name: e.name, argsJson: e.argsJson },
          ts: Date.now()
        });
        await this.storage.save(this.record);
        return "aborted";
      }
      this.emit({ kind: "toolCallResolved", toolId, status: "approved" });
    }

    // Execute.
    let result: string;
    try {
      if (e.name === "read_file") {
        result = await readFile({ workspaceRoot: this.workspaceRoot }, args as { path: string });
      } else if (e.name === "write_file") {
        const writeArgs = normalizeWriteFileArgs(args, e.argsJson);
        const absolute = await assertInsideWorkspace(this.workspaceRoot, writeArgs.path);
        let previous = "";
        try {
          previous = await readFile({ workspaceRoot: this.workspaceRoot }, { path: writeArgs.path });
        } catch {
          previous = "";
        }
        const r = await writeFile({ workspaceRoot: this.workspaceRoot }, writeArgs);
        if (this.activeFileWrites) {
          rememberFileWrite(this.activeFileWrites, {
            key: path.resolve(absolute),
            path: displayPathForChange(this.workspaceRoot, absolute, writeArgs.path),
            previous,
            next: writeArgs.content
          });
        }
        result = `wrote ${r.bytesWritten} bytes to ${writeArgs.path}`;
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
      this.emit({ kind: "toolCallResolved", toolId, status: "executed", resultPreview: previewOf(result) });
      } catch (err) {
        result = `error: ${(err as Error).message}`;
        this.emit({ kind: "toolCallResolved", toolId, status: "failed", resultPreview: result });
        this.record.messages.push({
          role: "tool",
          content: result,
          toolCall: { name: e.name, argsJson: e.argsJson },
          ts: Date.now()
        });
        await this.storage.save(this.record);
        return "executed";
      }

      this.record.messages.push({
      role: "tool",
      content: result,
      toolCall: { name: e.name, argsJson: e.argsJson },
      ts: Date.now()
    });
    await this.storage.save(this.record);
    return "executed";
  }

  private buildPromptMessages(s: HarnessSettings): { role: "system" | "user" | "assistant" | "tool"; content: string }[] {
    const sys = buildSystemPrompt({
      family: s.modelFamily,
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

function previewOf(s: string): string {
  const oneLine = s.replace(/\s+/g, " ");
  return oneLine.length <= 200 ? oneLine : oneLine.slice(0, 197) + "...";
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
  const keys = Object.keys(normalized).join(", ") || "(none)";
  const raw = rawArgsJson ? rawArgsJson.slice(0, 400) : "";
  const rawHint = raw
    ? `\nRaw input received: ${raw}${rawArgsJson && rawArgsJson.length > 400 ? "..." : ""}`
    : "";
  return `write_file requires a ${needed}. Detected keys after normalization: ${keys}. Expected one of: ${expectedKeys}.${rawHint}`;
}

async function writeDiffPreview(workspaceRoot: string, filePath: string, next: string): Promise<string> {
  await assertInsideWorkspace(workspaceRoot, filePath);
  let previous = "";
  try {
    previous = await readFile({ workspaceRoot }, { path: filePath });
  } catch {
    previous = "";
  }
  return renderLineDiff(previous, next);
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
    `To allow this command, add a narrow regex for the exact command shape to localLlmHarness.safeCommands.`
  ].join("\n");
}

function planModeViolationReason(toolName: string, args: Record<string, unknown>): string {
  const attempted = toolName === "run_command"
    ? `Attempted command: ${String(args.command ?? "(empty command)")}`
    : `Attempted write path: ${String(args.path ?? "(missing path)")}`;
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
