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
  | { id: string; kind: "text"; text: string }
  | { id: string; kind: "thought"; text: string; live: boolean; userExpanded?: boolean; startedAt?: number; durationMs?: number }
  | { id: string; kind: "tool"; card: ToolCard }
  | { id: string; kind: "summary"; text: string }
  | { id: string; kind: "plan"; markdown: string }
  | { id: string; kind: "abort"; reason: string };

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
  workStartedAt?: number;
  workEndedAt?: number;
  workDurationMs?: number;
  workExpanded?: boolean;
}

type ComposerDecision =
  | { kind: "tool"; tool: ToolCard }
  | { kind: "plan"; message: Message };

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
let mounted = false;
let renderQueued = false;
let partSeq = 0;
let renderedBusy: boolean | undefined;
let renderedScrollDown: boolean | undefined;
let tooltipTarget: HTMLElement | undefined;
const messageEls = new Map<string, HTMLElement>();
const partEls = new Map<string, HTMLElement>();
const noticeEls = new Map<string, HTMLElement>();
const hiddenApprovalToolIds = new Set<string>();

function nextPartId(kind: MessagePart["kind"]): string {
  partSeq += 1;
  return `p_${kind}_${partSeq}`;
}

function send(msg: ChatToExt): void { vscode.postMessage(msg); }

function getOrCreateMsg(id: string, role: Message["role"]): Message {
  let m = state.messages.find(x => x.id === id);
  if (!m) {
    m = { id, role, parts: [], text: "", thought: "", toolCards: [] };
    state.messages.push(m);
  }
  return m;
}

function markWorkStarted(m: Message): void {
  if (m.workStartedAt === undefined) m.workStartedAt = Date.now();
  if (m.workEndedAt !== undefined) m.workEndedAt = undefined;
  if (m.workExpanded === undefined) m.workExpanded = true;
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
    markWorkStarted(m);
    finalizeLiveThoughts(m);
    m.parts.push({ id: nextPartId("thought"), kind: "thought", text: delta, live: true, startedAt: Date.now() });
  } else {
    finalizeLiveThoughts(m);
    m.parts.push({ id: nextPartId("text"), kind: "text", text: delta });
  }
}

function appendPlanText(m: Message, delta: string): void {
  finalizeLiveThoughts(m);
  let part = [...m.parts].reverse().find((p): p is Extract<MessagePart, { kind: "plan" }> => p.kind === "plan");
  if (!part) {
    part = { id: nextPartId("plan"), kind: "plan", markdown: "" };
    m.parts.push(part);
  }
  part.markdown += delta;
  m.plan = part.markdown;
}

function render(immediate = true): void {
  if (!immediate) {
    scheduleRender();
    return;
  }
  renderQueued = false;
  mountShell();
  const body = chatBody();
  const savedTop = body ? body.scrollTop : state.savedScrollTop;
  const shouldStickToBottom = state.autoScroll;
  reconcileNotices();
  reconcileMessages();
  updateComposer();
  updateContextPill();
  if (body) {
    if (shouldStickToBottom) body.scrollTop = body.scrollHeight;
    else body.scrollTop = savedTop;
    state.savedScrollTop = body.scrollTop;
    updateScrollState(body, false);
  }
}

function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => render(true));
}

function mountShell(): void {
  if (mounted) return;
  mounted = true;
  root.innerHTML = `
    <header class="chat-header">
      <div class="chat-title">Chat</div>
      <div class="header-actions">
        <button id="plus" class="icon-btn" data-tip="New chat" aria-label="New chat">${plusIcon()}</button>
        <button id="gear" class="icon-btn" data-tip="Settings" aria-label="Settings">${settingsIcon()}</button>
      </div>
    </header>
    <main class="chat-body">
      <div id="notices" style="display: contents"></div>
      <div id="messages" style="display: contents"></div>
    </main>
    <footer class="composer">
      <div id="scrollDownSlot"></div>
      <div class="composer-row">
        <div id="approvalSlot"></div>
        <textarea id="input" rows="3"></textarea>
        <span id="sendSlot"></span>
      </div>
      <div class="composer-toggles">
        <button id="planToggle" class="mode-pill" data-tip="Toggle plan mode with Shift+Tab">${scrollIcon()}<span>Plan mode</span></button>
        <button id="compact" class="ctx-pill" type="button">
          <span id="ctxIcon"></span><span id="ctxPct"></span>
        </button>
      </div>
    </footer>
    <div id="tooltip" class="tooltip" role="tooltip" hidden></div>
  `;
  bindOnce();
}

