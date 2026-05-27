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
  tokens: number;
  limit: number;
  planMode: boolean;
  autoapproveWrites: boolean;
  busy: boolean;
}

const state: State = {
  messages: [],
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
  const pctClass = ratio > 0.9 ? "danger" : ratio > 0.75 ? "warn" : "ok";
  root.innerHTML = `
    <header class="chat-header">
      <button id="gear" title="Settings">⚙</button>
      <button id="plus" title="New chat">+</button>
      <div class="ctx-bar" title="Context: ${state.tokens} / ${state.limit} tokens">
        <div class="ctx-fill ${pctClass}" style="width: ${(ratio * 100).toFixed(1)}%"></div>
        <span class="ctx-label">${state.tokens} / ${state.limit}</span>
      </div>
      <button id="compact" title="Compact context now">Compact</button>
    </header>
    <main class="chat-body">${state.messages.map(renderMessage).join("")}</main>
    <footer class="composer">
      <div class="composer-row">
        <textarea id="input" placeholder="${state.planMode ? "Plan mode — model is read-only" : "Message…"}" rows="3"></textarea>
        <button id="send" class="primary" ${state.busy ? "disabled" : ""}>${state.busy ? "…" : "Send"}</button>
      </div>
      <div class="composer-toggles">
        <label><input type="checkbox" id="planToggle" ${state.planMode ? "checked" : ""}/> Plan mode <kbd>⇧Tab</kbd></label>
        <label><input type="checkbox" id="aaw" ${state.autoapproveWrites ? "checked" : ""}/> Auto-approve writes</label>
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
  root.querySelector("#planToggle")?.addEventListener("change", () => send({ type: "togglePlanMode" }));
  root.querySelector("#aaw")?.addEventListener("change", e => {
    const on = (e.target as HTMLInputElement).checked;
    send({ type: "setAutoApproveWrites", on });
  });
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

function loadFromRecord(rec: ChatRecord): void {
  state.messages = [];
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
    case "turnEnd": state.busy = false; render(); break;
    case "tokens": state.tokens = msg.total; state.limit = msg.limit; render(); break;
    case "planModeChanged": state.planMode = msg.on; render(); break;
  }
});

send({ type: "ready" });
render();
