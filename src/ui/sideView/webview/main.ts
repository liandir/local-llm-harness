import type { ExtToSide, SideToExt } from "../../messaging.js";

declare function acquireVsCodeApi(): {
  postMessage(msg: SideToExt): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

interface State {
  tab: "welcome" | "chats" | "settings";
  chats: { id: string; title: string; updatedAt: number }[];
  settings: Record<string, unknown>;
  endpointMsg?: { ok: boolean; text: string };
  openTabs: { id: string; title: string }[];
}

const state: State = {
  tab: "welcome",
  chats: [],
  settings: {},
  openTabs: []
};

const root = document.getElementById("app")!;

function send(msg: SideToExt): void { vscode.postMessage(msg); }

function render(): void {
  root.innerHTML = `
    <div class="tabs">
      ${tabBtn("welcome", "Welcome")}
      ${tabBtn("chats", "Chats")}
      ${tabBtn("settings", "Settings")}
    </div>
    <div class="tab-body">
      ${state.tab === "welcome" ? renderWelcome() : state.tab === "chats" ? renderChats() : renderSettings()}
    </div>
  `;
  bind();
}

function tabBtn(id: string, label: string): string {
  const active = state.tab === id ? "active" : "";
  return `<button class="tab-btn ${active}" data-tab="${id}">${label}</button>`;
}

function renderWelcome(): string {
  const recent = state.chats.slice(0, 5);
  return `
    <h2>Local LLM Harness</h2>
    <p class="muted">Offline coding assistant. No internet, workspace-only file access.</p>
    <div class="row">
      <button id="newChat" class="primary">+ New chat</button>
      <button id="goSettings">Settings</button>
    </div>
    ${state.openTabs.length > 0 ? `
      <h3>Open</h3>
      <ul class="chat-list">${state.openTabs.map(t => `<li data-open="${t.id}"><span>${esc(t.title)}</span></li>`).join("")}</ul>
    ` : ""}
    <h3>Recent</h3>
    ${recent.length === 0 ? `<p class="muted">No chats yet.</p>` :
      `<ul class="chat-list">${recent.map(c => `<li data-open="${c.id}"><span>${esc(c.title)}</span><time>${ago(c.updatedAt)}</time></li>`).join("")}</ul>`}
  `;
}

function renderChats(): string {
  if (state.chats.length === 0) return `<p class="muted">No chats yet. Use the + button in the chat header.</p>`;
  return `<ul class="chat-list">${state.chats.map(c => `
    <li data-open="${c.id}">
      <span>${esc(c.title)}</span>
      <time>${ago(c.updatedAt)}</time>
      <button class="delete" data-delete="${c.id}" title="Delete">×</button>
    </li>`).join("")}</ul>`;
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
    <h2>Settings</h2>
    <label>Endpoint
      <input id="endpoint" type="text" value="${esc(endpoint)}" />
      <button id="saveEndpoint" class="primary">Save</button>
    </label>
    <div class="validation ${validationCls}">${esc(state.endpointMsg?.text ?? "")}</div>

    <label>Model family
      <select id="modelFamily">
        <option value="gemma4" ${family === "gemma4" ? "selected" : ""}>Gemma 4</option>
        <option value="qwen3" ${family === "qwen3" ? "selected" : ""}>Qwen 3</option>
      </select>
    </label>

    <label>Context size (tokens)
      <input id="contextSize" type="number" value="${esc(ctxSize)}" />
    </label>

    <label class="toggle">
      <input id="autoCompact" type="checkbox" ${autoCompact ? "checked" : ""}/>
      Auto-compact when full
    </label>

    <label>Auto-compact threshold (tokens)
      <input id="autoCompactThreshold" type="number" value="${esc(threshold)}" />
    </label>

    <label class="toggle">
      <input id="autoapproveReads" type="checkbox" ${arReads ? "checked" : ""}/>
      Auto-approve reads
    </label>

    <label class="toggle">
      <input id="autoapproveWrites" type="checkbox" ${arWrites ? "checked" : ""}/>
      Auto-approve writes
    </label>

    <div class="row">
      <button id="editSafe">Edit safe-commands in settings.json</button>
    </div>
  `;
}

function bind(): void {
  root.querySelectorAll(".tab-btn").forEach(b => b.addEventListener("click", () => {
    const id = (b as HTMLElement).dataset.tab as "welcome" | "chats" | "settings";
    state.tab = id;
    send({ type: "openTab", tab: id });
    render();
  }));
  root.querySelectorAll("li[data-open]").forEach(li => li.addEventListener("click", e => {
    if ((e.target as HTMLElement).hasAttribute("data-delete")) return;
    send({ type: "openChat", id: (li as HTMLElement).dataset.open! });
  }));
  root.querySelectorAll("[data-delete]").forEach(b => b.addEventListener("click", e => {
    e.stopPropagation();
    send({ type: "deleteChat", id: (b as HTMLElement).dataset.delete! });
  }));
  root.querySelector("#newChat")?.addEventListener("click", () => send({ type: "newChat" }));
  root.querySelector("#goSettings")?.addEventListener("click", () => {
    state.tab = "settings"; render();
  });
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