function chatBody(): HTMLElement | null {
  return root.querySelector(".chat-body") as HTMLElement | null;
}

function reconcileNotices(): void {
  const host = root.querySelector("#notices") as HTMLElement | null;
  if (!host) return;
  const wanted = new Set(state.notices.map(n => n.id));
  for (const [id, el] of noticeEls) {
    if (!wanted.has(id)) {
      el.remove();
      noticeEls.delete(id);
    }
  }
  for (const notice of state.notices) {
    let el = noticeEls.get(notice.id);
    if (!el) {
      el = document.createElement("div");
      el.className = "notice";
      noticeEls.set(notice.id, el);
      host.appendChild(el);
    }
    const html = `${clockIcon()}<span>${escapeHtml(notice.text)}</span>`;
    if (el.innerHTML !== html) el.innerHTML = html;
  }
}

function reconcileMessages(): void {
  const host = root.querySelector("#messages") as HTMLElement | null;
  if (!host) return;
  const wanted = new Set(state.messages.map(m => m.id));
  for (const [id, el] of messageEls) {
    if (!wanted.has(id)) {
      for (const child of Array.from(el.querySelectorAll("[data-part-id]")) as HTMLElement[]) {
        if (child.dataset.partId) partEls.delete(child.dataset.partId);
      }
      el.remove();
      messageEls.delete(id);
    }
  }
  for (const m of state.messages) {
    let el = messageEls.get(m.id);
    if (!el) {
      el = document.createElement("div");
      el.dataset.messageId = m.id;
      messageEls.set(m.id, el);
      host.appendChild(el);
    }
    el.className = m.role === "user" ? "msg user" : "msg assistant";
    if (m.role === "user") renderUserMessage(el, m);
    else reconcileAssistantParts(el, m);
    if (el.parentElement === host) host.appendChild(el);
  }
}

function renderUserMessage(el: HTMLElement, m: Message): void {
  const html = `<div class="bubble">${md.render(m.text)}</div>`;
  if (el.innerHTML !== html) el.innerHTML = html;
}

function reconcileAssistantParts(el: HTMLElement, m: Message): void {
  const workParts = m.parts.filter(isWorkPart);
  const visibleParts = m.parts.filter(p => !isWorkPart(p));
  const wantsWork = workParts.length > 0 || !!m.workStartedAt;
  const wantedVisible = new Set(visibleParts.map(p => p.id));
  for (const child of Array.from(el.children) as HTMLElement[]) {
    const id = child.dataset.partId;
    const workId = child.dataset.workId;
    if (workId && !wantsWork) {
      child.remove();
    } else if (id && !wantedVisible.has(id)) {
      child.remove();
      partEls.delete(id);
    } else if (!id && !workId) {
      child.remove();
    }
  }
  if (wantsWork) {
    const workEl = ensureWorkElement(el, m.id);
    renderWorkSection(workEl, m, workParts);
    if (workEl.parentElement === el) el.appendChild(workEl);
  }
  for (const part of visibleParts) {
    let partEl = partEls.get(part.id);
    if (!partEl) {
      partEl = document.createElement("div");
      partEl.dataset.partId = part.id;
      partEls.set(part.id, partEl);
      el.appendChild(partEl);
    }
    renderPartInto(partEl, m.id, part);
    if (partEl.parentElement === el) el.appendChild(partEl);
  }
}

