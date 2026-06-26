import MarkdownIt from "markdown-it";
import type { RenderRule } from "markdown-it/lib/renderer.mjs";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import bash from "@shikijs/langs/bash";
import cpp from "@shikijs/langs/cpp";
import csharp from "@shikijs/langs/csharp";
import css from "@shikijs/langs/css";
import diffLang from "@shikijs/langs/diff";
import dockerfile from "@shikijs/langs/dockerfile";
import go from "@shikijs/langs/go";
import html from "@shikijs/langs/html";
import java from "@shikijs/langs/java";
import javascript from "@shikijs/langs/javascript";
import json from "@shikijs/langs/json";
import markdown from "@shikijs/langs/markdown";
import php from "@shikijs/langs/php";
import python from "@shikijs/langs/python";
import ruby from "@shikijs/langs/ruby";
import rust from "@shikijs/langs/rust";
import sql from "@shikijs/langs/sql";
import typescript from "@shikijs/langs/typescript";
import xml from "@shikijs/langs/xml";
import yaml from "@shikijs/langs/yaml";
import darkPlus from "@shikijs/themes/dark-plus";
import lightPlus from "@shikijs/themes/light-plus";
import mdKatex from "@vscode/markdown-it-katex";
import type { ChatToExt, ExtToChat } from "../../messaging.js";
import type { ChatRecord, FileChangeSummary, TodoItem } from "../../../chat/storage.js";
import { restoredRecordMessageId, restoredToolCardId } from "./ids.js";

