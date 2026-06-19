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
      ${tabBtn("chats", "Chats")}
      ${tabBtn("settings", "Settings")}
    </div>
    <div class="tab-body">
      ${state.tab === "welcome" ? renderWelcome() : state.tab === "chats" ? renderChats() : renderSettings()}
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
  const icon = id === "chats" ? historyIcon() : id === "settings" ? settingsIcon() : "";
  return `<button class="tab-btn ${active}" data-tab="${id}">${icon}<span>${label}</span></button>`;
}

function renderWelcome(): string {
  return `
    <div class="panel welcome-panel">
      <section class="welcome-section welcome-hero">
        <h2>Welcome to Local LLM Harness</h2>
        <p class="welcome-copy">Vibe with your locally hosted language model.</p>
      </section>

      <section class="welcome-actions">
        <div class="welcome-group">
          <p class="welcome-caption">Start chatting immediately.</p>
          <button id="newChat" class="welcome-button icon-label">${plusIcon()}<span>Start new chat</span></button>
        </div>
        <div class="welcome-group">
          <p class="welcome-caption">Continue, where you left off.</p>
          <button id="openRecentChats" class="welcome-button icon-label">${historyIcon()}<span>Open recent chats</span></button>
        </div>
        <div class="welcome-group">
          <p class="welcome-caption">First time here? Set things up, before you get started.</p>
          <button id="openSettings" class="welcome-button icon-label">${settingsIcon()}<span>Open settings</span></button>
        </div>
      </section>
    </div>
  `;
}

function renderChats(): string {
  const query = state.search.trim().toLowerCase();
  const chats = query
    ? state.chats.filter(c => c.title.toLowerCase().includes(query))
    : state.chats;
  return `
    <div class="panel">
      <section class="panel-section">
        <button id="newChat" class="welcome-button icon-label">${plusIcon()}<span>Start new chat</span></button>
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
  const endpoint = String(s["endpoint"] ?? "http://localhost:8080/v1");
  const family = String(s["modelFamily"] ?? "gemma4");
  const ctxSize = String(s["contextSize"] ?? 32768);
  const temperature = String(s["temperature"] ?? 0.7);
  const topK = String(s["topK"] ?? 40);
  const topP = String(s["topP"] ?? 0.95);
  const autoCompact = !!s["autoCompact"];
  const autoCompactPct = clampPercent(Number(s["autoCompactThresholdPercent"] ?? 80));
  const arReads = !!s["autoapproveReads"];
  const arWrites = !!s["autoapproveWrites"];
  const arCommands = !!s["autoapproveCommands"];
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

        <div class="field-row">
          <div class="field-cell">
            <label class="field-label" for="temperature">Temperature</label>
            <input id="temperature" type="number" min="0" max="2" step="0.05" value="${esc(temperature)}" />
          </div>
          <div class="field-cell">
            <label class="field-label" for="topK">Top-k</label>
            <input id="topK" type="number" min="0" step="1" value="${esc(topK)}" />
          </div>
          <div class="field-cell">
            <label class="field-label" for="topP">Top-p</label>
            <input id="topP" type="number" min="0" max="1" step="0.05" value="${esc(topP)}" />
          </div>
        </div>
      </section>

      <section class="panel-section">
        <h3>Automation</h3>
        ${switchControl("autoCompact", "Auto-compact context", autoCompact)}
        <label class="range-setting" for="autoCompactThresholdPercent">
          <span class="range-setting-head">
            <span>Auto-compact threshold</span>
            <strong id="autoCompactThresholdValue">${autoCompactPct}%</strong>
          </span>
          <input id="autoCompactThresholdPercent" type="range" min="50" max="95" step="1" value="${autoCompactPct}" />
        </label>

        ${switchControl("autoapproveReads", "Auto-approve reads", arReads)}
        ${switchControl("autoapproveWrites", "Auto-approve edits", arWrites)}
        ${switchControl("autoapproveCommands", "Auto-approve commands", arCommands)}
      </section>

      <section class="panel-section">
        <h3>Commands</h3>
        <button id="editSafe" class="wide-button">Edit safe commands</button>
        <button id="restoreSafe" class="wide-button">Restore default safe commands</button>
      </section>

      <section class="panel-section">
        <h3>Reset</h3>
        <button id="resetDefaults" class="wide-button danger">Restore all defaults</button>
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
  root.querySelector("#openRecentChats")?.addEventListener("click", () => openTab("chats"));
  root.querySelector("#openSettings")?.addEventListener("click", () => openTab("settings"));
  root.querySelector("#saveEndpoint")?.addEventListener("click", () => {
    const url = (root.querySelector("#endpoint") as HTMLInputElement).value;
    send({ type: "validateEndpoint", url });
  });
  bindSetting("modelFamily", "change", v => v);
  bindSetting("contextSize", "change", v => Number(v));
  bindSetting("temperature", "change", v => Number(v));
  bindSetting("topK", "change", v => Number(v));
  bindSetting("topP", "change", v => Number(v));
  bindSetting("autoCompact", "change", (_v, el) => (el as HTMLInputElement).checked);
  bindRangeSetting("autoCompactThresholdPercent");
  bindSetting("autoapproveReads", "change", (_v, el) => (el as HTMLInputElement).checked);
  bindSetting("autoapproveWrites", "change", (_v, el) => (el as HTMLInputElement).checked);
  bindSetting("autoapproveCommands", "change", (_v, el) => (el as HTMLInputElement).checked);
  root.querySelector("#editSafe")?.addEventListener("click", () => send({ type: "editSafeCommandsJson" }));
  root.querySelector("#restoreSafe")?.addEventListener("click", () => send({ type: "restoreDefaultSafeCommands" }));
  root.querySelector("#resetDefaults")?.addEventListener("click", () => send({ type: "resetAllDefaults" }));
}

function openTab(tab: SideTab): void {
  state.tab = tab;
  send({ type: "openTab", tab });
  render();
}

function bindSetting(id: string, evt: string, getter: (v: string, el: Element) => unknown): void {
  const el = root.querySelector("#" + id);
  if (!el) return;
  el.addEventListener(evt, () => {
    const value = getter((el as HTMLInputElement).value, el);
    send({ type: "saveSetting", key: id, value });
  });
}

function bindRangeSetting(id: string): void {
  const el = root.querySelector("#" + id) as HTMLInputElement | null;
  if (!el) return;
  el.addEventListener("input", () => {
    updateAutoCompactThresholdLabel(clampPercent(Number(el.value)));
  });
  el.addEventListener("change", () => {
    const pct = clampPercent(Number(el.value));
    el.value = String(pct);
    updateAutoCompactThresholdLabel(pct);
    send({ type: "saveSetting", key: id, value: pct });
  });
}

function updateAutoCompactThresholdLabel(percent: number): void {
  const label = root.querySelector("#autoCompactThresholdValue") as HTMLElement | null;
  if (label) label.textContent = `${percent}%`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 80;
  return Math.min(95, Math.max(50, Math.round(value)));
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
        ? { ok: true, text: `OK — allowed endpoint ${msg.resolved?.join(", ") ?? ""}`.trim() }
        : { ok: false, text: msg.error ?? "Validation failed." };
      render(); break;
    case "openTabs": state.openTabs = msg.tabs; render(); break;
  }
});

send({ type: "ready" });
render();
