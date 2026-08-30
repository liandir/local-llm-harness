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
import { DEFAULT_THINKING_MODE, type ThinkingMode } from "../../../chat/thinkingMode.js";
import { restoredRecordMessageId, restoredToolCardId } from "./ids.js";
import { normalizeToolArgsForDisplay } from "./toolArgs.js";
import { restoredCreatesNewFile, restoredToolStatus } from "./toolHistory.js";
import { modeMenusAfterPointerDown } from "./composerModes.js";
import { formatElapsedDuration } from "./duration.js";
import { shimmerTiming } from "./shimmerTiming.js";
import { approvalHintForCategory } from "./approvalHints.js";
import { sanitizeTerminalText } from "../../../util/terminalText.js";
import {
  activeToolLabel,
  commandToolLabel,
  editOperationLabel,
  erroredToolLabel,
  finishedWorkSummary,
  liveWorkSummary,
  liveWorkSummaryIncludesCurrent,
  settledToolLabel,
  workActivityIconType,
  type WorkActivity
} from "./workLabels.js";

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
  approvalRequired?: boolean;
  reason?: string;
  status: "streaming" | "pending" | "approved" | "rejected" | "executed" | "failed";
  resultPreview?: string;
  diffPreview?: string;
  diffRequested?: boolean;
  added?: number;
  removed?: number;
  // write_file that created a non-existent file → labelled "Created file"; any
  // other settled write/edit (including a failed one) → "Edited file".
  createsNewFile?: boolean;
  processJobId?: string;
  processRunning?: boolean;
  processStopping?: boolean;
  // replace_range only: the number of lines the edit replaces, for the live
  // "Replacing Y with X lines" note and the -Y in the heading.
  replacedLines?: number;
  progress?: {
    path?: string;
    contentLines: number;
    startLine?: number;
    endLine?: number;
    line?: number;
  };
  expanded: boolean;
}

type MessagePart =
  | { id: string; kind: "text"; text: string; startedAt?: number }
  | { id: string; kind: "thought"; text: string; live: boolean; userExpanded?: boolean; startedAt?: number; durationMs?: number }
  | { id: string; kind: "tool"; card: ToolCard; startedAt?: number }
  | { id: string; kind: "summary"; text: string }
  | { id: string; kind: "abort"; reason: string };

interface Message {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  recordTs?: number;
  responseToTs?: number;
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
  hasTurnWorkSummary?: boolean;
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
  queuedMessages: { id: string; text: string }[];
  notices: { id: string; text: string }[];
  tokens: number;
  limit: number;
  planMode: boolean;
  planModeMenuOpen: boolean;
  thinkingMode: ThinkingMode;
  thinkingModeMenuOpen: boolean;
  serverPending?: "server" | "title" | "context";
  autoCompact: boolean;
  autoCompactThresholdPercent: number;
  busy: boolean;
  draft: string;
  // The free-text "other" answer typed into a pending ask_user_question box,
  // kept here so it survives composer re-renders like the main draft does.
  questionDraft: string;
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
  recentChats: { id: string; title: string; updatedAt: number }[];
  editingQueuedMessageId?: string;
  queuedMessageDraft: string;
  editingMessageTs?: number;
  editDraft: string;
}

