import type { ExtToSide, SideToExt } from "../../messaging.js";
import type { SideTab } from "../../messaging.js";

declare function acquireVsCodeApi(): {
  postMessage(msg: SideToExt): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

interface State {
  tab: SideTab;
  search: string;
  chats: { id: string; title: string; updatedAt: number }[];
  settings: Record<string, unknown>;
  endpointMsg?: { ok: boolean; text: string };
  openTabs: { id: string; title: string }[];
}

const state: State = {
  tab: "welcome",
  search: "",
  chats: [],
  settings: {},
  openTabs: []
};

const root = document.getElementById("app")!;

function send(msg: SideToExt): void { vscode.postMessage(msg); }

function render(): void {
  const keepSearchFocus = (document.activeElement as HTMLElement | null)?.id === "chatSearch";
  root.innerHTML = `
    <div class="tabs">
      ${tabBtn("welcome", "Welcome")}
      ${tabBtn("settings", "Settings")}
    </div>
    <div class="tab-body">
      ${state.tab === "welcome" ? renderWelcome() : renderSettings()}
    </div>
  `;
  bind();
  if (keepSearchFocus) {
    const input = root.querySelector("#chatSearch") as HTMLInputElement | null;
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }
}

function tabBtn(id: SideTab, label: string): string {
  const active = state.tab === id ? "active" : "";
  return `<button class="tab-btn ${active}" data-tab="${id}">${label}</button>`;
}

function renderWelcome(): string {
  const query = state.search.trim().toLowerCase();
  const chats = query
    ? state.chats.filter(c => c.title.toLowerCase().includes(query))
    : state.chats;
  return `
    <div class="panel">
      <section class="panel-section intro-section">
        <h2>Local LLM Harness</h2>
        <p class="muted">Offline coding assistant. No internet, workspace-only file access.</p>
        <button id="newChat" class="primary wide-button">+ New chat</button>
      </section>

      <section class="panel-section">
        <h3>Find</h3>
        <div class="search-box">
          ${searchIcon()}
          <input id="chatSearch" type="search" value="${esc(state.search)}" placeholder="Search chats" />
        </div>
      </section>

      ${state.openTabs.length > 0 ? `
        <section class="panel-section">
          <h3>Open</h3>
          <ul class="chat-list">${state.openTabs.map(t => `
            <li data-open="${t.id}">
              <span>${esc(t.title)}</span>
              <button class="delete" data-delete="${t.id}" data-tip="Delete" aria-label="Delete chat">${trashIcon()}</button>
            </li>`).join("")}</ul>
        </section>
      ` : ""}

      <section class="panel-section">
        <h3>Chats</h3>
        ${chats.length === 0 ? `<p class="empty-state">${query ? "No matching chats." : "No chats yet."}</p>` :
          `<ul class="chat-list">${chats.map(c => `
            <li data-open="${c.id}">
              <span>${esc(c.title)}</span>
              <time>${ago(c.updatedAt)}</time>
              <button class="delete" data-delete="${c.id}" data-tip="Delete" aria-label="Delete chat">${trashIcon()}</button>
            </li>`).join("")}</ul>`}
      </section>
    </div>
  `;
}

function renderSettings(): string {
  const s = state.settings;
  const endpoint = String(s["endpoint"] ?? "http://localhost:8080");
  const family = String(s["modelFamily"] ?? "gemma4");
  const ctxSize = String(s["contextSize"] ?? 32768);
  const autoCompact = !!s["autoCompact"];
  const threshold = String(s["autoCompactThreshold"] ?? 28000);
  const arReads = !!s["autoapproveReads"];
  const arWrites = !!s["autoapproveWrites"];
  const validationCls = state.endpointMsg?.ok ? "ok" : state.endpointMsg ? "err" : "";

  return `
    <div class="panel">
      <h2>Settings</h2>

      <section class="panel-section">
        <h3>Model</h3>
        <label class="field-label" for="endpoint">Server URL</label>
        <div class="setting-action-row">
          <input id="endpoint" type="text" value="${esc(endpoint)}" />
          <button id="saveEndpoint" class="primary">Save</button>
        </div>
        <div class="validation ${validationCls}">${esc(state.endpointMsg?.text ?? "")}</div>

        <label class="field-label" for="modelFamily">Model family</label>
        <select id="modelFamily">
          <option value="gemma4" ${family === "gemma4" ? "selected" : ""}>Gemma 4</option>
          <option value="qwen3" ${family === "qwen3" ? "selected" : ""}>Qwen 3</option>
        </select>

        <label class="field-label" for="contextSize">Context size</label>
        <input id="contextSize" type="number" value="${esc(ctxSize)}" />
      </section>

      <section class="panel-section">
        <h3>Automation</h3>
        ${switchControl("autoCompact", "Auto-compact when full", autoCompact)}

        <label class="field-label" for="autoCompactThreshold">Auto-compact threshold</label>
        <input id="autoCompactThreshold" type="number" value="${esc(threshold)}" />

        ${switchControl("autoapproveReads", "Auto-approve reads", arReads)}
        ${switchControl("autoapproveWrites", "Auto-approve file edits", arWrites)}
      </section>

      <section class="panel-section">
        <h3>Commands</h3>
        <button id="editSafe" class="wide-button">Edit safe commands</button>
      </section>
    </div>
  `;
}

function bind(): void {
  root.querySelectorAll(".tab-btn").forEach(b => b.addEventListener("click", () => {
    const id = (b as HTMLElement).dataset.tab as SideTab;
    state.tab = id;
    send({ type: "openTab", tab: id });
    render();
  }));
  root.querySelector("#chatSearch")?.addEventListener("input", e => {
    state.search = (e.target as HTMLInputElement).value;
    render();
  });
  root.querySelectorAll("li[data-open]").forEach(li => li.addEventListener("click", e => {
    if ((e.target as HTMLElement).hasAttribute("data-delete")) return;
    send({ type: "openChat", id: (li as HTMLElement).dataset.open! });
  }));
  root.querySelectorAll("[data-delete]").forEach(b => b.addEventListener("click", e => {
    e.stopPropagation();
    send({ type: "deleteChat", id: (b as HTMLElement).dataset.delete! });
  }));
  root.querySelector("#newChat")?.addEventListener("click", () => send({ type: "newChat" }));
  root.querySelector("#saveEndpoint")?.addEventListener("click", () => {
    const url = (root.querySelector("#endpoint") as HTMLInputElement).value;
    send({ type: "validateEndpoint", url });
  });
  bindSetting("modelFamily", "change", v => v);
  bindSetting("contextSize", "change", v => Number(v));
  bindSetting("autoCompact", "change", (_v, el) => (el as HTMLInputElement).checked);
  bindSetting("autoCompactThreshold", "change", v => Number(v));
  bindSetting("autoapproveReads", "change", (_v, el) => (el as HTMLInputElement).checked);
  bindSetting("autoapproveWrites", "change", (_v, el) => (el as HTMLInputElement).checked);
  root.querySelector("#editSafe")?.addEventListener("click", () => send({ type: "editSafeCommandsJson" }));
}

function bindSetting(id: string, evt: string, getter: (v: string, el: Element) => unknown): void {
  const el = root.querySelector("#" + id);
  if (!el) return;
  el.addEventListener(evt, () => {
    const value = getter((el as HTMLInputElement).value, el);
    send({ type: "saveSetting", key: id, value });
  });
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

function trashIcon(): string {
  return `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
    <path d="M6 2h4l.5 1.5H14v1H2v-1h3.5L6 2Zm-2 4h8l-.5 8h-7L4 6Zm2 1v6h1V7H6Zm3 0v6h1V7H9Z" fill="currentColor"/>
  </svg>`;
}

function searchIcon(): string {
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <circle cx="10.5" cy="10.5" r="5.75"/>
    <path d="m15 15 4.5 4.5"/>
  </svg>`;
}

function switchControl(id: string, label: string, checked: boolean): string {
  return `<label class="switch-row" for="${id}">
    <span>${esc(label)}</span>
    <input id="${id}" type="checkbox" ${checked ? "checked" : ""}/>
    <span class="switch" aria-hidden="true"></span>
  </label>`;
}

function ago(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return "just now";
  if (d < 3600_000) return Math.floor(d / 60_000) + "m";
  if (d < 86400_000) return Math.floor(d / 3600_000) + "h";
  return Math.floor(d / 86400_000) + "d";
}

window.addEventListener("message", ev => {
  const msg = ev.data as ExtToSide;
  switch (msg.type) {
    case "settings": state.settings = msg.settings; render(); break;
    case "chats": state.chats = msg.chats; render(); break;
    case "focusTab": state.tab = msg.tab; render(); break;
    case "endpointValidation":
      state.endpointMsg = msg.ok
        ? { ok: true, text: `OK — resolved to ${msg.resolved?.join(", ") ?? "LAN"}` }
        : { ok: false, text: msg.error ?? "Validation failed." };
      render(); break;
    case "openTabs": state.openTabs = msg.tabs; render(); break;
  }
});

send({ type: "ready" });
render();
