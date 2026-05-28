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
}

interface Message {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  thought: string;
  toolCards: ToolCard[];
  summary?: string;
  plan?: string;
  aborted?: string;
  thinkingExpanded: boolean;
}

interface State {
  messages: Message[];
  notices: { id: string; text: string }[];
  tokens: number;
  limit: number;
  planMode: boolean;
  autoapproveWrites: boolean;
  busy: boolean;
}

const state: State = {
  messages: [],
  notices: [],
  tokens: 0,
  limit: 32768,
  planMode: false,
  autoapproveWrites: false,
  busy: false
};

const root = document.getElementById("app")!;

function send(msg: ChatToExt): void { vscode.postMessage(msg); }

function getOrCreateMsg(id: string, role: Message["role"]): Message {
  let m = state.messages.find(x => x.id === id);
  if (!m) {
    m = { id, role, text: "", thought: "", toolCards: [], thinkingExpanded: false };
    state.messages.push(m);
  }
  return m;
}

function render(): void {
  const ratio = Math.min(1, state.tokens / Math.max(1, state.limit));
  const pct = Math.round(ratio * 100);
  const pctClass = ratio >= 0.9 ? "danger" : "ok";
  root.innerHTML = `
    <header class="chat-header">
      <div class="chat-title">Chat</div>
      <div class="header-actions">
        <button id="plus" class="icon-btn" title="New chat" aria-label="New chat">${plusIcon()}</button>
        <button id="gear" class="icon-btn" title="Settings" aria-label="Settings">${settingsIcon()}</button>
      </div>
    </header>
    <main class="chat-body">
      ${state.notices.map(n => `<div class="notice">${clockIcon()}<span>${escapeHtml(n.text)}</span></div>`).join("")}
      ${state.messages.map(renderMessage).join("")}
    </main>
    <footer class="composer">
      <div class="composer-row">
        <textarea id="input" placeholder="${state.planMode ? "Plan mode — model is read-only" : "Message…"}" rows="3"></textarea>
        <button id="send" class="send-btn" title="Send" aria-label="Send" ${state.busy ? "disabled" : ""}>${state.busy ? "…" : sendIcon()}</button>
      </div>
      <div class="composer-toggles">
        <button id="planToggle" class="mode-pill ${state.planMode ? "active" : ""}" title="Toggle plan mode with Shift+Tab">Plan mode</button>
        <button id="compact" class="ctx-pill ${pctClass}" title="Context: ${state.tokens} / ${state.limit} tokens. Click to compact.">
          ${clockIcon()}<span>${pct}%</span>
        </button>
        ${state.busy ? `<button id="cancel" class="cancel">Cancel</button>` : ""}
      </div>
    </footer>
  `;
  bind();
  scrollToBottom();
}

function renderMessage(m: Message): string {
  if (m.role === "user") {
    return `<div class="msg user"><div class="bubble">${md.render(m.text)}</div></div>`;
  }
  const parts: string[] = [];
  if (m.thought) {
    parts.push(`
      <div class="thinking ${m.thinkingExpanded ? "open" : ""}" data-toggle="${m.id}">
        <div class="thinking-head"><span class="shimmer">Thinking…</span><span class="arrow">▾</span></div>
        ${m.thinkingExpanded ? `<div class="thinking-body">${md.render(m.thought)}</div>` : ""}
      </div>`);
  }
  if (m.text) parts.push(`<div class="bubble">${md.render(m.text)}</div>`);
  for (const tc of m.toolCards) parts.push(renderToolCard(tc));
  if (m.plan) parts.push(renderPlanCard(m.id, m.plan));
  if (m.summary) parts.push(`<div class="card summary">${md.render(m.summary)}</div>`);
  if (m.aborted) parts.push(`<div class="card abort">⛔ ${escapeHtml(m.aborted)}</div>`);
  return `<div class="msg assistant">${parts.join("")}</div>`;
}

function renderToolCard(tc: ToolCard): string {
  const cls = "tool-card " + tc.category + " " + tc.status;
  let args = tc.argsJson;
  try { args = JSON.stringify(JSON.parse(tc.argsJson), null, 2); } catch { /* keep raw */ }
  const buttons =
    tc.status === "pending" && (tc.category === "write" || tc.category === "safeCmd" || tc.category === "read")
      ? `<div class="card-actions">
           <button class="approve" data-approve="${tc.toolId}">Approve</button>
           <button class="reject" data-reject="${tc.toolId}">Reject</button>
         </div>`
      : "";
  const result = tc.resultPreview ? `<pre class="tool-result">${escapeHtml(tc.resultPreview)}</pre>` : "";
  const reason = tc.reason ? `<div class="tool-reason">${escapeHtml(tc.reason)}</div>` : "";
  const statusBadge = tc.status === "pending" ? "" : `<span class="badge ${tc.status}">${tc.status}</span>`;
  return `<div class="${cls}">
    <div class="tool-head"><strong>${escapeHtml(tc.toolName)}</strong>${statusBadge}</div>
    <pre class="tool-args">${escapeHtml(args)}</pre>
    ${reason}${result}${buttons}
  </div>`;
}

function renderPlanCard(msgId: string, planMd: string): string {
  return `<div class="card plan">
    <div class="plan-body">${md.render(planMd)}</div>
    <div class="card-actions">
      <button class="approve" data-accept-plan="${msgId}">Accept plan</button>
      <button class="reject" data-reject-plan="${msgId}">Reject & suggest</button>
    </div>
    <textarea class="plan-suggestion hidden" data-suggestion="${msgId}" placeholder="Describe what to change in the plan…"></textarea>
  </div>`;
}