function ensureWorkElement(parent: HTMLElement, msgId: string): HTMLElement {
  const selector = `[data-work-id="${CSS.escape(msgId)}"]`;
  let el = parent.querySelector(selector) as HTMLElement | null;
  if (!el) {
    el = document.createElement("div");
    el.dataset.workId = msgId;
    parent.appendChild(el);
  }
  return el;
}

function isWorkPart(part: MessagePart): part is Extract<MessagePart, { kind: "thought" | "tool" }> {
  return part.kind === "thought" || part.kind === "tool";
}

function renderWorkSection(el: HTMLElement, m: Message, parts: Extract<MessagePart, { kind: "thought" | "tool" }>[]): void {
  const live = m.workEndedAt === undefined && !!m.workStartedAt;
  const expanded = m.workExpanded ?? live;
  const cls = `work-section ${expanded ? "open" : ""}`;
  if (el.className !== cls) el.className = cls;
  const headHtml = `<div class="work-head" data-work-toggle="${m.id}">
    ${chevronIcon()}
    ${live ? `<span class="shimmer">Working…</span>` : `<span>${escapeHtml(workLabel(m))}</span>`}
  </div>`;
  const currentHead = el.querySelector(".work-head") as HTMLElement | null;
  if (!currentHead || currentHead.outerHTML !== headHtml) {
    const body = el.querySelector(".work-body");
    el.innerHTML = headHtml;
    if (body) el.appendChild(body);
  }
  let body = el.querySelector(".work-body") as HTMLElement | null;
  if (!expanded) {
    for (const part of parts) partEls.delete(part.id);
    body?.remove();
    return;
  }
  if (!body) {
    body = document.createElement("div");
    body.className = "work-body";
    el.appendChild(body);
  }
  const wanted = new Set(parts.map(p => p.id));
  for (const child of Array.from(body.children) as HTMLElement[]) {
    const id = child.dataset.partId;
    if (!id || !wanted.has(id)) {
      child.remove();
      if (id) partEls.delete(id);
    }
  }
  for (const part of parts) {
    let partEl = partEls.get(part.id);
    if (!partEl) {
      partEl = document.createElement("div");
      partEl.dataset.partId = part.id;
      partEls.set(part.id, partEl);
      body.appendChild(partEl);
    }
    renderPartInto(partEl, m.id, part);
    if (partEl.parentElement === body) body.appendChild(partEl);
  }
}

