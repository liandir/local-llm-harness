import type { MemoryListItem } from "../../../chat/memory.js";
import { DEFAULT_MEMORY_MAX_COUNT, MAX_MEMORY_COUNT } from "../../../chat/memoryLimits.js";
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
  endpointMetadata?: { modelAlias: string; contextSize: number };
  serverModels: { id: string }[];
  openTabs: { id: string; title: string }[];
  version: string;
  memories: MemoryListItem[];
  memoryError?: string;
  memorySettingError?: string;
}

const state: State = {
  tab: "welcome",
  search: "",
  chats: [],
  settings: {},
  serverModels: [],
  openTabs: [],
  memories: [],
  version: ""
};

const memoryDrafts = new Map<string, string>();
const expandedMemories = new Set<string>();

const root = document.getElementById("app")!;

function send(msg: SideToExt): void { vscode.postMessage(msg); }

function render(): void {
  const active = document.activeElement as HTMLTextAreaElement | null;
  const editingMemory = active?.dataset.memoryEditor;
  const editingPanel = active?.closest<HTMLElement>("[data-memory-details]")?.id;
  const selection = editingMemory ? [active!.selectionStart, active!.selectionEnd] : undefined;
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
  if (editingMemory && selection) {
    const editor = root.querySelector(`#${editingPanel} [data-memory-editor="${editingMemory}"]`) as HTMLTextAreaElement | null;
    editor?.focus();
    editor?.setSelectionRange(selection[0], selection[1]);
  }
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
          <p class="welcome-caption">Set things up, before you get started.</p>
          <button id="openSettings" class="welcome-button icon-label">${settingsIcon()}<span>Open settings</span></button>
        </div>
      </section>
      <footer class="welcome-footer">
        ${state.version ? `<span>v${esc(state.version)}</span><span aria-hidden="true">·</span>` : ""}
        <button id="openGithub" class="link-button" type="button">GitHub</button>
      </footer>
    </div>
  `;
}

function renderChats(): string {
  const query = state.search.trim().toLowerCase();
  const busy = state.memories.some(memory => memory.status === "queued" || memory.status === "generating");
  const memories = new Map(state.memories.map(memory => [memory.sourceId, memory]));
  const chats = query
    ? state.chats.filter(c => c.title.toLowerCase().includes(query))
    : state.chats;
  return `
    <div class="panel">
      <section class="panel-section">
        <button id="newChat" class="welcome-button icon-label">${plusIcon()}<span>Start new chat</span></button>
        <button id="summarizeMemories" class="wide-button icon-label">${cloudIcon()}<span>Re-generate memories</span></button>
        ${busy ? '<button id="cancelMemories" class="wide-button">Cancel generation</button>' : ""}
        <p class="setting-help">Memories update after responses. Edited memories are preserved.</p>
        ${state.memoryError ? `<p class="memory-error" role="alert">${esc(state.memoryError)}</p>` : ""}
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
          <ul class="chat-list">${state.openTabs.map(t => renderChatEntry(t, memories.get(t.id), "open")).join("")}</ul>
        </section>
      ` : ""}

      <section class="panel-section">
        <h3>Chats</h3>
        ${chats.length === 0 ? `<p class="empty-state">${query ? "No matching chats." : "No chats yet."}</p>` :
          `<ul class="chat-list">${chats.map(c => renderChatEntry(c, memories.get(c.id), "recent")).join("")}</ul>`}
        ${state.chats.length > 0 ? `<button id="clearChats" class="wide-button danger icon-label clear-chats">${trashIcon()}<span>Clear all chats</span></button>` : ""}
      </section>
    </div>
  `;
}

function renderMemorySettings(): string {
  return `<section class="panel-section">
    <h3>Workspace memory</h3>
    ${switchControl("memoryEnabled", "Use workspace memories", state.settings.memoryEnabled === true)}
    <p class="setting-help">Load relevant summaries from other chats into context. This switch only controls context loading; summaries are generated and managed in Recent Chats.</p>
    <label class="field-label" for="memoryMaxCount">Maximum memories</label>
    <input id="memoryMaxCount" type="number" min="1" max="${MAX_MEMORY_COUNT}" step="1" value="${esc(String(state.settings.memoryMaxCount ?? DEFAULT_MEMORY_MAX_COUNT))}" />
    <p class="setting-help">Default: 10. Token limits may load fewer. Existing chats keep their saved selection.</p>
    ${state.memorySettingError ? `<p class="memory-error" role="alert">${esc(state.memorySettingError)}</p>` : ""}
  </section>`;
}