declare function acquireVsCodeApi(): {
  postMessage(msg: ChatToExt): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();
const md = new MarkdownIt({ html: false, linkify: false, breaks: false }).use(mdKatex);
md.renderer.rules.fence = renderFenceCode;
md.renderer.rules.code_block = renderIndentedCode;
md.renderer.rules.code_inline = renderInlineCode;

interface ToolCard {
  toolId: string;
  toolName: string;
  argsJson: string;
  category: string;
  reason?: string;
  status: "streaming" | "pending" | "approved" | "rejected" | "executed" | "failed";
  resultPreview?: string;
  diffPreview?: string;
  diffRequested?: boolean;
  // Consecutive edits to the same file share a groupId so they collapse into one
  // card; added/removed are the cumulative line stats for that whole run, and
  // groupTools is the edit tools that made it up, in call order.
  groupId?: string;
  added?: number;
  removed?: number;
  groupTools?: string[];
  // When a run of consecutive read_file calls collapses into one "Read N Files"
  // card, this holds the constituent read cards (in call order). Set only on the
  // synthetic group card; absent on a lone read_file card.
  readGroup?: ToolCard[];
  progress?: {
    path?: string;
    contentBytes: number;
    contentLines: number;
  };
  expanded: boolean;
}

type MessagePart =
  | { id: string; kind: "text"; text: string }
  | { id: string; kind: "thought"; text: string; live: boolean; userExpanded?: boolean; startedAt?: number; durationMs?: number }
  | { id: string; kind: "tool"; card: ToolCard; startedAt?: number }
  | { id: string; kind: "summary"; text: string }
  | { id: string; kind: "abort"; reason: string };

interface Message {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  parts: MessagePart[];
  text: string;
  thought: string;
  toolCards: ToolCard[];
  summary?: string;
  isPlan?: boolean;
  planResolved?: "accepted" | "rejected";
  aborted?: string;
  workStartedAt?: number;
  workEndedAt?: number;
  workGroupExpanded?: Map<string, boolean>;
  fileChanges?: FileChangeSummary[];
  fileChangesExpanded?: boolean;
  expandedFileChanges?: Set<string>;
}

type ComposerDecision =
  | { kind: "tool"; tool: ToolCard }
  | { kind: "plan"; message: Message };

interface CompactActivity {
  id: string;
  source: "manual" | "auto";
  status: "pending" | "executed" | "failed";
  beforeTokens: number;
  afterTokens?: number;
  beforeMessages: number;
  afterMessages?: number;
  keepTail: number;
  error?: string;
}

interface State {
  messages: Message[];
  notices: { id: string; text: string }[];
  tokens: number;
  limit: number;
  planMode: boolean;
  autoapproveWrites: boolean;
  autoCompact: boolean;
  autoCompactThresholdPercent: number;
  busy: boolean;
  draft: string;
  chatTitle: string;
  hasChat: boolean;
  renamingTitle: boolean;
  autoScroll: boolean;
  savedScrollTop: number;
  scrollDownOpacity: number;
  pendingPlanRejection: boolean;
  compactAvailable: boolean;
  compactCurrentMessages: number;
  compactMinMessages: number;
  compactNudge: boolean;
  compactMenuOpen: boolean;
  compactHintOverride?: string;
  compactActivity?: CompactActivity;
}

const state: State = {
  messages: [],
  notices: [],
  tokens: 0,
  limit: 32768,
  planMode: false,
  autoapproveWrites: false,
  autoCompact: true,
  autoCompactThresholdPercent: 80,
  busy: false,
  draft: "",
  chatTitle: "Chat",
  hasChat: false,
  renamingTitle: false,
  autoScroll: true,
  savedScrollTop: 0,
  scrollDownOpacity: 1,
  pendingPlanRejection: false,
  compactAvailable: false,
  compactCurrentMessages: 0,
  compactMinMessages: 6,
  compactNudge: false,
  compactMenuOpen: false
};

const SHIKI_THEMES = [darkPlus, lightPlus];
const SHIKI_LANGUAGES = [
  bash,
  cpp,
  csharp,
  css,
  diffLang,
  dockerfile,
  go,
  html,
  java,
  javascript,
  json,
  markdown,
  php,
  python,
  ruby,
  rust,
  sql,
  typescript,
  xml,
  yaml
];

const root = document.getElementById("app")!;
let mounted = false;
let renderQueued = false;
let partSeq = 0;
let renderedBusy: boolean | undefined;
let renderedScrollDown: boolean | undefined;
let tooltipTarget: HTMLElement | undefined;
let copiedMessageId: string | undefined;
let copiedResetTimer: ReturnType<typeof setTimeout> | undefined;
const codeCopyResetTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();
let compactNudgeTimer: ReturnType<typeof setTimeout> | undefined;
let titleAnimTimer: ReturnType<typeof setTimeout> | undefined;
let titleAnimating = false;
const messageEls = new Map<string, HTMLElement>();
const partEls = new Map<string, HTMLElement>();
const noticeEls = new Map<string, HTMLElement>();
const hiddenApprovalToolIds = new Set<string>();
let shikiHighlighter: Awaited<ReturnType<typeof createHighlighterCore>> | undefined;
let shikiStarted = false;
let lastThemeClass = document.body.className;

function nextPartId(kind: MessagePart["kind"]): string {
  partSeq += 1;
  return `p_${kind}_${partSeq}`;
}

function send(msg: ChatToExt): void { vscode.postMessage(msg); }

function startShiki(): void {
  if (shikiStarted) return;
  shikiStarted = true;
  void createHighlighterCore({
    themes: SHIKI_THEMES,
    langs: SHIKI_LANGUAGES,
    engine: createJavaScriptRegexEngine()
  }).then(highlighter => {
    shikiHighlighter = highlighter;
    render();
  }).catch(() => {
    shikiHighlighter = undefined;
  });
}

function watchThemeChanges(): void {
  new MutationObserver(() => {
    if (document.body.className === lastThemeClass) return;
    lastThemeClass = document.body.className;
    render();
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
}

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
  if (kind === "text" && !delta.trim()) {
    if (last?.kind === "text") last.text += delta;
    return;
  }
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

function compactActivityMessageId(activity: Pick<CompactActivity, "id">): string {
  return `compact_msg_${activity.id}`;
}

function compactActivityPartId(activity: Pick<CompactActivity, "id">): string {
  return `compact_part_${activity.id}`;
}

function upsertCompactActivityMessage(activity: CompactActivity): void {
  const partId = compactActivityPartId(activity);

  // Update an existing card in place, wherever it lives (the live turn's
  // timeline or a dedicated message).
  for (const message of state.messages) {
    const existingPart = message.parts.find((part): part is Extract<MessagePart, { kind: "tool" }> =>
      part.kind === "tool" && (part.id === partId || part.card.toolId === activity.id)
    );
    if (!existingPart) continue;
    const expanded = activity.status === "pending" ? false : existingPart.card.expanded;
    const card = compactActivityToolCard(activity, expanded);
    existingPart.card = card;
    const cardIndex = message.toolCards.findIndex(t => t.toolId === activity.id);
    if (cardIndex >= 0) message.toolCards[cardIndex] = card;
    else message.toolCards.push(card);
    return;
  }

  // New activity. Auto-compaction fires mid-turn; attach its card to the live
  // assistant turn so it appears as an item in that timeline rather than as a
  // visually separate message block. Idle (manual) compaction keeps its own
  // dedicated message.
  let message = [...state.messages].reverse().find(m => m.role === "assistant" && isAssistantTurnLive(m));
  if (!message) {
    const messageId = compactActivityMessageId(activity);
    message = state.messages.find(m => m.id === messageId);
    if (!message) {
      message = { id: messageId, role: "assistant", parts: [], text: "", thought: "", toolCards: [] };
      state.messages.push(message);
    }
  }
  const card = compactActivityToolCard(activity, false);
  message.toolCards.push(card);
  message.parts.push({ id: partId, kind: "tool", card, startedAt: Date.now() });
}

function renderFenceCode(tokens: Parameters<RenderRule>[0], idx: number): string {
  const token = tokens[idx];
  const rawLanguage = token.info.trim().split(/\s+/)[0] ?? "";
  return renderCopyableCodeBlock(token.content, normalizeHighlightLanguage(rawLanguage));
}

function renderIndentedCode(tokens: Parameters<RenderRule>[0], idx: number): string {
  return renderCopyableCodeBlock(tokens[idx].content, undefined);
}

function renderInlineCode(tokens: Parameters<RenderRule>[0], idx: number): string {
  const code = escapeHtml(tokens[idx].content);
  return `<code class="inline-code">${code}</code>`;
}

function renderCopyableCodeBlock(code: string, language: string | undefined): string {
  const languageClass = language ? ` language-${escapeHtml(language)}` : "";
  return `<div class="copy-code-block">
    <button class="copy-btn code-copy-btn block-code-copy-btn" type="button" data-copy-code aria-label="Copy code">${copyIcon()}</button>
    <pre><code class="copy-code-source${languageClass}">${highlightCode(code, language)}</code></pre>
  </div>`;
}

function normalizeHighlightLanguage(language: string): string | undefined {
  const raw = language.trim().toLowerCase();
  if (!raw) return undefined;
  const aliases: Record<string, string> = {
    cplusplus: "cpp",
    h: "cpp",
    hpp: "cpp",
    htm: "html",
    html: "html",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    py: "python",
    shell: "bash",
    sh: "bash",
    ts: "typescript",
    tsx: "typescript",
    zsh: "bash"
  };
  return aliases[raw] ?? raw;
}

/**
 * Assign innerHTML only when the template string actually changed since the
 * last assignment. Comparing against el.innerHTML directly never matches for
 * templates containing SVG (the serializer expands self-closing tags), which
 * made every render rebuild children — cancelling in-flight clicks and
 * restarting CSS animations (shimmer, pulse) on every streamed token.
 */
const lastSetHtml = new WeakMap<HTMLElement, string>();
function setHtml(el: HTMLElement, html: string): void {
  if (lastSetHtml.get(el) === html) return;
  lastSetHtml.set(el, html);
  el.innerHTML = html;
}

/**
 * Keep `el` positioned right after `anchor` (or first in `parent`) without
 * touching nodes already in place. appendChild on an existing child MOVES it,
 * which cancels an in-flight click on the node and restarts its animations;
 * during streaming that happened every frame for every message and part.
 */
function placeAfter(parent: HTMLElement, el: HTMLElement, anchor: HTMLElement | null): void {
  if (el.parentElement === parent && el.previousElementSibling === anchor) return;
  parent.insertBefore(el, anchor ? anchor.nextSibling : parent.firstChild);
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
  updateHeaderTitle();
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
      <div class="chat-title-wrap" id="chatTitleWrap">
        <span id="chatTitle" class="chat-title"></span>
        <span id="titleField" class="title-field" data-value=""><input id="chatTitleInput" class="chat-title-input" type="text" size="1" /></span>
        <button id="renameChat" class="icon-btn title-edit" aria-label="Rename chat" tabindex="-1">${pencilIcon()}</button>
      </div>
      <span id="titleHint" class="title-hint" aria-hidden="true"></span>
      <div class="header-actions">
        <span id="headerHint" class="header-action-hint" aria-hidden="true"></span>
        <button id="plus" class="icon-btn header-action" aria-label="Start new chat" data-header-hint="Start new chat">${plusIcon()}</button>
        <button id="chats" class="icon-btn header-action" aria-label="Open recent chats" data-header-hint="Open recent chats">${historyIcon()}</button>
        <button id="gear" class="icon-btn header-action" aria-label="Open settings" data-header-hint="Open settings">${settingsIcon()}</button>
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
        <button id="planToggle" class="mode-pill" aria-label="Toggle plan mode">${scrollIcon()}<span>Plan mode</span></button>
        <span id="planHint" class="inline-hint plan-hint">Toggle read-only planning</span>
        <span class="compact-group">
          <span id="compactHint" class="inline-hint compact-hint"></span>
          <button id="compact" class="ctx-pill" type="button" aria-label="Compact context">
            <span id="ctxIcon"></span><span id="ctxPct"></span>
          </button>
          <div id="compactMenu" class="compact-menu" role="menu" hidden>
            <p>Agent is currently active.</p>
            <button type="button" data-compact-action="interrupt">Interrupt chat and compact</button>
            <button type="button" data-compact-action="wait">Wait for the agent to respond</button>
          </div>
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
    setHtml(el, html);
  }
}

/**
 * Render todo items as checklist rows for an `update_todos` timeline card.
 * Styling keys off the status class: pending (empty box), in_progress
 * (highlighted row + box), completed (crossed box, dimmed text).
 */
function renderTodoRows(todos: TodoItem[]): string {
  return todos
    .map(t => `<li class="todo-item ${t.status}"><span class="todo-box" aria-hidden="true"></span><span class="todo-text">${escapeHtml(t.content)}</span></li>`)
    .join("");
}

/** Parse a tool card's `update_todos` arguments into todo items (lenient). */
function todosFromCard(tc: ToolCard): TodoItem[] {
  const raw = toolArgs(tc).todos;
  if (!Array.isArray(raw)) return [];
  const out: TodoItem[] = [];
  for (const it of raw) {
    if (typeof it === "string") {
      const content = it.trim();
      if (content) out.push({ content, status: "pending" });
      continue;
    }
    if (!it || typeof it !== "object") continue;
    const rec = it as Record<string, unknown>;
    const content = String(rec.content ?? rec.text ?? rec.title ?? "").trim();
    if (!content) continue;
    const s = String(rec.status ?? "").toLowerCase();
    const status: TodoItem["status"] = s === "completed" ? "completed" : s === "in_progress" ? "in_progress" : "pending";
    out.push({ content, status });
  }
  return out;
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
  let anchor: HTMLElement | null = null;
  for (const m of state.messages) {
    let el = messageEls.get(m.id);
    if (!el) {
      el = document.createElement("div");
      el.dataset.messageId = m.id;
      messageEls.set(m.id, el);
      host.appendChild(el);
    }
    const hasFileChanges = m.role !== "user" && (m.fileChanges?.length ?? 0) > 0;
    const cls = m.role === "user"
      ? "msg user"
      : [
        "msg",
        "assistant",
        hasFileChanges ? "has-file-changes" : "",
        messageUsesTimeline(m) ? "timeline" : ""
      ].filter(Boolean).join(" ");
    if (el.className !== cls) el.className = cls;
    if (m.role === "user") renderUserMessage(el, m);
    else reconcileAssistantParts(el, m);
    placeAfter(host, el, anchor);
    anchor = el;
  }
}

function renderUserMessage(el: HTMLElement, m: Message): void {
  const html = `<div class="bubble">${md.render(m.text)}</div>${renderMessageActionsHtml(m)}`;
  setHtml(el, html);
}

function renderMessageActions(parent: HTMLElement, m: Message): void {
  let actions = directChild(parent, "message-actions");
  const inner = renderMessageActionsInnerHtml(m);
  if (!inner) {
    actions?.remove();
    return;
  }
  if (!actions) {
    actions = document.createElement("div");
    actions.className = "message-actions";
    parent.appendChild(actions);
  }
  if (actions.dataset.messageActions !== m.id) actions.dataset.messageActions = m.id;
  setHtml(actions, inner);
}

function renderMessageActionsHtml(m: Message): string {
  const inner = renderMessageActionsInnerHtml(m);
  if (!inner) return "";
  return `<div class="message-actions" data-message-actions="${m.id}">${inner}</div>`;
}

function renderMessageActionsInnerHtml(m: Message): string {
  if (m.role === "assistant" && isAssistantTurnLive(m)) return "";
  if (!copyableMessageText(m).trim()) return "";
  const copied = copiedMessageId === m.id;
  const cls = `copy-btn${copied ? " copied" : ""}`;
  const label = copied ? "Copied" : "Copy message";
  return `<button class="${cls}" type="button" data-copy-message="${m.id}" aria-label="${label}">
      ${copyIcon()}
    </button>
    <span class="copy-inline-hint${copied ? " copied" : ""}">${label}</span>`;
}

function renderFileChangeSummary(parent: HTMLElement, m: Message): void {
  let summary = directChild(parent, "change-summary");
  const changes = m.fileChanges ?? [];
  if (changes.length === 0) {
    summary?.remove();
    return;
  }
  if (!summary) {
    summary = document.createElement("div");
    parent.appendChild(summary);
  }
  const expanded = m.fileChangesExpanded ?? false;
  const cls = `change-summary${expanded ? " open" : ""}`;
  if (summary.className !== cls) summary.className = cls;
  if (summary.dataset.changeSummary !== m.id) summary.dataset.changeSummary = m.id;
  const totals = totalFileChangeStats(changes);
  setHtml(summary, `<div class="change-summary-head">
      <button class="change-summary-toggle" type="button" data-file-changes-toggle="${m.id}" aria-expanded="${expanded}">
        ${chevronIcon()}
        <span class="change-summary-main">
          <span class="change-summary-title">Edited ${changes.length} file${changes.length === 1 ? "" : "s"}</span>
          <span class="diff-stat-group"><span class="diff-stat add">+${totals.added}</span><span class="diff-stat del">-${totals.removed}</span></span>
        </span>
      </button>
      <button class="review-btn change-review-btn" type="button" data-review-workspace-changes>Review</button>
    </div>
    ${expanded ? `<div class="change-file-list">${changes.map((change, index) => renderFileChangeRow(m, change, index)).join("")}</div>` : ""}`);
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

interface ResolvedUnit {
  kind: "work" | "inline";
  groupId?: string;
  parts: MessagePart[];
  expanded: boolean;
}

/**
 * Split an assistant message's parts into chronological render units. While
 * the turn is live every part renders flat, in order — tool cards, thinking
 * rows, and intermediate answers appear as they stream. Once the turn settles,
 * everything before the final answer collapses into one "Worked for N
 * seconds" group, and the final answer (plus any trailing parts) renders
 * inline after it.
 */
function resolveRenderUnits(m: Message): ResolvedUnit[] {
  const turnLive = isAssistantTurnLive(m);
  const parts = m.parts.filter(part => !isBlankTextPart(part));
  if (!turnLive && parts.some(isWorkPart)) return resolveSettledRenderUnits(m, parts);
  return resolveLiveRenderUnits(parts);
}

function resolveLiveRenderUnits(parts: MessagePart[]): ResolvedUnit[] {
  return collapseReadGroups(collapseWriteGroups(parts)).map(part => ({
    kind: "inline" as const,
    parts: [part],
    expanded: false
  }));
}

function resolveSettledRenderUnits(m: Message, parts: MessagePart[]): ResolvedUnit[] {
  const units: ResolvedUnit[] = [];
  const finalIndex = lastFinalAnswerIndex(parts);
  const workedParts = finalIndex > 0 ? parts.slice(0, finalIndex) : finalIndex === -1 ? parts : [];
  if (workedParts.length > 0) {
    const groupId = `${m.id}:worked`;
    units.push({
      kind: "work",
      groupId,
      parts: workedParts,
      expanded: m.workGroupExpanded?.get(groupId) ?? false
    });
  }
  if (finalIndex >= 0) {
    units.push({ kind: "inline", parts: [parts[finalIndex]], expanded: false });
    for (const part of parts.slice(finalIndex + 1)) {
      units.push({ kind: "inline", parts: [part], expanded: false });
    }
  }
  return units;
}

function lastFinalAnswerIndex(parts: MessagePart[]): number {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part.kind === "text" && part.text.trim()) return i;
  }
  return -1;
}

function reconcileAssistantParts(el: HTMLElement, m: Message): void {
  const units = resolveRenderUnits(m);
  const wantedWorkIds = new Set<string>();
  const wantedPartIds = new Set<string>();
  for (const u of units) {
    if (u.kind === "work") wantedWorkIds.add(u.groupId!);
    else wantedPartIds.add(u.parts[0].id);
  }
  for (const child of Array.from(el.children) as HTMLElement[]) {
    const partId = child.dataset.partId;
    const workId = child.dataset.workId;
    const actionId = child.dataset.messageActions;
    const changeSummaryId = child.dataset.changeSummary;
    if (workId && !wantedWorkIds.has(workId)) {
      removeWorkElement(child);
    } else if (partId && !wantedPartIds.has(partId)) {
      child.remove();
      partEls.delete(partId);
    } else if (!partId && !workId && !actionId && !changeSummaryId) {
      child.remove();
    }
  }
  let anchor: HTMLElement | null = null;
  for (const u of units) {
    if (u.kind === "work") {
      const workEl = ensureWorkElement(el, u.groupId!);
      renderWorkSection(workEl, m.id, u);
      placeAfter(el, workEl, anchor);
      anchor = workEl;
    } else {
      const part = u.parts[0];
      let partEl = partEls.get(part.id);
      if (!partEl) {
        partEl = document.createElement("div");
        partEl.dataset.partId = part.id;
        partEls.set(part.id, partEl);
        el.appendChild(partEl);
      }
      renderPartInto(partEl, m.id, part, textPresentationForUnit(m, units, u));
      placeAfter(el, partEl, anchor);
      anchor = partEl;
    }
  }
  renderFileChangeSummary(el, m);
  renderMessageActions(el, m);
}

function removeWorkElement(el: HTMLElement): void {
  for (const inner of Array.from(el.querySelectorAll("[data-part-id]")) as HTMLElement[]) {
    if (inner.dataset.partId) partEls.delete(inner.dataset.partId);
  }
  el.remove();
}

function ensureWorkElement(parent: HTMLElement, groupId: string): HTMLElement {
  const selector = `[data-work-id="${CSS.escape(groupId)}"]`;
  let el = parent.querySelector(selector) as HTMLElement | null;
  if (!el) {
    el = document.createElement("div");
    el.dataset.workId = groupId;
    parent.appendChild(el);
  }
  return el;
}

function isWorkPart(part: MessagePart): part is Extract<MessagePart, { kind: "thought" | "tool" }> {
  return part.kind === "thought" || (part.kind === "tool" && part.card.toolName !== "compact_context");
}

function messageUsesTimeline(m: Message): boolean {
  return m.workStartedAt !== undefined || m.parts.some(isWorkPart);
}

function isAssistantTurnLive(m: Message): boolean {
  return m.workEndedAt === undefined && m.workStartedAt !== undefined;
}

function isBlankTextPart(part: MessagePart): part is Extract<MessagePart, { kind: "text" }> {
  return part.kind === "text" && !part.text.trim();
}

function renderWorkHead(el: HTMLElement, group: ResolvedUnit): void {
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

  head.dataset.workToggle = group.groupId;
  let title = head.querySelector(".work-title") as HTMLElement | null;
  if (!title) {
    title = document.createElement("span");
    title.className = "work-title";
    head.appendChild(title);
  }
  const titleText = formatWorkedLabel(groupDurationMs(group.parts));
  if (title.className !== "work-title") title.className = "work-title";
  if (title.textContent !== titleText) title.textContent = titleText;
}

/**
 * Collapse a run of consecutive edits to the same file into one card. Such
 * edits share a server-assigned groupId; only the most recent card is kept (it
 * carries the cumulative line stats and the combined original→latest diff), so
 * the run reads as a single Edit File card. Parts without a groupId (pending or
 * streaming edits, reads, thoughts) are always kept.
 */
function collapseWriteGroups(parts: MessagePart[]): MessagePart[] {
  const members = new Map<string, Extract<MessagePart, { kind: "tool" }>[]>();
  for (const part of parts) {
    if (part.kind === "tool" && part.card.groupId) {
      const list = members.get(part.card.groupId) ?? [];
      list.push(part);
      members.set(part.card.groupId, list);
    }
  }
  return parts.filter(part => {
    if (part.kind !== "tool" || !part.card.groupId) return true;
    const group = members.get(part.card.groupId)!;
    const survivor = group[group.length - 1];
    if (part !== survivor) return false;
    // Record the constituent edit tools, in call order, on the surviving card so
    // it can show "write_file › replace_range › …" for a multi-step file edit.
    part.card.groupTools = group.map(p => p.card.toolName);
    return true;
  });
}

/**
 * Collapse a run of two or more consecutive read_file calls into a single
 * "Read N Files" card. The collapsed card reuses the first read's part id and
 * toolId so the timeline element stays stable as more reads stream in and so
 * its expanded state toggles through the existing tool-toggle handler (which
 * looks the toolId up in m.toolCards). A lone read_file is left untouched.
 */
function collapseReadGroups(parts: MessagePart[]): MessagePart[] {
  const result: MessagePart[] = [];
  for (let i = 0; i < parts.length; ) {
    const part = parts[i];
    if (part.kind === "tool" && part.card.toolName === "read_file") {
      const run: Extract<MessagePart, { kind: "tool" }>[] = [];
      let j = i;
      while (j < parts.length) {
        const p = parts[j];
        if (p.kind === "tool" && p.card.toolName === "read_file") { run.push(p); j++; }
        else break;
      }
      result.push(run.length >= 2 ? makeReadGroupPart(run) : part);
      i = j;
      continue;
    }
    result.push(part);
    i++;
  }
  return result;
}

function makeReadGroupPart(run: Extract<MessagePart, { kind: "tool" }>[]): MessagePart {
  const anchor = run[0];
  const card: ToolCard = {
    ...anchor.card,
    readGroup: run.map(p => p.card),
    expanded: anchor.card.expanded
  };
  return { ...anchor, card };
}

function isReadGroupCard(tc: ToolCard): boolean {
  return Array.isArray(tc.readGroup) && tc.readGroup.length >= 2;
}

function renderWorkSection(el: HTMLElement, msgId: string, group: ResolvedUnit): void {
  const { parts, expanded } = group;
  const cls = [
    "work-section",
    expanded ? "open" : "",
    parts.length > 0 ? "has-items" : ""
  ].filter(Boolean).join(" ");
  if (el.className !== cls) el.className = cls;
  renderWorkHead(el, group);
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
  const renderParts = collapseReadGroups(collapseWriteGroups(parts));
  const wanted = new Set(renderParts.map(p => p.id));
  for (const child of Array.from(body.children) as HTMLElement[]) {
    const id = child.dataset.partId;
    if (!id || !wanted.has(id)) {
      child.remove();
      if (id) partEls.delete(id);
    }
  }
  let anchor: HTMLElement | null = null;
  for (const part of renderParts) {
    let partEl = partEls.get(part.id);
    if (!partEl) {
      partEl = document.createElement("div");
      partEl.dataset.partId = part.id;
      partEls.set(part.id, partEl);
      body.appendChild(partEl);
    }
    renderPartInto(partEl, msgId, part);
    placeAfter(body, partEl, anchor);
    anchor = partEl;
  }
}

/** Span of a work group from the earliest to latest timestamp of its parts. */
function groupDurationMs(parts: MessagePart[]): number | undefined {
  let minStart = Infinity;
  let maxEnd = -Infinity;
  for (const part of parts) {
    if (part.kind === "thought" && part.startedAt !== undefined) {
      minStart = Math.min(minStart, part.startedAt);
      maxEnd = Math.max(maxEnd, part.startedAt + (part.durationMs ?? 0));
    } else if (part.kind === "tool" && part.startedAt !== undefined) {
      minStart = Math.min(minStart, part.startedAt);
      maxEnd = Math.max(maxEnd, part.startedAt);
    }
  }
  if (minStart === Infinity) return undefined;
  const duration = maxEnd - minStart;
  return duration >= 1000 ? duration : undefined;
}

function formatWorkedLabel(durationMs: number | undefined): string {
  if (durationMs === undefined) return "Worked";
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 150) return `Worked for ${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `Worked for ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function textPresentationForUnit(
  m: Message,
  units: ResolvedUnit[],
  unit: ResolvedUnit
): "inline" | "answer" {
  const part = unit.parts[0];
  if (part?.kind !== "text") return "inline";
  // While the turn is live, every text run streams as a dot timeline item —
  // mid-turn we cannot know whether it is the final answer (a tool call may
  // still follow), and a gray bubble that later demotes into a dot item reads
  // worse than promoting the real final answer to a bubble once the turn
  // settles.
  if (isAssistantTurnLive(m)) return "inline";
  // Settled (or work-free): the trailing text run is the final answer and
  // renders in a bubble; any text run followed by more work is an
  // intermediate answer between tool calls.
  const index = units.indexOf(unit);
  const hasLaterWork = units.slice(index + 1).some(u => u.kind === "work" || u.parts.some(isWorkPart));
  return hasLaterWork ? "inline" : "answer";
}

function renderPartInto(
  el: HTMLElement,
  msgId: string,
  part: MessagePart,
  textPresentation: "inline" | "answer" = "inline"
): void {
  let cls = "";
  let html = "";
  if (part.kind === "thought") {
    if (el.className !== "part thought-part") el.className = "part thought-part";
    renderThoughtPart(el, msgId, part);
    return;
  } else if (part.kind === "text") {
    // Intermediate answers are timeline items like tool cards and thinking
    // rows, but they are not collapsible: a small dot marks them instead of a
    // disclosure chevron.
    cls = `part text-part${textPresentation === "answer" ? " final-answer-part" : " intermediate-part"}`;
    html = textPresentation === "answer"
      ? `<div class="card answer bubble">${md.render(part.text)}</div>`
      : `<div class="intermediate-answer"><span class="intermediate-dot" aria-hidden="true"></span><div class="assistant-markdown">${md.render(part.text)}</div></div>`;
  } else if (part.kind === "tool") {
    if (el.className !== "part tool-part") el.className = "part tool-part";
    renderToolPart(el, part.card);
    return;
  } else if (part.kind === "summary") {
    cls = "part summary-part";
    html = `<div class="card summary">${md.render(part.text)}</div>`;
  } else {
    cls = "part abort-part";
    html = `<div class="card answer bubble abort">${escapeHtml(part.reason)}</div>`;
  }
  if (el.className !== cls) el.className = cls;
  setHtml(el, html);
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
    thinking.innerHTML = `<div class="thinking-head">${chevronIcon()}<span class="thinking-icon" aria-hidden="true">${brainIcon()}</span><span class="thinking-label"></span></div>`;
    el.appendChild(thinking);
  }

  const expanded = part.userExpanded ?? false;
  const cls = `thinking${expanded ? " open" : ""}${part.live ? " live" : ""}`;
  if (thinking.className !== cls) thinking.className = cls;
  delete thinking.dataset.thoughtToggle;

  let head = directChild(thinking, "thinking-head");
  if (!head) {
    head = document.createElement("div");
    head.className = "thinking-head";
    head.innerHTML = `${chevronIcon()}<span class="thinking-icon" aria-hidden="true">${brainIcon()}</span><span class="thinking-label"></span>`;
    thinking.insertBefore(head, thinking.firstChild);
  } else if (head !== thinking.firstElementChild) {
    thinking.insertBefore(head, thinking.firstChild);
  }
  ensureDisclosureIcon(head);
  ensureThinkingIcon(head);
  head.dataset.thoughtToggle = `${msgId}|${part.id}`;

  let label = head.querySelector(".thinking-label") as HTMLElement | null;
  if (!label) {
    label = head.querySelector("span") as HTMLElement | null;
    if (!label) {
      label = document.createElement("span");
      head.appendChild(label);
    }
    label.classList.add("thinking-label");
  }
  // Only the leading word ("Thought"/"Thinking…") carries the bold tool-name
  // font; the "for X seconds" suffix is normal body text. The live shimmer rides
  // the lead word (the suffix only exists once the thought has settled).
  const { lead, rest } = thoughtLabelParts(part);
  const leadClass = part.live ? "thinking-lead shimmer" : "thinking-lead";
  const labelHtml = `<span class="${leadClass}">${escapeHtml(lead)}</span>`
    + (rest ? `<span class="thinking-rest">${escapeHtml(rest)}</span>` : "");
  if (label.hasAttribute("style")) label.removeAttribute("style");
  if (label.className !== "thinking-label") label.className = "thinking-label";
  setHtml(label, labelHtml);

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
  setHtml(body, bodyHtml);
}