function workLabel(m: Message): string {
  const duration = m.workDurationMs ?? (
    m.workStartedAt !== undefined && m.workEndedAt !== undefined
      ? m.workEndedAt - m.workStartedAt
      : undefined
  );
  if (duration === undefined) return "Worked";
  const seconds = Math.max(1, Math.round(duration / 1000));
  if (seconds < 150) return `Worked for ${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `Worked for ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function renderPartInto(el: HTMLElement, msgId: string, part: MessagePart): void {
  let cls = "";
  let html = "";
  if (part.kind === "thought") {
    cls = "part thought-part";
    const expanded = part.userExpanded ?? false;
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
    html = `<div class="thinking ${expanded ? "open" : ""}" data-thought-toggle="${msgId}|${part.id}">
      <div class="thinking-head">${chevronIcon()}${labelSpan}</div>
      ${expanded ? `<div class="thinking-body">${md.render(part.text)}</div>` : ""}
    </div>`;
  } else if (part.kind === "text") {
    cls = "part text-part";
    html = `<div class="bubble">${md.render(part.text)}</div>`;
  } else if (part.kind === "tool") {
    cls = "part tool-part";
    html = renderToolCard(part.card);
  } else if (part.kind === "plan") {
    cls = "part plan-part";
    html = renderPlanCard(msgId, part.markdown);
  } else if (part.kind === "summary") {
    cls = "part summary-part";
    html = `<div class="card summary">${md.render(part.text)}</div>`;
  } else {
    cls = "part abort-part";
    html = `<div class="card abort">⛔ ${escapeHtml(part.reason)}</div>`;
  }
  if (el.className !== cls) el.className = cls;
  if (el.innerHTML !== html) el.innerHTML = html;
}

function updateComposer(): void {
  const pendingDecision = findPendingComposerDecision();
  const approvalSlot = root.querySelector("#approvalSlot") as HTMLElement | null;
  const input = root.querySelector("#input") as HTMLTextAreaElement | null;
  if (input) {
    const active = document.activeElement === input;
    const placeholder = state.pendingPlanRejection ? "Suggest changes to the plan…" : state.planMode ? "Plan mode — model is read-only" : "Message…";
    if (input.placeholder !== placeholder) input.placeholder = placeholder;
    if (!active && input.value !== state.draft) input.value = state.draft;
    input.style.display = pendingDecision ? "none" : "";
  }
  if (approvalSlot) {
    approvalSlot.style.display = pendingDecision ? "" : "none";
    const html = pendingDecision ? renderApprovalComposer(pendingDecision) : "";
    if (approvalSlot.innerHTML !== html) approvalSlot.innerHTML = html;
  }
  const sendSlot = root.querySelector("#sendSlot") as HTMLElement | null;
  if (sendSlot && renderedBusy !== state.busy) {
    const html = state.busy
      ? `<button id="cancel" class="send-btn cancel-btn" data-tip="Cancel" aria-label="Cancel">${stopIcon()}</button>`
      : `<button id="send" class="send-btn" data-tip="Send" aria-label="Send">${sendIcon()}</button>`;
    sendSlot.innerHTML = html;
    renderedBusy = state.busy;
  }
  if (sendSlot) sendSlot.style.display = pendingDecision ? "none" : "";
  const planToggle = root.querySelector("#planToggle") as HTMLElement | null;
  planToggle?.classList.toggle("active", state.planMode);
  const scrollSlot = root.querySelector("#scrollDownSlot") as HTMLElement | null;
  const shouldShowScrollDown = !state.autoScroll;
  if (scrollSlot && renderedScrollDown !== shouldShowScrollDown) {
    const html = shouldShowScrollDown
      ? `<button id="scrollDown" class="scroll-down" style="opacity: ${state.scrollDownOpacity.toFixed(2)}" data-tip="Scroll to latest" aria-label="Scroll to latest">${downArrowIcon()}</button>`
      : "";
    scrollSlot.innerHTML = html;
    renderedScrollDown = shouldShowScrollDown;
  }
}

function findPendingComposerDecision(): ComposerDecision | undefined {
  for (const m of state.messages) {
    for (const tc of m.toolCards) {
      if (
        tc.status === "pending" &&
        !hiddenApprovalToolIds.has(tc.toolId) &&
        (tc.category === "write" || tc.category === "safeCmd" || tc.category === "read")
      ) {
        return { kind: "tool", tool: tc };
      }
    }
  }
  for (const m of state.messages) {
    if (m.plan && !m.planResolved && !state.busy) {
      return { kind: "plan", message: m };
    }
  }
  return undefined;
}

function renderApprovalComposer(decision: ComposerDecision): string {
  if (decision.kind === "plan") return renderPlanApprovalComposer(decision.message);
  return renderToolApprovalComposer(decision.tool);
}

function renderToolApprovalComposer(tc: ToolCard): string {
  const isWrite = tc.category === "write";
  const approveText = isWrite ? "Accept changes" : "Approve";
  const rejectText = isWrite ? "Reject changes and suggest changes" : "Reject";
  return `<div class="approval-composer">
    <div class="approval-summary">
      <span class="tool-icon" aria-hidden="true">${toolIcon(tc)}</span>
      <strong>${escapeHtml(toolDisplayName(tc.toolName))}</strong>
      <span>${escapeHtml(toolCardLabel(tc))}</span>
    </div>
    <div class="approval-actions">
      <button class="approve" data-approve="${tc.toolId}">${approveText}</button>
      <button class="reject" data-reject="${tc.toolId}">${rejectText}</button>
    </div>
  </div>`;
}

function renderPlanApprovalComposer(m: Message): string {
  return `<div class="approval-composer">
    <div class="approval-summary">
      <span class="tool-icon" aria-hidden="true">${scrollIcon()}</span>
      <strong>Plan ready</strong>
      <span>Review the plan above, then choose how to continue.</span>
    </div>
    <div class="approval-actions">
      <button class="approve" data-accept-plan="${m.id}">Accept plan and execute</button>
      <button class="reject" data-reject-plan="${m.id}">Reject plan and suggest changes</button>
    </div>
  </div>`;
}

function updateContextPill(): void {
  const ratio = Math.min(1, state.tokens / Math.max(1, state.limit));
  const pct = Math.round(ratio * 100);
  const pctClass = ratio >= 0.9 ? "danger" : "ok";
  const compact = root.querySelector("#compact") as HTMLElement | null;
  compact?.classList.toggle("danger", pctClass === "danger");
  compact?.classList.toggle("ok", pctClass === "ok");
  if (compact) compact.dataset.tip = `Context: ${state.tokens} / ${state.limit} tokens. Click to compact.`;
  const icon = root.querySelector("#ctxIcon") as HTMLElement | null;
  const pctEl = root.querySelector("#ctxPct") as HTMLElement | null;
  if (icon) icon.innerHTML = circleIcon(ratio);
  if (pctEl) pctEl.textContent = `${pct}%`;
}

function showTooltip(target: HTMLElement): void {
  const text = target.dataset.tip;
  const tooltip = root.querySelector("#tooltip") as HTMLElement | null;
  if (!tooltip || !text) return;
  tooltipTarget = target;
  tooltip.textContent = text;
  tooltip.hidden = false;
  positionTooltip(target, tooltip);
}

function hideTooltip(target?: HTMLElement): void {
  if (target && tooltipTarget !== target) return;
  const tooltip = root.querySelector("#tooltip") as HTMLElement | null;
  if (tooltip) tooltip.hidden = true;
  tooltipTarget = undefined;
}

function refreshTooltip(): void {
  if (tooltipTarget) showTooltip(tooltipTarget);
}

function positionTooltip(target: HTMLElement, tooltip: HTMLElement): void {
  const gap = 6;
  const margin = 8;
  const targetRect = target.getBoundingClientRect();
  const tipRect = tooltip.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  let top = targetRect.top - tipRect.height - gap;
  if (top < margin) top = targetRect.bottom + gap;
  if (top + tipRect.height > viewportHeight - margin) {
    top = Math.max(margin, viewportHeight - margin - tipRect.height);
  }
  const centered = targetRect.left + (targetRect.width / 2) - (tipRect.width / 2);
  const left = Math.max(margin, Math.min(centered, viewportWidth - margin - tipRect.width));
  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.top = `${Math.round(top)}px`;
}

function renderToolCard(tc: ToolCard): string {
  const cls = "tool-card " + tc.category + " " + tc.status + (tc.expanded ? " open" : "");
  const commandLabel = toolCardLabel(tc);
  const expanded = tc.expanded;
  const result = tc.resultPreview
    ? `<div class="tool-output-label">Out:</div><pre class="tool-result">${escapeHtml(tc.resultPreview)}</pre>`
    : "";
  const diff = tc.diffPreview
    ? `<div class="tool-output-label">Changes:</div><pre class="tool-diff edit-preview">${renderDiffLines(tc.diffPreview)}</pre>`
    : "";
  const argsBlock = tc.category !== "read" && tc.argsJson && tc.argsJson !== "{}"
    ? `<div class="tool-output-label">Arguments:</div><pre class="tool-args">${escapeHtml(prettyArgs(tc.argsJson))}</pre>`
    : "";
  const reason = tc.reason ? `<div class="tool-reason">${escapeHtml(tc.reason)}</div>` : "";
  const statusBadge = tc.status === "pending" ? "" : `<span class="badge ${tc.status}">${tc.status}</span>`;
  return `<div class="${cls}" data-tool-card="${tc.toolId}">
    <div class="tool-head">
      ${chevronIcon()}
      <span class="tool-icon" aria-hidden="true">${toolIcon(tc)}</span>
      <strong>${escapeHtml(toolDisplayName(tc.toolName))}</strong>
      <span class="tool-label">${escapeHtml(commandLabel)}</span>
      ${statusBadge}
    </div>
    ${expanded ? `<div class="tool-expanded">${reason}${diff}${argsBlock}${result}</div>` : ""}
  </div>`;
}

function toolIcon(tc: ToolCard): string {
  if (tc.toolName === "run_command" || tc.category === "safeCmd" || tc.category === "unsafeCmd") return terminalIcon();
  if (tc.toolName === "write_file" || tc.category === "write") return pencilIcon();
  return searchIcon();
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
    msg.parts.push({ id: nextPartId("text"), kind: "text", text: recordMessage.content });
  }
  finalizeLiveThoughts(msg);
}