function renderChatEntry(chat: { id: string; title: string; updatedAt?: number }, memory: MemoryListItem | undefined, group: string): string {
  const panelId = `memory-${group}-${chat.id}`;
  const included = memory?.enabled ?? true;
  return `<li class="chat-entry">
    <div class="chat-row" data-open="${esc(chat.id)}">
      <span>${esc(chat.title)}</span>
      ${chat.updatedAt !== undefined ? `<time>${ago(chat.updatedAt)}</time>` : ""}
      <button class="memory-reveal${included ? " memory-included" : ""}" data-memory-reveal="${esc(panelId)}" data-tip="Memory ${included ? "included" : "excluded"}" aria-label="Memory for ${esc(chat.title)} (${included ? "included" : "excluded"})" aria-expanded="${expandedMemories.has(panelId)}" aria-controls="${esc(panelId)}">${cloudIcon()}</button>
      <button class="delete" data-delete="${esc(chat.id)}" data-tip="Delete" aria-label="Delete chat">${trashIcon()}</button>
    </div>
    ${renderChatMemory(memory ?? { sourceId: chat.id, title: chat.title, text: "", sourceRevision: "", generatedAt: 0, enabled: true, status: "missing" }, panelId)}
  </li>`;
}

function renderChatMemory(memory: MemoryListItem, panelId: string): string {
  return `<div class="memory-entry" id="${esc(panelId)}" data-memory-details="${esc(memory.sourceId)}" ${expandedMemories.has(panelId) ? "" : "hidden"}>
        <p class="memory-status">Memory · ${memory.enabled ? esc(memory.status) : `excluded · ${esc(memory.status)}`}</p>
        ${memory.generatedAt ? `<p class="setting-help">Updated ${esc(new Date(memory.generatedAt).toLocaleString())}</p>` : ""}
        ${memory.error ? `<p class="memory-error">${esc(memory.error)}</p>` : ""}
        <textarea class="memory-editor" data-memory-editor="${esc(memory.sourceId)}" aria-label="Memory for ${esc(memory.title)}" placeholder="No summary yet">${esc(memoryDrafts.get(memory.sourceId) ?? memory.text)}</textarea>
        <div class="memory-actions">
          <button data-memory-save="${esc(memory.sourceId)}">Save edit</button>
          <button data-memory-toggle="${esc(memory.sourceId)}" aria-label="${memory.enabled ? "Exclude memory for" : "Include memory for"} ${esc(memory.title)}">${memory.enabled ? "Exclude" : "Include"}</button>
          <button data-memory-regenerate="${esc(memory.sourceId)}">Regenerate</button>
        </div>
      </div>`;
}

