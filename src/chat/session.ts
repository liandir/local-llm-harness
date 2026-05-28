import { streamChat } from "../llm/client.js";
import { buildSystemPrompt } from "../llm/prompt.js";
import { makeParser, type ParsedEvent } from "../llm/parser/index.js";
import { classifyToolName } from "../tools/forbiddenTools.js";
import { checkSafeCommand, type SafeCommandEntry } from "../tools/safeCommands.js";
import { readFile, writeFile, listDir, glob } from "../tools/fsTools.js";
import { runCommand } from "../tools/terminalTool.js";
import { readSettings, type HarnessSettings } from "../config/settings.js";
import { ChatStorage, titleFromFirstMessage, type ChatRecord } from "./storage.js";
import { compact } from "./compactor.js";
import { recomputeTokens } from "./contextTracker.js";

/** Events the session emits to the chat webview. */
export type UiEvent =
  | { kind: "turnStart"; messageId: string }
  | { kind: "text"; messageId: string; delta: string }
  | { kind: "thought"; messageId: string; delta: string }
  | { kind: "toolCallProposed"; toolId: string; messageId: string; toolName: string; argsJson: string; category: ToolCategory; reason?: string }
  | { kind: "toolCallResolved"; toolId: string; status: "approved" | "rejected" | "executed" | "failed"; resultPreview?: string }
  | { kind: "summary"; messageId: string; text: string }
  | { kind: "planFinal"; messageId: string; markdown: string }
  | { kind: "abort"; reason: string }
  | { kind: "notice"; text: string }
  | { kind: "turnEnd"; messageId: string }
  | { kind: "tokens"; total: number; limit: number }
  | { kind: "chatLoaded"; record: ChatRecord }
  | { kind: "chatClosed" }
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
  }

  setPlanMode(on: boolean): void {
    this.record.planMode = on;
    this.emit({ kind: "planModeChanged", on });
    void this.storage.save(this.record);
  }

  async compactNow(source: "manual" | "auto" = "manual"): Promise<void> {
    const s = readSettings();
    const before = this.record.totalTokens;
    const ac = new AbortController();
    await compact(s.endpoint, this.record, ac.signal);
    await this.storage.save(this.record);
    this.emit({ kind: "chatLoaded", record: this.record });
    this.emit({ kind: "tokens", total: this.record.totalTokens, limit: s.contextSize });
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
    }
    this.record.messages.push({ role: "user", content: text, ts: Date.now() });
    await this.storage.save(this.record);

    if (s.autoCompact) {
      await recomputeTokens(s.endpoint, this.record);
      if (this.record.totalTokens > s.autoCompactThreshold) {
        await this.compactNow("auto");
      }
    }

    await this.runTurn(s);
  }

  private async runTurn(s: HarnessSettings): Promise<void> {
    this.abort = new AbortController();
    const messageId = `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.emit({ kind: "turnStart", messageId });

    let assistantBuf = "";
    let thoughtBuf = "";
    const turnEvents: ParsedEvent[] = [];

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const parser = makeParser(this.record.modelFamily);
      const messages = this.buildPromptMessages(s);

      let aborted = false;
      try {
        for await (const chunk of streamChat(s.endpoint, { messages }, this.abort.signal)) {
          const events = parser.feed(chunk);
          const continueAfter = await this.handleEvents(events, messageId, s);
          for (const e of events) {
            if (e.kind === "text") assistantBuf += e.text;
            if (e.kind === "thought") thoughtBuf += e.text;
            turnEvents.push(e);
          }
          if (!continueAfter.continue) {
            aborted = continueAfter.abort ?? false;
            break;
          }
          if (continueAfter.toolLoop) break; // re-prompt with tool result appended
        }
        if (!aborted) {
          const tail = parser.end();
          await this.handleEvents(tail, messageId, s);
          for (const e of tail) {
            if (e.kind === "text") assistantBuf += e.text;
            if (e.kind === "thought") thoughtBuf += e.text;
            turnEvents.push(e);
          }
        }
      } catch (e) {
        this.emit({ kind: "abort", reason: (e as Error).message });
        aborted = true;
      }

      const lastTool = [...this.record.messages].reverse().find(m => m.role === "tool");
      const justAddedToolResult = lastTool && lastTool.ts > (this.record.messages.find(m => m.role === "assistant")?.ts ?? 0);

      // If a tool ran this iteration, the LLM needs another pass; otherwise we are done.
      if (aborted) break;
      if (justAddedToolResult) {
        // Append the partial assistant text we got before the tool call so the model can see it.
        if (assistantBuf || thoughtBuf) {
          this.record.messages.push({
            role: "assistant",
            content: assistantBuf,
            events: turnEvents.splice(0),
            ts: Date.now()
          });
          assistantBuf = "";
          thoughtBuf = "";
        }
        await this.storage.save(this.record);
        continue;
      }
      // Done — flush final assistant message.
      if (assistantBuf || thoughtBuf || turnEvents.length > 0) {
        if (this.record.planMode) {
          this.emit({ kind: "planFinal", messageId, markdown: assistantBuf });
        } else if (assistantBuf.trim()) {
          this.emit({ kind: "summary", messageId, text: extractSummary(assistantBuf) });
        }
        this.record.messages.push({
          role: "assistant",
          content: assistantBuf,
          events: turnEvents,
          ts: Date.now()
        });
      }
      break;
    }

    await this.storage.save(this.record);
    await recomputeTokens(s.endpoint, this.record);
    this.emit({ kind: "tokens", total: this.record.totalTokens, limit: s.contextSize });
    this.emit({ kind: "turnEnd", messageId });
  }

  /** Returns { continue, abort?, toolLoop? } */
  private async handleEvents(
    events: ParsedEvent[],
    messageId: string,
    s: HarnessSettings
  ): Promise<{ continue: boolean; abort?: boolean; toolLoop?: boolean }> {
    for (const e of events) {
      if (e.kind === "text") {
        if (e.text) this.emit({ kind: "text", messageId, delta: e.text });
      } else if (e.kind === "thought") {
        if (e.text) this.emit({ kind: "thought", messageId, delta: e.text });
      } else if (e.kind === "toolCall") {
        const verdict = await this.handleToolCall(e, messageId, s);
        if (verdict === "aborted") {
          this.abort?.abort();
          return { continue: false, abort: true };
        }
        if (verdict === "executed") {
          this.abort?.abort();
          return { continue: false, toolLoop: true };
        }
      } else if (e.kind === "done") {
        return { continue: false };
      }
    }
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
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(e.argsJson); } catch { /* ignore */ }

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
    } else {
      category = "read";
    }

    this.emit({ kind: "toolCallProposed", toolId, messageId, toolName: e.name, argsJson: e.argsJson, category, reason });

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
        const r = await writeFile({ workspaceRoot: this.workspaceRoot }, args as { path: string; content: string });
        result = `wrote ${r.bytesWritten} bytes to ${(args as { path: string }).path}`;
      } else if (e.name === "list_dir") {
        const r = await listDir({ workspaceRoot: this.workspaceRoot }, args as { path: string });
        result = JSON.stringify(r);
      } else if (e.name === "glob") {
        const r = await glob({ workspaceRoot: this.workspaceRoot }, args as { pattern: string });
        result = JSON.stringify(r);
      } else if (e.name === "run_command") {
        const r = await runCommand(String(args.command ?? ""), this.workspaceRoot);
        result = `exit ${r.exitCode}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}${r.truncated ? "\n[output truncated]" : ""}`;
      } else {
        result = `[harness] unknown tool: ${e.name}`;
      }
      this.emit({ kind: "toolCallResolved", toolId, status: "executed", resultPreview: previewOf(result) });
    } catch (err) {
      result = `error: ${(err as Error).message}`;
      this.emit({ kind: "toolCallResolved", toolId, status: "failed", resultPreview: result });
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
        // Render tool results as user messages prefixed with the tool name (works for both Gemma and Qwen).
        const name = m.toolCall?.name ?? "tool";
        msgs.push({ role: "user", content: `[${name} result]\n${m.content}` });
      } else {
        msgs.push({ role: m.role as "user" | "assistant" | "system", content: m.content });
      }
    }
    return msgs;
  }
}

function previewOf(s: string): string {
  const oneLine = s.replace(/\s+/g, " ");
  return oneLine.length <= 200 ? oneLine : oneLine.slice(0, 197) + "...";
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