const state: State = {
  messages: [],
  queuedMessages: [],
  notices: [],
  tokens: 0,
  limit: 32768,
  planMode: false,
  planModeMenuOpen: false,
  thinkingMode: DEFAULT_THINKING_MODE,
  thinkingModeMenuOpen: false,
  serverPending: undefined,
  autoCompact: true,
  autoCompactThresholdPercent: 80,
  busy: false,
  draft: "",
  questionDraft: "",
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
  compactMenuOpen: false,
  recentChats: [],
  queuedMessageDraft: "",
  editDraft: ""
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
    m.parts.push({ id: nextPartId("text"), kind: "text", text: delta, startedAt: Date.now() });
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

function renderCopyableCodeBlock(
  code: string,
  language: string | undefined,
  displayPrefix = "",
  extraAction = ""
): string {
  const languageClass = language ? ` language-${escapeHtml(language)}` : "";
  const renderedCode = highlightCode(code, language);
  const codeContent = displayPrefix
    ? `<span class="code-display-prefix" aria-hidden="true">${escapeHtml(displayPrefix)}</span><span class="copy-code-source">${renderedCode}</span>`
    : renderedCode;
  const codeClass = `${displayPrefix ? "command-code-display" : "copy-code-source"}${languageClass}`;
  return `<div class="copy-code-block${extraAction ? " has-extra-actions" : ""}">
    <span class="code-block-actions">${extraAction}<button class="copy-btn code-copy-btn block-code-copy-btn" type="button" data-copy-code aria-label="Copy code">${copyIcon()}</button></span>
    <pre><code class="${codeClass}">${codeContent}</code></pre>
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
  reconcileEmptyState();
  reconcileMessages();
  updateServerStatus();
  updateComposer();
  updateContextPill();
  updateHeaderTitle();
  syncShimmerAnimations();
  if (body) {
    if (shouldStickToBottom) body.scrollTop = body.scrollHeight;
    else body.scrollTop = savedTop;
    state.savedScrollTop = body.scrollTop;
    updateScrollState(body, false);
  }
}

const shimmerAnimations = new Map<HTMLElement, { animation: Animation; width: number }>();
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
reducedMotion.addEventListener("change", syncShimmerAnimations);

function syncShimmerAnimations(): void {
  const elements = new Set(Array.from(root.querySelectorAll<HTMLElement>(".shimmer, .active-tool-head")));
  for (const [element, running] of shimmerAnimations) {
    if (elements.has(element) && !reducedMotion.matches) continue;
    running.animation.cancel();
    shimmerAnimations.delete(element);
  }
  if (reducedMotion.matches) return;

  for (const element of elements) {
    const width = element.getBoundingClientRect().width;
    if (width <= 0) continue;
    const running = shimmerAnimations.get(element);
    if (running && Math.abs(running.width - width) < 0.5) continue;
    running?.animation.cancel();
    const { durationMs, sweepEndOffset } = shimmerTiming(width);
    const animation = element.animate([
      { backgroundPosition: "200% 0", offset: 0 },
      { backgroundPosition: "-100% 0", offset: sweepEndOffset },
      { backgroundPosition: "-100% 0", offset: 1 }
    ], {
      duration: durationMs,
      easing: "linear",
      iterations: Infinity
    });
    shimmerAnimations.set(element, { animation, width });
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
      <div id="emptyState" hidden></div>
      <div id="notices" style="display: contents"></div>
      <div id="messages" style="display: contents"><div id="serverStatusFallback" class="msg assistant timeline server-status-fallback" hidden></div></div>
    </main>
    <footer class="composer">
      <div id="scrollDownSlot"></div>
      <div id="messageQueue" class="message-queue" hidden></div>
      <div class="composer-row">
        <div id="approvalSlot"></div>
        <textarea id="input" rows="3"></textarea>
        <span id="sendSlot"></span>
      </div>
      <div class="composer-toggles">
        <span class="composer-mode-controls">
          <span class="mode-selector plan-mode-group">
            <button id="planMode" class="mode-pill mode-icon-toggle" type="button" aria-label="Mode (Normal)" aria-haspopup="menu" aria-controls="planModeMenu" aria-expanded="false" data-composer-mode-hint="Mode (Normal)"><span id="planModeIcon">${pawnIcon()}</span></button>
            <span id="planModeMenu" class="mode-select-menu plan-mode-menu" role="menu" hidden>
              <button type="button" role="menuitemradio" data-plan-mode="false"><span class="mode-select-check"></span><span class="mode-select-option-icon">${pawnIcon()}</span><span>Normal mode</span></button>
              <button type="button" role="menuitemradio" data-plan-mode="true"><span class="mode-select-check"></span><span class="mode-select-option-icon">${scrollIcon()}</span><span>Plan mode</span></button>
            </span>
          </span>
          <span class="mode-selector thinking-mode-group">
            <button id="thinkingMode" class="mode-pill mode-icon-toggle" type="button" aria-label="Intelligence (Capped)" aria-haspopup="menu" aria-controls="thinkingModeMenu" aria-expanded="false" data-composer-mode-hint="Intelligence (Capped)">${brainIcon()}</button>
            <span id="thinkingModeMenu" class="mode-select-menu thinking-mode-menu" role="menu" hidden>
              <button type="button" role="menuitemradio" data-thinking-mode="instant"><span class="mode-select-check"></span><span>Instant</span></button>
              <button type="button" role="menuitemradio" data-thinking-mode="capped"><span class="mode-select-check"></span><span>Capped</span></button>
              <button type="button" role="menuitemradio" data-thinking-mode="unlimited"><span class="mode-select-check"></span><span>Unlimited</span></button>
            </span>
          </span>
          <span id="composerModeHint" class="inline-hint composer-mode-hint" aria-hidden="true"></span>
        </span>
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
    const html = `<span>${escapeHtml(notice.text)}</span>`;
    setHtml(el, html);
  }
}

function reconcileEmptyState(): void {
  const host = root.querySelector("#emptyState") as HTMLElement | null;
  if (!host) return;
  const visible = state.messages.length === 0 && !state.busy;
  host.hidden = !visible;
  if (!visible) return;

  const recent = state.recentChats.map(chat => `
    <button class="recent-chat-item" type="button" data-open-chat="${escapeHtml(chat.id)}">
      <span class="recent-chat-title">${escapeHtml(chat.title)}</span>
      <span class="recent-chat-time">${escapeHtml(formatRecentChatTime(chat.updatedAt))}</span>
    </button>`).join("");
  setHtml(host, `<div class="empty-chat-head">
      <span class="empty-chat-title">Start a conversation</span>
    </div>
    ${recent ? `<div class="recent-chat-section">
      <div class="recent-chat-label">Recent chats</div>
      <div class="recent-chat-list">${recent}</div>
      <button class="recent-chat-view-all" type="button" data-view-all-chats>View all</button>
    </div>` : ""}`);
}

function updateServerStatus(): void {
  const fallback = root.querySelector("#serverStatusFallback") as HTMLElement | null;
  if (!fallback) return;
  // Title generation may temporarily replace the latest activity in a
  // collapsed live sub-session. Always restore that real activity before
  // placing (or removing) the transient status on this render.
  for (const part of Array.from(root.querySelectorAll<HTMLElement>("[data-title-status-suppressed]"))) {
    part.hidden = false;
    delete part.dataset.titleStatusSuppressed;
  }
  let status = root.querySelector("#serverStatus") as HTMLElement | null;
  if (!state.serverPending) {
    if (status) {
      status.hidden = true;
      fallback.appendChild(status);
    }
    fallback.hidden = true;
    return;
  }

  if (!status) {
    status = document.createElement("div");
    status.id = "serverStatus";
    status.className = "part tool-part server-status-part";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
  }
  const label = state.serverPending === "title"
    ? "Generating title"
    : state.serverPending === "context"
      ? "Loading chat context"
      : "Server pending";
  const content = '<div class="tool-card pending"><div class="tool-head active-tool-head">'
    + '<strong class="tool-name">' + label + '</strong></div></div>';
  setHtml(status, content);
  status.hidden = false;

  const liveMessage = [...state.messages].reverse().find(message =>
    message.role === "assistant" && isAssistantTurnLive(message)
  );
  const messageEl = liveMessage ? messageEls.get(liveMessage.id) : undefined;
  if (!messageEl) {
    fallback.appendChild(status);
    fallback.hidden = false;
    return;
  }

  const collapsedTurnSummary = messageEl.querySelector(
    ".work-section.conglomerate.live:not(.open)"
  );
  if (collapsedTurnSummary) {
    status.hidden = true;
    fallback.appendChild(status);
    fallback.hidden = true;
    return;
  }

  const latestPart = liveMessage?.parts.filter(part => !isBlankTextPart(part)).at(-1);
  const expandedLiveSubSession = messageEl.querySelector(".work-section.session.live.open");
  if (latestPart && isWorkPart(latestPart) && !expandedLiveSubSession) {
    if (state.serverPending === "title") {
      const currentOnlyBody = messageEl.querySelector(
        ".work-section.session.live:not(.open) > .work-body.current-only"
      ) as HTMLElement | null;
      if (currentOnlyBody) {
        // The title request is not a model tool call and must never enter the
        // session chronology. While it blocks the next model continuation,
        // show it in the same slot as the current activity instead.
        for (const part of Array.from(currentOnlyBody.children) as HTMLElement[]) {
          if (!part.dataset.partId) continue;
          part.hidden = true;
          part.dataset.titleStatusSuppressed = "true";
        }
        currentOnlyBody.appendChild(status);
        fallback.hidden = true;
        return;
      }
    }
    // In current-only mode the latest activity already communicates progress.
    // Keep the extra server notice for the expanded chronology, where it sits
    // below the most recently completed activity.
    status.hidden = true;
    fallback.appendChild(status);
    fallback.hidden = true;
    return;
  }

  fallback.hidden = true;
  const liveBodies = Array.from(messageEl.querySelectorAll(".work-section.live .work-body")) as HTMLElement[];
  const target = liveBodies.at(-1) ?? messageEl;
  if (target === messageEl) {
    const structuralSibling = Array.from(messageEl.children).find(child => {
      const element = child as HTMLElement;
      return !!element.dataset.changeSummary || !!element.dataset.messageActions;
    }) ?? null;
    messageEl.insertBefore(status, structuralSibling);
  } else {
    target.appendChild(status);
  }
}

function formatRecentChatTime(updatedAt: number): string {
  const date = new Date(updatedAt);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
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
  if (m.recordTs !== undefined && state.editingMessageTs === m.recordTs) {
    const html = `<div class="user-edit-card">
      <textarea class="user-edit-input" rows="3" data-edit-input="${m.recordTs}">${escapeHtml(state.editDraft)}</textarea>
      <div class="user-edit-actions">
        <button class="user-edit-cancel" type="button" data-edit-cancel>Cancel</button>
        <button class="user-edit-submit" type="button" data-edit-submit="${m.recordTs}"${state.editDraft.trim() ? "" : " disabled"}>Send</button>
      </div>
    </div>`;
    setHtml(el, html);
    return;
  }
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
  const actions: string[] = [];
  let persistentHint = "";
  if (copyableMessageText(m).trim()) {
    const copied = copiedMessageId === m.id;
    const cls = `copy-btn${copied ? " copied" : ""}`;
    const label = copied ? "Copied" : "Copy message";
    if (copied) persistentHint = label;
    actions.push(`<button class="${cls}" type="button" data-copy-message="${m.id}" data-message-action-hint="${label}" aria-label="${label}">
      ${copyIcon()}
    </button>`);
  }
  if (m.role === "user" && m.recordTs !== undefined && !state.busy) {
    actions.push(`<button class="copy-btn" type="button" data-edit-message="${m.recordTs}" data-message-action-hint="Edit message" aria-label="Edit message">${pencilIcon()}</button>`);
  }
  if (m.role === "assistant" && m.responseToTs !== undefined && !state.busy) {
    actions.push(`<button class="copy-btn" type="button" data-fork-chat="${m.responseToTs}" data-message-action-hint="Fork chat" aria-label="Fork chat">${forkIcon()}</button>`);
  }
  if (actions.length === 0) return "";
  const hintClass = `message-action-hint${persistentHint ? " active" : ""}`;
  return `${actions.join("")}<span class="${hintClass}" aria-hidden="true">${persistentHint}</span>`;
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
  live?: boolean;
  conglomerate?: boolean;
  children?: ResolvedUnit[];
  startedAt?: number;
  endedAt?: number;
}

/**
 * Split an assistant message's parts into chronological render units. Every
 * run of work before a model text output gets its own disclosure group. A
 * multi-item trailing run keeps a live summary above its independently
 * expandable current activity; as soon as model text arrives it becomes a
 * normal collapsed group.
 */
function resolveRenderUnits(m: Message): ResolvedUnit[] {
  const parts = m.parts.filter(part => !isBlankTextPart(part));
  if (!parts.some(isWorkPart)) {
    const inlineUnits: ResolvedUnit[] = parts.map(part => ({
      kind: "inline" as const,
      parts: [part],
      expanded: false
    }));
    return wrapTurnWorkSummary(m, parts, inlineUnits);
  }

  const units: ResolvedUnit[] = [];
  let workParts: MessagePart[] = [];
  let sessionIndex = 0;
  const flushWork = (endedAt: number | undefined, live: boolean): void => {
    if (workParts.length === 0) return;
    const stableId = `${m.id}:worked:${sessionIndex++}`;
    // Changing identity when the live session settles makes it collapse again,
    // even when the user had expanded it while watching the tools run.
    const groupId = live ? `${stableId}:live` : stableId;
    const firstPartStart = partStartedAt(workParts[0]);
    const startedAt = sessionIndex === 1 ? (m.workStartedAt ?? firstPartStart) : firstPartStart;
    units.push({
      kind: "work",
      groupId,
      parts: workParts,
      expanded: m.workGroupExpanded?.get(groupId) ?? false,
      live,
      startedAt,
      endedAt
    });
    workParts = [];
  };

  for (const part of parts) {
    if (isWorkPart(part)) {
      workParts.push(part);
      continue;
    }
    flushWork(partStartedAt(part), false);
    units.push({ kind: "inline", parts: [part], expanded: false });
  }
  const trailingLive = workParts.length > 0 && isAssistantTurnLive(m);
  flushWork(trailingLive ? undefined : m.workEndedAt, trailingLive);
  return wrapTurnWorkSummary(m, parts, units);
}

function wrapTurnWorkSummary(m: Message, parts: MessagePart[], units: ResolvedUnit[]): ResolvedUnit[] {
  if (m.workStartedAt === undefined) return units;
  if (!m.hasTurnWorkSummary && !parts.some(isWorkPart)) return units;
  const live = isAssistantTurnLive(m);
  const finalPartIndex = lastFinalAnswerIndex(parts);
  const finalPart = finalPartIndex >= 0 ? parts[finalPartIndex] : undefined;
  const finalUnitIndex = finalPart
    ? units.findIndex(unit => unit.kind === "inline" && unit.parts[0]?.id === finalPart.id)
    : -1;
  const hasTrailingAnswer = finalUnitIndex >= 0 && finalUnitIndex === units.length - 1;
  const children = hasTrailingAnswer ? units.slice(0, finalUnitIndex) : units;
  const outputUnits = hasTrailingAnswer ? units.slice(finalUnitIndex) : [];
  const stableId = `${m.id}:worked:all`;
  const groupId = live ? `${stableId}:live` : stableId;
  const summary: ResolvedUnit = {
    kind: "work",
    groupId,
    parts: children.flatMap(unit => unit.parts),
    children,
    conglomerate: true,
    expanded: m.workGroupExpanded?.get(groupId) ?? live,
    live,
    startedAt: m.workStartedAt,
    endedAt: live ? undefined : (finalPart ? partStartedAt(finalPart) : m.workEndedAt)
  };
  return [summary, ...outputUnits];
}

function lastFinalAnswerIndex(parts: MessagePart[]): number {
  for (let index = parts.length - 1; index >= 0; index--) {
    if (parts[index].kind === "text") return index;
  }
  return -1;
}

function partStartedAt(part: MessagePart): number | undefined {
  return part.kind === "text" || part.kind === "thought" || part.kind === "tool"
    ? part.startedAt
    : undefined;
}

function reconcileAssistantParts(el: HTMLElement, m: Message): void {
  const units = resolveRenderUnits(m);
  const wantedWorkIds = new Set<string>();
  const wantedPartIds = new Set<string>();
  for (const u of units) {
    if (u.kind === "work" && !rendersAsDirectWorkItem(u)) wantedWorkIds.add(u.groupId!);
    else wantedPartIds.add(u.parts[0].id);
  }
  for (const child of Array.from(el.children) as HTMLElement[]) {
    const partId = child.dataset.partId;
    const workId = child.dataset.workId;
    const actionId = child.dataset.messageActions;
    const changeSummaryId = child.dataset.changeSummary;
    if (child.id === "serverStatus") continue;
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
    if (u.kind === "work" && !rendersAsDirectWorkItem(u)) {
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
      const presentation = u.kind === "inline" ? textPresentationForUnit(m, units, u) : "inline";
      renderPartInto(partEl, m.id, part, presentation, u.kind === "work" && !!u.live);
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
  return part.kind === "thought" || part.kind === "tool";
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
    el.insertBefore(head, el.firstChild);
  } else if (head !== el.firstElementChild) {
    el.insertBefore(head, el.firstChild);
  }
  head.dataset.workToggle = group.groupId;
  if (group.live && group.conglomerate) {
    const durationMs = groupDurationMs(group);
    setHtml(head, `<span class="work-icon" aria-hidden="true">${clockIcon()}</span>`
      + `<span class="work-title">${escapeHtml(formatWorkingLabel(durationMs))}</span>${chevronIcon()}`);
    return;
  }
  if (!group.conglomerate) {
    renderSettledSubSessionHead(head, group);
    return;
  }
  const durationMs = groupDurationMs(group);
  const html = [
    durationMs === undefined ? "" : `<span class="work-icon" aria-hidden="true">${clockIcon()}</span>`,
    `<span class="work-title">${escapeHtml(formatWorkedLabel(durationMs))}</span>`,
    chevronIcon()
  ].join("");
  setHtml(head, html);
}

function renderSettledSubSessionHead(head: HTMLElement, group: ResolvedUnit): void {
  const allActivities = workActivities(group.parts);
  const includeCurrent = !!group.live && liveWorkSummaryIncludesCurrent(allActivities);
  const summarizedParts = group.live && !includeCurrent ? group.parts.slice(0, -1) : group.parts;
  const activities = group.live ? allActivities : workActivities(summarizedParts);
  const seen = new Set<string>();
  const icons: string[] = [];
  for (let index = 0; index < summarizedParts.length; index++) {
    const part = summarizedParts[index];
    const activity = activities[index];
    if (!activity) continue;
    const type = workActivityIconType(activity);
    if (!type) continue;
    if (seen.has(type)) continue;
    seen.add(type);
    const icon = part.kind === "thought" ? brainIcon() : part.kind === "tool" ? toolIcon(part.card) : "";
    if (icon) icons.push(`<span class="work-type-icon" aria-hidden="true">${icon}</span>`);
  }
  const summary = (group.live ? liveWorkSummary(activities) : finishedWorkSummary(activities)) ?? "Worked";
  setHtml(head, `<span class="work-type-icons">${icons.join("")}</span>`
    + `<span class="work-title">${escapeHtml(summary)}</span>${chevronIcon()}`);
}

function renderWorkSection(el: HTMLElement, msgId: string, group: ResolvedUnit): void {
  const { parts, expanded } = group;
  const currentOnly = !!group.live && !group.conglomerate && !expanded;
  const currentTool = group.live && parts[parts.length - 1]?.kind === "tool"
    ? (parts[parts.length - 1] as Extract<MessagePart, { kind: "tool" }>).card
    : undefined;
  const cls = [
    "work-section",
    group.conglomerate ? "conglomerate" : "session",
    group.live ? "live" : "settled",
    currentTool?.category,
    currentTool?.status,
    expanded ? "open" : "",
    parts.length > 0 ? "has-items" : ""
  ].filter(Boolean).join(" ");
  if (el.className !== cls) el.className = cls;
  renderWorkHead(el, group);
  const head = directChild(el, "work-head");
  if (head) head.hidden = currentOnly;
  let body = el.querySelector(".work-body") as HTMLElement | null;
  // A collapsed top-level turn hides its entire chronology even while live.
  // Live sub-sessions retain their compact latest-activity preview.
  if (!expanded && (!group.live || group.conglomerate)) {
    for (const part of parts) partEls.delete(part.id);
    body?.remove();
    return;
  }
  if (!body) {
    body = document.createElement("div");
    body.className = "work-body";
    el.appendChild(body);
  }
  body.classList.toggle("current-only", currentOnly);
  if (currentOnly) body.dataset.workToggle = group.groupId;
  else delete body.dataset.workToggle;
  if (group.children) {
    reconcileNestedUnits(body, msgId, group.children);
    return;
  }
  const allRenderParts = parts;
  const renderParts = group.live && !expanded ? allRenderParts.slice(-1) : allRenderParts;
  const activePartId = group.live ? allRenderParts[allRenderParts.length - 1]?.id : undefined;
  const wanted = new Set(renderParts.map(p => p.id));
  for (const child of Array.from(body.children) as HTMLElement[]) {
    if (child.id === "serverStatus") continue;
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
    renderPartInto(partEl, msgId, part, "inline", part.id === activePartId);
    placeAfter(body, partEl, anchor);
    anchor = partEl;
  }
}

function reconcileNestedUnits(parent: HTMLElement, msgId: string, units: ResolvedUnit[]): void {
  const wantedWorkIds = new Set(units
    .filter((unit): unit is ResolvedUnit & { kind: "work" } => unit.kind === "work" && !rendersAsDirectWorkItem(unit))
    .map(unit => unit.groupId!));
  const wantedPartIds = new Set(units
    .filter(unit => unit.kind === "inline" || rendersAsDirectWorkItem(unit))
    .map(unit => unit.parts[0].id));
  for (const child of Array.from(parent.children) as HTMLElement[]) {
    if (child.id === "serverStatus") continue;
    const workId = child.dataset.workId;
    const partId = child.dataset.partId;
    if (workId && !wantedWorkIds.has(workId)) removeWorkElement(child);
    else if (partId && !wantedPartIds.has(partId)) {
      child.remove();
      partEls.delete(partId);
    } else if (!workId && !partId) child.remove();
  }
  let anchor: HTMLElement | null = null;
  for (const unit of units) {
    let unitEl: HTMLElement;
    if (unit.kind === "work" && !rendersAsDirectWorkItem(unit)) {
      unitEl = ensureWorkElement(parent, unit.groupId!);
      renderWorkSection(unitEl, msgId, unit);
    } else {
      const part = unit.parts[0];
      unitEl = partEls.get(part.id) ?? document.createElement("div");
      unitEl.dataset.partId = part.id;
      partEls.set(part.id, unitEl);
      if (!unitEl.parentElement) parent.appendChild(unitEl);
      renderPartInto(unitEl, msgId, part, "inline");
    }
    placeAfter(parent, unitEl, anchor);
    anchor = unitEl;
  }
}

/** A single sub-session activity is already its own disclosure. */
function rendersAsDirectWorkItem(unit: ResolvedUnit): boolean {
  return unit.kind === "work" && !unit.conglomerate && unit.parts.length === 1;
}

function findWorkUnit(units: ResolvedUnit[], groupId: string): ResolvedUnit | undefined {
  for (const unit of units) {
    if (unit.kind === "work" && unit.groupId === groupId) return unit;
    const nested = unit.children ? findWorkUnit(unit.children, groupId) : undefined;
    if (nested) return nested;
  }
  return undefined;
}

/** Span of a work session, bounded by adjacent model output when available. */
function groupDurationMs(group: ResolvedUnit): number | undefined {
  const starts = group.parts.map(partStartedAt).filter((t): t is number => t !== undefined);
  const start = group.startedAt ?? (starts.length > 0 ? Math.min(...starts) : undefined);
  let end = group.endedAt;
  if (end === undefined && group.live) end = Date.now();
  if (end === undefined) {
    const thoughtEnds = group.parts
      .filter((part): part is Extract<MessagePart, { kind: "thought" }> => part.kind === "thought")
      .filter(part => part.startedAt !== undefined && part.durationMs !== undefined)
      .map(part => part.startedAt! + part.durationMs!);
    if (thoughtEnds.length > 0) end = Math.max(...thoughtEnds);
  }
  if (start === undefined || end === undefined) return undefined;
  const duration = Math.max(0, end - start);
  return group.live || duration >= 1000 ? duration : undefined;
}

function formatWorkedLabel(durationMs: number | undefined): string {
  if (durationMs === undefined) return "Worked";
  return `Worked for ${formatElapsedDuration(durationMs)}`;
}

function formatWorkingLabel(durationMs: number | undefined): string {
  if (durationMs === undefined) return "Working";
  return `Working for ${formatElapsedDuration(durationMs)}`;
}

function workActivities(parts: MessagePart[]): WorkActivity[] {
  return parts.flatMap((part): WorkActivity[] => {
    if (part.kind === "thought") return [{ kind: "thought" }];
    if (part.kind === "tool") {
      const resource = toolPath(part.card) || undefined;
      return [{
        kind: "tool",
        toolName: part.card.toolName,
        resource,
        createsNewFile: part.card.createsNewFile,
        status: part.card.status
      }];
    }
    return [];
  });
}

function textPresentationForUnit(
  m: Message,
  units: ResolvedUnit[],
  unit: ResolvedUnit
): "inline" | "answer" {
  const part = unit.parts[0];
  if (part?.kind !== "text") return "inline";
  // While the turn is live, every text run streams as inline model output —
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
  textPresentation: "inline" | "answer" = "inline",
  activeTool = false
): void {
  let cls = "";
  let html = "";
  if (part.kind === "thought") {
    if (el.className !== "part thought-part") el.className = "part thought-part";
    renderThoughtPart(el, msgId, part);
    return;
  } else if (part.kind === "text") {
    // Intermediate answers remain plain model output between tool calls.
    cls = `part text-part${textPresentation === "answer" ? " final-answer-part" : " intermediate-part"}`;
    html = textPresentation === "answer"
      ? `<div class="card answer bubble">${md.render(part.text)}</div>`
      : `<div class="assistant-markdown intermediate-answer">${md.render(part.text)}</div>`;
  } else if (part.kind === "tool") {
    if (el.className !== "part tool-part") el.className = "part tool-part";
    renderToolPart(el, part.card, activeTool);
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
    thinking.innerHTML = `<div class="thinking-head"><span class="thinking-icon" aria-hidden="true">${brainIcon()}</span><span class="thinking-label"></span>${chevronIcon()}</div>`;
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
    head.innerHTML = `<span class="thinking-icon" aria-hidden="true">${brainIcon()}</span><span class="thinking-label"></span>${chevronIcon()}`;
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
  // Only the leading word ("Thought"/"Thinking") carries the bold tool-name
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
  if (part.live) return { lead: "Thinking", rest: "" };
  if (part.durationMs !== undefined) {
    return { lead: "Thought", rest: ` for ${formatElapsedDuration(part.durationMs)}` };
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
  const wrapper = button.closest(".copy-code-block, .tool-change-card");
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

function renderToolPart(el: HTMLElement, tc: ToolCard, activeLabel = false): void {
  const card = directChild(el, "tool-card");
  if (!card) {
    el.innerHTML = renderToolCard(tc, activeLabel);
    return;
  }

  const cls = toolCardClass(tc);
  if (card.className !== cls) card.className = cls;
  card.dataset.toolCard = tc.toolId;
  renderToolHead(card, tc, activeLabel);

  let expanded = directChild(card, "tool-expanded");
  if (!toolBodyOpen(tc)) {
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

function renderToolHead(card: HTMLElement, tc: ToolCard, activeLabel = false): void {
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
  const headClass = toolHeadClass(tc, activeLabel);
  if (head.className !== headClass) head.className = headClass;
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
  const displayName = toolCardHeadName(tc, activeLabel);
  if (name.className !== "tool-name") name.className = "tool-name";
  if (name.textContent !== displayName) name.textContent = displayName;

  let label = head.querySelector(".tool-label") as HTMLElement | null;
  if (!label) {
    label = document.createElement("span");
    label.className = "tool-label";
    head.appendChild(label);
  }
  const labelClass = toolLabelClass(tc);
  if (label.className !== labelClass) label.className = labelClass;
  renderToolHeadLabel(label, tc);
  label.hidden = !label.textContent?.trim();

  directChild(head, "badge")?.remove();
  ensureToolDisclosure(head, expandable);
}

/**
 * Patch the head label in place. For write cards the ±stats change on every
 * progress frame. Keep the path and stat nodes mounted and update only their
 * text so changing counts remain visually stable.
 */
function renderToolHeadLabel(label: HTMLElement, tc: ToolCard): void {
  if (!isWriteToolCard(tc)) {
    setHtml(label, renderToolCardLabel(tc));
    return;
  }
  if (toolBodyOpen(tc) && writeHasVisibleDiff(tc)) {
    label.textContent = "";
    return;
  }
  let main = directChild(label, "tool-label-main");
  if (!main) {
    label.textContent = "";
    main = document.createElement("span");
    main.className = "tool-label-main";
    label.appendChild(main);
  }
  setHtml(main, renderToolPathLabel(tc));
  const stats = writeStats(tc);
  let group = directChild(label, "diff-stat-group");
  if (!stats) {
    group?.remove();
    return;
  }
  if (!group) {
    group = document.createElement("span");
    group.className = "diff-stat-group";
    group.innerHTML = `<span class="diff-stat add"></span><span class="diff-stat del"></span>`;
    label.appendChild(group);
  }
  updateDiffStat(group, "add", `+${stats.added}`);
  updateDiffStat(group, "del", `-${stats.removed}`);
}

function updateDiffStat(group: HTMLElement, kind: "add" | "del", text: string): void {
  const el = group.querySelector(`.diff-stat.${kind}`) as HTMLElement | null;
  if (!el || el.textContent === text) return;
  el.textContent = text;
}

function directChild(parent: HTMLElement, className: string): HTMLElement | null {
  for (const child of Array.from(parent.children)) {
    if (child instanceof HTMLElement && child.classList.contains(className)) return child;
  }
  return null;
}

function ensureDisclosureIcon(head: HTMLElement): void {
  const chevron = head.querySelector(":scope > .disclosure-icon");
  if (!chevron) head.insertAdjacentHTML("beforeend", chevronIcon());
  else if (chevron !== head.lastElementChild) head.appendChild(chevron);
}

/** The brain glyph that sits between the chevron and the "Thinking" label. */
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

/** Keep an expandable tool's disclosure chevron at the right edge. */
function ensureToolDisclosure(head: HTMLElement, expandable: boolean): void {
  const chevron = head.querySelector(":scope > .disclosure-icon");
  if (expandable) {
    if (!chevron) head.insertAdjacentHTML("beforeend", chevronIcon());
    else if (chevron !== head.lastElementChild) head.appendChild(chevron);
  } else {
    chevron?.remove();
  }
}

function updateComposer(): void {
  const pendingDecision = findPendingComposerDecision();
  const queue = root.querySelector("#messageQueue") as HTMLElement | null;
  if (queue) {
    const editingInput = document.activeElement?.hasAttribute("data-queued-edit-input")
      ? document.activeElement as HTMLInputElement
      : undefined;
    const selectionStart = editingInput?.selectionStart ?? undefined;
    const selectionEnd = editingInput?.selectionEnd ?? undefined;
    queue.hidden = state.queuedMessages.length === 0;
    setHtml(queue, state.queuedMessages.map((message, index) => `
      <div class="queued-message${state.editingQueuedMessageId === message.id ? " editing" : ""}">
        <span class="queued-message-order">${index + 1}</span>
        ${state.editingQueuedMessageId === message.id
          ? `<input class="queued-message-input" type="text" data-queued-edit-input="${escapeHtml(message.id)}" value="${escapeHtml(message.text)}" aria-label="Edit queued message" />
             <button class="queued-message-action save" type="button" data-save-queued="${escapeHtml(message.id)}" data-tip="Save" aria-label="Save queued message">${checkIcon()}</button>
             <button class="queued-message-action" type="button" data-cancel-queued-edit data-tip="Cancel" aria-label="Cancel editing">&times;</button>`
          : `<span class="queued-message-text">${escapeHtml(message.text)}</span>
             <button class="queued-message-action" type="button" data-edit-queued="${escapeHtml(message.id)}" data-tip="Edit" aria-label="Edit queued message">${pencilIcon()}</button>
             <button class="queued-message-action remove" type="button" data-remove-queued="${escapeHtml(message.id)}" data-tip="Remove" aria-label="Remove queued message">${trashIcon()}</button>`}
      </div>`).join(""));
    const nextEditingInput = queue.querySelector("[data-queued-edit-input]") as HTMLInputElement | null;
    if (nextEditingInput && nextEditingInput.value !== state.queuedMessageDraft) {
      nextEditingInput.value = state.queuedMessageDraft;
    }
    if (editingInput && nextEditingInput && editingInput !== nextEditingInput) {
      nextEditingInput.focus();
      nextEditingInput.setSelectionRange(selectionStart ?? nextEditingInput.value.length, selectionEnd ?? nextEditingInput.value.length);
    }
  }
  const approvalSlot = root.querySelector("#approvalSlot") as HTMLElement | null;
  const input = root.querySelector("#input") as HTMLTextAreaElement | null;
  if (input) {
    const active = document.activeElement === input;
    const placeholder = state.busy ? "Follow-up message..." : state.pendingPlanRejection ? "Suggest changes to the plan…" : state.planMode ? "Plan mode — model is read-only" : "Message…";
    if (input.placeholder !== placeholder) input.placeholder = placeholder;
    if (!active && input.value !== state.draft) input.value = state.draft;
    input.style.display = pendingDecision ? "none" : "";
    if (!pendingDecision) resizeComposerInput(input);
  }
  if (approvalSlot) {
    approvalSlot.style.display = pendingDecision ? "" : "none";
    const html = pendingDecision ? renderApprovalComposer(pendingDecision) : "";
    setHtml(approvalSlot, html);
    syncQuestionOther(approvalSlot, pendingDecision);
  }
  const sendSlot = root.querySelector("#sendSlot") as HTMLElement | null;
  if (sendSlot && renderedBusy !== state.busy) {
    const html = state.busy
      ? `<button id="queueMessage" class="send-btn" data-tip="Queue message" aria-label="Queue message">${sendIcon()}</button><button id="cancel" class="send-btn cancel-btn" data-tip="Cancel" aria-label="Cancel">${stopIcon()}</button>`
      : `<button id="send" class="send-btn" data-tip="Send" aria-label="Send">${sendIcon()}</button>`;
    sendSlot.innerHTML = html;
    renderedBusy = state.busy;
  }
  root.querySelector(".composer-row")?.classList.toggle("busy", state.busy);
  if (sendSlot) sendSlot.style.display = pendingDecision ? "none" : "";
  updatePlanModeControl();
  updateThinkingModeControl();
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

const MAX_COMPOSER_LINES = 20;

function resizeComposerInput(input: HTMLTextAreaElement): void {
  input.style.height = "auto";
  const style = getComputedStyle(input);
  const lineHeight = Number.parseFloat(style.lineHeight) || 20;
  const verticalChrome = Number.parseFloat(style.paddingTop)
    + Number.parseFloat(style.paddingBottom)
    + Number.parseFloat(style.borderTopWidth)
    + Number.parseFloat(style.borderBottomWidth);
  const maxHeight = Math.ceil((lineHeight * MAX_COMPOSER_LINES) + verticalChrome);
  const contentHeight = input.scrollHeight;
  input.style.height = `${Math.min(contentHeight, maxHeight)}px`;
  input.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
}

/**
 * Keep the "other" answer field in step with state.questionDraft (restoring it
 * when the box is re-mounted) and enable Answer only once it has text. The box
 * HTML is static, so the field's live value otherwise survives re-renders.
 */
function syncQuestionOther(slot: HTMLElement, pendingDecision: ComposerDecision | undefined): void {
  const isQuestion = pendingDecision?.kind === "tool" && pendingDecision.tool.category === "question";
  if (!isQuestion) return;
  const other = slot.querySelector("#questionOther") as HTMLTextAreaElement | null;
  if (!other) return;
  if (document.activeElement !== other && other.value !== state.questionDraft) {
    other.value = state.questionDraft;
  }
  const submit = slot.querySelector("[data-answer-submit]") as HTMLButtonElement | null;
  if (submit) submit.disabled = other.value.trim() === "";
}

function findPendingComposerDecision(): ComposerDecision | undefined {
  for (const m of state.messages) {
    for (const tc of m.toolCards) {
      if (
        tc.status === "pending" &&
        !hiddenApprovalToolIds.has(tc.toolId) &&
        (tc.approvalRequired || tc.category === "question")
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
  if (decision.tool.category === "question") return renderQuestionComposer(decision.tool);
  return renderToolApprovalComposer(decision.tool);
}

interface QuestionPayload {
  question: string;
  suggestions: string[];
}

function parseQuestionPayload(tc: ToolCard): QuestionPayload {
  try {
    const parsed = JSON.parse(tc.argsJson) as { question?: unknown; suggestions?: unknown };
    const question = typeof parsed.question === "string" ? parsed.question : "";
    const suggestions = Array.isArray(parsed.suggestions)
      ? parsed.suggestions.filter((s): s is string => typeof s === "string")
      : [];
    return { question, suggestions };
  } catch {
    return { question: "", suggestions: [] };
  }
}

function renderQuestionComposer(tc: ToolCard): string {
  const { question, suggestions } = parseQuestionPayload(tc);
  // Use the chat's Markdown pipeline verbatim so fenced/indented code gets the
  // same syntax highlighting and delegated copy control as assistant output.
  const renderedQuestion = md.render(question || "Question");
  const options = suggestions
    .map(
      s =>
        `<button class="question-option" type="button" data-answer-option="${tc.toolId}" data-answer="${escapeHtml(s)}">${escapeHtml(s)}</button>`
    )
    .join("");
  return `<div class="approval-composer question-composer">
    <div class="approval-summary question-summary">
      <span class="tool-icon" aria-hidden="true">${questionIcon()}</span>
      <div class="assistant-markdown question-markdown">${renderedQuestion}</div>
    </div>
    <div class="question-options">${options}</div>
    <div class="question-other">
      <textarea id="questionOther" class="question-other-input" rows="1" placeholder="Or type your own answer…"></textarea>
      <button class="question-submit" type="button" data-answer-submit="${tc.toolId}" data-tip="Answer" aria-label="Answer" disabled>${sendIcon()}</button>
    </div>
  </div>`;
}

function submitQuestionAnswer(toolId: string, answer: string): void {
  if (!answer) return;
  hiddenApprovalToolIds.add(toolId);
  send({ type: "answerQuestion", toolId, answer });
  state.questionDraft = "";
  render();
}

function renderToolApprovalComposer(tc: ToolCard): string {
  const isWrite = tc.category === "write";
  const approveText = isWrite ? "Accept changes" : "Approve";
  const rejectText = isWrite ? "Reject changes and suggest changes" : "Reject";
  const label = renderToolApprovalLabel(tc);
  const approvalHint = approvalHintForCategory(tc.category);
  return `<div class="approval-composer">
    <div class="approval-summary">
      <span class="tool-icon" aria-hidden="true">${toolIcon(tc)}</span>
      <strong>${escapeHtml(toolApprovalName(tc))}</strong>
      <span>${label}</span>
    </div>
    ${approvalHint ? `<div class="command-approval-hint">${escapeHtml(approvalHint)}</div>` : ""}
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

function updatePlanModeControl(): void {
  const toggle = root.querySelector("#planMode") as HTMLButtonElement | null;
  const selectedLabel = state.planMode ? "Plan" : "Normal";
  const hint = `Mode (${selectedLabel})`;
  toggle?.classList.toggle("active", state.planModeMenuOpen);
  toggle?.setAttribute("aria-expanded", String(state.planModeMenuOpen));
  toggle?.setAttribute("aria-label", hint);
  if (toggle) toggle.dataset.composerModeHint = hint;
  const icon = root.querySelector("#planModeIcon") as HTMLElement | null;
  if (icon) {
    const html = state.planMode ? scrollIcon() : pawnIcon();
    if (icon.dataset.html !== html) {
      icon.dataset.html = html;
      icon.innerHTML = html;
    }
  }
  const menu = root.querySelector("#planModeMenu") as HTMLElement | null;
  if (menu) menu.hidden = !state.planModeMenuOpen;
  root.querySelectorAll<HTMLElement>("[data-plan-mode]").forEach(option => {
    const selected = (option.dataset.planMode === "true") === state.planMode;
    updateModeMenuOption(option, selected);
  });
}

function updateThinkingModeControl(): void {
  const toggle = root.querySelector("#thinkingMode") as HTMLButtonElement | null;
  const hint = `Intelligence (${thinkingModeHintLabel(state.thinkingMode)})`;
  toggle?.classList.toggle("active", state.thinkingModeMenuOpen);
  toggle?.setAttribute("aria-expanded", String(state.thinkingModeMenuOpen));
  toggle?.setAttribute("aria-label", hint);
  if (toggle) toggle.dataset.composerModeHint = hint;
  const menu = root.querySelector("#thinkingModeMenu") as HTMLElement | null;
  if (menu) menu.hidden = !state.thinkingModeMenuOpen;
  root.querySelectorAll<HTMLElement>("[data-thinking-mode]").forEach(option => {
    const selected = option.dataset.thinkingMode === state.thinkingMode;
    updateModeMenuOption(option, selected);
  });
}

function updateModeMenuOption(option: HTMLElement, selected: boolean): void {
  option.classList.toggle("selected", selected);
  option.setAttribute("aria-checked", String(selected));
  const check = option.querySelector(".mode-select-check") as HTMLElement | null;
  if (!check) return;
  const html = selected ? checkIcon() : "";
  if (check.dataset.html !== html) {
    check.dataset.html = html;
    check.innerHTML = html;
  }
}

function thinkingModeHintLabel(mode: ThinkingMode): string {
  return mode[0].toUpperCase() + mode.slice(1);
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

function renderToolCard(tc: ToolCard, activeLabel = false): string {
  const cls = toolCardClass(tc);
  const labelClass = toolLabelClass(tc);
  const commandLabel = renderToolCardLabel(tc);
  const expandable = isExpandableTool(tc);
  const bodyOpen = toolBodyOpen(tc);
  const expanded = bodyOpen ? renderToolExpandedHtml(tc) : "";
  const disclosure = expandable ? chevronIcon() : "";
  const toggleAttr = expandable ? ` data-tool-toggle="${tc.toolId}"` : "";
  const labelHidden = commandLabel ? "" : " hidden";
  return `<div class="${cls}" data-tool-card="${tc.toolId}">
    <div class="${toolHeadClass(tc, activeLabel)}"${toggleAttr}>
      <span class="tool-icon" aria-hidden="true">${toolIcon(tc)}</span>
      <strong class="tool-name">${escapeHtml(toolCardHeadName(tc, activeLabel))}</strong>
      <span class="${labelClass}"${labelHidden}>${commandLabel}</span>
      ${disclosure}
    </div>
    ${bodyOpen ? `<div class="tool-expanded">${expanded}</div>` : ""}
  </div>`;
}

function isExpandableTool(tc: ToolCard): boolean {
  // Successful reads stay compact, but a failed/rejected read must expose its
  // diagnostic just like every other erroneous tool call.
  return (tc.toolName !== "read_file" || isErrorToolCard(tc)) &&
    !(tc.toolName === "compact_context" && tc.status === "pending");
}

/** Whether the card's expanded body should be shown right now. */
function toolBodyOpen(tc: ToolCard): boolean {
  return isExpandableTool(tc) && tc.expanded;
}

function toolCardClass(tc: ToolCard): string {
  const toolClass = tc.toolName === "list_dir"
    ? " list-dir"
    : tc.toolName === "update_todos"
      ? " update-todos"
      : "";
  const outputClass = usesOutputSurface(tc) ? " output-surface-tool" : "";
  const processClass = tc.processRunning ? " process-running" : "";
  return "tool-card " + tc.category + " " + tc.status + toolClass + outputClass + processClass + (toolBodyOpen(tc) ? " open" : "");
}

function usesOutputSurface(tc: ToolCard): boolean {
  return tc.toolName === "list_dir" || tc.toolName === "glob" || tc.toolName === "update_todos" ||
    isWriteToolCard(tc) || isCommandTool(tc) || !!tc.resultPreview;
}

function toolHeadClass(tc: ToolCard, activeLabel = false): string {
  const active = !isErrorToolCard(tc) && (activeLabel || isActiveToolCard(tc));
  return "tool-head" + (active ? " active-tool-head" : "");
}

function toolLabelClass(tc: ToolCard): string {
  const edit = isWriteToolCard(tc) && writeStats(tc) ? " edit-label" : "";
  return "tool-label" + edit;
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

function renderToolExpandedHtml(tc: ToolCard): string {
  const resultIsError = tc.status === "failed" || tc.status === "rejected";
  if (resultIsError) return renderErroredToolExpandedHtml(tc);

  if (tc.toolName === "update_todos") {
    const todos = todosFromCard(tc);
    if (todos.length === 0) {
      const content = tc.resultPreview ? renderToolResult(tc, false) : "";
      return renderToolOutputSurface(content, false);
    }
    return renderToolOutputSurface(`<ul class="todo-list todo-list-timeline">${renderTodoRows(todos)}</ul>`, false);
  }
  if (tc.toolName === "list_dir" || tc.toolName === "glob") {
    const list = renderFileListHtml(tc);
    if (list) return renderToolOutputSurface(list, false);
    // Fall through to the raw preview if the result didn't parse.
  }
  const command = isCommandTool(tc) ? toolCommand(tc) : "";
  const stopProcessAction = (tc.toolName === "run_command" || tc.toolName === "run_process") && tc.processJobId && tc.processRunning
    ? `<button class="copy-btn code-block-stop" type="button" data-stop-process="${escapeHtml(tc.processJobId)}" data-tip="${tc.processStopping ? "Stopping process" : "Stop process"}" aria-label="${tc.processStopping ? "Stopping process" : "Stop process"}" ${tc.processStopping ? "disabled" : ""}>${stopIcon()}</button>`
    : "";
  const commandBlock = command ? renderCopyableCodeBlock(command, "bash", "$ ", stopProcessAction) : "";
  // A successful file edit already shows the full diff, so its "Out: wrote N
  // bytes" preview is redundant — drop it (but keep error output).
  const hideWriteOut = isWriteToolCard(tc) && !resultIsError;
  const result = tc.resultPreview && !hideWriteOut
    ? renderToolResult(tc, resultIsError)
    : "";
  const diff = isWriteToolCard(tc)
    ? renderWriteExpandedState(tc)
    : "";
  const surfaceClass = isWriteToolCard(tc) && diff ? " edit-diff-surface" : "";
  return renderToolOutputSurface(`${commandBlock}${diff}${result}`, false, surfaceClass);
}

/**
 * Failed commands mirror the successful command layout: the attempted command
 * and its diagnostic share one surface, separated by the standard divider. The
 * whole surface is red so it still reads as an error.
 *
 * Other tools keep their attempted context neutral and put only the diagnostic
 * in the shared red error surface. In particular, edit-diff-surface deliberately
 * has a transparent background; combining it with the error class used to make
 * revision-mismatch messages look like unboxed red text.
 */
function renderErroredToolExpandedHtml(tc: ToolCard): string {
  const command = isCommandTool(tc) ? toolCommand(tc) : "";
  const commandBlock = command ? renderCopyableCodeBlock(command, "bash", "$ ") : "";
  const diagnostic = renderToolResult(tc, true);
  if (isCommandTool(tc)) {
    return renderToolOutputSurface(commandBlock + diagnostic, true);
  }
  if (isWriteToolCard(tc)) {
    return renderChangeCard(tc, toolResultDetail(tc));
  }
  const diff = isWriteToolCard(tc) ? renderWriteExpandedState(tc) : "";
  const context = commandBlock + diff;
  const contextClass = isWriteToolCard(tc) && diff ? " edit-diff-surface" : "";
  const contextSurface = renderToolOutputSurface(context, false, contextClass);
  return contextSurface + renderToolOutputSurface(diagnostic, true);
}

function renderToolOutputSurface(content: string, error: boolean, extraClass = ""): string {
  if (!content) return "";
  return `<div class="tool-output-surface${error ? " error" : ""}${extraClass}">${content}</div>`;
}

function renderToolResult(tc: ToolCard, error: boolean): string {
  const text = toolResultDetail(tc);
  if (!text) return "";
  return error
    ? `<div class="tool-error-result">${escapeHtml(text)}</div>`
    : `<pre class="tool-result">${escapeHtml(text)}</pre>`;
}

function toolResultDetail(tc: ToolCard): string {
  const text = tc.resultPreview ?? "";
  // Older saved command results may predate output sanitization. Clean them at
  // render time as well so reopening a chat cannot expose ANSI control glyphs.
  if (isCommandTool(tc)) return sanitizeTerminalText(text);
  if (tc.toolName !== "tool_call") return text;
  // The first malformed-call line is represented compactly in the card head.
  // Keep the remaining diagnostic and raw arguments in the expanded surface.
  const lines = text.split("\n");
  return lines.slice(1).join("\n");
}

function renderWriteExpandedState(tc: ToolCard): string {
  const steps = renderEditStepsHtml(tc);
  if (tc.diffPreview) return renderChangeCard(tc);
  if (tc.status === "failed" || tc.status === "rejected") return steps;
  // Mount the finished diff card's header immediately. Its live path, operation,
  // and +/- stats stay in place while the body is still being generated.
  return renderChangeCard(tc);
}

/**
 * The exact tool call behind a single (ungrouped) edit card, with its target
 * lines, e.g. "Edit  replace_range 10-12". The "Edit file" header alone hides
 * whether write_file, insert_text, or replace_range ran — which is exactly
 * what the user needs to attribute a mistargeted edit.
 */
function renderEditStepsHtml(tc: ToolCard): string {
  if (!isWriteToolCard(tc)) return "";
  return `<div class="edit-steps"><span class="edit-steps-label">Edit</span><span class="edit-step">${escapeHtml(editStepLabel(tc))}</span></div>`;
}

/** Short per-call label for an edit: tool name plus the lines it targeted. */
function editStepLabel(tc: ToolCard): string {
  const args = editDisplayArgs(tc);
  const toolName = tc.toolName;
  if (toolName === "insert_text") {
    const line = readRangeNumber(args.line ?? args.lineNumber ?? args.line_number);
    return line !== undefined ? `insert_text @${line}` : "insert_text";
  }
  if (toolName === "replace_range") {
    const start = readRangeNumber(args.startLine ?? args.start_line ?? args.start);
    const end = readRangeNumber(args.endLine ?? args.end_line ?? args.end);
    return start !== undefined && end !== undefined
      ? `replace_range ${start}-${end}`
      : "replace_range";
  }
  return toolName;
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
  if (tc.toolName === "ask_user_question") return questionIcon();
  if (isCommandTool(tc)) return terminalIcon();
  if (isWriteToolCard(tc)) return pencilIcon();
  if (tc.toolName === "read_file") return readFileIcon();
  return searchIcon();
}

function isCommandTool(tc: ToolCard): boolean {
  return tc.toolName === "run_command" || tc.toolName === "run_process" ||
    tc.toolName === "wait_process" || tc.toolName === "stop_process" ||
    tc.category === "safeCmd" || tc.category === "command" || tc.category === "process";
}

function isWriteToolCard(tc: ToolCard): boolean {
  return tc.category === "write" || ["write_file", "create_file", "edit_file", "insert_text", "replace_range"].includes(tc.toolName);
}

function renderChangeCard(tc: ToolCard, errorText?: string): string {
  const path = toolPath(tc);
  const hasError = errorText !== undefined;
  const hasDiff = !hasError && !!tc.diffPreview;
  const stats = hasError ? undefined : writeStats(tc);
  const operation = editOperationLabel(tc.toolName, editDisplayArgs(tc));
  const copyText = (tc.diffPreview ?? "").split("\n").map(line => {
    const parsed = parseDiffLine(line);
    return `${parsed.marker ? `${parsed.marker} ` : "  "}${parsed.code}`;
  }).join("\n");
  return `<div class="tool-change-card${hasDiff || hasError ? "" : " pending-diff"}${hasError ? " error-diff" : ""}">
    <div class="tool-change-head">
      <button class="tool-change-path" type="button" data-open-file="${escapeHtml(path)}">${escapeHtml(path || "Edited file")}</button>
      ${stats ? diffStatHtml(stats) : ""}
      ${operation ? `<span class="tool-change-operation">${escapeHtml(operation)}</span>` : ""}
      ${hasDiff ? `<button class="copy-btn tool-change-copy" type="button" data-copy-code aria-label="Copy diff">${copyIcon()}</button>` : ""}
    </div>
    ${hasError
      ? `<div class="tool-change-error">${escapeHtml(errorText)}</div>`
      : hasDiff
        ? `<pre class="tool-diff edit-preview change-diff">${renderDiffLines(tc.diffPreview ?? "", path)}</pre>
    <span class="copy-code-source tool-change-copy-source">${escapeHtml(copyText)}</span>`
        : ""}
  </div>`;
}

/** Merge progressively parsed line locations into the eventual tool arguments. */
function editDisplayArgs(tc: ToolCard): Record<string, unknown> {
  const args = { ...toolArgs(tc) };
  if (args.startLine === undefined && tc.progress?.startLine !== undefined) args.startLine = tc.progress.startLine;
  if (args.endLine === undefined && tc.progress?.endLine !== undefined) args.endLine = tc.progress.endLine;
  if (args.line === undefined && tc.progress?.line !== undefined) args.line = tc.progress.line;
  return args;
}

function renderDiffLines(diff: string, filePath: string): string {
  const language = highlightLanguageForPath(filePath);
  const lines = diff.split("\n").map(line => {
    const parsed = parseDiffLine(line);
    const lineNumber = parsed.kind === "del"
      ? parsed.oldLine
      : parsed.newLine || parsed.oldLine;
    return `<span class="diff-line ${parsed.kind}">
      <span class="diff-no">${escapeHtml(lineNumber)}</span>
      <span class="diff-code">${highlightCode(parsed.code, language)}</span>
    </span>`;
  }).join("");
  // One intrinsic-width grid makes every row share the longest line's width,
  // so row backgrounds continue through the full horizontal scroll extent.
  return `<span class="diff-lines">${lines}</span>`;
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

/** Header name for a tool card. */
function toolCardHeadName(tc: ToolCard, activeLabel = false): string {
  if (tc.toolName === "run_command" || tc.toolName === "run_process") {
    return tc.processRunning ? "Running command" : commandToolLabel(tc.status);
  }
  if (!isErrorToolCard(tc) && (activeLabel || isActiveToolCard(tc))) {
    return activeToolLabel(tc.toolName, tc.createsNewFile);
  }
  if (isErrorToolCard(tc)) return erroredToolLabel(tc.toolName, tc.status);
  if (tc.status === "executed") return settledToolLabel(tc.toolName, tc.createsNewFile);
  return toolDisplayName(tc.toolName);
}

function toolApprovalName(tc: ToolCard): string {
  if (isWriteToolCard(tc)) return tc.createsNewFile ? "Create file" : "Edit file";
  return toolDisplayName(tc.toolName);
}

function isActiveToolCard(tc: ToolCard): boolean {
  return tc.processRunning === true || tc.status === "streaming" || tc.status === "pending" || tc.status === "approved";
}

function isErrorToolCard(tc: ToolCard): tc is ToolCard & { status: "failed" | "rejected" } {
  return tc.status === "failed" || tc.status === "rejected";
}

function toolDisplayName(toolName: string): string {
  const aliases: Record<string, string> = {
    read_file: "Read file",
    list_dir: "Read directory",
    write_file: "Write file",
    create_file: "Create file",
    edit_file: "Edit file",
    insert_text: "Edit file",
    replace_range: "Edit file",
    glob: "Find files",
    run_command: "Run command",
    run_process: "Run command",
    wait_process: "Wait for process",
    stop_process: "Stop process",
    update_todos: "Update todos",
    ask_user_question: "Ask question",
    compact_context: "Compact context"
  };
  return aliases[toolName] ?? toolName;
}

function toolCardLabel(tc: ToolCard): string {
  if (tc.toolName === "tool_call") return "Could not be parsed; nothing was executed";
  if (tc.toolName === "read_file" || tc.toolName === "list_dir" || isWriteToolCard(tc)) {
    const path = toolPath(tc);
    const stats = isWriteToolCard(tc) ? writeStats(tc) : undefined;
    if (stats) return `${path} +${stats.added} -${stats.removed}`;
    return path;
  }
  if (tc.toolName === "glob") return String(toolArgs(tc).pattern ?? "");
  if (tc.toolName === "run_command" || tc.toolName === "run_process") {
    // The expanded command surface shows the full, copyable command directly
    // below the heading. Keep the compact summary only while the card is
    // collapsed so the same command is not repeated on adjacent rows.
    return toolBodyOpen(tc) ? "" : toolCommand(tc);
  }
  if (tc.toolName === "compact_context") return "";
  return "";
}

function writeStats(tc: ToolCard): { added: number; removed: number } | undefined {
  // Streaming counts describe the proposed payload, not a disk mutation. Once
  // an individual write fails or is rejected, do not present them as changes.
  if (isErrorToolCard(tc)) return undefined;
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
  if (tc.toolName === "update_todos") {
    const todos = todosFromCard(tc);
    const done = todos.filter(t => t.status === "completed").length;
    return `<span class="tool-label-text">(${done}/${todos.length})</span>`;
  }
  if (isWriteToolCard(tc)) {
    if (toolBodyOpen(tc) && writeHasVisibleDiff(tc)) return "";
    // Same node structure the in-place patcher (renderToolHeadLabel) maintains,
    // so a string-rendered card hands over cleanly to targeted updates.
    const stats = writeStats(tc);
    return `<span class="tool-label-main">${renderToolPathLabel(tc)}</span>` + (stats ? diffStatHtml(stats) : "");
  }
  if (tc.toolName === "read_file") return renderToolPathLabel(tc) + readRangeHtml(tc);
  if (tc.toolName === "ask_user_question") {
    const { question } = parseQuestionPayload(tc);
    const answer = answeredValue(tc);
    const answered = answer ? `<span class="question-answered">→ ${escapeHtml(answer)}</span>` : "";
    return `<span class="tool-label-text">${escapeHtml(question)}</span>${answered}`;
  }
  const label = toolCardLabel(tc);
  return label ? `<span class="tool-label-text">${escapeHtml(label)}</span>` : "";
}

function writeHasVisibleDiff(tc: ToolCard): boolean {
  return isWriteToolCard(tc);
}

/** The answer the user gave to an ask_user_question card, once resolved. */
function answeredValue(tc: ToolCard): string | undefined {
  if (tc.status !== "executed" || !tc.resultPreview) return undefined;
  const match = /^the user has answered your question: "([\s\S]*)"$/.exec(tc.resultPreview);
  return match ? match[1] : undefined;
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
  const filePath = toolPath(tc);
  const rangeText = start !== undefined && end !== undefined ? `${start}-${end}` : `${start ?? end}`;
  const jumpLine = start ?? end;
  // Same link styling as the path so it shares its colour (no hover-brighten),
  // and clicking it opens the file at the range's first line.
  if (!filePath) return `<span class="tool-label-text read-range">(${escapeHtml(rangeText)})</span>`;
  return `<button class="tool-path-link read-range" type="button" data-open-file="${escapeHtml(filePath)}" data-open-line="${jumpLine}">(${escapeHtml(rangeText)})</button>`;
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
  const args = toolArgs(tc);
  if (tc.toolName === "run_process") {
    const argv = Array.isArray(args.args) ? args.args.filter(value => typeof value === "string") : [];
    return [String(args.program ?? ""), ...argv].join(" ").trim();
  }
  return String(args.command ?? "");
}

function toolArgs(tc: ToolCard): Record<string, unknown> {
  try {
    return normalizeToolArgsForDisplay(JSON.parse(tc.argsJson));
  } catch {
    return normalizeToolArgsForDisplay(tc.argsJson);
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
        const previousPart = msg.parts[msg.parts.length - 1];
        appendPartText(msg, e.kind, e.text);
        if (e.kind === "text") {
          restoredText += e.text;
          const textPart = msg.parts[msg.parts.length - 1];
          if (textPart?.kind === "text" && textPart !== previousPart) {
            textPart.startedAt = typeof e.t === "number" ? e.t : undefined;
          }
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
  const restoredStarts = msg.parts.map(partStartedAt).filter((t): t is number => t !== undefined);
  if (restoredStarts.length > 0) {
    msg.workStartedAt = Math.min(msg.workStartedAt ?? Infinity, ...restoredStarts);
  }
  // appendPartText marks work as started; finalize it so a restored message is
  // never treated as live (its work parts collapse into a labelled group).
  if (msg.workStartedAt !== undefined && msg.workEndedAt === undefined) {
    msg.workEndedAt = restoredStarts.length > 0 ? Math.max(...restoredStarts) : msg.workStartedAt;
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
  // Close either drop-up before an outside click is handled. Pointerdown also
  // catches clicks outside #app while allowing the eventual click to keep its
  // normal behavior without selecting or changing a menu option.
  document.addEventListener("pointerdown", e => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const next = modeMenusAfterPointerDown(state, {
      inPlanModeGroup: !!target.closest(".plan-mode-group"),
      inThinkingModeGroup: !!target.closest(".thinking-mode-group")
    });
    const changed = next.planModeMenuOpen !== state.planModeMenuOpen ||
      next.thinkingModeMenuOpen !== state.thinkingModeMenuOpen;
    state.planModeMenuOpen = next.planModeMenuOpen;
    state.thinkingModeMenuOpen = next.thinkingModeMenuOpen;
    if (changed) render();
  });
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
    resizeComposerInput(input);
  });
  input?.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  });
  window.addEventListener("resize", () => {
    const composerInput = root.querySelector("#input") as HTMLTextAreaElement | null;
    if (composerInput && composerInput.style.display !== "none") resizeComposerInput(composerInput);
  });
  // The ask_user_question "other" field is mounted dynamically, so its events are
  // handled by delegation: keep the draft in sync and submit on Enter.
  root.addEventListener("input", e => {
    const other = e.target as HTMLElement | null;
    if (other?.hasAttribute("data-queued-edit-input")) {
      state.queuedMessageDraft = (other as HTMLInputElement).value;
      return;
    }
    if (other?.hasAttribute("data-edit-input")) {
      state.editDraft = (other as HTMLTextAreaElement).value;
      const submitBtn = root.querySelector("[data-edit-submit]") as HTMLButtonElement | null;
      if (submitBtn) submitBtn.disabled = state.editDraft.trim() === "";
      return;
    }
    if (other?.id !== "questionOther") return;
    state.questionDraft = (other as HTMLTextAreaElement).value;
    const submitBtn = root.querySelector("[data-answer-submit]") as HTMLButtonElement | null;
    if (submitBtn) submitBtn.disabled = state.questionDraft.trim() === "";
  });
  root.addEventListener("keydown", e => {
    const other = e.target as HTMLElement | null;
    if (e.key === "Escape" && (state.planModeMenuOpen || state.thinkingModeMenuOpen)) {
      e.preventDefault();
      state.planModeMenuOpen = false;
      state.thinkingModeMenuOpen = false;
      render();
      return;
    }
    if (other?.hasAttribute("data-queued-edit-input")) {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelQueuedMessageEdit();
      } else if (e.key === "Enter") {
        e.preventDefault();
        saveQueuedMessageEdit();
      }
      return;
    }
    if (other?.hasAttribute("data-edit-input")) {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelMessageEdit();
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submitMessageEdit();
      }
      return;
    }
    if (other?.id !== "questionOther" || e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    const submitBtn = root.querySelector("[data-answer-submit]") as HTMLButtonElement | null;
    const toolId = submitBtn?.dataset.answerSubmit;
    if (toolId) submitQuestionAnswer(toolId, state.questionDraft.trim());
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
    const composerModeAction = (e.target as HTMLElement).closest("[data-composer-mode-hint]") as HTMLElement | null;
    if (composerModeAction) setComposerModeHint(composerModeAction.dataset.composerModeHint);
    const messageAction = (e.target as HTMLElement).closest("[data-message-action-hint]") as HTMLElement | null;
    if (messageAction) setMessageActionHint(messageAction, messageAction.dataset.messageActionHint);
    const target = (e.target as HTMLElement).closest("[data-tip]") as HTMLElement | null;
    if (target) showTooltip(target);
  });
  root.addEventListener("pointerout", e => {
    const titleAction = (e.target as HTMLElement).closest("[data-title-hint]") as HTMLElement | null;
    const headerAction = (e.target as HTMLElement).closest("[data-header-hint]") as HTMLElement | null;
    const composerModeAction = (e.target as HTMLElement).closest("[data-composer-mode-hint]") as HTMLElement | null;
    const next = e.relatedTarget as HTMLElement | null;
    if (titleAction && !(next?.closest?.("[data-title-hint]"))) setTitleHint(undefined);
    if (headerAction && !(next?.closest?.("[data-header-hint]"))) setHeaderHint(undefined);
    if (composerModeAction && !composerModeAction.contains(next)) setComposerModeHint(undefined);
    const messageAction = (e.target as HTMLElement).closest("[data-message-action-hint]") as HTMLElement | null;
    if (messageAction && !messageAction.contains(next)) setMessageActionHint(messageAction, undefined);
    const target = (e.target as HTMLElement).closest("[data-tip]") as HTMLElement | null;
    if (target && !target.contains(e.relatedTarget as Node | null)) hideTooltip(target);
  });
  root.addEventListener("pointermove", refreshTooltip);
  root.addEventListener("focusin", e => {
    const titleAction = (e.target as HTMLElement).closest("[data-title-hint]") as HTMLElement | null;
    if (titleAction) setTitleHint(titleAction.dataset.titleHint);
    const headerAction = (e.target as HTMLElement).closest("[data-header-hint]") as HTMLElement | null;
    if (headerAction) setHeaderHint(headerAction.dataset.headerHint);
    const composerModeAction = (e.target as HTMLElement).closest("[data-composer-mode-hint]") as HTMLElement | null;
    if (composerModeAction) setComposerModeHint(composerModeAction.dataset.composerModeHint);
    const messageAction = (e.target as HTMLElement).closest("[data-message-action-hint]") as HTMLElement | null;
    if (messageAction) setMessageActionHint(messageAction, messageAction.dataset.messageActionHint);
    const target = (e.target as HTMLElement).closest("[data-tip]") as HTMLElement | null;
    if (target) showTooltip(target);
  });
  root.addEventListener("focusout", e => {
    const next = e.relatedTarget as HTMLElement | null;
    if (!(next?.closest?.("[data-title-hint]"))) setTitleHint(undefined);
    if (!(next?.closest?.("[data-header-hint]"))) setHeaderHint(undefined);
    if (!(next?.closest?.("[data-composer-mode-hint]"))) setComposerModeHint(undefined);
    const messageAction = (e.target as HTMLElement).closest("[data-message-action-hint]") as HTMLElement | null;
    if (messageAction && !messageAction.contains(next)) setMessageActionHint(messageAction, undefined);
    const target = (e.target as HTMLElement).closest("[data-tip]") as HTMLElement | null;
    if (target) hideTooltip(target);
  });
  window.addEventListener("resize", refreshTooltip);
  window.addEventListener("resize", syncShimmerAnimations);
  window.addEventListener("scroll", refreshTooltip, true);
  root.addEventListener("pointerdown", e => {
    const target = e.target as HTMLElement;
    if (target.closest("#cancel")) {
      e.preventDefault();
      send({ type: "cancel" });
      return;
    }
    const workEl = target.closest("[data-work-toggle]") as HTMLElement | null;
    if (workEl && !target.closest("button")) {
      e.preventDefault();
      const groupId = workEl.dataset.workToggle!;
      const m = state.messages.find(x => findWorkUnit(resolveRenderUnits(x), groupId));
      if (m) {
        const group = findWorkUnit(resolveRenderUnits(m), groupId);
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
          if (tc.expanded && isWriteToolCard(tc)) {
            if (tc.status === "executed" && !tc.diffPreview && !tc.diffRequested) {
              tc.diffRequested = true;
              send({ type: "requestToolDiff", toolId: tc.toolId });
            }
          }
          state.autoScroll = false;
          render();
          return;
        }
      }
    }
    const stopProcess = target.closest("[data-stop-process]") as HTMLButtonElement | null;
    if (stopProcess) {
      e.preventDefault();
      const jobId = stopProcess.dataset.stopProcess!;
      for (const message of state.messages) {
        for (const card of message.toolCards) {
          if (card.processJobId === jobId) card.processStopping = true;
        }
      }
      send({ type: "stopProcess", jobId });
      render();
      return;
    }
  });
  root.addEventListener("click", e => {
    const target = e.target as HTMLElement;
    const planOption = target.closest("[data-plan-mode]") as HTMLElement | null;
    if (planOption) {
      const on = planOption.dataset.planMode === "true";
      state.planMode = on;
      state.planModeMenuOpen = false;
      setComposerModeHint(undefined);
      send({ type: "setPlanMode", on });
      render();
      return;
    }
    const thinkingOption = target.closest("[data-thinking-mode]") as HTMLElement | null;
    if (thinkingOption) {
      const mode = thinkingOption.dataset.thinkingMode as ThinkingMode;
      state.thinkingMode = mode;
      state.thinkingModeMenuOpen = false;
      setComposerModeHint(undefined);
      send({ type: "setThinkingMode", mode });
      render();
      return;
    }
    const recentChat = target.closest("[data-open-chat]") as HTMLElement | null;
    if (recentChat) {
      send({ type: "openChat", id: recentChat.dataset.openChat! });
      return;
    }
    if (target.closest("[data-view-all-chats]")) {
      send({ type: "openChats" });
      return;
    }
    const editMessage = target.closest("[data-edit-message]") as HTMLElement | null;
    if (editMessage) {
      startMessageEdit(Number(editMessage.dataset.editMessage));
      return;
    }
    if (target.closest("[data-edit-cancel]")) {
      cancelMessageEdit();
      return;
    }
    if (target.closest("[data-edit-submit]")) {
      submitMessageEdit();
      return;
    }
    const forkChat = target.closest("[data-fork-chat]") as HTMLElement | null;
    if (forkChat) {
      send({ type: "forkChat", throughUserMessageTs: Number(forkChat.dataset.forkChat) });
      return;
    }
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
    else if (target.closest("#planMode")) {
      state.planModeMenuOpen = !state.planModeMenuOpen;
      state.thinkingModeMenuOpen = false;
      state.compactMenuOpen = false;
      render();
    }
    else if (target.closest("#thinkingMode")) {
      state.thinkingModeMenuOpen = !state.thinkingModeMenuOpen;
      state.planModeMenuOpen = false;
      state.compactMenuOpen = false;
      render();
    }
    else if (target.closest("#compact")) {
      if (!state.compactAvailable) {
        state.compactMenuOpen = false;
        showCompactUnavailable();
      } else if (state.busy) {
        state.planModeMenuOpen = false;
        state.thinkingModeMenuOpen = false;
        state.compactMenuOpen = !state.compactMenuOpen;
        render();
      } else {
        state.compactMenuOpen = false;
        send({ type: "compactNow" });
      }
    }
    else if (target.closest("#send")) submit();
    else if (target.closest("#queueMessage")) submit();
    else if (target.closest("[data-edit-queued]")) {
      const edit = target.closest("[data-edit-queued]") as HTMLElement;
      startQueuedMessageEdit(edit.dataset.editQueued!);
    }
    else if (target.closest("[data-save-queued]")) saveQueuedMessageEdit();
    else if (target.closest("[data-cancel-queued-edit]")) cancelQueuedMessageEdit();
    else if (target.closest("[data-remove-queued]")) {
      const remove = target.closest("[data-remove-queued]") as HTMLElement;
      const id = remove.dataset.removeQueued!;
      state.queuedMessages = state.queuedMessages.filter(message => message.id !== id);
      send({ type: "removeQueuedMessage", id });
      render();
    }
    else if (target.closest("#scrollDown")) {
      state.autoScroll = true;
      render();
    } else {
      const review = target.closest("[data-review-path]") as HTMLElement | null;
      const reviewTool = target.closest("[data-review-tool]") as HTMLElement | null;
      const openFile = target.closest("[data-open-file]") as HTMLElement | null;
      const approve = target.closest("[data-approve]") as HTMLElement | null;
      const reject = target.closest("[data-reject]") as HTMLElement | null;
      const answerOption = target.closest("[data-answer-option]") as HTMLElement | null;
      const answerSubmit = target.closest("[data-answer-submit]") as HTMLElement | null;
      const acceptPlan = target.closest("[data-accept-plan]") as HTMLElement | null;
      const rejectPlan = target.closest("[data-reject-plan]") as HTMLElement | null;
      if (openFile) {
        const lineAttr = openFile.dataset.openLine;
        const line = lineAttr ? Number(lineAttr) : undefined;
        send({ type: "openFile", path: openFile.dataset.openFile!, line: Number.isInteger(line) ? line : undefined });
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
      else if (answerOption) {
        submitQuestionAnswer(answerOption.dataset.answerOption!, answerOption.dataset.answer ?? "");
      }
      else if (answerSubmit) {
        const answer = state.questionDraft.trim();
        if (answer) submitQuestionAnswer(answerSubmit.dataset.answerSubmit!, answer);
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

function setComposerModeHint(text: string | undefined): void {
  const hint = root.querySelector("#composerModeHint") as HTMLElement | null;
  if (!hint) return;
  hint.textContent = text ?? "";
  hint.classList.toggle("active", !!text);
}

function setMessageActionHint(action: HTMLElement, text: string | undefined): void {
  const row = action.closest(".message-actions");
  const hint = row?.querySelector(":scope > .message-action-hint") as HTMLElement | null;
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

function startMessageEdit(messageTs: number): void {
  if (!Number.isFinite(messageTs) || state.busy) return;
  const message = state.messages.find(item => item.role === "user" && item.recordTs === messageTs);
  if (!message) return;
  state.editingMessageTs = messageTs;
  state.editDraft = message.text;
  state.autoScroll = false;
  render();
  requestAnimationFrame(() => {
    const input = root.querySelector("[data-edit-input]") as HTMLTextAreaElement | null;
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  });
}

function cancelMessageEdit(): void {
  state.editingMessageTs = undefined;
  state.editDraft = "";
  render();
}

function submitMessageEdit(): void {
  const messageTs = state.editingMessageTs;
  const text = state.editDraft.trim();
  if (messageTs === undefined || !text || state.busy) return;
  state.editingMessageTs = undefined;
  state.editDraft = "";
  state.autoScroll = true;
  send({ type: "editMessage", messageTs, text });
  render();
}

function submit(): void {
  const input = root.querySelector("#input") as HTMLTextAreaElement | null;
  const text = input?.value.trim();
  if (!text) return;
  if (state.busy) {
    const id = `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    state.queuedMessages.push({ id, text });
    state.draft = "";
    if (input) input.value = "";
    send({ type: "queueMessage", id, text });
    render();
    return;
  }
  state.busy = true;
  state.serverPending = "server";
  state.draft = "";
  if (input) input.value = "";
  state.pendingPlanRejection = false;
  send({ type: "send", text });
  render();
}

function startQueuedMessageEdit(id: string): void {
  const message = state.queuedMessages.find(item => item.id === id);
  if (!message) return;
  state.editingQueuedMessageId = id;
  state.queuedMessageDraft = message.text;
  render();
  requestAnimationFrame(() => {
    const input = root.querySelector("[data-queued-edit-input]") as HTMLInputElement | null;
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  });
}

function cancelQueuedMessageEdit(): void {
  state.editingQueuedMessageId = undefined;
  state.queuedMessageDraft = "";
  render();
}

function saveQueuedMessageEdit(): void {
  const id = state.editingQueuedMessageId;
  const text = state.queuedMessageDraft.trim();
  if (!id || !text) return;
  const message = state.queuedMessages.find(item => item.id === id);
  if (!message) {
    cancelQueuedMessageEdit();
    return;
  }
  message.text = text;
  state.editingQueuedMessageId = undefined;
  state.queuedMessageDraft = "";
  send({ type: "updateQueuedMessage", id, text });
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

function clockIcon(): string {
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <circle cx="12" cy="12" r="8.5"/>
    <path d="M12 7.5v5l3.3 2"/>
  </svg>`;
}

function trashIcon(): string {
  return `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
    <path d="M6 2h4l.5 1.5H14v1H2v-1h3.5L6 2Zm-2 4h8l-.5 8h-7L4 6Zm2 1v6h1V7H6Zm3 0v6h1V7H9Z" fill="currentColor"/>
  </svg>`;
}

function checkIcon(): string {
  return `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <path d="m3 8.2 3.1 3.1L13 4.7"/>
  </svg>`;
}

function searchIcon(): string {
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <circle cx="10.5" cy="10.5" r="5.75"/>
    <path d="m15 15 4.5 4.5"/>
  </svg>`;
}

function readFileIcon(): string {
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <g transform="translate(0 .6) scale(1 .95)">
      <path d="M12 7C10.95 4.65 9.25 3.4 7.1 3.4H4.6C3.72 3.4 3 4.12 3 5v11.35c0 .9.75 1.65 1.65 1.65H7.4c2.15 0 3.7 1.15 4.6 3.1Z"/>
      <path d="M12 7c1.05-2.35 2.75-3.6 4.9-3.6h2.5c.88 0 1.6.72 1.6 1.6v11.35c0 .9-.75 1.65-1.65 1.65H16.6c-2.15 0-3.7 1.15-4.6 3.1Z"/>
    </g>
  </svg>`;
}

function questionIcon(): string {
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <circle cx="12" cy="12" r="9"/>
    <path d="M9.4 9.2a2.6 2.6 0 0 1 5 .9c0 1.7-2.4 2.2-2.4 3.9"/>
    <path d="M12 17.2h.01"/>
  </svg>`;
}

function pencilIcon(): string {
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <path d="M4.35 19.65c-.16-.16-.21-.4-.15-.61l.7-2.38c.05-.18.15-.34.28-.47L15 5a2.83 2.83 0 0 1 4 4L8.81 20.19c-.13.13-.29.23-.47.28l-2.38.7c-.21.06-.45.01-.61-.15Z"/>
    <path d="m13.5 6.5 4 4"/>
  </svg>`;
}

function forkIcon(): string {
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <circle cx="6" cy="5" r="2"/>
    <circle cx="18" cy="7" r="2"/>
    <circle cx="6" cy="19" r="2"/>
    <path d="M6 7v10"/>
    <path d="M6 11h4c3.1 0 5.2-1.1 6.5-2.8"/>
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
  // Keep the small composer glyph deliberately simple: rounded hemispheres
  // and two broad folds remain legible without sub-pixel circuit details.
  return `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" shape-rendering="geometricPrecision" aria-hidden="true" focusable="false">
    <path d="M10.5 4.2A3.2 3.2 0 0 0 5.3 6.7a3.15 3.15 0 0 0-1 5.7 3.25 3.25 0 0 0 2.5 5.2 3.25 3.25 0 0 0 3.7 2.1Z"/>
    <path d="M13.5 4.2a3.2 3.2 0 0 1 5.2 2.5 3.15 3.15 0 0 1 1 5.7 3.25 3.25 0 0 1-2.5 5.2 3.25 3.25 0 0 1-3.7 2.1Z"/>
    <path d="M10.5 8.1H8.7a1.8 1.8 0 0 0-1.8 1.8M13.5 13.7h1.8a1.8 1.8 0 0 1 1.8 1.8"/>
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

function pawnIcon(): string {
  return `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" shape-rendering="geometricPrecision" aria-hidden="true" focusable="false">
    <circle cx="12" cy="5.2" r="2.7"/>
    <path d="M9.5 8.2h5c.05 2.55 1.15 4.45 2.85 5.95H6.65c1.7-1.5 2.8-3.4 2.85-5.95Z"/>
    <path d="M6.7 14.15h10.6l1.25 3.1a1.05 1.05 0 0 1-.98 1.45H6.43a1.05 1.05 0 0 1-.98-1.45Z"/>
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
  let currentUserTs: number | undefined;
  for (const [index, m] of rec.messages.entries()) {
    const id = restoredRecordMessageId(index, m.ts);
    if (m.role === "user") {
      currentUserTs = m.ts;
      state.messages.push({ id, role: "user", recordTs: m.ts, parts: [], text: m.content, thought: "", toolCards: [] });
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
        const msg: Message = { id, role: "assistant", responseToTs: currentUserTs, parts: [], text: "", thought: "", toolCards: [] };
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
        last = { id, role: "assistant", responseToTs: currentUserTs, parts: [], text: "", thought: "", toolCards: [] };
        state.messages.push(last);
      }
      const restoredName = m.toolCall?.name ?? "tool";
      // File lists and commands have scrollable output surfaces, so retain
      // their full bounded content when a saved chat is restored.
      const showsFullResult = restoredName === "list_dir" || restoredName === "glob" ||
        restoredName === "run_command" || restoredName === "run_process";
      const malformedToolCall = restoredName === "tool_call";
      const tc: ToolCard = {
        toolId: restoredToolCardId(index, m.ts),
        toolName: restoredName,
        argsJson: m.toolCall?.argsJson ?? "{}",
        category: malformedToolCall ? "unknown" : "read",
        status: restoredToolStatus(m.toolCall?.status, m.content, malformedToolCall),
        resultPreview: showsFullResult ? m.content : m.content.slice(0, 400),
        createsNewFile: restoredCreatesNewFile(restoredName, m.toolCall?.createsNewFile),
        expanded: false
      };
      last.toolCards.push(tc);
      last.parts.push({ id: nextPartId("tool"), kind: "tool", card: tc, startedAt: m.ts });
    }
  }
}

window.addEventListener("message", ev => {
  const msg = ev.data as ExtToChat;
  if ("type" in msg) {
    if (msg.type === "settings") {
      state.planMode = msg.planMode;
      state.thinkingMode = msg.thinkingMode;
      state.autoCompact = msg.autoCompact;
      state.autoCompactThresholdPercent = msg.autoCompactThresholdPercent;
      render();
      return;
    }
    if (msg.type === "recentChats") {
      state.recentChats = msg.chats;
      render();
      return;
    }
    if (msg.type === "messageQueue") {
      state.queuedMessages = msg.messages;
      if (state.editingQueuedMessageId && !msg.messages.some(message => message.id === state.editingQueuedMessageId)) {
        state.editingQueuedMessageId = undefined;
        state.queuedMessageDraft = "";
      }
      render();
      return;
    }
  }
  if (!("kind" in msg)) return;
  switch (msg.kind) {
    case "chatLoaded": {
      hiddenApprovalToolIds.clear();
      cancelTitleAnim();
      state.renamingTitle = false;
      state.editingMessageTs = undefined;
      state.editDraft = "";
      state.chatTitle = msg.record.title;
      state.hasChat = true;
      state.serverPending = undefined;
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
      state.editingMessageTs = undefined;
      state.editDraft = "";
      state.hasChat = false;
      state.chatTitle = "Chat";
      state.messages = [];
      state.queuedMessages = [];
      state.editingQueuedMessageId = undefined;
      state.queuedMessageDraft = "";
      state.tokens = 0;
      state.busy = false;
      state.serverPending = undefined;
      state.autoScroll = true;
      state.compactMenuOpen = false;
      state.planModeMenuOpen = false;
      state.thinkingModeMenuOpen = false;
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
    case "turnPreparing":
      state.busy = true;
      state.serverPending = msg.reason;
      state.autoScroll = true;
      render();
      break;
    case "turnWorkStarted": {
      state.busy = true;
      state.autoScroll = true;
      const m = getOrCreateMsg(msg.messageId, "assistant");
      const lastUser = [...state.messages].reverse().find(message => message.role === "user");
      m.responseToTs = lastUser?.recordTs;
      m.workStartedAt ??= msg.startedAt;
      m.workEndedAt = undefined;
      m.hasTurnWorkSummary = true;
      render();
      break;
    }
    case "titleGenerationFinished":
      if (state.serverPending === "title") {
        state.serverPending = "server";
        render();
      }
      break;
    case "turnStart":
      state.busy = true;
      state.serverPending ??= "server";
      state.compactMenuOpen = false;
      state.planModeMenuOpen = false;
      state.thinkingModeMenuOpen = false;
      state.autoScroll = true;
      {
        const m = getOrCreateMsg(msg.messageId, "assistant");
        const lastUser = [...state.messages].reverse().find(message => message.role === "user");
        m.responseToTs = lastUser?.recordTs;
        markWorkStarted(m);
        m.hasTurnWorkSummary = true;
      }
      render();
      break;
    case "userMessage": {
      state.messages.push({
        id: msg.messageId,
        role: "user",
        recordTs: msg.messageTs,
        parts: [],
        text: msg.text,
        thought: "",
        toolCards: []
      });
      render();
      break;
    }
    case "text": {
      state.serverPending = undefined;
      const m = getOrCreateMsg(msg.messageId, "assistant");
      m.text += msg.delta;
      appendPartText(m, "text", msg.delta);
      render(false);
      break;
    }
    case "thought": {
      state.serverPending = undefined;
      const m = getOrCreateMsg(msg.messageId, "assistant");
      m.thought += msg.delta;
      appendPartText(m, "thought", msg.delta);
      render(false);
      break;
    }
    case "toolCallProgress": {
      state.serverPending = undefined;
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
          added: msg.added,
          removed: msg.removed,
          createsNewFile: msg.createsNewFile,
          replacedLines: msg.replacedLines,
          progress: {
            path: msg.path,
            contentLines: msg.contentLines,
            startLine: msg.startLine,
            endLine: msg.endLine,
            line: msg.line
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
        if (typeof msg.added === "number") card.added = msg.added;
        if (typeof msg.removed === "number") card.removed = msg.removed;
        if (typeof msg.createsNewFile === "boolean") card.createsNewFile = msg.createsNewFile;
        if (typeof msg.replacedLines === "number") card.replacedLines = msg.replacedLines;
        card.progress = {
          path: msg.path ?? card.progress?.path,
          contentLines: msg.contentLines,
          startLine: msg.startLine ?? card.progress?.startLine,
          endLine: msg.endLine ?? card.progress?.endLine,
          line: msg.line ?? card.progress?.line
        };
      }
      render(false);
      break;
    }
    case "toolCallProposed": {
      state.serverPending = undefined;
      const m = getOrCreateMsg(msg.messageId, "assistant");
      markWorkStarted(m);
      let card = m.toolCards.find(t => t.toolId === msg.toolId);
      if (!card) {
        card = {
          toolId: msg.toolId,
          toolName: msg.toolName,
          argsJson: msg.argsJson,
          category: msg.category,
          approvalRequired: msg.approvalRequired,
          reason: msg.reason,
          diffPreview: msg.diffPreview,
          diffRequested: false,
          status: "pending",
          createsNewFile: msg.createsNewFile,
          expanded: false
        };
        m.toolCards.push(card);
        finalizeLiveThoughts(m);
        m.parts.push({ id: nextPartId("tool"), kind: "tool", card, startedAt: Date.now() });
      } else {
        card.toolName = msg.toolName;
        card.argsJson = msg.argsJson;
        card.category = msg.category;
        card.approvalRequired = msg.approvalRequired;
        card.reason = msg.reason;
        card.diffPreview = msg.diffPreview;
        card.diffRequested = false;
        card.progress = undefined;
        card.status = "pending";
        if (typeof msg.createsNewFile === "boolean") card.createsNewFile = msg.createsNewFile;
      }
      render();
      break;
    }
    case "toolCallOutput": {
      for (const m of state.messages) {
        const tc = m.toolCards.find(t => t.toolId === msg.toolId);
        if (tc && isActiveToolCard(tc)) {
          tc.resultPreview = msg.resultPreview;
          break;
        }
      }
      render(false);
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
          if (typeof msg.added === "number") tc.added = msg.added;
          if (typeof msg.removed === "number") tc.removed = msg.removed;
          if ((msg.status === "failed" || msg.status === "rejected") && !msg.diffPreview) {
            // Drop live proposal counts: no edit landed, so +N/-N would imply
            // a file change that never happened.
            tc.added = undefined;
            tc.removed = undefined;
          }
          if (typeof msg.createsNewFile === "boolean") tc.createsNewFile = msg.createsNewFile;
          if (msg.processJobId) tc.processJobId = msg.processJobId;
          if (typeof msg.processRunning === "boolean") tc.processRunning = msg.processRunning;
          // A write resolving while its card is already open should show its
          // diff without another toggle — fetch it now.
          if (msg.status === "executed" && isWriteToolCard(tc) && !tc.diffPreview && !tc.diffRequested) {
            if (tc.expanded) {
              tc.diffRequested = true;
              send({ type: "requestToolDiff", toolId: tc.toolId });
            }
          }
        }
      }
      render();
      break;
    }
    case "processJobState": {
      for (const message of state.messages) {
        for (const card of message.toolCards) {
          if (card.toolId !== msg.toolId && card.processJobId !== msg.jobId) continue;
          card.processJobId = msg.jobId;
          card.processRunning = msg.running;
          card.processStopping = false;
          if (msg.resultPreview) card.resultPreview = msg.resultPreview;
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
      state.serverPending = undefined;
      let target = state.messages[state.messages.length - 1];
      // Preflight failures (for example, an unavailable llama.cpp /props
      // endpoint) happen before turnStart creates an assistant message. Do not
      // attach the abort part to the user's message, whose renderer ignores
      // assistant timeline parts; create a response row so the error is
      // visible in the chat instead.
      if (!target || target.role !== "assistant" || !isAssistantTurnLive(target)) {
        const lastUser = [...state.messages].reverse().find(message => message.role === "user");
        target = {
          id: `abort_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          role: "assistant",
          responseToTs: lastUser?.recordTs,
          parts: [],
          text: "",
          thought: "",
          toolCards: []
        };
        state.messages.push(target);
      }
      target.aborted = msg.reason;
      finalizeLiveThoughts(target);
      if (target.workStartedAt !== undefined && target.workEndedAt === undefined) {
        target.workEndedAt = Date.now();
      }
      if (!target.parts.some(part => part.kind === "abort" && part.reason === msg.reason)) {
        target.parts.push({ id: nextPartId("abort"), kind: "abort", reason: msg.reason });
      }
      state.busy = state.queuedMessages.length > 0;
      state.serverPending = state.queuedMessages.length > 0 ? "server" : undefined;
      render();
      break;
    }
    case "notice":
      state.serverPending = undefined;
      state.notices.push({ id: `n_${Date.now()}`, text: msg.text });
      render();
      break;
    case "compactStart":
      state.serverPending = undefined;
      state.compactMenuOpen = false;
      state.planModeMenuOpen = false;
      state.thinkingModeMenuOpen = false;
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
      if (msg.source === "auto" && state.busy) state.serverPending = "server";
      state.autoScroll = true;
      render();
      break;
    case "turnEnd":
      state.busy = state.queuedMessages.length > 0;
      state.serverPending = state.queuedMessages.length > 0 ? "server" : undefined;
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
    case "thinkingModeChanged": state.thinkingMode = msg.mode; render(); break;
  }
});

watchThemeChanges();
startShiki();
send({ type: "ready" });
render();

window.setInterval(() => {
  if (state.messages.some(isAssistantTurnLive)) render(false);
}, 1000);