function renderSettings(): string {
  const s = state.settings;
  const endpoint = String(s["endpoint"] ?? "http://localhost:8080/v1");
  const model = String(s["model"] ?? "local");
  const toolCallingMode = String(s["toolCallingMode"] ?? "compat-gemma4");
  const temperature = String(s["temperature"] ?? 0.7);
  const topK = String(s["topK"] ?? 40);
  const topP = String(s["topP"] ?? 0.95);
  const reasoningBudget = String(s["reasoningBudget"] ?? 16384);
  const showThinking = s["showThinking"] !== false;
  const autoCompact = !!s["autoCompact"];
  const autoCompactPct = clampPercent(Number(s["autoCompactThresholdPercent"] ?? 80));
  const arReads = !!s["autoapproveReads"];
  const arWrites = !!s["autoapproveWrites"];
  const arCommands = !!s["autoapproveCommands"];
  const validationCls = state.endpointMsg?.ok ? "ok" : state.endpointMsg ? "err" : "";

  return `
    <div class="panel">
      <section class="panel-section">
        <h3>Model</h3>
        <label class="field-label" for="endpoint">Server URL</label>
        <div class="setting-action-row">
          <input id="endpoint" type="text" value="${esc(endpoint)}" />
          <button id="saveEndpoint" class="primary">Set</button>
        </div>
        <div class="validation ${validationCls}">${esc(state.endpointMsg?.text ?? "")}</div>
        ${state.serverModels.length > 0 ? `
          <label class="field-label" for="model">Model</label>
          <select id="model">
            ${state.serverModels.map(item => `<option value="${esc(item.id)}" ${item.id === model ? "selected" : ""}>${esc(item.id)}</option>`).join("")}
          </select>
        ` : ""}
        ${state.endpointMetadata ? `<div class="endpoint-metadata">
          <div><span>Reported model</span><strong>${esc(state.endpointMetadata.modelAlias)}</strong></div>
          <div><span>Context</span><strong>${esc(state.endpointMetadata.contextSize.toLocaleString())} tokens</strong></div>
        </div>` : ""}

        <label class="field-label" for="toolCallingMode">Tool calling</label>
        <select id="toolCallingMode">
          <option value="native" ${toolCallingMode === "native" ? "selected" : ""}>Native server only</option>
          <option value="compat-gemma4" ${toolCallingMode === "compat-gemma4" ? "selected" : ""}>Gemma 4 compatibility</option>
          <option value="compat-qwen3" ${toolCallingMode === "compat-qwen3" ? "selected" : ""}>Qwen 3 compatibility</option>
          <option value="compat-muse-glimmer" ${toolCallingMode === "compat-muse-glimmer" ? "selected" : ""}>Muse Glimmer compatibility</option>
          <option value="compat-gpt-oss" ${toolCallingMode === "compat-gpt-oss" ? "selected" : ""}>GPT-OSS compatibility</option>
        </select>

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
        <label class="field-label" for="reasoningBudget">Reasoning budget</label>
        <input id="reasoningBudget" type="number" min="-1" step="1" value="${esc(reasoningBudget)}" />
        <p class="setting-help">Use -1 for unlimited reasoning, 0 for an instant answer, or a positive number for a token threshold.</p>
      </section>

      <section class="panel-section">
        <h3>Chat</h3>
        ${switchControl("showThinking", "Show thoughts", showThinking)}
        <p class="setting-help">When off, completed thoughts are hidden from tool history. Current thinking remains visible while it is active.</p>
      </section>

      ${renderMemorySettings()}
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
        ${switchControl("autoapproveCommands", "Auto-approve safe commands", arCommands)}
      </section>

      <section class="panel-section">
        <h3>User settings</h3>
        <p class="setting-help">Edit workspace settings.json to customize reasoning-effort choices, chat-title instructions, commit-message formatting, and the safe-command auto-approval list. User messages and staged diffs are appended to their prompts automatically.</p>
        <button id="editUserSettings" class="wide-button">Edit User Settings</button>
        <button id="restorePrompts" class="wide-button">Restore default prompts</button>
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
    openTab(id);
  }));
  root.querySelector("#chatSearch")?.addEventListener("input", e => {
    state.search = (e.target as HTMLInputElement).value;
    render();
  });
  root.querySelectorAll("[data-open]").forEach(li => li.addEventListener("click", e => {
    if ((e.target as Element).closest("button")) return;
    send({ type: "openChat", id: (li as HTMLElement).dataset.open! });
  }));
  root.querySelectorAll("[data-delete]").forEach(b => b.addEventListener("click", e => {
    e.stopPropagation();
    send({ type: "deleteChat", id: (b as HTMLElement).dataset.delete! });
  }));
  root.querySelector("#newChat")?.addEventListener("click", () => send({ type: "newChat" }));
  root.querySelector("#clearChats")?.addEventListener("click", () => send({ type: "clearChats" }));
  root.querySelector("#openRecentChats")?.addEventListener("click", () => openTab("chats"));
  root.querySelector("#openSettings")?.addEventListener("click", () => openTab("settings"));
  root.querySelector("#openGithub")?.addEventListener("click", () => send({ type: "openGithub" }));
  root.querySelector("#saveEndpoint")?.addEventListener("click", () => {
    const url = (root.querySelector("#endpoint") as HTMLInputElement).value;
    state.endpointMsg = { ok: true, text: "Reading server metadata…" };
    state.endpointMetadata = undefined;
    state.serverModels = [];
    render();
    send({ type: "validateEndpoint", url });
  });
  bindSetting("model", "change", v => v);
  bindSetting("toolCallingMode", "change", v => v);
  bindSetting("temperature", "change", v => Number(v));
  bindSetting("topK", "change", v => Number(v));
  bindSetting("topP", "change", v => Number(v));
  bindSetting("reasoningBudget", "change", v => Math.round(Number(v)));
  bindSetting("memoryEnabled", "change", (_v, el) => (el as HTMLInputElement).checked);
  bindSetting("memoryMaxCount", "change", v => Math.floor(Math.max(1, Math.min(MAX_MEMORY_COUNT, Number(v) || DEFAULT_MEMORY_MAX_COUNT))));
  root.querySelector("#summarizeMemories")?.addEventListener("click", () => send({ type: "summarizeExistingChats" }));
  root.querySelector("#cancelMemories")?.addEventListener("click", () => send({ type: "cancelMemoryGeneration" }));
  root.querySelectorAll<HTMLButtonElement>("[data-memory-reveal]").forEach(el => el.addEventListener("click", e => {
    e.stopPropagation();
    const id = el.dataset.memoryReveal!;
    const expanded = !expandedMemories.has(id);
    if (expanded) expandedMemories.add(id); else expandedMemories.delete(id);
    el.setAttribute("aria-expanded", String(expanded));
    document.getElementById(id)!.hidden = !expanded;
  }));
  root.querySelectorAll<HTMLTextAreaElement>("[data-memory-editor]").forEach(el => el.addEventListener("input", () => memoryDrafts.set(el.dataset.memoryEditor!, el.value)));
  root.querySelectorAll<HTMLElement>("[data-memory-save]").forEach(el => el.addEventListener("click", () => {
    const id = el.dataset.memorySave!;
    state.memoryError = undefined;
    send({ type: "editMemory", id, text: memoryDrafts.get(id) ?? state.memories.find(m => m.sourceId === id)?.text ?? "" });
  }));
  root.querySelectorAll<HTMLElement>("[data-memory-toggle]").forEach(el => el.addEventListener("click", () => {
    const id = el.dataset.memoryToggle!;
    send({ type: "setMemoryEnabled", id, enabled: !(state.memories.find(m => m.sourceId === id)?.enabled ?? true) });
  }));
  root.querySelectorAll<HTMLElement>("[data-memory-regenerate]").forEach(el => el.addEventListener("click", () => {
    const id = el.dataset.memoryRegenerate!;
    memoryDrafts.delete(id);
    send({ type: "regenerateMemory", id });
  }));
  bindSetting("showThinking", "change", (_v, el) => (el as HTMLInputElement).checked);
  bindSetting("autoCompact", "change", (_v, el) => (el as HTMLInputElement).checked);
  bindRangeSetting("autoCompactThresholdPercent");
  bindSetting("autoapproveReads", "change", (_v, el) => (el as HTMLInputElement).checked);
  bindSetting("autoapproveWrites", "change", (_v, el) => (el as HTMLInputElement).checked);
  bindSetting("autoapproveCommands", "change", (_v, el) => (el as HTMLInputElement).checked);
  root.querySelector("#editUserSettings")?.addEventListener("click", () => send({ type: "editUserSettingsJson" }));
  root.querySelector("#restorePrompts")?.addEventListener("click", () => send({ type: "restoreDefaultGeneratedPrompts" }));
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

function cloudIcon(): string {
  return `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <path d="M4.25 12.5h7.5a2.75 2.75 0 0 0 .3-5.48A4.25 4.25 0 0 0 3.8 6.1a3.25 3.25 0 0 0 .45 6.4Z"/>
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
    case "settingSaved":
      if ((msg.key === "memoryEnabled" || msg.key === "memoryMaxCount") && !msg.ok) { state.memorySettingError = msg.error; render(); }
      break;
    case "memories": state.memories = msg.memories; render(); break;
    case "memoryError": state.memoryError = msg.error; render(); break;
    case "appInfo": state.version = msg.version; render(); break;
    case "settings": state.settings = msg.settings; state.memorySettingError = undefined; render(); break;
    case "chats": state.chats = msg.chats; render(); break;
    case "focusTab": state.tab = msg.tab; render(); break;
    case "endpointValidation":
      state.endpointMsg = msg.ok
        ? { ok: true, text: `Connected — ${msg.resolved?.join(", ") ?? "allowed endpoint"}`.trim() }
        : { ok: false, text: msg.error ?? "Validation failed." };
      state.endpointMetadata = msg.ok ? msg.metadata : undefined;
      state.serverModels = msg.ok ? msg.models ?? [] : [];
      if (msg.ok && msg.selectedModel) state.settings = { ...state.settings, model: msg.selectedModel };
      render(); break;
    case "openTabs": state.openTabs = msg.tabs; render(); break;
  }
});

send({ type: "ready" });
render();
