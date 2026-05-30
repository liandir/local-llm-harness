import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
// @ts-expect-error no types for markdown-it-katex
import mdKatex from "markdown-it-katex";
import type { ChatToExt, ExtToChat } from "../../messaging.js";
import type { ChatRecord, FileChangeSummary } from "../../../chat/storage.js";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("go", go);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("php", php);
hljs.registerLanguage("python", python);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

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
  fileChanges?: FileChangeSummary[];
  fileChangesExpanded?: boolean;
  expandedFileChanges?: Set<string>;
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
  compactAvailable: boolean;
  compactCurrentMessages: number;
  compactMinMessages: number;
  compactNudge: boolean;
  compactHintOverride?: string;
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
  pendingPlanRejection: false,
  compactAvailable: false,
  compactCurrentMessages: 0,
  compactMinMessages: 6,
  compactNudge: false
};

const root = document.getElementById("app")!;
let mounted = false;
let renderQueued = false;
let partSeq = 0;
let renderedBusy: boolean | undefined;
let renderedScrollDown: boolean | undefined;
let tooltipTarget: HTMLElement | undefined;
let copiedMessageId: string | undefined;
let copiedResetTimer: ReturnType<typeof setTimeout> | undefined;
let compactNudgeTimer: ReturnType<typeof setTimeout> | undefined;
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
        <button id="planToggle" class="mode-pill" aria-label="Toggle plan mode with Shift+Tab">${scrollIcon()}<span>Plan mode</span></button>
        <span id="planHint" class="inline-hint plan-hint">Toggle plan mode with Shift+Tab</span>
        <span class="compact-group">
          <span id="compactHint" class="inline-hint compact-hint"></span>
          <button id="compact" class="ctx-pill" type="button" aria-label="Compact context">
            <span id="ctxIcon"></span><span id="ctxPct"></span>
          </button>
        </span>
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
  const html = `<div class="bubble">${md.render(m.text)}</div>${renderMessageActionsHtml(m)}`;
  if (el.innerHTML !== html) el.innerHTML = html;
}

function renderMessageActions(parent: HTMLElement, m: Message): void {
  let actions = directChild(parent, "message-actions");
  const html = renderMessageActionsHtml(m);
  if (!html) {
    actions?.remove();
    return;
  }
  if (!actions) {
    actions = document.createElement("div");
    parent.appendChild(actions);
  }
  if (actions.outerHTML !== html) {
    actions.outerHTML = html;
    actions = directChild(parent, "message-actions");
  }
  if (actions?.parentElement === parent) parent.appendChild(actions);
}

function renderMessageActionsHtml(m: Message): string {
  if (!copyableMessageText(m).trim()) return "";
  const copied = copiedMessageId === m.id;
  const cls = `copy-btn${copied ? " copied" : ""}`;
  const label = copied ? "Copied" : "Copy message";
  return `<div class="message-actions" data-message-actions="${m.id}">
    <button class="${cls}" type="button" data-copy-message="${m.id}" aria-label="${label}">
      ${copyIcon()}
    </button>
    <span class="copy-inline-hint${copied ? " copied" : ""}">${label}</span>
  </div>`;
}

function renderFileChangeSummary(parent: HTMLElement, m: Message): void {
  let summary = directChild(parent, "change-summary");
  const html = renderFileChangeSummaryHtml(m);
  if (!html) {
    summary?.remove();
    return;
  }
  if (!summary) {
    summary = document.createElement("div");
    parent.appendChild(summary);
  }
  if (summary.outerHTML !== html) {
    summary.outerHTML = html;
    summary = directChild(parent, "change-summary");
  }
  if (summary?.parentElement === parent) parent.appendChild(summary);
}

function renderFileChangeSummaryHtml(m: Message): string {
  const changes = m.fileChanges ?? [];
  if (changes.length === 0) return "";
  const totals = totalFileChangeStats(changes);
  const expanded = m.fileChangesExpanded ?? false;
  const cls = `change-summary${expanded ? " open" : ""}`;
  return `<div class="${cls}" data-change-summary="${m.id}">
    <div class="change-summary-head">
      <button class="change-summary-toggle" type="button" data-file-changes-toggle="${m.id}" aria-expanded="${expanded}">
        ${chevronIcon()}
        <span class="change-summary-main">
          <span class="change-summary-title">Edited ${changes.length} file${changes.length === 1 ? "" : "s"}</span>
          <span class="diff-stat-group"><span class="diff-stat add">+${totals.added}</span><span class="diff-stat del">-${totals.removed}</span></span>
        </span>
      </button>
      <button class="review-btn change-review-btn" type="button" data-review-workspace-changes>Review</button>
    </div>
    ${expanded ? `<div class="change-file-list">${changes.map((change, index) => renderFileChangeRow(m, change, index)).join("")}</div>` : ""}
  </div>`;
}