function thoughtLabelParts(part: Extract<MessagePart, { kind: "thought" }>): { lead: string; rest: string } {
  if (part.live) return { lead: "Thinking…", rest: "" };
  if (part.durationMs !== undefined) {
    const secs = Math.max(1, Math.round(part.durationMs / 1000));
    return { lead: "Thought", rest: ` for ${secs} second${secs === 1 ? "" : "s"}` };
  }
  return { lead: "Thought", rest: "" };
}

function copyableMessageText(m: Message): string {
  if (m.role === "user") return m.text;
  const visible = m.parts
    .map(part => {
      if (part.kind === "text") return part.text;
      if (part.kind === "summary") return part.text;
      if (part.kind === "abort") return part.reason;
      return "";
    })
    .filter(text => text.trim());
  if (visible.length > 0) return visible.join("\n\n");
  return m.text;
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

async function handleCopyCode(button: HTMLElement): Promise<void> {
  const wrapper = button.closest(".copy-code-block");
  const source = wrapper?.querySelector(".copy-code-source") as HTMLElement | null;
  const text = source?.textContent ?? "";
  if (!text.trim()) return;
  try {
    await copyTextToClipboard(text);
    markCodeCopyButtonCopied(button);
  } catch {
    state.notices.push({ id: `n_${Date.now()}`, text: "Could not copy code to clipboard." });
    render();
  }
}

function markCodeCopyButtonCopied(button: HTMLElement): void {
  const previousTimer = codeCopyResetTimers.get(button);
  if (previousTimer) clearTimeout(previousTimer);
  button.classList.add("copied");
  button.setAttribute("aria-label", "Copied");
  const timer = setTimeout(() => {
    button.classList.remove("copied");
    button.setAttribute("aria-label", "Copy code");
    codeCopyResetTimers.delete(button);
  }, 1500);
  codeCopyResetTimers.set(button, timer);
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
  if (!tc.expanded || !isExpandableTool(tc)) {
    expanded?.remove();
    return;
  }
  if (!expanded) {
    expanded = document.createElement("div");
    expanded.className = "tool-expanded";
    card.appendChild(expanded);
  }
  const html = renderToolExpandedHtml(tc);
  setHtml(expanded, html);
}

function renderToolHead(card: HTMLElement, tc: ToolCard): void {
  const expandable = isExpandableTool(tc);
  let head = directChild(card, "tool-head");
  if (!head) {
    head = document.createElement("div");
    head.className = "tool-head";
    head.innerHTML = `<span class="tool-icon" aria-hidden="true"></span><strong class="tool-name"></strong><span class="tool-label"></span>`;
    card.insertBefore(head, card.firstChild);
  } else if (head !== card.firstElementChild) {
    card.insertBefore(head, card.firstChild);
  }
  ensureToolMarker(head, expandable);
  if (expandable) head.dataset.toolToggle = tc.toolId;
  else delete head.dataset.toolToggle;

  let icon = directChild(head, "tool-icon");
  if (!icon) {
    icon = document.createElement("span");
    icon.className = "tool-icon";
    icon.setAttribute("aria-hidden", "true");
    head.appendChild(icon);
  }
  const iconHtml = toolIcon(tc);
  setHtml(icon, iconHtml);

  let name = head.querySelector(".tool-name") as HTMLElement | null;
  if (!name) {
    name = head.querySelector("strong") as HTMLElement | null;
    if (!name) {
      name = document.createElement("strong");
      head.appendChild(name);
    }
    name.className = "tool-name";
  }
  const displayName = toolCardHeadName(tc);
  const nameClass = toolNameClass(tc);
  if (name.className !== nameClass) name.className = nameClass;
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
  setHtml(label, labelHtml);

  let badge = directChild(head, "badge");
  if (!shouldShowBadge(tc)) {
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

function shouldShowBadge(tc: ToolCard): boolean {
  if (tc.status === "pending" || tc.toolName === "compact_context") return false;
  // The "Read N Files" group is a summary, not a single call — no status badge.
  if (isReadGroupCard(tc)) return false;
  // Todo cards stay clean — icon · "Update Todos" · (done/total) — no badge.
  if (tc.toolName === "update_todos") return false;
  // Edit File cards stay clean — icon · name · path · +/- — so only surface a
  // status badge when an edit actually failed or was rejected.
  if (isWriteToolCard(tc)) return tc.status === "failed" || tc.status === "rejected";
  return true;
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

/** The brain glyph that sits between the chevron and the "Thinking…" label. */
function ensureThinkingIcon(head: HTMLElement): void {
  if (head.querySelector(".thinking-icon")) return;
  const icon = document.createElement("span");
  icon.className = "thinking-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = brainIcon();
  const label = head.querySelector(".thinking-label");
  if (label) head.insertBefore(icon, label);
  else head.appendChild(icon);
}

/**
 * Keep a tool head's leading marker in sync with whether the card is
 * expandable: a disclosure chevron when it is, a static dot (matching the
 * intermediate-answer dot) when it isn't. Removes the stale marker so updates
 * don't leave both behind.
 */
function ensureToolMarker(head: HTMLElement, expandable: boolean): void {
  const chevron = head.querySelector(":scope > .disclosure-icon");
  const dot = directChild(head, "tool-dot");
  if (expandable) {
    dot?.remove();
    if (!chevron) head.insertAdjacentHTML("afterbegin", chevronIcon());
  } else {
    chevron?.remove();
    if (!dot) head.insertAdjacentHTML("afterbegin", `<span class="tool-dot" aria-hidden="true"></span>`);
  }
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
    setHtml(approvalSlot, html);
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
    if (m.isPlan && !m.planResolved && !state.busy) {
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
  const dangerAt = state.autoCompact ? 0.9 : state.autoCompactThresholdPercent / 100;
  const pctClass = ratio >= dangerAt ? "danger" : "ok";
  const compact = root.querySelector("#compact") as HTMLElement | null;
  compact?.classList.toggle("danger", pctClass === "danger");
  compact?.classList.toggle("ok", pctClass === "ok");
  compact?.classList.toggle("nudge", state.compactNudge);
  compact?.classList.toggle("active-menu", state.compactMenuOpen);
  compact?.setAttribute("aria-disabled", String(!state.compactAvailable));
  compact?.setAttribute("aria-expanded", String(state.compactMenuOpen));
  const hint = root.querySelector("#compactHint") as HTMLElement | null;
  if (hint) {
    hint.textContent = state.compactHintOverride ?? `Context: ${state.tokens} / ${state.limit} tokens. Click to compact.`;
    hint.classList.toggle("active", !!state.compactHintOverride);
  }
  const menu = root.querySelector("#compactMenu") as HTMLElement | null;
  if (menu) menu.hidden = !state.compactMenuOpen;
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
  if (!available) state.compactMenuOpen = false;
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
  const expandable = isExpandableTool(tc);
  const expanded = expandable && tc.expanded ? renderToolExpandedHtml(tc) : "";
  const statusBadge = shouldShowBadge(tc) ? `<span class="badge ${tc.status}">${tc.status}</span>` : "";
  // A read_file card carries no useful expansion, so it shows a static dot
  // where other cards show the disclosure chevron and is not togglable.
  const marker = expandable ? chevronIcon() : `<span class="tool-dot" aria-hidden="true"></span>`;
  const toggleAttr = expandable ? ` data-tool-toggle="${tc.toolId}"` : "";
  return `<div class="${cls}" data-tool-card="${tc.toolId}">
    <div class="tool-head"${toggleAttr}>
      ${marker}
      <span class="tool-icon" aria-hidden="true">${toolIcon(tc)}</span>
      <strong class="${toolNameClass(tc)}">${escapeHtml(toolCardHeadName(tc))}</strong>
      <span class="${labelClass}">${commandLabel}</span>
      ${statusBadge}
    </div>
    ${expandable && tc.expanded ? `<div class="tool-expanded">${expanded}</div>` : ""}
  </div>`;
}

/**
 * A lone read_file card is not expandable (a dot replaces the chevron). A
 * collapsed "Read N Files" group is expandable — it lists its files.
 */
function isExpandableTool(tc: ToolCard): boolean {
  return tc.toolName !== "read_file" || isReadGroupCard(tc);
}

function toolCardClass(tc: ToolCard): string {
  return "tool-card " + tc.category + " " + tc.status + (tc.expanded ? " open" : "");
}

function toolNameClass(tc: ToolCard): string {
  const active = tc.status === "streaming" || tc.status === "pending" || tc.status === "approved";
  const shimmering =
    (tc.toolName === "compact_context" && tc.status === "pending") ||
    (isWriteToolCard(tc) && active);
  return "tool-name" + (shimmering ? " shimmer" : "");
}

function toolLabelClass(tc: ToolCard): string {
  return "tool-label" + (isWriteToolCard(tc) && writeStats(tc) ? " edit-label" : "");
}

/**
 * Render a list_dir / glob result as a plain vertical stack of names so the
 * user can see exactly what the model received. list_dir rows carry a dir/file
 * icon (directories first, then alphabetical); glob rows are bare names.
 * Returns "" if the stored result isn't a parseable array.
 */
function renderFileListHtml(tc: ToolCard): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(tc.resultPreview ?? "");
  } catch {
    return "";
  }
  if (!Array.isArray(parsed)) return "";

  if (tc.toolName === "list_dir") {
    if (parsed.length === 0) return `<div class="tool-filelist tool-filelist-empty">empty directory</div>`;
    const entries = (parsed as { name?: unknown; type?: unknown }[])
      .map(e => ({ name: String(e?.name ?? ""), isDir: e?.type === "dir" }))
      .filter(e => e.name)
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    const rows = entries
      .map(e => `<li class="tool-filelist-item"><span class="tool-filelist-icon" aria-hidden="true">${e.isDir ? dirIcon() : fileIcon()}</span><span class="tool-filelist-name">${escapeHtml(e.name)}</span></li>`)
      .join("");
    return `<ul class="tool-filelist">${rows}</ul>`;
  }

  // glob: bare names, no icons.
  if (parsed.length === 0) return `<div class="tool-filelist tool-filelist-empty">no matches</div>`;
  const rows = (parsed as unknown[])
    .map(p => String(p ?? ""))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .map(name => `<li class="tool-filelist-item"><span class="tool-filelist-name">${escapeHtml(name)}</span></li>`)
    .join("");
  return `<ul class="tool-filelist">${rows}</ul>`;
}

/**
 * The expanded body of a "Read N Files" group: one clickable row per file,
 * styled like the list_dir / glob file lists, with the read line range (if any)
 * trailing each path.
 */
function renderReadGroupHtml(tc: ToolCard): string {
  const rows = (tc.readGroup ?? []).map(card => {
    const path = toolPath(card);
    const name = path
      ? `<button class="tool-path-link tool-filelist-name" type="button" data-open-file="${escapeHtml(path)}">${escapeHtml(path)}</button>`
      : `<span class="tool-filelist-name">(unknown file)</span>`;
    return `<li class="tool-filelist-item"><span class="tool-filelist-icon" aria-hidden="true">${fileIcon()}</span>${name}${readRangeHtml(card)}</li>`;
  }).join("");
  return `<ul class="tool-filelist">${rows}</ul>`;
}

function renderToolExpandedHtml(tc: ToolCard): string {
  if (isReadGroupCard(tc)) return renderReadGroupHtml(tc);
  if (tc.toolName === "update_todos") {
    const todos = todosFromCard(tc);
    if (todos.length === 0) {
      return tc.resultPreview ? `<pre class="tool-result">${escapeHtml(tc.resultPreview)}</pre>` : "";
    }
    return `<ul class="todo-list todo-list-timeline">${renderTodoRows(todos)}</ul>`;
  }
  if (tc.toolName === "list_dir" || tc.toolName === "glob") {
    const list = renderFileListHtml(tc);
    if (list) return list;
    // Fall through to the raw preview if the result didn't parse.
  }
  const command = isCommandTool(tc) ? toolCommand(tc) : "";
  const commandBlock = command
    ? `<div class="tool-output-label">Command:</div>${renderCopyableCodeBlock(command, "bash")}`
    : "";
  const resultIsError = tc.status === "failed" || tc.status === "rejected";
  // A successful file edit already shows the full diff, so its "Out: wrote N
  // bytes" preview is redundant — drop it (but keep error output).
  const hideWriteOut = isWriteToolCard(tc) && !resultIsError;
  const result = tc.resultPreview && !hideWriteOut
    ? resultIsError
      ? `<div class="tool-output-label">Error:</div><div class="card answer bubble abort tool-error-result">${escapeHtml(tc.resultPreview)}</div>`
      : `<div class="tool-output-label">Out:</div><pre class="tool-result">${escapeHtml(tc.resultPreview)}</pre>`
    : "";
  const diff = isWriteToolCard(tc)
    ? renderWriteExpandedState(tc)
    : "";
  return `${commandBlock}${diff}${result}`;
}

function renderWriteExpandedState(tc: ToolCard): string {
  const steps = renderEditStepsHtml(tc);
  if (tc.diffPreview) return steps + renderChangeCard(tc);
  if (tc.status === "failed" || tc.status === "rejected") return steps;
  const path = toolPath(tc);
  const title = tc.status === "executed"
    ? "Preparing diff"
    : tc.status === "pending"
      ? "Edit pending"
    : tc.toolName === "write_file"
      ? "Writing file"
    : "Editing file";
  const details = tc.progress
    ? `${formatCount(tc.progress.contentLines, "line")} / ${formatBytes(tc.progress.contentBytes)}`
    : path || "File edit";
  return steps + `<div class="tool-write-note">
    <div class="tool-write-note-title">${escapeHtml(title)}</div>
    <div class="tool-write-note-detail">${escapeHtml(details)}</div>
  </div>`;
}

/**
 * For a merged multi-step file edit, the constituent edit tools in call order,
 * e.g. "Edits  write_file › replace_range › insert_text". Hidden for a single
 * edit, where the tool name adds nothing beyond the "Edit File" header.
 */
function renderEditStepsHtml(tc: ToolCard): string {
  const tools = tc.groupTools;
  if (!tools || tools.length < 2) return "";
  const items = tools
    .map(name => `<span class="edit-step">${escapeHtml(name)}</span>`)
    .join(`<span class="edit-step-sep" aria-hidden="true">›</span>`);
  return `<div class="edit-steps"><span class="edit-steps-label">Edits</span>${items}</div>`;
}

function formatCount(value: number, unit: string): string {
  return `${value.toLocaleString()} ${unit}${value === 1 ? "" : "s"}`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function compactActivityToolCard(activity: CompactActivity, expanded: boolean): ToolCard {
  return {
    toolId: activity.id,
    toolName: "compact_context",
    argsJson: "{}",
    category: "compact",
    status: activity.status,
    resultPreview: activity.status === "pending" ? undefined : compactActivityOutput(activity),
    expanded
  };
}

function compactActivityOutput(activity: CompactActivity): string {
  const source = activity.source === "auto" ? "Automatic compaction" : "Manual compaction";
  const kept = Math.min(activity.keepTail, activity.beforeMessages);
  if (activity.status === "pending") {
    return [
      `${source} is summarizing older conversation history.`,
      `Messages before compaction: ${activity.beforeMessages}. Keeping the latest ${kept} message${kept === 1 ? "" : "s"} verbatim.`,
      `Token estimate before compaction: ${activity.beforeTokens}.`
    ].join("\n");
  }
  if (activity.status === "failed") {
    return [
      `${source} failed.`,
      activity.error ?? "The compaction request did not complete."
    ].join("\n");
  }
  const afterTokens = activity.afterTokens ?? activity.beforeTokens;
  const pct = Math.round((afterTokens / Math.max(1, activity.beforeTokens)) * 100);
  return [
    `${source} completed.`,
    `Messages: ${activity.beforeMessages} -> ${activity.afterMessages ?? activity.beforeMessages}.`,
    `Tokens: ${activity.beforeTokens} -> ${afterTokens} (${pct}% of the previous estimate).`,
    `Older turns were summarized; the latest ${kept} message${kept === 1 ? "" : "s"} were kept verbatim.`
  ].join("\n");
}

function toolIcon(tc: ToolCard): string {
  if (tc.toolName === "compact_context") return compactIcon();
  if (tc.toolName === "update_todos") return checklistIcon();
  if (isCommandTool(tc)) return terminalIcon();
  if (isWriteToolCard(tc)) return pencilIcon();
  return searchIcon();
}

function isCommandTool(tc: ToolCard): boolean {
  return tc.toolName === "run_command" || tc.category === "safeCmd" || tc.category === "unsafeCmd";
}

function isWriteToolCard(tc: ToolCard): boolean {
  return tc.category === "write" || tc.toolName === "write_file" || tc.toolName === "insert_text" || tc.toolName === "replace_range";
}

function renderChangeCard(tc: ToolCard): string {
  const path = toolPath(tc);
  const stats = diffStats(tc.diffPreview ?? "");
  const review = path
    ? `<button class="review-btn change-review-btn" type="button" data-review-tool="${escapeHtml(tc.toolId)}">Review</button>`
    : "";
  const statHtml = `<span class="diff-stat-group"><span class="diff-stat add">+${stats.added}</span><span class="diff-stat del">-${stats.removed}</span></span>`;
  return `<div class="tool-change-card change-summary open">
    <div class="change-summary-head">
      <div class="tool-change-summary">
        <span class="change-summary-main">
          <span class="change-summary-title">Edited 1 file</span>
          ${statHtml}
        </span>
      </div>
      ${review}
    </div>
    <div class="change-file-list">
      <div class="change-file-item open">
        <div class="change-file-row tool-change-row">
          <span class="change-file-path">${escapeHtml(path || "File changes")}</span>
          ${statHtml}
        </div>
        <pre class="tool-diff edit-preview change-diff">${renderDiffLines(tc.diffPreview ?? "", path)}</pre>
      </div>
    </div>
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

/** Header name for a card, accounting for the synthetic "Read N Files" group. */
function toolCardHeadName(tc: ToolCard): string {
  if (isReadGroupCard(tc)) return `Read ${tc.readGroup!.length} Files`;
  return toolDisplayName(tc.toolName);
}

function toolDisplayName(toolName: string): string {
  const aliases: Record<string, string> = {
    read_file: "Read File",
    list_dir: "Read Directory",
    write_file: "Write File",
    insert_text: "Edit File",
    replace_range: "Edit File",
    glob: "Find Files",
    run_command: "Run Command",
    update_todos: "Update Todos",
    compact_context: "Compact Context"
  };
  return aliases[toolName] ?? toolName;
}

function toolCardLabel(tc: ToolCard): string {
  if (tc.toolName === "read_file" || tc.toolName === "list_dir" || isWriteToolCard(tc)) {
    const path = toolPath(tc);
    const stats = isWriteToolCard(tc) ? writeStats(tc) : undefined;
    if (stats) return `${path} +${stats.added} -${stats.removed}`;
    return path;
  }
  if (tc.toolName === "glob") return String(toolArgs(tc).pattern ?? "");
  if (tc.toolName === "run_command") return toolCommand(tc);
  if (tc.toolName === "compact_context") return "";
  return "";
}

function writeStats(tc: ToolCard): { added: number; removed: number } | undefined {
  if (typeof tc.added === "number" && typeof tc.removed === "number") {
    return { added: tc.added, removed: tc.removed };
  }
  if (tc.diffPreview) return diffStats(tc.diffPreview);
  return undefined;
}

function diffStatHtml(stats: { added: number; removed: number }): string {
  return `<span class="diff-stat-group"><span class="diff-stat add">+${stats.added}</span><span class="diff-stat del">-${stats.removed}</span></span>`;
}

function renderToolCardLabel(tc: ToolCard): string {
  // The "Read N Files" group keeps a clean header; its files show on expand.
  if (isReadGroupCard(tc)) return `<span class="tool-label-text"></span>`;
  if (tc.toolName === "update_todos") {
    const todos = todosFromCard(tc);
    const done = todos.filter(t => t.status === "completed").length;
    return `<span class="tool-label-text">(${done}/${todos.length})</span>`;
  }
  if (isWriteToolCard(tc)) {
    const stats = writeStats(tc);
    return renderToolPathLabel(tc) + (stats ? diffStatHtml(stats) : "");
  }
  if (tc.toolName === "read_file") return renderToolPathLabel(tc) + readRangeHtml(tc);
  return `<span class="tool-label-text">${escapeHtml(toolCardLabel(tc))}</span>`;
}

function renderToolApprovalLabel(tc: ToolCard): string {
  if (isWriteToolCard(tc)) {
    const stats = writeStats(tc);
    return stats ? `${renderToolPathLabel(tc)} ${diffStatHtml(stats)}` : renderToolPathLabel(tc);
  }
  if (tc.toolName === "read_file") return renderToolPathLabel(tc) + readRangeHtml(tc);
  return escapeHtml(toolCardLabel(tc));
}

/** Range suffix for read_file cards, e.g. `12-40` (or `12-` / `-40` for open ends). */
function readRangeHtml(tc: ToolCard): string {
  const args = toolArgs(tc);
  const start = readRangeNumber(args.startLine ?? args.start_line ?? args.start);
  const end = readRangeNumber(args.endLine ?? args.end_line ?? args.end);
  if (start === undefined && end === undefined) return "";
  const label = `${start ?? ""}-${end ?? ""}`;
  return `<span class="tool-label-text read-range">${escapeHtml(label)}</span>`;
}

function readRangeNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isInteger(n) ? n : undefined;
}

function renderToolPathLabel(tc: ToolCard): string {
  const filePath = toolPath(tc);
  if (!filePath) return `<span class="tool-label-text"></span>`;
  return `<button class="tool-path-link tool-label-text" type="button" data-open-file="${escapeHtml(filePath)}">${escapeHtml(filePath)}</button>`;
}

function toolPath(tc: ToolCard): string {
  const args = toolArgs(tc);
  return String(args.path ?? args.file_path ?? args.filePath ?? args.filename ?? args.file ?? tc.progress?.path ?? "");
}

function toolContent(tc: ToolCard): string | undefined {
  const args = toolArgs(tc);
  const value = args.content
    ?? args.text
    ?? args.contents
    ?? args.body
    ?? args.new_content
    ?? args.newContent
    ?? args.value;
  return typeof value === "string" ? value : undefined;
}

function findToolCard(toolId: string): ToolCard | undefined {
  for (const message of state.messages) {
    const card = message.toolCards.find(t => t.toolId === toolId);
    if (card) return card;
  }
  return undefined;
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
  const highlighter = shikiHighlighter;
  if (!language || !highlighter) return escapeHtml(code);
  try {
    const html = highlighter.codeToHtml(code, {
      lang: language,
      theme: currentShikiTheme()
    });
    return extractShikiCode(html);
  } catch {
    return escapeHtml(code);
  }
}

function currentShikiTheme(): string {
  return document.body.classList.contains("vscode-light") ? "light-plus" : "dark-plus";
}

function extractShikiCode(html: string): string {
  const match = /<code[^>]*>([\s\S]*?)<\/code>/.exec(html);
  return match?.[1] ?? html;
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
  let runThought: Extract<MessagePart, { kind: "thought" }> | null = null;
  if (Array.isArray(recordMessage.events)) {
    for (const event of recordMessage.events) {
      if (!event || typeof event !== "object") continue;
      const e = event as { kind?: unknown; text?: unknown; t?: unknown };
      if ((e.kind === "text" || e.kind === "thought") && typeof e.text === "string") {
        appendPartText(msg, e.kind, e.text);
        if (e.kind === "text") {
          restoredText += e.text;
          runThought = null;
          continue;
        }
        restoredThought += e.text;
        const part = msg.parts[msg.parts.length - 1];
        if (part?.kind !== "thought") continue;
        const t = typeof e.t === "number" ? e.t : undefined;
        if (part !== runThought) {
          // New thought run: replace appendPartText's synthetic Date.now() with
          // the persisted timestamp (or none, for chats saved before timing).
          part.startedAt = t;
          part.durationMs = undefined;
          part.live = false;
          runThought = part;
        } else if (t !== undefined && part.startedAt !== undefined) {
          part.durationMs = t - part.startedAt;
        }
      } else {
        runThought = null;
      }
    }
  }
  // Accumulate rather than assign: a multi-round turn restores into one
  // message via repeated calls, matching how deltas accrued live.
  msg.text += restoredText || recordMessage.content;
  msg.thought += restoredThought;
  if (recordMessage.fileChanges?.length) {
    msg.fileChanges = [...(msg.fileChanges ?? []), ...recordMessage.fileChanges];
  }
  if (!restoredText && recordMessage.content) {
    // Chats saved before events were captured: render the round's content as
    // its text part (appended after any parts earlier rounds contributed).
    appendPartText(msg, "text", recordMessage.content);
  }
  finalizeLiveThoughts(msg);
  // appendPartText marks work as started; finalize it so a restored message is
  // never treated as live (its work parts collapse into a labelled group).
  if (msg.workStartedAt !== undefined && msg.workEndedAt === undefined) {
    msg.workEndedAt = msg.workStartedAt;
  }
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
  });
  const titleInput = root.querySelector("#chatTitleInput") as HTMLInputElement | null;
  titleInput?.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); commitRename(); }
    else if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
  });
  titleInput?.addEventListener("input", () => { if (titleInput) syncTitleField(titleInput); });
  titleInput?.addEventListener("blur", () => { if (state.renamingTitle) commitRename(); });
  root.addEventListener("pointerover", e => {
    const titleAction = (e.target as HTMLElement).closest("[data-title-hint]") as HTMLElement | null;
    if (titleAction) setTitleHint(titleAction.dataset.titleHint);
    const headerAction = (e.target as HTMLElement).closest("[data-header-hint]") as HTMLElement | null;
    if (headerAction) setHeaderHint(headerAction.dataset.headerHint);
    const target = (e.target as HTMLElement).closest("[data-tip]") as HTMLElement | null;
    if (target) showTooltip(target);
  });
  root.addEventListener("pointerout", e => {
    const titleAction = (e.target as HTMLElement).closest("[data-title-hint]") as HTMLElement | null;
    const headerAction = (e.target as HTMLElement).closest("[data-header-hint]") as HTMLElement | null;
    const next = e.relatedTarget as HTMLElement | null;
    if (titleAction && !(next?.closest?.("[data-title-hint]"))) setTitleHint(undefined);
    if (headerAction && !(next?.closest?.("[data-header-hint]"))) setHeaderHint(undefined);
    const target = (e.target as HTMLElement).closest("[data-tip]") as HTMLElement | null;
    if (target && !target.contains(e.relatedTarget as Node | null)) hideTooltip(target);
  });
  root.addEventListener("pointermove", refreshTooltip);
  root.addEventListener("focusin", e => {
    const titleAction = (e.target as HTMLElement).closest("[data-title-hint]") as HTMLElement | null;
    if (titleAction) setTitleHint(titleAction.dataset.titleHint);
    const headerAction = (e.target as HTMLElement).closest("[data-header-hint]") as HTMLElement | null;
    if (headerAction) setHeaderHint(headerAction.dataset.headerHint);
    const target = (e.target as HTMLElement).closest("[data-tip]") as HTMLElement | null;
    if (target) showTooltip(target);
  });
  root.addEventListener("focusout", e => {
    const next = e.relatedTarget as HTMLElement | null;
    if (!(next?.closest?.("[data-title-hint]"))) setTitleHint(undefined);
    if (!(next?.closest?.("[data-header-hint]"))) setHeaderHint(undefined);
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
      const groupId = workEl.dataset.workToggle!;
      const m = state.messages.find(x => x.id === groupId.slice(0, groupId.indexOf(":")));
      if (m) {
        const group = resolveRenderUnits(m).find(u => u.kind === "work" && u.groupId === groupId);
        m.workGroupExpanded ??= new Map<string, boolean>();
        m.workGroupExpanded.set(groupId, !(group?.expanded ?? false));
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
    const toolEl = target.closest("[data-tool-toggle]") as HTMLElement | null;
    if (toolEl && !target.closest("button")) {
      e.preventDefault();
      const id = toolEl.dataset.toolToggle!;
      for (const m of state.messages) {
        const tc = m.toolCards.find(t => t.toolId === id);
        if (tc) {
          if (tc.toolName === "compact_context" && tc.status === "pending") return;
          tc.expanded = !tc.expanded;
          if (tc.expanded && isWriteToolCard(tc) && tc.status === "executed" && !tc.diffPreview && !tc.diffRequested) {
            tc.diffRequested = true;
            send({ type: "requestToolDiff", toolId: id });
          }
          state.autoScroll = false;
          render();
          return;
        }
      }
    }
  });
  root.addEventListener("click", e => {
    const target = e.target as HTMLElement;
    const compactAction = target.closest("[data-compact-action]") as HTMLElement | null;
    if (compactAction) {
      e.preventDefault();
      const action = compactAction.dataset.compactAction;
      state.compactMenuOpen = false;
      render();
      if (action === "interrupt") send({ type: "compactInterruptAndRun" });
      return;
    }
    if (state.compactMenuOpen && !target.closest(".compact-group")) {
      state.compactMenuOpen = false;
      render();
      return;
    }
    const copyCode = target.closest("[data-copy-code]") as HTMLElement | null;
    if (copyCode) {
      e.preventDefault();
      void handleCopyCode(copyCode);
      return;
    }
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
    if (target.closest("#chatTitleWrap")) {
      if (state.hasChat) startRename();
    }
    else if (target.closest("#gear")) send({ type: "openSettings" });
    else if (target.closest("#chats")) send({ type: "openChats" });
    else if (target.closest("#plus")) send({ type: "newChat" });
    else if (target.closest("#compact")) {
      if (!state.compactAvailable) {
        state.compactMenuOpen = false;
        showCompactUnavailable();
      } else if (state.busy) {
        state.compactMenuOpen = !state.compactMenuOpen;
        render();
      } else {
        state.compactMenuOpen = false;
        send({ type: "compactNow" });
      }
    }
    else if (target.closest("#send")) submit();
    else if (target.closest("#planToggle")) send({ type: "togglePlanMode" });
    else if (target.closest("#scrollDown")) {
      state.autoScroll = true;
      render();
    } else {
      const review = target.closest("[data-review-path]") as HTMLElement | null;
      const reviewTool = target.closest("[data-review-tool]") as HTMLElement | null;
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
      else if (reviewTool) {
        const tc = findToolCard(reviewTool.dataset.reviewTool!);
        const path = tc ? toolPath(tc) : "";
        const content = tc ? toolContent(tc) : undefined;
        if (path && content !== undefined) send({ type: "reviewProposedFile", path, content });
        else if (path) send({ type: "reviewFile", path });
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

function setHeaderHint(text: string | undefined): void {
  const hint = root.querySelector("#headerHint") as HTMLElement | null;
  if (!hint) return;
  hint.textContent = text ?? "";
  hint.classList.toggle("active", !!text);
}

function setTitleHint(text: string | undefined): void {
  const hint = root.querySelector("#titleHint") as HTMLElement | null;
  if (!hint) return;
  hint.textContent = text ?? "";
  hint.classList.toggle("active", !!text);
}

function updateHeaderTitle(): void {
  const wrap = root.querySelector("#chatTitleWrap") as HTMLElement | null;
  const span = root.querySelector("#chatTitle") as HTMLElement | null;
  if (!wrap || !span) return;
  wrap.classList.toggle("has-chat", state.hasChat);
  if (state.hasChat && !state.renamingTitle) wrap.dataset.titleHint = "Rename chat";
  else delete wrap.dataset.titleHint;
  // While renaming, the input owns the title region; while animating, the
  // ticker owns the span's text — don't clobber either here.
  if (!state.renamingTitle && !titleAnimating && span.textContent !== state.chatTitle) {
    span.textContent = state.chatTitle;
  }
}

function cancelTitleAnim(): void {
  if (titleAnimTimer) {
    clearTimeout(titleAnimTimer);
    titleAnimTimer = undefined;
  }
  if (titleAnimating) {
    titleAnimating = false;
    const span = root.querySelector("#chatTitle") as HTMLElement | null;
    span?.classList.remove("typing");
    if (span) span.textContent = state.chatTitle;
  }
}

function animateTitle(target: string): void {
  cancelTitleAnim();
  state.chatTitle = target;
  state.hasChat = true;
  const span = root.querySelector("#chatTitle") as HTMLElement | null;
  if (!span || state.renamingTitle) { updateHeaderTitle(); return; }
  titleAnimating = true;
  span.classList.add("typing");
  span.textContent = "";
  let i = 0;
  const tick = (): void => {
    i += 1;
    span.textContent = target.slice(0, i);
    if (i >= target.length) {
      titleAnimating = false;
      titleAnimTimer = undefined;
      span.classList.remove("typing");
      return;
    }
    titleAnimTimer = setTimeout(tick, 35);
  };
  titleAnimTimer = setTimeout(tick, 35);
}

function syncTitleField(input: HTMLInputElement): void {
  // Mirror the value into the grid sizer so the field's width tracks the exact
  // rendered text width — keeping the edit pill identical to the display pill.
  const field = root.querySelector("#titleField") as HTMLElement | null;
  if (field) field.dataset.value = input.value;
}

function startRename(): void {
  if (!state.hasChat || state.renamingTitle) return;
  cancelTitleAnim();
  state.renamingTitle = true;
  setTitleHint(undefined);
  updateHeaderTitle();
  const wrap = root.querySelector("#chatTitleWrap") as HTMLElement | null;
  const input = root.querySelector("#chatTitleInput") as HTMLInputElement | null;
  if (!wrap || !input) return;
  input.value = state.chatTitle;
  syncTitleField(input);
  wrap.classList.add("editing");
  input.focus();
  input.select();
}

function endRename(): HTMLInputElement | null {
  const wrap = root.querySelector("#chatTitleWrap") as HTMLElement | null;
  wrap?.classList.remove("editing");
  return root.querySelector("#chatTitleInput") as HTMLInputElement | null;
}

function commitRename(): void {
  if (!state.renamingTitle) return;
  state.renamingTitle = false;
  const input = endRename();
  const next = input?.value.trim() ?? "";
  if (next && next !== state.chatTitle) {
    state.chatTitle = next;
    send({ type: "renameChat", title: next });
  }
  updateHeaderTitle();
}

function cancelRename(): void {
  if (!state.renamingTitle) return;
  state.renamingTitle = false;
  endRename();
  updateHeaderTitle();
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

function historyIcon(): string {
  return `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <path d="M4.05 5.2h-2.2V3"/>
    <path d="M2.22 5.18A5.7 5.7 0 1 1 2.1 10"/>
    <path d="M8 5.15v3.1l2.05 1.2"/>
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

function compactIcon(): string {
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <path d="M5 4.5h14"/>
    <path d="M7.5 9h9"/>
    <path d="M10 13.5h4"/>
    <path d="m8 18 4-3 4 3"/>
  </svg>`;
}

function copyIcon(): string {
  return `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <path d="M11 4h6a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3h-1"/>
    <path d="M8 4.2A3 3 0 0 1 10.8 4"/>
    <rect x="4" y="8" width="12" height="12" rx="3"/>
  </svg>`;
}

function brainIcon(): string {
  // Side profile of a brain: a lobed outline with concentric interior folds
  // (the side-view gyri) and a short brainstem at the bottom.
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <path d="M5.5 9.2C4.8 6.6 6.9 4.2 9.6 4.6 10.6 3.6 12.3 3.6 13.3 4.7 15.2 4.2 17.2 5.7 17.2 7.7 18.8 8.3 19.4 10.4 18.3 11.8 18.7 13.7 17.2 15.4 15.3 15.2 14.4 16.4 12.6 16.6 11.5 15.7 9.8 16.2 7.9 15.2 7.6 13.4 5.7 13.1 4.7 11.2 5.5 9.2Z"/>
    <path d="M9.8 6.2C11.6 6.6 12.1 8.5 11 10 10.1 11.2 10.6 12.8 12.1 13.3"/>
    <path d="M13.6 6.8C14.9 7.4 15.2 9 14.4 10.2"/>
    <path d="M10.2 15.9 9.8 18.8"/>
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

function checklistIcon(): string {
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <path d="m3 6 1.5 1.5L7 5"/>
    <path d="m3 14 1.5 1.5L7 13"/>
    <path d="M11 6.5h10"/>
    <path d="M11 14.5h10"/>
  </svg>`;
}

function dirIcon(): string {
  return `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <path d="M3 7a2 2 0 0 1 2-2h3.5l2 2.5H19a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>
  </svg>`;
}

function fileIcon(): string {
  return `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <path d="M6 3h7l5 5v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/>
    <path d="M13 3v5h5"/>
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
  for (const [index, m] of rec.messages.entries()) {
    const id = restoredRecordMessageId(index, m.ts);
    if (m.role === "user") {
      state.messages.push({ id, role: "user", parts: [], text: m.content, thought: "", toolCards: [] });
    } else if (m.role === "assistant") {
      // A turn that looped over tools is persisted as one assistant message
      // per LLM round-trip. Merge consecutive assistant/tool rounds into a
      // single message so a restored turn renders as the same connected
      // timeline the user watched stream live. (Only a user message can sit
      // between two turns, so a run of assistant/tool rows is always one turn.)
      const prev = state.messages[state.messages.length - 1];
      if (prev?.role === "assistant") {
        restoreAssistantParts(prev, m);
      } else {
        const msg: Message = { id, role: "assistant", parts: [], text: "", thought: "", toolCards: [] };
        restoreAssistantParts(msg, m);
        state.messages.push(msg);
      }
    } else if (m.role === "tool") {
      // Attach to the CURRENT turn's assistant message. A turn is persisted as
      // its tool results followed by the final assistant message, so when a new
      // turn's tools are restored its assistant message does not exist yet — the
      // current turn's assistant is the last message iff it is an assistant.
      // Reaching further back would graft these tools onto the previous turn's
      // summary (rendered as stray cards after its final reply); start a fresh
      // stub instead, which the turn's later assistant message merges into.
      const lastMsg = state.messages[state.messages.length - 1];
      let last = lastMsg?.role === "assistant" ? lastMsg : undefined;
      if (!last) {
        last = { id, role: "assistant", parts: [], text: "", thought: "", toolCards: [] };
        state.messages.push(last);
      }
      const restoredName = m.toolCall?.name ?? "tool";
      // list_dir/glob render their result as a file list, so keep the full
      // (bounded) content on restore instead of the generic preview slice.
      const showsFileList = restoredName === "list_dir" || restoredName === "glob";
      const tc: ToolCard = {
        toolId: restoredToolCardId(index, m.ts),
        toolName: restoredName,
        argsJson: m.toolCall?.argsJson ?? "{}",
        category: "read",
        status: "executed",
        resultPreview: showsFileList ? m.content : m.content.slice(0, 400),
        expanded: false
      };
      last.toolCards.push(tc);
      last.parts.push({ id: nextPartId("tool"), kind: "tool", card: tc, startedAt: m.ts });
    }
  }
}

window.addEventListener("message", ev => {
  const msg = ev.data as ExtToChat;
  if ("type" in msg && msg.type === "settings") {
    state.planMode = msg.planMode;
    state.autoapproveWrites = msg.autoapproveWrites;
    state.autoCompact = msg.autoCompact;
    state.autoCompactThresholdPercent = msg.autoCompactThresholdPercent;
    render();
    return;
  }
  if (!("kind" in msg)) return;
  switch (msg.kind) {
    case "chatLoaded": {
      hiddenApprovalToolIds.clear();
      cancelTitleAnim();
      state.renamingTitle = false;
      state.chatTitle = msg.record.title;
      state.hasChat = true;
      const pendingCompactActivity = state.compactActivity?.status === "pending" ? state.compactActivity : undefined;
      if (!pendingCompactActivity) state.compactActivity = undefined;
      loadFromRecord(msg.record);
      if (pendingCompactActivity) {
        state.compactActivity = pendingCompactActivity;
        upsertCompactActivityMessage(pendingCompactActivity);
      }
      applyCompactStatus(msg.record.messages.length, state.compactMinMessages, msg.record.messages.length >= state.compactMinMessages);
      state.autoScroll = true;
      render();
      break;
    }
    case "titleChanged":
      state.hasChat = true;
      if (msg.animate) {
        animateTitle(msg.title);
      } else {
        state.chatTitle = msg.title;
        updateHeaderTitle();
      }
      break;
    case "chatClosed":
      hiddenApprovalToolIds.clear();
      cancelTitleAnim();
      state.renamingTitle = false;
      state.hasChat = false;
      state.chatTitle = "Chat";
      state.messages = [];
      state.tokens = 0;
      state.busy = false;
      state.autoScroll = true;
      state.compactMenuOpen = false;
      state.compactActivity = undefined;
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
      state.compactMenuOpen = false;
      state.autoScroll = true;
      {
        const m = getOrCreateMsg(msg.messageId, "assistant");
        markWorkStarted(m);
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
      appendPartText(m, "text", msg.delta);
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
    case "toolCallProgress": {
      const m = getOrCreateMsg(msg.messageId, "assistant");
      markWorkStarted(m);
      let card = m.toolCards.find(t => t.toolId === msg.toolId);
      if (!card) {
        card = {
          toolId: msg.toolId,
          toolName: msg.toolName,
          argsJson: "{}",
          category: "write",
          status: "streaming",
          progress: {
            path: msg.path,
            contentBytes: msg.contentBytes,
            contentLines: msg.contentLines
          },
          expanded: false
        };
        m.toolCards.push(card);
        finalizeLiveThoughts(m);
        m.parts.push({ id: nextPartId("tool"), kind: "tool", card, startedAt: Date.now() });
      } else {
        card.status = "streaming";
        card.category = "write";
        card.toolName = msg.toolName;
        card.progress = {
          path: msg.path ?? card.progress?.path,
          contentBytes: msg.contentBytes,
          contentLines: msg.contentLines
        };
      }
      render(false);
      break;
    }
    case "toolCallProposed": {
      const m = getOrCreateMsg(msg.messageId, "assistant");
      markWorkStarted(m);
      let card = m.toolCards.find(t => t.toolId === msg.toolId);
      if (!card) {
        card = {
          toolId: msg.toolId,
          toolName: msg.toolName,
          argsJson: msg.argsJson,
          category: msg.category,
          reason: msg.reason,
          diffPreview: msg.diffPreview,
          diffRequested: false,
          status: "pending",
          expanded: false
        };
        m.toolCards.push(card);
        finalizeLiveThoughts(m);
        m.parts.push({ id: nextPartId("tool"), kind: "tool", card, startedAt: Date.now() });
      } else {
        card.toolName = msg.toolName;
        card.argsJson = msg.argsJson;
        card.category = msg.category;
        card.reason = msg.reason;
        card.diffPreview = msg.diffPreview;
        card.diffRequested = false;
        card.progress = undefined;
        card.status = "pending";
      }
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
          if (msg.diffPreview) {
            tc.diffPreview = msg.diffPreview;
            tc.diffRequested = false;
          }
          if (msg.groupId) tc.groupId = msg.groupId;
          if (typeof msg.added === "number") tc.added = msg.added;
          if (typeof msg.removed === "number") tc.removed = msg.removed;
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
      // Plan output streams as ordinary text parts (same renderer as a normal
      // answer); planFinal only flags the turn so Accept/Reject is offered.
      const m = getOrCreateMsg(msg.messageId, "assistant");
      m.isPlan = true;
      finalizeLiveThoughts(m);
      if (!m.text && msg.markdown) {
        m.text = msg.markdown;
        appendPartText(m, "text", msg.markdown);
      }
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
    case "compactStart":
      state.compactMenuOpen = false;
      {
        const activity: CompactActivity = {
          id: msg.compactId,
          source: msg.source,
          status: "pending",
          beforeTokens: msg.beforeTokens,
          beforeMessages: msg.beforeMessages,
          keepTail: msg.keepTail
        };
        state.compactActivity = activity;
        upsertCompactActivityMessage(activity);
      }
      state.autoScroll = true;
      render();
      break;
    case "compactEnd":
      {
        const activity: CompactActivity = {
          id: msg.compactId,
          source: msg.source,
          status: msg.status,
          beforeTokens: msg.beforeTokens,
          afterTokens: msg.afterTokens,
          beforeMessages: msg.beforeMessages,
          afterMessages: msg.afterMessages,
          keepTail: msg.keepTail,
          error: msg.error
        };
        state.compactActivity = activity;
        upsertCompactActivityMessage(activity);
      }
      state.autoScroll = true;
      render();
      break;
    case "turnEnd":
      state.busy = false;
      for (const m of state.messages) {
        finalizeLiveThoughts(m);
        if (m.id === msg.messageId && m.workStartedAt !== undefined && m.workEndedAt === undefined) {
          m.workEndedAt = Date.now();
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

watchThemeChanges();
startShiki();
send({ type: "ready" });
render();
