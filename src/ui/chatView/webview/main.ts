import MarkdownIt from "markdown-it";
// @ts-expect-error no types for markdown-it-katex
import mdKatex from "markdown-it-katex";
import type { ChatToExt, ExtToChat } from "../../messaging.js";
import type { ChatRecord } from "../../../chat/storage.js";

declare function acquireVsCodeApi(): {
  postMessage(msg: ChatToExt): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();
const md = new MarkdownIt({ html: false, linkify: false, breaks: false }).use(mdKatex);

interface ToolCard {
  toolId: string;
  toolName: string;
  argsJson: string;
  category: string;
  reason?: string;
  status: "pending" | "approved" | "rejected" | "executed" | "failed";
  resultPreview?: string;
  diffPreview?: string;
  expanded: boolean;
}

type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "thought"; text: string; live: boolean; userExpanded?: boolean; startedAt?: number; durationMs?: number }
  | { kind: "tool"; card: ToolCard }
  | { kind: "summary"; text: string }
  | { kind: "plan"; markdown: string }
  | { kind: "abort"; reason: string };

interface Message {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  parts: MessagePart[];
  text: string;
  thought: string;
  toolCards: ToolCard[];
  summary?: string;
  plan?: string;
  planResolved?: "accepted" | "rejected";
  aborted?: string;
}

interface State {
  messages: Message[];
  notices: { id: string; text: string }[];
  tokens: number;
  limit: number;
  planMode: boolean;
  autoapproveWrites: boolean;
  busy: boolean;
  draft: string;
  autoScroll: boolean;
  savedScrollTop: number;
  scrollDownOpacity: number;
  pendingPlanRejection: boolean;
}

const state: State = {
  messages: [],
  notices: [],
  tokens: 0,
  limit: 32768,
  planMode: false,
  autoapproveWrites: false,
  busy: false,
  draft: "",
  autoScroll: true,
  savedScrollTop: 0,
  scrollDownOpacity: 1,
  pendingPlanRejection: false
};

const root = document.getElementById("app")!;

function send(msg: ChatToExt): void { vscode.postMessage(msg); }

function getOrCreateMsg(id: string, role: Message["role"]): Message {
  let m = state.messages.find(x => x.id === id);
  if (!m) {
    m = { id, role, parts: [], text: "", thought: "", toolCards: [] };
    state.messages.push(m);
  }
  return m;
}

function finalizeLiveThoughts(m: Message): void {
  for (const p of m.parts) {
    if (p.kind === "thought" && p.live) {
      p.live = false;
      if (p.startedAt !== undefined && p.durationMs === undefined) {
        p.durationMs = Date.now() - p.startedAt;
      }
    }
  }
}

function appendPartText(m: Message, kind: "text" | "thought", delta: string): void {
  const last = m.parts[m.parts.length - 1];
  if (last?.kind === kind) {
    last.text += delta;
    return;
  }
  if (kind === "thought") {
    finalizeLiveThoughts(m);
    m.parts.push({ kind: "thought", text: delta, live: true, startedAt: Date.now() });
  } else {
    finalizeLiveThoughts(m);
    m.parts.push({ kind: "text", text: delta });
  }
}

function appendPlanText(m: Message, delta: string): void {
  finalizeLiveThoughts(m);
  let part = [...m.parts].reverse().find((p): p is Extract<MessagePart, { kind: "plan" }> => p.kind === "plan");
  if (!part) {
    part = { kind: "plan", markdown: "" };
    m.parts.push(part);
  }
  part.markdown += delta;
  m.plan = part.markdown;
}