function renderFileChangeRow(m: Message, change: FileChangeSummary, index: number): string {
  const key = fileChangeKey(index);
  const expanded = m.expandedFileChanges?.has(key) ?? false;
  return `<div class="change-file-item${expanded ? " open" : ""}">
    <button class="change-file-row" type="button" data-file-change-toggle="${m.id}|${key}" aria-expanded="${expanded}">
      ${chevronIcon()}
      <span class="change-file-path">${escapeHtml(change.path)}</span>
      <span class="diff-stat-group"><span class="diff-stat add">+${change.added}</span><span class="diff-stat del">-${change.removed}</span></span>
    </button>
    ${expanded ? `<pre class="tool-diff edit-preview change-diff">${renderDiffLines(change.diffPreview, change.path)}</pre>` : ""}
  </div>`;
}

function totalFileChangeStats(changes: FileChangeSummary[]): { added: number; removed: number } {
  return changes.reduce((total, change) => ({
    added: total.added + change.added,
    removed: total.removed + change.removed
  }), { added: 0, removed: 0 });
}

function fileChangeKey(index: number): string {
  return String(index);
}

function reconcileAssistantParts(el: HTMLElement, m: Message): void {
  const workParts = m.parts.filter(isWorkPart);
  const visibleParts = m.parts.filter(p => !isWorkPart(p));
  const wantsWork = workParts.length > 0 || !!m.workStartedAt;
  const wantedVisible = new Set(visibleParts.map(p => p.id));
  for (const child of Array.from(el.children) as HTMLElement[]) {
    const id = child.dataset.partId;
    const workId = child.dataset.workId;
    const actionId = child.dataset.messageActions;
    const changeSummaryId = child.dataset.changeSummary;
    if (workId && !wantsWork) {
      child.remove();
    } else if (id && !wantedVisible.has(id)) {
      child.remove();
      partEls.delete(id);
    } else if (!id && !workId && !actionId && !changeSummaryId) {
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
  renderFileChangeSummary(el, m);
  renderMessageActions(el, m);
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

function renderWorkHead(el: HTMLElement, m: Message, live: boolean): void {
  let head = directChild(el, "work-head");
  if (!head) {
    head = document.createElement("div");
    head.className = "work-head";
    head.innerHTML = `${chevronIcon()}<span class="work-title"></span>`;
    el.insertBefore(head, el.firstChild);
  } else if (head !== el.firstElementChild) {
    el.insertBefore(head, el.firstChild);
  }
  ensureDisclosureIcon(head);

  head.dataset.workToggle = m.id;
  let title = head.querySelector(".work-title") as HTMLElement | null;
  if (!title) {
    title = document.createElement("span");
    title.className = "work-title";
    head.appendChild(title);
  }
  const titleClass = live ? "work-title shimmer" : "work-title";
  const titleText = live ? "Working…" : workLabel(m);
  if (title.className !== titleClass) title.className = titleClass;
  if (title.textContent !== titleText) title.textContent = titleText;
}

function renderWorkSection(el: HTMLElement, m: Message, parts: Extract<MessagePart, { kind: "thought" | "tool" }>[]): void {
  const live = m.workEndedAt === undefined && !!m.workStartedAt;
  const expanded = m.workExpanded ?? live;
  const cls = [
    "work-section",
    expanded ? "open" : "",
    parts.length > 0 ? "has-items" : ""
  ].filter(Boolean).join(" ");
  if (el.className !== cls) el.className = cls;
  renderWorkHead(el, m, live);
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
    if (el.className !== "part thought-part") el.className = "part thought-part";
    renderThoughtPart(el, msgId, part);
    return;
  } else if (part.kind === "text") {
    cls = "part text-part";
    html = `<div class="card answer bubble">${md.render(part.text)}</div>`;
  } else if (part.kind === "tool") {
    if (el.className !== "part tool-part") el.className = "part tool-part";
    renderToolPart(el, part.card);
    return;
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

function renderThoughtPart(
  el: HTMLElement,
  msgId: string,
  part: Extract<MessagePart, { kind: "thought" }>
): void {
  let thinking = directChild(el, "thinking");
  if (!thinking) {
    el.textContent = "";
    thinking = document.createElement("div");
    thinking.innerHTML = `<div class="thinking-head">${chevronIcon()}<span class="thinking-label"></span></div>`;
    el.appendChild(thinking);
  }

  const expanded = part.userExpanded ?? false;
  const cls = `thinking${expanded ? " open" : ""}`;
  if (thinking.className !== cls) thinking.className = cls;
  thinking.dataset.thoughtToggle = `${msgId}|${part.id}`;

  let head = directChild(thinking, "thinking-head");
  if (!head) {
    head = document.createElement("div");
    head.className = "thinking-head";
    head.innerHTML = `${chevronIcon()}<span class="thinking-label"></span>`;
    thinking.insertBefore(head, thinking.firstChild);
  } else if (head !== thinking.firstElementChild) {
    thinking.insertBefore(head, thinking.firstChild);
  }
  ensureDisclosureIcon(head);

  let label = head.querySelector(".thinking-label") as HTMLElement | null;
  if (!label) {
    label = head.querySelector("span") as HTMLElement | null;
    if (!label) {
      label = document.createElement("span");
      head.appendChild(label);
    }
    label.classList.add("thinking-label");
  }
  const labelClass = part.live ? "thinking-label shimmer" : "thinking-label";
  const labelText = thoughtLabel(part);
  if (label.hasAttribute("style")) label.removeAttribute("style");
  if (label.className !== labelClass) label.className = labelClass;
  if (label.textContent !== labelText) label.textContent = labelText;

  let body = directChild(thinking, "thinking-body");
  if (!expanded) {
    body?.remove();
    return;
  }
  if (!body) {
    body = document.createElement("div");
    body.className = "thinking-body";
    thinking.appendChild(body);
  }
  const bodyHtml = md.render(part.text);
  if (body.innerHTML !== bodyHtml) body.innerHTML = bodyHtml;
}

function thoughtLabel(part: Extract<MessagePart, { kind: "thought" }>): string {
  if (part.live) return "Thinking…";
  if (part.durationMs !== undefined) {
    const secs = Math.max(1, Math.round(part.durationMs / 1000));
    return `Thought for ${secs} second${secs === 1 ? "" : "s"}`;
  }
  return "Thought";
}

function copyableMessageText(m: Message): string {
  if (m.role === "user") return m.text;
  const visible = m.parts
    .map(part => {
      if (part.kind === "text") return part.text;
      if (part.kind === "plan") return part.markdown;
      if (part.kind === "summary") return part.text;
      if (part.kind === "abort") return part.reason;
      return "";
    })
    .filter(Boolean);
  if (visible.length > 0) return visible.join("\n\n");
  return m.text || m.plan || "";
}

async function handleCopyMessage(messageId: string): Promise<void> {
  const m = state.messages.find(x => x.id === messageId);
  const text = m ? copyableMessageText(m).trimEnd() : "";
  if (!text.trim()) return;
  try {
    await copyTextToClipboard(text);
    copiedMessageId = messageId;
    if (copiedResetTimer) clearTimeout(copiedResetTimer);
    copiedResetTimer = setTimeout(() => {
      if (copiedMessageId === messageId) {
        copiedMessageId = undefined;
        render();
      }
    }, 1600);
  } catch {
    state.notices.push({ id: `n_${Date.now()}`, text: "Could not copy message to clipboard." });
  }
  render();
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the textarea fallback below.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand("copy");
  textarea.remove();
  if (!ok) throw new Error("Clipboard copy was rejected.");
}

function renderToolPart(el: HTMLElement, tc: ToolCard): void {
  const card = directChild(el, "tool-card");
  if (!card) {
    el.innerHTML = renderToolCard(tc);
    return;
  }

  const cls = toolCardClass(tc);
  if (card.className !== cls) card.className = cls;
  card.dataset.toolCard = tc.toolId;
  renderToolHead(card, tc);

  let expanded = directChild(card, "tool-expanded");
  if (!tc.expanded) {
    expanded?.remove();
    return;
  }
  if (!expanded) {
    expanded = document.createElement("div");
    expanded.className = "tool-expanded";
    card.appendChild(expanded);
  }
  const html = renderToolExpandedHtml(tc);
  if (expanded.innerHTML !== html) expanded.innerHTML = html;
}

function renderToolHead(card: HTMLElement, tc: ToolCard): void {
  let head = directChild(card, "tool-head");
  if (!head) {
    head = document.createElement("div");
    head.className = "tool-head";
    head.innerHTML = `${chevronIcon()}<span class="tool-icon" aria-hidden="true"></span><strong class="tool-name"></strong><span class="tool-label"></span>`;
    card.insertBefore(head, card.firstChild);
  } else if (head !== card.firstElementChild) {
    card.insertBefore(head, card.firstChild);
  }
  ensureDisclosureIcon(head);

  let icon = directChild(head, "tool-icon");
  if (!icon) {
    icon = document.createElement("span");
    icon.className = "tool-icon";
    icon.setAttribute("aria-hidden", "true");
    head.appendChild(icon);
  }
  const iconHtml = toolIcon(tc);
  if (icon.innerHTML !== iconHtml) icon.innerHTML = iconHtml;

  let name = head.querySelector(".tool-name") as HTMLElement | null;
  if (!name) {
    name = head.querySelector("strong") as HTMLElement | null;
    if (!name) {
      name = document.createElement("strong");
      head.appendChild(name);
    }
    name.className = "tool-name";
  }
  const displayName = toolDisplayName(tc.toolName);
  if (name.textContent !== displayName) name.textContent = displayName;

  let label = head.querySelector(".tool-label") as HTMLElement | null;
  if (!label) {
    label = document.createElement("span");
    label.className = "tool-label";
    head.appendChild(label);
  }
  const labelClass = toolLabelClass(tc);
  const labelHtml = renderToolCardLabel(tc);
  if (label.className !== labelClass) label.className = labelClass;
  if (label.innerHTML !== labelHtml) label.innerHTML = labelHtml;

  let badge = directChild(head, "badge");
  if (tc.status === "pending") {
    badge?.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement("span");
    head.appendChild(badge);
  }
  const badgeClass = `badge ${tc.status}`;
  if (badge.className !== badgeClass) badge.className = badgeClass;
  if (badge.textContent !== tc.status) badge.textContent = tc.status;
}

function directChild(parent: HTMLElement, className: string): HTMLElement | null {
  for (const child of Array.from(parent.children)) {
    if (child instanceof HTMLElement && child.classList.contains(className)) return child;
  }
  return null;
}

function ensureDisclosureIcon(head: HTMLElement): void {
  if (!head.querySelector(".disclosure-icon")) head.insertAdjacentHTML("afterbegin", chevronIcon());
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
  const label = renderToolApprovalLabel(tc);
  return `<div class="approval-composer">
    <div class="approval-summary">
      <span class="tool-icon" aria-hidden="true">${toolIcon(tc)}</span>
      <strong>${escapeHtml(toolDisplayName(tc.toolName))}</strong>
      <span>${label}</span>
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
  compact?.classList.toggle("nudge", state.compactNudge);
  compact?.setAttribute("aria-disabled", String(!state.compactAvailable));
  const hint = root.querySelector("#compactHint") as HTMLElement | null;
  if (hint) {
    hint.textContent = state.compactHintOverride ?? `Context: ${state.tokens} / ${state.limit} tokens. Click to compact.`;
    hint.classList.toggle("active", !!state.compactHintOverride);
  }
  const icon = root.querySelector("#ctxIcon") as HTMLElement | null;
  const pctEl = root.querySelector("#ctxPct") as HTMLElement | null;
  if (icon) icon.innerHTML = circleIcon(ratio);
  if (pctEl) pctEl.textContent = `${pct}%`;
}

function showCompactUnavailable(): void {
  state.compactNudge = true;
  state.compactHintOverride = `Compaction is available after ${state.compactMinMessages} saved messages.`;
  if (compactNudgeTimer) clearTimeout(compactNudgeTimer);
  compactNudgeTimer = setTimeout(() => {
    state.compactNudge = false;
    state.compactHintOverride = undefined;
    render();
  }, 1800);
  render();
}

function applyCompactStatus(currentMessages: number, minMessages: number, available: boolean): void {
  state.compactCurrentMessages = currentMessages;
  state.compactMinMessages = minMessages;
  state.compactAvailable = available;
  if (available && state.compactHintOverride) {
    state.compactHintOverride = undefined;
    state.compactNudge = false;
    if (compactNudgeTimer) {
      clearTimeout(compactNudgeTimer);
      compactNudgeTimer = undefined;
    }
  }
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
  const cls = toolCardClass(tc);
  const labelClass = toolLabelClass(tc);
  const commandLabel = renderToolCardLabel(tc);
  const expanded = tc.expanded ? renderToolExpandedHtml(tc) : "";
  const statusBadge = tc.status === "pending" ? "" : `<span class="badge ${tc.status}">${tc.status}</span>`;
  return `<div class="${cls}" data-tool-card="${tc.toolId}">
    <div class="tool-head">
      ${chevronIcon()}
      <span class="tool-icon" aria-hidden="true">${toolIcon(tc)}</span>
      <strong class="tool-name">${escapeHtml(toolDisplayName(tc.toolName))}</strong>
      <span class="${labelClass}">${commandLabel}</span>
      ${statusBadge}
    </div>
    ${tc.expanded ? `<div class="tool-expanded">${expanded}</div>` : ""}
  </div>`;
}

function toolCardClass(tc: ToolCard): string {
  return "tool-card " + tc.category + " " + tc.status + (tc.expanded ? " open" : "");
}

function toolLabelClass(tc: ToolCard): string {
  return "tool-label" + (tc.toolName === "write_file" && tc.diffPreview ? " edit-label" : "");
}

function renderToolExpandedHtml(tc: ToolCard): string {
  const command = isCommandTool(tc) ? toolCommand(tc) : "";
  const commandBlock = command
    ? `<div class="tool-output-label">Command:</div><pre class="tool-command">${escapeHtml(command)}</pre>`
    : "";
  const result = tc.resultPreview
    ? `<div class="tool-output-label">Out:</div><pre class="tool-result">${escapeHtml(tc.resultPreview)}</pre>`
    : "";
  const diff = tc.diffPreview
    ? renderChangeCard(tc)
    : "";
  const reason = tc.reason ? `<div class="tool-reason">${escapeHtml(tc.reason)}</div>` : "";
  return `${reason}${commandBlock}${result}${diff}`;
}

function toolIcon(tc: ToolCard): string {
  if (isCommandTool(tc)) return terminalIcon();
  if (tc.toolName === "write_file" || tc.category === "write") return pencilIcon();
  return searchIcon();
}

function isCommandTool(tc: ToolCard): boolean {
  return tc.toolName === "run_command" || tc.category === "safeCmd" || tc.category === "unsafeCmd";
}

function renderChangeCard(tc: ToolCard): string {
  const path = toolPath(tc);
  const review = path
    ? `<button class="review-btn" type="button" data-review-path="${escapeHtml(path)}">review</button>`
    : "";
  return `<div class="tool-change-card">
    <div class="tool-change-head">
      <div class="tool-output-label">Changes:</div>
      ${review}
    </div>
    <pre class="tool-diff edit-preview">${renderDiffLines(tc.diffPreview ?? "", path)}</pre>
  </div>`;
}

function renderDiffLines(diff: string, filePath: string): string {
  const language = highlightLanguageForPath(filePath);
  return diff.split("\n").map(line => {
    const parsed = parseDiffLine(line);
    return `<span class="diff-line ${parsed.kind}">
      <span class="diff-no old">${escapeHtml(parsed.oldLine)}</span>
      <span class="diff-no new">${escapeHtml(parsed.newLine)}</span>
      <span class="diff-marker">${escapeHtml(parsed.marker)}</span>
      <span class="diff-code">${highlightCode(parsed.code, language)}</span>
    </span>`;
  }).join("");
}

function parseDiffLine(line: string): { kind: "add" | "del" | "neutral"; oldLine: string; newLine: string; marker: string; code: string } {
  if (line === "...\t\t\t...") {
    return { kind: "neutral", oldLine: "", newLine: "", marker: "", code: "..." };
  }
  if ((line.startsWith("+\t") || line.startsWith("-\t") || line.startsWith(" \t"))) {
    const first = line.indexOf("\t");
    const second = line.indexOf("\t", first + 1);
    const third = line.indexOf("\t", second + 1);
    if (first >= 0 && second >= 0 && third >= 0) {
      const marker = line.slice(0, first).trim();
      const oldLine = line.slice(first + 1, second);
      const newLine = line.slice(second + 1, third);
      const code = line.slice(third + 1);
      return {
        kind: marker === "+" ? "add" : marker === "-" ? "del" : "neutral",
        oldLine,
        newLine,
        marker,
        code
      };
    }
  }
  if (line.startsWith("+ ")) return { kind: "add", oldLine: "", newLine: "", marker: "+", code: line.slice(2) };
  if (line.startsWith("- ")) return { kind: "del", oldLine: "", newLine: "", marker: "-", code: line.slice(2) };
  return { kind: "neutral", oldLine: "", newLine: "", marker: "", code: line };
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
  if (tc.toolName === "read_file" || tc.toolName === "list_dir" || tc.toolName === "write_file") {
    const path = toolPath(tc);
    if (tc.toolName === "write_file" && tc.diffPreview) {
      const stats = diffStats(tc.diffPreview);
      return `${path} +${stats.added} -${stats.removed}`;
    }
    return path;
  }
  if (tc.toolName === "glob") return String(toolArgs(tc).pattern ?? "");
  if (tc.toolName === "run_command") return toolCommand(tc);
  return "";
}

function renderToolCardLabel(tc: ToolCard): string {
  if (tc.toolName === "write_file" && tc.diffPreview) {
    const stats = diffStats(tc.diffPreview);
    return [
      renderToolPathLabel(tc),
      `<span class="diff-stat-group"><span class="diff-stat add">+${stats.added}</span><span class="diff-stat del">-${stats.removed}</span></span>`
    ].join("");
  }
  if (isFilePathTool(tc)) return renderToolPathLabel(tc);
  return `<span class="tool-label-text">${escapeHtml(toolCardLabel(tc))}</span>`;
}

function renderToolApprovalLabel(tc: ToolCard): string {
  if (tc.toolName === "write_file" && tc.diffPreview) {
    const stats = diffStats(tc.diffPreview);
    return `${renderToolPathLabel(tc)} <span class="diff-stat-group"><span class="diff-stat add">+${stats.added}</span><span class="diff-stat del">-${stats.removed}</span></span>`;
  }
  if (isFilePathTool(tc)) return renderToolPathLabel(tc);
  return escapeHtml(toolCardLabel(tc));
}

function renderToolPathLabel(tc: ToolCard): string {
  const filePath = toolPath(tc);
  if (!filePath) return `<span class="tool-label-text"></span>`;
  return `<button class="tool-path-link tool-label-text" type="button" data-open-file="${escapeHtml(filePath)}" data-tip="Open file">${escapeHtml(filePath)}</button>`;
}

function isFilePathTool(tc: ToolCard): boolean {
  return tc.toolName === "read_file" || tc.toolName === "write_file";
}

function toolPath(tc: ToolCard): string {
  const args = toolArgs(tc);
  return String(args.path ?? args.file_path ?? args.filePath ?? args.filename ?? args.file ?? "");
}

function toolCommand(tc: ToolCard): string {
  return String(toolArgs(tc).command ?? "");
}

function toolArgs(tc: ToolCard): Record<string, unknown> {
  try {
    return normalizeToolArgs(JSON.parse(tc.argsJson));
  } catch {
    return normalizeToolArgs(tc.argsJson);
  }
}

function highlightCode(code: string, language: string | undefined): string {
  if (!code) return "";
  if (!language) return escapeHtml(code);
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

function highlightLanguageForPath(filePath: string): string | undefined {
  const name = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
  const map: Record<string, string> = {
    bash: "bash",
    c: "cpp",
    cc: "cpp",
    cjs: "javascript",
    cpp: "cpp",
    cs: "csharp",
    css: "css",
    dockerfile: "dockerfile",
    go: "go",
    h: "cpp",
    hpp: "cpp",
    htm: "xml",
    html: "xml",
    java: "java",
    js: "javascript",
    json: "json",
    jsx: "javascript",
    mjs: "javascript",
    md: "markdown",
    markdown: "markdown",
    php: "php",
    py: "python",
    rb: "ruby",
    rs: "rust",
    sh: "bash",
    sql: "sql",
    ts: "typescript",
    tsx: "typescript",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml"
  };
  return map[ext];
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
    if (line.startsWith("+ ") || line.startsWith("+\t")) added++;
    else if (line.startsWith("- ") || line.startsWith("-\t")) removed++;
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
  msg.fileChanges = recordMessage.fileChanges ?? [];
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
        const currentExpanded = part.userExpanded ?? false;
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
    const copy = target.closest("[data-copy-message]") as HTMLElement | null;
    if (copy) {
      void handleCopyMessage(copy.dataset.copyMessage!);
      return;
    }
    const fileChangesToggle = target.closest("[data-file-changes-toggle]") as HTMLElement | null;
    if (fileChangesToggle) {
      const m = state.messages.find(x => x.id === fileChangesToggle.dataset.fileChangesToggle);
      if (m) {
        m.fileChangesExpanded = !(m.fileChangesExpanded ?? false);
        state.autoScroll = false;
        render();
      }
      return;
    }
    const fileChangeToggle = target.closest("[data-file-change-toggle]") as HTMLElement | null;
    if (fileChangeToggle) {
      const [msgId, key] = fileChangeToggle.dataset.fileChangeToggle!.split("|");
      const m = state.messages.find(x => x.id === msgId);
      if (m) {
        m.expandedFileChanges ??= new Set<string>();
        if (m.expandedFileChanges.has(key)) m.expandedFileChanges.delete(key);
        else m.expandedFileChanges.add(key);
        state.autoScroll = false;
        render();
      }
      return;
    }
    if (target.closest("[data-review-workspace-changes]")) {
      send({ type: "reviewWorkspaceChanges" });
      return;
    }
    if (target.closest("#gear")) send({ type: "openSettings" });
    else if (target.closest("#plus")) send({ type: "newChat" });
    else if (target.closest("#compact")) {
      if (state.compactAvailable) send({ type: "compactNow" });
      else showCompactUnavailable();
    }
    else if (target.closest("#send")) submit();
    else if (target.closest("#planToggle")) send({ type: "togglePlanMode" });
    else if (target.closest("#scrollDown")) {
      state.autoScroll = true;
      render();
    } else {
      const review = target.closest("[data-review-path]") as HTMLElement | null;
      const openFile = target.closest("[data-open-file]") as HTMLElement | null;
      const approve = target.closest("[data-approve]") as HTMLElement | null;
      const reject = target.closest("[data-reject]") as HTMLElement | null;
      const acceptPlan = target.closest("[data-accept-plan]") as HTMLElement | null;
      const rejectPlan = target.closest("[data-reject-plan]") as HTMLElement | null;
      if (openFile) {
        send({ type: "openFile", path: openFile.dataset.openFile! });
      }
      else if (review) {
        send({ type: "reviewFile", path: review.dataset.reviewPath! });
      }
      else if (approve) {
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
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <circle cx="10.5" cy="10.5" r="5.75"/>
    <path d="m15 15 4.5 4.5"/>
  </svg>`;
}

function pencilIcon(): string {
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <path d="M4.5 16.75V20h3.25L18.8 8.95a2.3 2.3 0 0 0 0-3.25l-.5-.5a2.3 2.3 0 0 0-3.25 0L4.5 16.75Z"/>
    <path d="m13.75 6.5 3.75 3.75"/>
    <path d="M4.5 20h4.25"/>
  </svg>`;
}

function terminalIcon(): string {
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <rect x="3.5" y="5" width="17" height="14" rx="3"/>
    <path d="m7.5 9.25 3 2.75-3 2.75"/>
    <path d="M13.5 15h3.5"/>
  </svg>`;
}

function copyIcon(): string {
  return `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <path d="M11 4h6a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3h-1"/>
    <path d="M8 4.2A3 3 0 0 1 10.8 4"/>
    <rect x="4" y="8" width="12" height="12" rx="3"/>
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
      applyCompactStatus(msg.record.messages.length, state.compactMinMessages, msg.record.messages.length >= state.compactMinMessages);
      state.autoScroll = true;
      render();
      break;
    case "chatClosed":
      hiddenApprovalToolIds.clear();
      state.messages = [];
      state.tokens = 0;
      state.busy = false;
      state.autoScroll = true;
      state.compactHintOverride = undefined;
      state.compactNudge = false;
      if (compactNudgeTimer) {
        clearTimeout(compactNudgeTimer);
        compactNudgeTimer = undefined;
      }
      applyCompactStatus(0, state.compactMinMessages, false);
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
    case "fileChanges": {
      const m = getOrCreateMsg(msg.messageId, "assistant");
      m.fileChanges = msg.changes;
      m.fileChangesExpanded = false;
      m.expandedFileChanges = new Set<string>();
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
    case "compactStatus":
      applyCompactStatus(msg.currentMessages, msg.minMessages, msg.available);
      render();
      break;
    case "planModeChanged": state.planMode = msg.on; render(); break;
  }
});

send({ type: "ready" });
render();