function bind(): void {
  root.querySelector("#gear")?.addEventListener("click", () => send({ type: "openSettings" }));
  root.querySelector("#plus")?.addEventListener("click", () => send({ type: "newChat" }));
  root.querySelector("#compact")?.addEventListener("click", () => send({ type: "compactNow" }));
  const sendBtn = root.querySelector("#send");
  const input = root.querySelector("#input") as HTMLTextAreaElement | null;
  sendBtn?.addEventListener("click", () => submit());
  input?.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
    else if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); send({ type: "togglePlanMode" }); }
  });
  root.querySelector("#planToggle")?.addEventListener("click", () => send({ type: "togglePlanMode" }));
  root.querySelector("#cancel")?.addEventListener("click", () => send({ type: "cancel" }));
  root.querySelectorAll("[data-toggle]").forEach(el => el.addEventListener("click", () => {
    const id = (el as HTMLElement).dataset.toggle!;
    const m = state.messages.find(x => x.id === id);
    if (m) { m.thinkingExpanded = !m.thinkingExpanded; render(); }
  }));
  root.querySelectorAll("[data-approve]").forEach(el => el.addEventListener("click", () => {
    send({ type: "approveTool", toolId: (el as HTMLElement).dataset.approve!, approved: true });
  }));
  root.querySelectorAll("[data-reject]").forEach(el => el.addEventListener("click", () => {
    send({ type: "approveTool", toolId: (el as HTMLElement).dataset.reject!, approved: false });
  }));
  root.querySelectorAll("[data-accept-plan]").forEach(el => el.addEventListener("click", () => {
    send({ type: "acceptPlan" });
  }));
  root.querySelectorAll("[data-reject-plan]").forEach(el => el.addEventListener("click", () => {
    const id = (el as HTMLElement).dataset.rejectPlan!;
    const ta = root.querySelector(`[data-suggestion="${id}"]`) as HTMLTextAreaElement | null;
    if (ta) {
      if (ta.classList.contains("hidden")) { ta.classList.remove("hidden"); ta.focus(); }
      else { send({ type: "rejectPlan", suggestion: ta.value }); }
    }
  }));
}

function submit(): void {
  const input = root.querySelector("#input") as HTMLTextAreaElement | null;
  const text = input?.value.trim();
  if (!text) return;
  state.busy = true;
  send({ type: "send", text });
  input!.value = "";
  render();
}

function scrollToBottom(): void {
  const body = root.querySelector(".chat-body");
  if (body) body.scrollTop = body.scrollHeight;
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

function loadFromRecord(rec: ChatRecord): void {
  state.messages = [];
  state.notices = [];
  for (const m of rec.messages) {
    const id = `r_${m.ts}`;
    if (m.role === "user") {
      state.messages.push({ id, role: "user", text: m.content, thought: "", toolCards: [], thinkingExpanded: false });
    } else if (m.role === "assistant") {
      state.messages.push({ id, role: "assistant", text: m.content, thought: "", toolCards: [], thinkingExpanded: false });
    } else if (m.role === "tool") {
      // attach to last assistant message as an executed card; if none, create a stub
      const last = [...state.messages].reverse().find(x => x.role === "assistant");
      const tc: ToolCard = {
        toolId: id,
        toolName: m.toolCall?.name ?? "tool",
        argsJson: m.toolCall?.argsJson ?? "{}",
        category: "read",
        status: "executed",
        resultPreview: m.content.slice(0, 400)
      };
      if (last) last.toolCards.push(tc);
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
      render();
      break;
    case "chatClosed":
      state.messages = [];
      state.tokens = 0;
      state.busy = false;
      render();
      break;
    case "turnStart":
      state.busy = true;
      getOrCreateMsg(msg.messageId, "assistant");
      render();
      break;
    case "text": getOrCreateMsg(msg.messageId, "assistant").text += msg.delta; render(); break;
    case "thought": getOrCreateMsg(msg.messageId, "assistant").thought += msg.delta; render(); break;
    case "toolCallProposed": {
      const m = getOrCreateMsg(msg.messageId, "assistant");
      m.toolCards.push({
        toolId: msg.toolId,
        toolName: msg.toolName,
        argsJson: msg.argsJson,
        category: msg.category,
        reason: msg.reason,
        status: "pending"
      });
      render();
      break;
    }
    case "toolCallResolved": {
      for (const m of state.messages) {
        const tc = m.toolCards.find(t => t.toolId === msg.toolId);
        if (tc) {
          tc.status = msg.status;
          if (msg.resultPreview) tc.resultPreview = msg.resultPreview;
        }
      }
      render();
      break;
    }
    case "summary": getOrCreateMsg(msg.messageId, "assistant").summary = msg.text; render(); break;
    case "planFinal": getOrCreateMsg(msg.messageId, "assistant").plan = msg.markdown; render(); break;
    case "abort": {
      const last = state.messages[state.messages.length - 1];
      if (last) last.aborted = msg.reason;
      state.busy = false;
      render();
      break;
    }
    case "notice":
      state.notices.push({ id: `n_${Date.now()}`, text: msg.text });
      render();
      break;
    case "turnEnd": state.busy = false; render(); break;
    case "tokens": state.tokens = msg.total; state.limit = msg.limit; render(); break;
    case "planModeChanged": state.planMode = msg.on; render(); break;
  }
});

send({ type: "ready" });
render();