function render(): void {
  const ratio = Math.min(1, state.tokens / Math.max(1, state.limit));
  const pct = Math.round(ratio * 100);
  const pctClass = ratio >= 0.9 ? "danger" : "ok";
  const oldBody = root.querySelector(".chat-body") as HTMLElement | null;
  const savedTop = oldBody ? oldBody.scrollTop : state.savedScrollTop;
  const shouldStickToBottom = state.autoScroll;
  const showScrollDown = !state.autoScroll;
  root.innerHTML = `
    <header class="chat-header">
      <div class="chat-title">Chat</div>
      <div class="header-actions">
        <button id="plus" class="icon-btn" data-tip="New chat" aria-label="New chat">${plusIcon()}</button>
        <button id="gear" class="icon-btn" data-tip="Settings" aria-label="Settings">${settingsIcon()}</button>
      </div>
    </header>
    <main class="chat-body">
      ${state.notices.map(n => `<div class="notice">${clockIcon()}<span>${escapeHtml(n.text)}</span></div>`).join("")}
      ${state.messages.map(renderMessage).join("")}
    </main>
    <footer class="composer">
      ${showScrollDown ? `<button id="scrollDown" class="scroll-down" style="opacity: ${state.scrollDownOpacity.toFixed(2)}" data-tip="Scroll to latest" aria-label="Scroll to latest">${downArrowIcon()}</button>` : ""}
      <div class="composer-row">
        <textarea id="input" placeholder="${state.pendingPlanRejection ? "Suggest changes to the plan…" : state.planMode ? "Plan mode — model is read-only" : "Message…"}" rows="3">${escapeHtml(state.draft)}</textarea>
        ${state.busy
          ? `<button id="cancel" class="send-btn cancel-btn" data-tip="Cancel" aria-label="Cancel">${stopIcon()}</button>`
          : `<button id="send" class="send-btn" data-tip="Send" aria-label="Send">${sendIcon()}</button>`}
      </div>
      <div class="composer-toggles">
        <button id="planToggle" class="mode-pill ${state.planMode ? "active" : ""}" data-tip="Toggle plan mode with Shift+Tab">${scrollIcon()}<span>Plan mode</span></button>
        <button id="compact" class="ctx-pill ${pctClass}" data-tip="Context: ${state.tokens} / ${state.limit} tokens. Click to compact.">
          ${circleIcon(ratio)}<span>${pct}%</span>
        </button>
      </div>
    </footer>
  `;
  bind();
  const newBody = root.querySelector(".chat-body") as HTMLElement | null;
  if (newBody) {
    if (shouldStickToBottom) {
      newBody.scrollTop = newBody.scrollHeight;
    } else {
      newBody.scrollTop = savedTop;
    }
    state.savedScrollTop = newBody.scrollTop;
    updateScrollState(newBody, false);
  }
}

function renderMessage(m: Message): string {
  if (m.role === "user") {
    return `<div class="msg user"><div class="bubble">${md.render(m.text)}</div></div>`;
  }
  return `<div class="msg assistant">${m.parts.map(part => renderPart(m.id, part)).join("")}</div>`;
}

function renderPart(msgId: string, part: MessagePart): string {
  if (part.kind === "thought") {
    const expanded = part.userExpanded ?? false;
    const idx = thoughtIndex(msgId, part);
    let labelSpan: string;
    if (part.live) {
      const phase = ((Date.now() % 1300) / 1000).toFixed(3);
      labelSpan = `<span class="shimmer" style="animation-delay: -${phase}s">Thinking…</span>`;
    } else if (part.durationMs !== undefined) {
      const secs = Math.max(1, Math.round(part.durationMs / 1000));
      labelSpan = `<span>Thought for ${secs} second${secs === 1 ? "" : "s"}</span>`;
    } else {
      labelSpan = `<span>Thought</span>`;
    }
    return `<div class="thinking ${expanded ? "open" : ""}" data-thought-toggle="${msgId}|${idx}">
      <div class="thinking-head">${labelSpan}</div>
      ${expanded ? `<div class="thinking-body">${md.render(part.text)}</div>` : ""}
    </div>`;
  }
  if (part.kind === "text") return `<div class="bubble">${md.render(part.text)}</div>`;
  if (part.kind === "tool") return renderToolCard(part.card);
  if (part.kind === "plan") return renderPlanCard(msgId, part.markdown);
  if (part.kind === "summary") return `<div class="card summary">${md.render(part.text)}</div>`;
  return `<div class="card abort">⛔ ${escapeHtml(part.reason)}</div>`;
}