function finalizeRestoredWork(msg: Message): void {
  if (!msg.parts.some(isWorkPart)) return;
  const duration = msg.parts.reduce((sum, part) => {
    if (part.kind === "thought" && part.durationMs !== undefined) return sum + part.durationMs;
    return sum;
  }, 0);
  msg.workDurationMs = duration >= 1000 ? duration : undefined;
  msg.workExpanded = false;
}

function renderPlanCard(msgId: string, planMd: string): string {
  const m = state.messages.find(x => x.id === msgId);
  const resolved = m?.planResolved;
  const actions = resolved
    ? `<div class="plan-resolved">${resolved === "accepted" ? "Plan accepted" : "Plan rejected — type your changes below"}</div>`
    : "";
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

function markUserScrollIntent(body: HTMLElement): void {
  requestAnimationFrame(() => {
    const distance = body.scrollHeight - body.scrollTop - body.clientHeight;
    if (distance <= 4) {
      if (!state.autoScroll) {
        state.autoScroll = true;
        render();
      }
    } else {
      state.autoScroll = false;
    }
  });
}

function bindOnce(): void {
  const body = chatBody();
  if (body) {
    body.addEventListener("scroll", () => updateScrollState(body, true));
    const userIsScrolling = (): void => markUserScrollIntent(body);
    body.addEventListener("wheel", userIsScrolling, { passive: true });
    body.addEventListener("touchmove", userIsScrolling, { passive: true });
    body.addEventListener("keydown", e => {
      const k = e.key;
      if (k === "PageUp" || k === "PageDown" || k === "ArrowUp" || k === "ArrowDown" || k === "Home" || k === "End" || k === " ") {
        userIsScrolling();
      }
    });
  }
  const input = root.querySelector("#input") as HTMLTextAreaElement | null;
  input?.addEventListener("input", () => {
    state.draft = input.value;
  });
  input?.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
    else if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); send({ type: "togglePlanMode" }); }
  });
  root.addEventListener("pointerover", e => {
    const target = (e.target as HTMLElement).closest("[data-tip]") as HTMLElement | null;
    if (target) showTooltip(target);
  });
  root.addEventListener("pointerout", e => {
    const target = (e.target as HTMLElement).closest("[data-tip]") as HTMLElement | null;
    if (target && !target.contains(e.relatedTarget as Node | null)) hideTooltip(target);
  });
  root.addEventListener("pointermove", refreshTooltip);
  root.addEventListener("focusin", e => {
    const target = (e.target as HTMLElement).closest("[data-tip]") as HTMLElement | null;
    if (target) showTooltip(target);
  });
  root.addEventListener("focusout", e => {
    const target = (e.target as HTMLElement).closest("[data-tip]") as HTMLElement | null;
    if (target) hideTooltip(target);
  });
  window.addEventListener("resize", refreshTooltip);
  window.addEventListener("scroll", refreshTooltip, true);
  root.addEventListener("pointerdown", e => {
    const target = e.target as HTMLElement;
    if (target.closest("#cancel")) {
      e.preventDefault();
      send({ type: "cancel" });
      return;
    }
    const workEl = target.closest("[data-work-toggle]") as HTMLElement | null;
    if (workEl) {
      e.preventDefault();
      const m = state.messages.find(x => x.id === workEl.dataset.workToggle);
      if (m) {
        m.workExpanded = !(m.workExpanded ?? (m.workEndedAt === undefined));
        state.autoScroll = false;
        render();
      }
      return;
    }
    const thoughtEl = target.closest("[data-thought-toggle]") as HTMLElement | null;
    if (thoughtEl) {
      e.preventDefault();
      const [msgId, partId] = thoughtEl.dataset.thoughtToggle!.split("|");
      const m = state.messages.find(x => x.id === msgId);
      const part = m?.parts.find((p): p is Extract<MessagePart, { kind: "thought" }> => p.id === partId && p.kind === "thought");
      if (part) {
        const currentExpanded = part.userExpanded ?? part.live;
        part.userExpanded = !currentExpanded;
        state.autoScroll = false;
        render();
      }
      return;
    }
    const toolEl = target.closest("[data-tool-card]") as HTMLElement | null;
    if (toolEl && !target.closest("button")) {
      e.preventDefault();
      const id = toolEl.dataset.toolCard!;
      for (const m of state.messages) {
        const tc = m.toolCards.find(t => t.toolId === id);
        if (tc) {
          tc.expanded = !tc.expanded;
          state.autoScroll = false;
          render();
          return;
        }
      }
    }
  });
  root.addEventListener("click", e => {
    const target = e.target as HTMLElement;
    if (target.closest("#gear")) send({ type: "openSettings" });
    else if (target.closest("#plus")) send({ type: "newChat" });
    else if (target.closest("#compact")) send({ type: "compactNow" });
    else if (target.closest("#send")) submit();
    else if (target.closest("#planToggle")) send({ type: "togglePlanMode" });
    else if (target.closest("#scrollDown")) {
      state.autoScroll = true;
      render();
    } else {
      const approve = target.closest("[data-approve]") as HTMLElement | null;
      const reject = target.closest("[data-reject]") as HTMLElement | null;
      const acceptPlan = target.closest("[data-accept-plan]") as HTMLElement | null;
      const rejectPlan = target.closest("[data-reject-plan]") as HTMLElement | null;
      if (approve) {
        const toolId = approve.dataset.approve!;
        hiddenApprovalToolIds.add(toolId);
        send({ type: "approveTool", toolId, approved: true });
        render();
      }
      else if (reject) {
        const toolId = reject.dataset.reject!;
        hiddenApprovalToolIds.add(toolId);
        send({ type: "approveTool", toolId, approved: false });
        render();
      }
      else if (acceptPlan) {
        const id = acceptPlan.dataset.acceptPlan!;
        const m = state.messages.find(x => x.id === id);
        if (m) m.planResolved = "accepted";
        state.pendingPlanRejection = false;
        send({ type: "acceptPlan" });
        render();
      } else if (rejectPlan) {
        const id = rejectPlan.dataset.rejectPlan!;
        const m = state.messages.find(x => x.id === id);
        if (m) m.planResolved = "rejected";
        state.pendingPlanRejection = true;
        render();
        (root.querySelector("#input") as HTMLTextAreaElement | null)?.focus();
      }
    }
  });
}