function renderToolCard(tc: ToolCard): string {
  const cls = "tool-card " + tc.category + " " + tc.status;
  const commandLabel = toolCardLabel(tc);
  const pendingButtons =
    tc.status === "pending" && (tc.category === "write" || tc.category === "safeCmd" || tc.category === "read")
      ? tc.category === "write"
        ? `<div class="card-actions stacked">
             <button class="approve" data-approve="${tc.toolId}">Accept changes</button>
             <button class="reject" data-reject="${tc.toolId}">Reject changes and suggest changes</button>
           </div>`
        : `<div class="card-actions stacked">
             <button class="approve" data-approve="${tc.toolId}">Approve</button>
             <button class="reject" data-reject="${tc.toolId}">Reject</button>
           </div>`
      : "";
  const expanded = tc.expanded;
  const result = tc.resultPreview
    ? `<div class="tool-output-label">Out:</div><pre class="tool-result">${escapeHtml(tc.resultPreview)}</pre>`
    : "";
  const diff = tc.diffPreview
    ? `<div class="tool-output-label">Changes:</div><pre class="tool-diff">${renderDiffLines(tc.diffPreview)}</pre>`
    : "";
  const argsBlock = tc.argsJson && tc.argsJson !== "{}"
    ? `<div class="tool-output-label">Arguments:</div><pre class="tool-args">${escapeHtml(prettyArgs(tc.argsJson))}</pre>`
    : "";
  const reason = tc.reason ? `<div class="tool-reason">${escapeHtml(tc.reason)}</div>` : "";
  const statusBadge = tc.status === "pending" ? "" : `<span class="badge ${tc.status}">${tc.status}</span>`;
  return `<div class="${cls}" data-tool-card="${tc.toolId}">
    <div class="tool-head">
      <strong>${escapeHtml(toolDisplayName(tc.toolName))}</strong>
      <span class="tool-label">${escapeHtml(commandLabel)}</span>
      ${statusBadge}
    </div>
    ${expanded ? `${reason}${diff}${argsBlock}${result}` : ""}
    ${pendingButtons}
  </div>`;
}

function prettyArgs(argsJson: string): string {
  try { return JSON.stringify(JSON.parse(argsJson), null, 2); }
  catch { return argsJson; }
}

function renderDiffLines(diff: string): string {
  return diff.split("\n").map(line => {
    const cls = line.startsWith("+ ") ? "add" : line.startsWith("- ") ? "del" : "neutral";
    return `<span class="${cls}">${escapeHtml(line)}</span>`;
  }).join("\n");
}

function toolDisplayName(toolName: string): string {
  const aliases: Record<string, string> = {
    read_file: "Read File",
    list_dir: "Read Directory",
    write_file: "Edit File",
    glob: "Find Files",
    run_command: "Run Command"
  };
  return aliases[toolName] ?? toolName;
}

function toolCardLabel(tc: ToolCard): string {
  try {
    const args = normalizeToolArgs(JSON.parse(tc.argsJson));
    if (tc.toolName === "read_file" || tc.toolName === "list_dir" || tc.toolName === "write_file") {
      const path = String(args.path ?? args.file_path ?? args.filePath ?? args.filename ?? args.file ?? "");
      if (tc.toolName === "write_file" && tc.diffPreview) {
        const stats = diffStats(tc.diffPreview);
        return `${path} (+${stats.added} -${stats.removed})`;
      }
      return path;
    }
    if (tc.toolName === "glob") return String(args.pattern ?? "");
    if (tc.toolName === "run_command") return String(args.command ?? "");
  } catch {
    /* fall through */
  }
  return "";
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

function diffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+ ")) added++;
    else if (line.startsWith("- ")) removed++;
  }
  return { added, removed };
}

function thoughtIndex(msgId: string, part: MessagePart): string {
  const m = state.messages.find(x => x.id === msgId);
  return String(m?.parts.indexOf(part) ?? 0);
}

function summaryRepeatsVisibleText(m: Message, summary: string): boolean {
  const normalizedSummary = summary.trim();
  if (!normalizedSummary) return true;
  const lastText = [...m.parts].reverse().find((part): part is Extract<MessagePart, { kind: "text" }> => part.kind === "text");
  return !!lastText && lastText.text.trim().endsWith(normalizedSummary);
}

function restoreAssistantParts(msg: Message, recordMessage: ChatRecord["messages"][number]): void {
  let restoredText = "";
  let restoredThought = "";
  if (Array.isArray(recordMessage.events)) {
    for (const event of recordMessage.events) {
      if (!event || typeof event !== "object") continue;
      const e = event as { kind?: unknown; text?: unknown };
      if ((e.kind === "text" || e.kind === "thought") && typeof e.text === "string") {
        appendPartText(msg, e.kind, e.text);
        if (e.kind === "text") restoredText += e.text;
        else restoredThought += e.text;
      }
    }
  }
  msg.text = restoredText || recordMessage.content;
  msg.thought = restoredThought;
  if (msg.parts.length === 0 && recordMessage.content) {
    msg.parts.push({ kind: "text", text: recordMessage.content });
  }
  finalizeLiveThoughts(msg);
}

function renderPlanCard(msgId: string, planMd: string): string {
  const m = state.messages.find(x => x.id === msgId);
  const resolved = m?.planResolved;
  const actions = resolved
    ? `<div class="plan-resolved">${resolved === "accepted" ? "Plan accepted" : "Plan rejected — type your changes below"}</div>`
    : state.busy
      ? ""
    : `<div class="card-actions stacked">
         <button class="approve" data-accept-plan="${msgId}">Accept plan and execute</button>
         <button class="reject" data-reject-plan="${msgId}">Reject plan and suggest changes</button>
       </div>`;
  return `<div class="card plan">
    <div class="plan-body">${md.render(planMd)}</div>
    ${actions}
  </div>`;
}

function updateScrollState(body: HTMLElement, fromUserScroll: boolean): void {
  const distance = body.scrollHeight - body.scrollTop - body.clientHeight;
  state.savedScrollTop = body.scrollTop;
  state.scrollDownOpacity = Math.max(0.15, Math.min(1, distance / 140));
  const btn = root.querySelector("#scrollDown") as HTMLButtonElement | null;
  if (btn) btn.style.opacity = state.scrollDownOpacity.toFixed(2);
  // Re-engage follow ONLY when the real user-scroll event lands at the bottom.
  // The render-internal call (fromUserScroll=false) must never re-engage — a short
  // streamed token can push savedTop within 4px of the new bottom and clobber the
  // user's intent to read older content.
  if (fromUserScroll && distance <= 4 && !state.autoScroll) {
    state.autoScroll = true;
    render();
  }
}