function submit(): void {
  const input = root.querySelector("#input") as HTMLTextAreaElement | null;
  const text = input?.value.trim();
  if (!text) return;
  state.busy = true;
  state.draft = "";
  if (input) input.value = "";
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

function searchIcon(): string {
  return `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
    <path d="M7 2a5 5 0 0 1 3.95 8.07l2.74 2.74-.88.88-2.74-2.74A5 5 0 1 1 7 2Zm0 1.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Z" fill="currentColor"/>
  </svg>`;
}

function pencilIcon(): string {
  return `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
    <path d="M11.65 1.9 14.1 4.35 5.45 13H3v-2.45L11.65 1.9Zm0 1.7L4.2 11.05v.75h.75l7.45-7.45-.75-.75Z" fill="currentColor"/>
  </svg>`;
}

function terminalIcon(): string {
  return `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
    <path d="M2 3h12v10H2V3Zm1.2 1.2v7.6h9.6V4.2H3.2Zm1.25 2.1.85-.85L8 8l-2.7 2.55-.85-.85L6.25 8 4.45 6.3ZM8.3 9.4h3.2v1.2H8.3V9.4Z" fill="currentColor"/>
  </svg>`;
}

function chevronIcon(): string {
  return `<svg class="disclosure-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
    <path d="M6 3.5 10.5 8 6 12.5l-.85-.85L8.8 8 5.15 4.35 6 3.5Z" fill="currentColor"/>
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
      finalizeRestoredWork(msg);
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
      last.parts.push({ id: nextPartId("tool"), kind: "tool", card: tc });
      finalizeRestoredWork(last);
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
      hiddenApprovalToolIds.clear();
      loadFromRecord(msg.record);
      state.autoScroll = true;
      render();
      break;
    case "chatClosed":
      hiddenApprovalToolIds.clear();
      state.messages = [];
      state.tokens = 0;
      state.busy = false;
      state.autoScroll = true;
      render();
      break;
    case "turnStart":
      state.busy = true;
      state.autoScroll = true;
      {
        const m = getOrCreateMsg(msg.messageId, "assistant");
        markWorkStarted(m);
        m.workExpanded = true;
      }
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
      render(false);
      break;
    }
    case "thought": {
      const m = getOrCreateMsg(msg.messageId, "assistant");
      m.thought += msg.delta;
      appendPartText(m, "thought", msg.delta);
      render(false);
      break;
    }
    case "toolCallProposed": {
      const m = getOrCreateMsg(msg.messageId, "assistant");
      markWorkStarted(m);
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
      m.parts.push({ id: nextPartId("tool"), kind: "tool", card });
      render();
      break;
    }
    case "toolCallResolved": {
      hiddenApprovalToolIds.delete(msg.toolId);
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
        m.parts.push({ id: nextPartId("summary"), kind: "summary", text: msg.text });
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
      else m.parts.push({ id: nextPartId("plan"), kind: "plan", markdown: msg.markdown });
      render();
      break;
    }
    case "abort": {
      const last = state.messages[state.messages.length - 1];
      if (last) {
        last.aborted = msg.reason;
        finalizeLiveThoughts(last);
        if (last.workStartedAt !== undefined && last.workEndedAt === undefined) {
          last.workEndedAt = Date.now();
          last.workDurationMs = last.workEndedAt - last.workStartedAt;
          last.workExpanded = false;
        }
        last.parts.push({ id: nextPartId("abort"), kind: "abort", reason: msg.reason });
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
      for (const m of state.messages) {
        finalizeLiveThoughts(m);
        if (m.id === msg.messageId && m.workStartedAt !== undefined && m.workEndedAt === undefined) {
          m.workEndedAt = Date.now();
          m.workDurationMs = m.workEndedAt - m.workStartedAt;
          m.workExpanded = false;
        }
      }
      render();
      break;
    case "tokens": state.tokens = msg.total; state.limit = msg.limit; render(); break;
    case "planModeChanged": state.planMode = msg.on; render(); break;
  }
});

send({ type: "ready" });
render();