function bind(): void {
  const body = root.querySelector(".chat-body") as HTMLElement | null;
  if (body) {
    body.addEventListener("scroll", () => updateScrollState(body, true));
    const userIsScrolling = (): void => { state.autoScroll = false; };
    body.addEventListener("wheel", userIsScrolling, { passive: true });
    body.addEventListener("touchmove", userIsScrolling, { passive: true });
    body.addEventListener("keydown", e => {
      const k = e.key;
      if (k === "PageUp" || k === "PageDown" || k === "ArrowUp" || k === "ArrowDown" || k === "Home" || k === "End" || k === " ") {
        userIsScrolling();
      }
    });
  }
  root.querySelector("#gear")?.addEventListener("click", () => send({ type: "openSettings" }));
  root.querySelector("#plus")?.addEventListener("click", () => send({ type: "newChat" }));
  root.querySelector("#compact")?.addEventListener("click", () => send({ type: "compactNow" }));
  const sendBtn = root.querySelector("#send");
  const input = root.querySelector("#input") as HTMLTextAreaElement | null;
  sendBtn?.addEventListener("click", () => submit());
  input?.addEventListener("input", () => {
    state.draft = input.value;
  });
  input?.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
    else if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); send({ type: "togglePlanMode" }); }
  });
  root.querySelector("#planToggle")?.addEventListener("click", () => send({ type: "togglePlanMode" }));
  // mousedown rather than click: render() rebuilds innerHTML on every streamed token,
  // and a click split across that rebuild loses its target. mousedown fires first.
  root.querySelector("#cancel")?.addEventListener("mousedown", e => {
    e.preventDefault();
    send({ type: "cancel" });
  });
  root.querySelector("#scrollDown")?.addEventListener("click", () => {
    state.autoScroll = true;
    render();
  });
  root.querySelectorAll("[data-thought-toggle]").forEach(el => el.addEventListener("click", () => {
    const [msgId, idxStr] = (el as HTMLElement).dataset.thoughtToggle!.split("|");
    const m = state.messages.find(x => x.id === msgId);
    const part = m?.parts[Number(idxStr)];
    if (part?.kind === "thought") {
      const currentExpanded = part.userExpanded ?? part.live;
      part.userExpanded = !currentExpanded;
      state.autoScroll = false;
      render();
    }
  }));
  root.querySelectorAll("[data-tool-card]").forEach(el => el.addEventListener("click", e => {
    if ((e.target as HTMLElement).closest("button")) return;
    const id = (el as HTMLElement).dataset.toolCard!;
    for (const m of state.messages) {
      const tc = m.toolCards.find(t => t.toolId === id);
      if (tc) {
        tc.expanded = !tc.expanded;
        state.autoScroll = false;
        render();
        return;
      }
    }
  }));
  root.querySelectorAll("[data-approve]").forEach(el => el.addEventListener("click", () => {
    send({ type: "approveTool", toolId: (el as HTMLElement).dataset.approve!, approved: true });
  }));
  root.querySelectorAll("[data-reject]").forEach(el => el.addEventListener("click", () => {
    send({ type: "approveTool", toolId: (el as HTMLElement).dataset.reject!, approved: false });
  }));
  root.querySelectorAll("[data-accept-plan]").forEach(el => el.addEventListener("click", () => {
    const id = (el as HTMLElement).dataset.acceptPlan!;
    const m = state.messages.find(x => x.id === id);
    if (m) m.planResolved = "accepted";
    state.pendingPlanRejection = false;
    send({ type: "acceptPlan" });
    render();
  }));
  root.querySelectorAll("[data-reject-plan]").forEach(el => el.addEventListener("click", () => {
    const id = (el as HTMLElement).dataset.rejectPlan!;
    const m = state.messages.find(x => x.id === id);
    if (m) m.planResolved = "rejected";
    state.pendingPlanRejection = true;
    render();
    (root.querySelector("#input") as HTMLTextAreaElement | null)?.focus();
  }));
}

function submit(): void {
  const input = root.querySelector("#input") as HTMLTextAreaElement | null;
  const text = input?.value.trim();
  if (!text) return;
  state.busy = true;
  state.draft = "";
  state.pendingPlanRejection = false;
  send({ type: "send", text });
  render();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

function plusIcon(): string {
  return `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
    <path d="M7.4 2h1.2v5.4H14v1.2H8.6V14H7.4V8.6H2V7.4h5.4V2Z" fill="currentColor"/>
  </svg>`;
}

function settingsIcon(): string {
  return `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
    <path d="M6.92 1.5h2.16l.34 1.7c.35.12.69.26 1 .43l1.45-.96 1.53 1.53-.96 1.45c.17.32.31.65.43 1l1.63.35v2.16l-1.63.35c-.12.35-.26.68-.43 1l.96 1.45-1.53 1.53-1.45-.96c-.31.17-.65.31-1 .43l-.34 1.54H6.92l-.34-1.54c-.35-.12-.69-.26-1-.43l-1.45.96-1.53-1.53.96-1.45c-.17-.32-.31-.65-.43-1L1.5 9.16V7l1.63-.35c.12-.35.26-.68.43-1L2.6 4.2l1.53-1.53 1.45.96c.31-.17.65-.31 1-.43l.34-1.7ZM8 5.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6Z" fill="currentColor"/>
  </svg>`;
}

function clockIcon(): string {
  return `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
    <path d="M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2Zm0 1.2a4.8 4.8 0 1 1 0 9.6 4.8 4.8 0 0 1 0-9.6Zm.55 2.05v3.08l2.15 1.28-.58.98-2.77-1.65V5.25h1.2Z" fill="currentColor"/>
  </svg>`;
}

function sendIcon(): string {
  return `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
    <path d="M8.55 3.15 13.4 8l-.85.85-3.95-3.94V13H7.4V4.91L3.45 8.85 2.6 8l4.85-4.85h1.1Z" fill="currentColor"/>
  </svg>`;
}

function stopIcon(): string {
  return `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
    <rect x="3" y="3" width="10" height="10" rx="1.2" fill="currentColor"/>
  </svg>`;
}

function scrollIcon(): string {
  return `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <path d="M8 21h12a2 2 0 0 0 2-2v-2H10v2a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v3h4"/>
    <path d="M19 17V5a2 2 0 0 0-2-2H4"/>
  </svg>`;
}

function downArrowIcon(): string {
  return `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
    <path d="M8 2.5v9.1l3.3-3.3.85.85L8 13.3 3.85 9.15l.85-.85L8 11.6V2.5h0Z" fill="currentColor"/>
  </svg>`;
}

function circleIcon(ratio: number): string {
  const r = 5.5;
  const c = 2 * Math.PI * r;
  const filled = c * Math.max(0, Math.min(1, ratio));
  const remainder = c - filled;
  return `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
    <circle cx="8" cy="8" r="${r}" fill="none" stroke="currentColor" stroke-width="2.5" opacity="0.28"/>
    <circle cx="8" cy="8" r="${r}" fill="none" stroke="currentColor" stroke-width="2.5"
      stroke-dasharray="${filled.toFixed(2)} ${remainder.toFixed(2)}"
      stroke-dashoffset="0"
      stroke-linecap="butt"
      transform="rotate(-90 8 8)"/>
  </svg>`;
}

function loadFromRecord(rec: ChatRecord): void {
  state.messages = [];
  state.notices = [];
  for (const m of rec.messages) {
    const id = `r_${m.ts}`;
    if (m.role === "user") {
      state.messages.push({ id, role: "user", parts: [], text: m.content, thought: "", toolCards: [] });
    } else if (m.role === "assistant") {
      const msg: Message = { id, role: "assistant", parts: [], text: "", thought: "", toolCards: [] };
      restoreAssistantParts(msg, m);
      state.messages.push(msg);
    } else if (m.role === "tool") {
      // attach to last assistant message as an executed card; if none, create a stub
      let last = [...state.messages].reverse().find(x => x.role === "assistant");
      if (!last) {
        last = { id, role: "assistant", parts: [], text: "", thought: "", toolCards: [] };
        state.messages.push(last);
      }
      const tc: ToolCard = {
        toolId: id,
        toolName: m.toolCall?.name ?? "tool",
        argsJson: m.toolCall?.argsJson ?? "{}",
        category: "read",
        status: "executed",
        resultPreview: m.content.slice(0, 400),
        expanded: false
      };
      last.toolCards.push(tc);
      last.parts.push({ kind: "tool", card: tc });
    }
  }
}

window.addEventListener("message", ev => {
  const msg = ev.data as ExtToChat;
  if ("type" in msg && msg.type === "settings") {
    state.planMode = msg.planMode;
    state.autoapproveWrites = msg.autoapproveWrites;
    render();
    return;
  }
  if (!("kind" in msg)) return;
  switch (msg.kind) {
    case "chatLoaded":
      loadFromRecord(msg.record);
      state.autoScroll = true;
      render();
      break;
    case "chatClosed":
      state.messages = [];
      state.tokens = 0;
      state.busy = false;
      state.autoScroll = true;
      render();
      break;
    case "turnStart":
      state.busy = true;
      state.autoScroll = true;
      getOrCreateMsg(msg.messageId, "assistant");
      render();
      break;
    case "userMessage": {
      state.messages.push({
        id: msg.messageId,
        role: "user",
        parts: [],
        text: msg.text,
        thought: "",
        toolCards: []
      });
      render();
      break;
    }
    case "text": {
      const m = getOrCreateMsg(msg.messageId, "assistant");
      m.text += msg.delta;
      if (state.planMode) appendPlanText(m, msg.delta);
      else appendPartText(m, "text", msg.delta);
      render();
      break;
    }
    case "thought": {
      const m = getOrCreateMsg(msg.messageId, "assistant");
      m.thought += msg.delta;
      appendPartText(m, "thought", msg.delta);
      render();
      break;
    }
    case "toolCallProposed": {
      const m = getOrCreateMsg(msg.messageId, "assistant");
      const card: ToolCard = {
        toolId: msg.toolId,
        toolName: msg.toolName,
        argsJson: msg.argsJson,
        category: msg.category,
        reason: msg.reason,
        diffPreview: msg.diffPreview,
        status: "pending",
        expanded: !!msg.reason
      };
      m.toolCards.push(card);
      finalizeLiveThoughts(m);
      m.parts.push({ kind: "tool", card });
      render();
      break;
    }
    case "toolCallResolved": {
      for (const m of state.messages) {
        const tc = m.toolCards.find(t => t.toolId === msg.toolId);
        if (tc) {
          tc.status = msg.status;
          if (msg.resultPreview) tc.resultPreview = msg.resultPreview;
          if (msg.status === "failed") tc.expanded = true;
        }
      }
      render();
      break;
    }
    case "summary": {
      const m = getOrCreateMsg(msg.messageId, "assistant");
      m.summary = msg.text;
      if (!summaryRepeatsVisibleText(m, msg.text)) {
        finalizeLiveThoughts(m);
        m.parts.push({ kind: "summary", text: msg.text });
      }
      render();
      break;
    }
    case "planFinal": {
      const m = getOrCreateMsg(msg.messageId, "assistant");
      m.plan = msg.markdown;
      finalizeLiveThoughts(m);
      const existing = m.parts.find((p): p is Extract<MessagePart, { kind: "plan" }> => p.kind === "plan");
      if (existing) existing.markdown = msg.markdown;
      else m.parts.push({ kind: "plan", markdown: msg.markdown });
      render();
      break;
    }
    case "abort": {
      const last = state.messages[state.messages.length - 1];
      if (last) {
        last.aborted = msg.reason;
        finalizeLiveThoughts(last);
        last.parts.push({ kind: "abort", reason: msg.reason });
      }
      state.busy = false;
      render();
      break;
    }
    case "notice":
      state.notices.push({ id: `n_${Date.now()}`, text: msg.text });
      render();
      break;
    case "turnEnd":
      state.busy = false;
      for (const m of state.messages) finalizeLiveThoughts(m);
      render();
      break;
    case "tokens": state.tokens = msg.total; state.limit = msg.limit; render(); break;
    case "planModeChanged": state.planMode = msg.on; render(); break;
  }
});

send({ type: "ready" });
render();
