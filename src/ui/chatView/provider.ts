import type { WorkspaceMemory } from "../../chat/workspaceMemory.js";
import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { ChatSession, type UiEvent } from "../../chat/session.js";
import { ChatStorage, MAX_ATTACHMENT_BYTES, type ChatAttachment, type ChatRecord } from "../../chat/storage.js";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "../../chat/attachmentLimits.js";
import type { ChatMode } from "../../chat/mode.js";
import { readSettings, onSettingsChange } from "../../config/settings.js";
import {
  DEFAULT_REASONING_EFFORT,
  availableReasoningEffort,
  normalizeReasoningEffort,
  WORKSPACE_REASONING_EFFORT_KEY,
  type ReasoningEffort
} from "../../chat/reasoningEffort.js";
import { assertInsideWorkspace } from "../../tools/workspaceGuard.js";
import { execFileUtf8 } from "../../util/exec.js";
import type { ChatToExt, ExtToChat, SideTab, UiAttachment, ChatTab } from "../messaging.js";
import { reorderItemsById, shouldDrainMessageQueue } from "./queuedMessages.js";
import { classifyWorkspacePath } from "./workspacePathTypes.js";

interface GitChangeState {
  uri?: vscode.Uri;
  resourceUri?: vscode.Uri;
  originalUri?: vscode.Uri;
}

interface GitRepositoryApi {
  rootUri: vscode.Uri;
  state?: {
    workingTreeChanges?: GitChangeState[];
    indexChanges?: GitChangeState[];
    mergeChanges?: GitChangeState[];
  };
}

interface GitApi {
  repositories?: GitRepositoryApi[];
}

interface GitExtensionApi {
  getAPI(version: number): GitApi;
}

interface ChatRuntime {
  session?: ChatSession;
  storage?: ChatStorage;
  queuedMessages: { id: string; text: string; attachments?: ChatAttachment[] }[];
  stagedAttachmentIds: Set<string>;
  pendingAttachments: Map<string, ChatAttachment>;
  messageLoopRunning: boolean;
  sessionCreationPending: boolean;
  attachmentSelectionPending: boolean;
  events: UiEvent[];
  draft: string;
  open: boolean;
  removed: boolean;
  running: boolean;
  compacting: boolean;
}

function newRuntime(): ChatRuntime {
  return { queuedMessages: [], stagedAttachmentIds: new Set(), pendingAttachments: new Map(),
    messageLoopRunning: false, sessionCreationPending: false, attachmentSelectionPending: false,
    events: [], draft: "", open: true, removed: false, running: false, compacting: false };
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "localLlmHarness.chat";
  private static readonly reviewScheme = "local-llm-harness-review";
  private view?: vscode.WebviewView;
  private runtimes = new Map<string, ChatRuntime>();
  private navigationGeneration = 0;
  private recentChatsGeneration = 0;
  private deleting = new Map<string, ChatStorage>();
  private clearingStorage?: ChatStorage;

  isClearingWorkspace(): boolean { return !!this.clearingStorage && this.clearingStorage === this.getStorage(); }
  private active = newRuntime();
  private get session(): ChatSession | undefined { return this.active.session; }
  private subs: vscode.Disposable[] = [];
  private chatFocusCtx = false;
  private reviewProviderRegistered = false;
  private reviewDocuments = new Map<string, string>();
  private get queuedMessages() { return this.active.queuedMessages; }
  private set queuedMessages(value: ChatRuntime["queuedMessages"]) { this.active.queuedMessages = value; }
  private get stagedAttachmentIds() { return this.active.stagedAttachmentIds; }
  private get pendingAttachments() { return this.active.pendingAttachments; }
  private get sessionCreationPending() { return this.active.sessionCreationPending; }
  private set sessionCreationPending(value: boolean) { this.active.sessionCreationPending = value; }

  constructor(
    private context: vscode.ExtensionContext,
    private getStorage: () => ChatStorage | undefined,
    private getWorkspaceRoot: () => string | undefined,
    private onOpenSideTab: (tab: SideTab) => void,
    private onChatOpened: (rec: ChatRecord) => void,
    private onCreateChat: () => Promise<ChatRecord | undefined>,
    private onChatListChanged: () => void,
    private memory?: WorkspaceMemory,
    private onOpenMemory?: (id: string) => void | Promise<void>
  ) {}

  private ensureReviewContentProvider(): void {
    if (this.reviewProviderRegistered) return;
    this.reviewProviderRegistered = true;
    this.context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(
      ChatViewProvider.reviewScheme,
      { provideTextDocumentContent: uri => this.reviewDocuments.get(uri.toString()) ?? "" }
    ));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ensureReviewContentProvider();
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "dist"),
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
        ...(this.getStorage() ? [vscode.Uri.file(this.getStorage()!.attachmentsRoot())] : [])
      ]
    };
    view.webview.html = this.html(view.webview);
    this.subs.push(
      view.webview.onDidReceiveMessage((m: ChatToExt) => this.onMessage(m)),
      view.onDidChangeVisibility(() => this.updateFocusContext(view.visible)),
      onSettingsChange(() => this.pushSettings())
    );
    this.updateFocusContext(view.visible);
    view.onDidDispose(() => {
      this.subs.forEach(d => d.dispose());
      this.subs = [];
      this.view = undefined;
      this.updateFocusContext(false);
    });
  }

  private updateFocusContext(focused: boolean): void {
    if (this.chatFocusCtx !== focused) {
      this.chatFocusCtx = focused;
      void vscode.commands.executeCommand("setContext", "localLlmHarness.chatFocus", focused);
    }
  }

  reveal(): void {
    this.view?.show?.(true);
    void vscode.commands.executeCommand("localLlmHarness.chat.focus");
  }

  post(msg: UiEvent | ExtToChat): void {
    this.view?.webview.postMessage(this.prepareMessage(msg));
  }

  private prepareMessage(msg: ExtToChat): ExtToChat {
    let payload: ExtToChat = msg;
    if ("type" in msg && msg.type === "chatSnapshot") return { ...msg, events: msg.events.map(event => this.prepareMessage(event)) };
    if ("kind" in msg && msg.kind === "userMessage" && msg.attachments) {
      payload = { ...msg, attachments: msg.attachments.map(attachment => this.toUiAttachment(attachment)) };
    } else if ("kind" in msg && msg.kind === "chatLoaded") {
      const { contextMessages, ...transcript } = msg.record;
      delete transcript.memory;
      delete transcript.memorySelection;
      delete transcript.memoryUsage;
      delete transcript.recalledMemories;
      payload = {
        ...msg,
        contextMessageCount: contextMessages?.length ?? transcript.messages.length,
        record: {
          ...transcript,
          messages: msg.record.messages.map(message => ({
            ...message,
            attachments: message.attachments?.map(attachment => this.toUiAttachment(attachment))
          }))
        }
      };
    }
    return payload;
  }

  private toUiAttachment(attachment: ChatAttachment, runtime = this.active): UiAttachment {
    const storage = runtime.storage ?? this.getStorage();
    const chatId = runtime.session?.getRecord().id;
    const previewUri = storage && chatId && this.view
      ? this.view.webview.asWebviewUri(vscode.Uri.file(storage.attachmentPath(chatId, attachment))).toString()
      : "";
    return { ...attachment, previewUri };
  }

  pushSettings(): void {
    const s = readSettings();
    const reasoningEffort = availableReasoningEffort(
      this.session?.getRecord().reasoningEffort ?? this.workspaceReasoningEffort(),
      s.reasoningEfforts
    );
    if (this.memory) this.refreshMemoryVisibility();
    this.post({
      type: "settings",
      mode: this.session?.getRecord().mode ?? "act",
      reasoningEffort,
      reasoningEfforts: s.reasoningEfforts,
      showThinking: s.showThinking,
      autoCompact: s.autoCompact,
      autoCompactThresholdPercent: s.autoCompactThresholdPercent,
      workspaceRoot: this.getWorkspaceRoot()
    });
  }

  async pushRecentChats(): Promise<void> {
    const generation = ++this.recentChatsGeneration;
    const storage = this.getStorage();
    if (!storage) {
      this.post({ type: "recentChats", chats: [], totalCount: 0 });
      return;
    }
    const currentId = this.session?.getRecord().id;
    const workspaceChats = await storage.list();
    if (generation !== this.recentChatsGeneration || storage !== this.getStorage() || currentId !== this.session?.getRecord().id) return;
    const chats = workspaceChats
      .filter(chat => chat.id !== currentId)
      .slice(0, 5);
    this.post({ type: "recentChats", chats, totalCount: workspaceChats.length });
  }

  getCurrentRecord(): ChatRecord | undefined {
    return this.session?.getRecord();
  }

  refreshMemoryVisibility(): void { for (const runtime of this.runtimes.values()) void runtime.session?.refreshMemoryVisibility(); }

  getTabs(): ChatTab[] {
    return [...this.runtimes.values()].filter(runtime => runtime.open || runtime.running || runtime.compacting).map(runtime => ({
      id: runtime.session!.getRecord().id, title: runtime.session!.getRecord().title,
      running: runtime.running || runtime.compacting, open: runtime.open
    }));
  }

  private pushTabs(): void {
    this.post({ type: "chatTabs", tabs: this.getTabs().filter(tab => tab.open), activeId: this.session?.getRecord().id });
    this.onChatListChanged();
  }

  closeTab(id: string): void {
    this.navigationGeneration++;
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    runtime.open = false;
    if (this.active === runtime) {
      const next = [...this.runtimes.values()].filter(item => item.open).at(-1);
      if (next) this.activateRuntime(next);
      else { this.active = newRuntime(); this.post({ kind: "chatClosed" }); }
    }
    this.pushTabs();
  }

  async removeChat(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    const storage = runtime?.storage ?? this.getStorage();
    if (!storage || this.deleting.get(id) === storage) return;
    this.deleting.set(id, storage);
    try {
      if (runtime) {
        this.closeTab(id);
        runtime.removed = true;
        this.runtimes.delete(id);
        this.clearMessageQueue(runtime);
        await runtime.session?.shutdown();
      }
      await storage.delete(id);
    } finally {
      this.deleting.delete(id);
      this.pushTabs();
    }
  }

  async clearChats(): Promise<void> {
    const storage = this.getStorage();
    if (!storage || this.isClearingWorkspace()) return;
    this.clearingStorage = storage;
    try {
      await this.closeAll();
      await storage.deleteAll();
    } finally { this.clearingStorage = undefined; }
  }

  async closeAll(): Promise<void> {
    this.navigationGeneration++;
    const runtimes = [...this.runtimes.values()];
    this.active.removed = true;
    this.runtimes.clear();
    this.active = newRuntime();
    this.post({ kind: "chatClosed" });
    this.pushTabs();
    await Promise.all(runtimes.map(async runtime => {
      runtime.removed = true;
      this.clearMessageQueue(runtime);
      await runtime.session?.shutdown();
    }));
  }

  async openChatById(id: string): Promise<void> {
    if (this.isClearingWorkspace() || this.deleting.has(id)) return;
    const generation = ++this.navigationGeneration;
    const existing = this.runtimes.get(id);
    if (existing) { this.activateRuntime(existing); return; }
    const storage = this.getStorage();
    const record = await storage?.load(id);
    if (record && storage === this.getStorage() && generation === this.navigationGeneration) this.openChat(record);
  }

  openChat(rec: ChatRecord): void {
    if (this.isClearingWorkspace() || this.deleting.has(rec.id)) return;
    this.navigationGeneration++;
    const existing = this.runtimes.get(rec.id);
    if (existing) { this.activateRuntime(existing); return; }
    const storage = this.getStorage();
    const ws = this.getWorkspaceRoot();
    if (!storage || !ws) {
      vscode.window.showErrorMessage("Local LLM Harness: open a folder to start a chat.");
      return;
    }
    const runtime = newRuntime();
    runtime.storage = storage;
    const session = new ChatSession({
      storage, workspaceRoot: ws, record: rec,
      emit: event => {
        if (runtime.removed) return;
        // A fresh baseline plus this turn's events preserves streamed text and
        // pending approvals without retaining an unbounded lifetime event log.
        if (event.kind === "turnPreparing" && !runtime.running) {
          const retained = new Map<string, UiEvent>();
          for (const old of runtime.events) {
            if (["tokens", "memoriesUsed", "compactStatus"].includes(old.kind)) retained.set(old.kind, old);
          }
          runtime.events = [{ kind: "chatLoaded", record: structuredClone(session.getRecord()) }, ...retained.values()];
          runtime.running = true;
          this.pushTabs();
        }
        if (event.kind === "compactStart" || event.kind === "compactEnd") {
          runtime.compacting = event.kind === "compactStart";
          this.pushTabs();
        }
        if (event.kind === "chatLoaded") runtime.events = [];
        const previous = runtime.events.at(-1);
        if ((event.kind === "text" || event.kind === "thought") && previous?.kind === event.kind && previous.messageId === event.messageId) {
          previous.delta += event.delta;
        } else runtime.events.push(structuredClone(event));
        if (runtime === this.active) this.post(event);
        if (event.kind === "turnEnd" || event.kind === "abort") {
          runtime.running = false;
          this.pushTabs();
          if (event.kind === "turnEnd") this.memory?.enqueue(rec.id);
        }
        if (event.kind === "titleChanged") { this.onChatOpened(rec); this.pushTabs(); }
      }
    });
    runtime.session = session;
    this.runtimes.set(rec.id, runtime);
    // Record the baseline before activating so a running turn is never reloaded.
    session.emitLoaded();
    this.activateRuntime(runtime);
  }

  private activateRuntime(runtime: ChatRuntime, force = false): void {
    if (this.active === runtime && !force) { this.reveal(); return; }
    this.active = runtime;
    runtime.open = true;
    this.post({ type: "chatSnapshot", id: runtime.session!.getRecord().id,
      events: runtime.events, busy: runtime.running, draft: runtime.draft });
    this.pushMessageQueue(runtime);
    this.post({ type: "attachmentCleared" });
    for (const id of runtime.stagedAttachmentIds) {
      const attachment = runtime.pendingAttachments.get(id);
      if (attachment) this.post({ type: "attachmentSelected", attachment: this.toUiAttachment(attachment, runtime) });
    }
    this.pushSettings();
    this.pushTabs();
    void this.pushRecentChats();
    if (!force) this.reveal();
    this.onChatOpened(runtime.session!.getRecord());
  }

  async renameChat(id: string, title?: string): Promise<void> {
    let runtime = this.runtimes.get(id);
    const storage = this.getStorage();
    const record = runtime?.session?.getRecord() ?? await storage?.load(id);
    if (!record || storage !== this.getStorage()) return;
    const next = (title ?? await vscode.window.showInputBox({ prompt: "Rename chat", value: record.title }))?.trim();
    if (!next || storage !== this.getStorage() || runtime?.removed) return;
    runtime = this.runtimes.get(id);
    if (runtime?.session) {
      await runtime.session.renameTitle(next);
      runtime.events.push({ kind: "titleChanged", title: next, animate: false });
      if (runtime === this.active) this.post({ kind: "titleChanged", title: next, animate: false });
    } else {
      // Reload after the input box: memory generation may have updated this record.
      const latest = await storage?.load(id);
      if (!latest || storage !== this.getStorage()) return;
      latest.title = next;
      await storage!.save(latest);
    }
    this.pushTabs();
  }

  togglePlanMode(): void {
    if (!this.session) return;
    const rec = this.session.getRecord();
    this.session.setMode(rec.mode === "plan" ? "act" : "plan");
  }

  private async setChatMode(mode: ChatMode): Promise<void> {
    if (!this.session) await this.onCreateChat();
    this.session?.setMode(mode);
  }

  private async setReasoningEffort(effort: ReasoningEffort): Promise<void> {
    const available = availableReasoningEffort(effort, readSettings().reasoningEfforts);
    if (this.session) {
      // Apply synchronously so a message sent while workspaceState is flushing
      // already snapshots the newly selected mode for its next turn.
      this.session.setReasoningEffort(available);
      await this.context.workspaceState.update(WORKSPACE_REASONING_EFFORT_KEY, available);
      return;
    }
    // New-chat construction reads this preference, so persist it before asking
    // the extension host to create the first record.
    await this.context.workspaceState.update(WORKSPACE_REASONING_EFFORT_KEY, available);
    await this.onCreateChat();
  }

  private workspaceReasoningEffort(): ReasoningEffort {
    return normalizeReasoningEffort(
      this.context.workspaceState.get<unknown>(WORKSPACE_REASONING_EFFORT_KEY)
        ?? this.context.workspaceState.get<unknown>("localLlmHarness.workspaceThinkingMode", DEFAULT_REASONING_EFFORT)
    );
  }

  async compactNow(): Promise<void> {
    await this.session?.compactNow();
  }

  async compactAfterInterrupt(): Promise<void> {
    await this.session?.compactAfterInterrupt();
  }

  private async onMessage(m: ChatToExt): Promise<void> {
    const navigation = ["openChat", "closeChatTab", "openChats", "openSettings", "newChat", "openMemory", "ready"].includes(m.type) || (m.type === "renameChat" && !!m.id);
    if (!navigation && m.chatId && m.chatId !== this.session?.getRecord().id) {
      if (m.type === "saveDraft") { const runtime = this.runtimes.get(m.chatId); if (runtime) runtime.draft = m.text; }
      return;
    }
    switch (m.type) {
      case "ready":
        this.pushSettings();
        if (this.session) this.activateRuntime(this.active, true);
        else this.pushTabs();
        this.pushMessageQueue();
        await this.pushRecentChats();
        break;
      case "saveDraft": this.active.draft = m.text; break;
      case "closeChatTab": this.closeTab(m.id); break;
      case "send":
        this.active.draft = "";
        if (!this.session) {
          this.sessionCreationPending = true;
          try {
            const rec = await this.onCreateChat();
            if (!rec || !this.session) {
              this.clearMessageQueue();
              return;
            }
          } finally {
            this.sessionCreationPending = false;
          }
        }
        await this.sendAndDrainQueue(this.active, m.text, this.takeStagedAttachments(m.attachmentIds));
        break;
      case "selectAttachment":
        await this.selectAttachment();
        break;
      case "pasteAttachment":
        await this.pasteAttachment(m.fileName, m.mimeType, m.dataUrl);
        break;
      case "discardAttachment": {
        const attachment = this.takeStagedAttachment(m.attachmentId);
        if (attachment && this.session) await this.getStorage()?.deleteAttachment(this.session.getRecord().id, attachment);
        break;
      }
      case "queueMessage": {
        const text = m.text.trim();
        if (this.queuedMessages.some(message => message.id === m.id)) break;
        const attachments = this.takeStagedAttachments(m.attachmentIds);
        if (!text && attachments.length === 0) break;
        this.queuedMessages.push({ id: m.id, text, attachments: attachments.length ? attachments : undefined });
        this.pushMessageQueue();
        this.drainMessageQueueIfIdle();
        break;
      }
      case "removeQueuedMessage":
        {
          const removed = this.queuedMessages.find(message => message.id === m.id);
          this.queuedMessages = this.queuedMessages.filter(message => message.id !== m.id);
          if (removed?.attachments?.length && this.session) {
            for (const attachment of removed.attachments) {
              this.stagedAttachmentIds.delete(attachment.id);
              this.pendingAttachments.delete(attachment.id);
            }
            await Promise.all(removed.attachments.map(attachment =>
              this.getStorage()?.deleteAttachment(this.session!.getRecord().id, attachment)
            ));
          }
        }
        this.pushMessageQueue();
        break;
      case "updateQueuedMessage": {
        const text = m.text.trim();
        const message = this.queuedMessages.find(item => item.id === m.id);
        if (message && (text || message.attachments?.length)) message.text = text;
        this.pushMessageQueue();
        break;
      }
      case "reorderQueuedMessages":
        this.queuedMessages = reorderItemsById(this.queuedMessages, m.ids);
        this.pushMessageQueue();
        break;
      case "editMessage": {
        const runtime = this.active;
        await runtime.session?.editUserMessage(m.messageTs, m.text, m.removeAttachmentIds ?? []);
        if (runtime.session && !runtime.removed) this.onChatOpened(runtime.session.getRecord());
        this.onChatListChanged();
        await this.pushRecentChats();
        this.drainMessageQueueIfIdle(runtime);
        break;
      }
      case "forkChat": {
        const storage = this.getStorage();
        const record = this.session?.getRecord();
        if (!storage || !record) break;
        const forked = await storage.fork(record, m.throughUserMessageTs);
        if (storage === this.getStorage()) this.openChat(forked);
        this.onChatListChanged();
        break;
      }
      case "openChat": await this.openChatById(m.id); break;
      case "openMemory": await this.onOpenMemory?.(m.id); break;
      case "cancel": this.session?.cancel(); break;
      case "approveTool": this.session?.approve(m.toolId, m.approved); break;
      case "answerQuestion": this.session?.answerQuestion(m.toolId, m.answer); break;
      case "stopProcess": await this.session?.stopProcessFromUser(m.jobId); break;
      case "setChatMode": await this.setChatMode(m.mode); break;
      case "setReasoningEffort": await this.setReasoningEffort(m.effort); break;
      case "compactNow": await this.compactNow(); break;
      case "compactInterruptAndRun": await this.compactAfterInterrupt(); break;
      case "newChat":
        await vscode.commands.executeCommand("localLlmHarness.newChat");
        break;
      case "openChats":
        this.onOpenSideTab("chats");
        await vscode.commands.executeCommand("workbench.view.extension.localLlmHarness");
        break;
      case "deleteCurrent":
        await vscode.commands.executeCommand("localLlmHarness.deleteChat");
        break;
      case "openSettings":
        this.onOpenSideTab("settings");
        await vscode.commands.executeCommand("workbench.view.extension.localLlmHarness");
        break;
      case "acceptPlan": {
        const runtime = this.active;
        runtime.session?.setMode("act");
        await this.sendAndDrainQueue(runtime, "I accept your plan. Please implement.");
        break;
      }
      case "classifyWorkspacePaths": {
        const workspaceRoot = this.getWorkspaceRoot();
        const paths = [...new Set(m.paths.filter(path => typeof path === "string" && path.length > 0))].slice(0, 256);
        const entries = await Promise.all(paths.map(async requestedPath => ({
          path: requestedPath,
          pathType: workspaceRoot
            ? await classifyWorkspacePath(workspaceRoot, requestedPath)
            : "missing" as const
        })));
        this.post({ type: "workspacePathTypes", requestId: m.requestId, entries });
        break;
      }
      case "openFile":
        await this.openWorkspaceFile(m.path, m.line);
        break;
      case "reviewFile":
        await this.openReviewDiff(m.path);
        break;
      case "reviewProposedFile":
        await this.openProposedReviewDiff(m.path, m.content);
        break;
      case "reviewWorkspaceChanges":
        await vscode.commands.executeCommand("workbench.view.scm");
        break;
      case "requestToolDiff":
        this.session?.requestToolDiff(m.toolId);
        break;
      case "renameChat":
        if (m.id ?? this.session?.getRecord().id) await this.renameChat(m.id ?? this.session!.getRecord().id, m.title);
        break;
    }
  }

  private async sendAndDrainQueue(runtime: ChatRuntime, firstMessage?: string, firstAttachments: ChatAttachment[] = []): Promise<void> {
    const session = runtime.session;
    if (!session || runtime.removed) return;
    if (runtime.messageLoopRunning) {
      const text = firstMessage?.trim() ?? "";
      if (text || firstAttachments.length) {
        runtime.queuedMessages.push({
          id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          text,
          attachments: firstAttachments.length ? firstAttachments : undefined
        });
        this.pushMessageQueue(runtime);
      }
      return;
    }
    runtime.messageLoopRunning = true;
    let pending: { text: string; attachments?: ChatAttachment[] } | undefined =
      firstMessage !== undefined || firstAttachments.length
        ? { text: firstMessage?.trim() ?? "", attachments: firstAttachments.length ? firstAttachments : undefined }
        : undefined;
    try {
      while (!runtime.removed) {
        if (!pending) {
          const next = runtime.queuedMessages.shift();
          this.pushMessageQueue(runtime);
          pending = next ? { text: next.text, attachments: next.attachments } : undefined;
        }
        if (!pending || (!pending.text && !pending.attachments?.length)) return;
        const { text, attachments = [] } = pending;
        for (const attachment of attachments) {
          runtime.stagedAttachmentIds.delete(attachment.id);
          runtime.pendingAttachments.delete(attachment.id);
        }
        await session.sendUserMessage(text, attachments);
        pending = undefined;
        if (runtime.removed) return;
        this.onChatOpened(session.getRecord());
        this.onChatListChanged();
        await this.pushRecentChats();
      }
    } finally {
      runtime.messageLoopRunning = false;
      runtime.running = false;
      this.pushTabs();
      this.drainMessageQueueIfIdle(runtime);
    }
  }

  private drainMessageQueueIfIdle(runtime = this.active): void {
    const session = runtime.session;
    if (runtime.removed || !session || !shouldDrainMessageQueue({
      queueLength: runtime.queuedMessages.length,
      messageLoopRunning: runtime.messageLoopRunning,
      sessionCreationPending: runtime.sessionCreationPending,
      turnActive: session.isTurnActive()
    })) return;
    void this.sendAndDrainQueue(runtime);
  }

  private pushMessageQueue(runtime = this.active): void {
    if (runtime !== this.active) return;
    this.post({
      type: "messageQueue",
      messages: runtime.queuedMessages.map(message => ({
        id: message.id,
        text: message.text,
        attachments: message.attachments?.map(attachment => this.toUiAttachment(attachment))
      }))
    });
  }

  private clearMessageQueue(runtime = this.active): void {
    const pending = [
      ...runtime.pendingAttachments.values(),
      ...runtime.queuedMessages.flatMap(message => message.attachments ?? [])
    ];
    const chatId = runtime.session?.getRecord().id;
    if (chatId) void Promise.all(pending.map(attachment => runtime.storage?.deleteAttachment(chatId, attachment)));
    runtime.stagedAttachmentIds.clear();
    runtime.pendingAttachments.clear();
    runtime.queuedMessages = [];
    this.pushMessageQueue(runtime);
    if (runtime === this.active) this.post({ type: "attachmentCleared" });
  }

  private stagedAttachment(id?: string): ChatAttachment | undefined {
    if (!id || !this.stagedAttachmentIds.has(id) || !this.session) return undefined;
    return this.findAttachmentFile(id);
  }

  private takeStagedAttachment(id?: string): ChatAttachment | undefined {
    const attachment = this.stagedAttachment(id);
    if (attachment) {
      this.stagedAttachmentIds.delete(attachment.id);
      this.pendingAttachments.delete(attachment.id);
    }
    return attachment;
  }

  private takeStagedAttachments(ids?: string[]): ChatAttachment[] {
    const uniqueIds = [...new Set(ids ?? [])].slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
    return uniqueIds.flatMap(id => {
      const attachment = this.takeStagedAttachment(id);
      return attachment ? [attachment] : [];
    });
  }

  private findAttachmentFile(id: string): ChatAttachment | undefined {
    for (const message of this.queuedMessages) {
      const attachment = message.attachments?.find(item => item.id === id);
      if (attachment) return attachment;
    }
    return this.pendingAttachments.get(id);
  }

  private async selectAttachment(): Promise<void> {
    let runtime = this.active;
    if (runtime.attachmentSelectionPending) return;
    runtime.attachmentSelectionPending = true;
    try {
      const selected = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: true,
        openLabel: "Attach images",
        filters: { Images: ["png", "jpg", "jpeg", "webp"] }
      });
      if (!selected?.length || runtime.removed) return;
      if (!runtime.session) {
        const rec = await this.onCreateChat();
        runtime = this.active;
        if (!rec || !runtime.session) return;
      }
      if (runtime.removed) return;
      const available = MAX_ATTACHMENTS_PER_MESSAGE - runtime.stagedAttachmentIds.size;
      for (const uri of selected.slice(0, available)) {
        const attachment = await runtime.storage!.importAttachment(runtime.session.getRecord().id, uri.fsPath);
        if (runtime.removed) { await runtime.storage!.deleteAttachment(runtime.session!.getRecord().id, attachment); return; }
        runtime.pendingAttachments.set(attachment.id, attachment);
        runtime.stagedAttachmentIds.add(attachment.id);
        if (runtime === this.active) this.post({ type: "attachmentSelected", attachment: this.toUiAttachment(attachment, runtime) });
      }
      if (selected.length > available) {
        if (runtime === this.active) this.post({ kind: "notice", text: `You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} images to one message.` });
      }
    } catch (error) {
      if (runtime === this.active) this.post({ kind: "notice", text: (error as Error).message });
    } finally {
      runtime.attachmentSelectionPending = false;
    }
  }

  private async pasteAttachment(fileName: string, mimeType: string, dataUrl: string): Promise<void> {
    let runtime = this.active;
    if (runtime.attachmentSelectionPending) {
      if (runtime === this.active) this.post({ type: "attachmentPasteFailed", error: "Another image attachment is already being added." });
      return;
    }
    runtime.attachmentSelectionPending = true;
    try {
      if (runtime.stagedAttachmentIds.size >= MAX_ATTACHMENTS_PER_MESSAGE) {
        throw new Error(`You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} images to one message.`);
      }
      if (!(mimeType === "image/png" || mimeType === "image/jpeg" || mimeType === "image/webp")) {
        throw new Error("Paste a JPEG, PNG, or WebP image.");
      }
      const prefix = `data:${mimeType};base64,`;
      if (!dataUrl.startsWith(prefix)) throw new Error("The pasted image data is invalid.");
      const encoded = dataUrl.slice(prefix.length);
      const maxEncodedLength = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4;
      if (encoded.length > maxEncodedLength) throw new Error("Images must be 10 MiB or smaller.");
      if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
        throw new Error("The pasted image data is invalid.");
      }
      const bytes = Buffer.from(encoded, "base64");
      if (!runtime.session) {
        const rec = await this.onCreateChat();
        runtime = this.active;
        if (!rec || !runtime.session) throw new Error("Could not create a chat for the pasted image.");
      }
      const attachment = await runtime.storage!.importAttachmentBytes(runtime.session.getRecord().id, fileName, bytes);
      if (runtime.removed) { await runtime.storage!.deleteAttachment(runtime.session!.getRecord().id, attachment); return; }
      runtime.pendingAttachments.set(attachment.id, attachment);
      runtime.stagedAttachmentIds.add(attachment.id);
      if (runtime === this.active) this.post({ type: "attachmentSelected", attachment: this.toUiAttachment(attachment, runtime) });
    } catch (error) {
      if (runtime === this.active) this.post({ type: "attachmentPasteFailed", error: (error as Error).message });
    } finally {
      runtime.attachmentSelectionPending = false;
    }
  }

  private async openWorkspaceFile(filePath: string, line?: number): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      vscode.window.showErrorMessage("Local LLM Harness: open a folder to open files.");
      return;
    }

    try {
      const absolute = await assertInsideWorkspace(workspaceRoot, filePath);
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absolute));
      // Reveal the requested 1-based line at the top and place the cursor there.
      const target = line !== undefined && Number.isInteger(line) && line >= 1
        ? new vscode.Range(line - 1, 0, line - 1, 0)
        : undefined;
      await vscode.window.showTextDocument(doc, { preview: false, selection: target });
      if (target) {
        const editor = vscode.window.activeTextEditor;
        if (editor?.document.uri.fsPath === absolute) {
          editor.revealRange(target, vscode.TextEditorRevealType.AtTop);
        }
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Local LLM Harness: could not open file: ${(err as Error).message}`);
    }
  }

  private async openReviewDiff(filePath: string): Promise<void> {
    try {
      const { workspaceRoot, absolute, relative } = await this.resolveReviewPath(filePath);
      const fileUri = vscode.Uri.file(absolute);
      const { originalUri, modifiedUri } = await this.reviewUris(fileUri, absolute, workspaceRoot);
      await vscode.commands.executeCommand(
        "vscode.diff",
        originalUri,
        modifiedUri,
        `${relative} (Working Tree)`,
        { preview: false }
      );
    } catch (err) {
      vscode.window.showErrorMessage(`Local LLM Harness: could not open review diff: ${(err as Error).message}`);
    }
  }

  private async openProposedReviewDiff(filePath: string, proposedContent: string): Promise<void> {
    try {
      const { absolute, relative } = await this.resolveReviewPath(filePath);
      let previous = "";
      try {
        previous = await fs.readFile(absolute, "utf8");
      } catch {
        previous = "";
      }
      const originalUri = this.snapshotReviewUri(`${relative} (current)`, previous);
      const modifiedUri = this.snapshotReviewUri(`${relative} (proposed)`, proposedContent);
      await vscode.commands.executeCommand(
        "vscode.diff",
        originalUri,
        modifiedUri,
        `${relative} (Proposed)`,
        { preview: false }
      );
    } catch (err) {
      vscode.window.showErrorMessage(`Local LLM Harness: could not open proposed diff: ${(err as Error).message}`);
    }
  }

  private async resolveReviewPath(filePath: string): Promise<{ workspaceRoot: string; absolute: string; relative: string }> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) throw new Error("open a folder to review file changes.");
    const absolute = await assertInsideWorkspace(workspaceRoot, filePath);
    const relative = path.relative(workspaceRoot, absolute);
    return { workspaceRoot, absolute, relative };
  }

  private async reviewUris(
    fileUri: vscode.Uri,
    absolute: string,
    workspaceRoot: string
  ): Promise<{ originalUri: vscode.Uri; modifiedUri: vscode.Uri }> {
    const gitExtension = vscode.extensions.getExtension<GitExtensionApi>("vscode.git");
    if (gitExtension) {
      try {
        const git = (await gitExtension.activate()).getAPI(1);
        const repo = git.repositories?.find(r => isInside(r.rootUri.fsPath, absolute))
          ?? git.repositories?.find(r => isInside(workspaceRoot, r.rootUri.fsPath));
        const changes = [
          ...(repo?.state?.workingTreeChanges ?? []),
          ...(repo?.state?.indexChanges ?? []),
          ...(repo?.state?.mergeChanges ?? [])
        ];
        const change = changes.find(c => {
          const uri = c.uri ?? c.resourceUri;
          return uri ? sameFsPath(uri.fsPath, absolute) : false;
        });
        if (change?.originalUri) {
          return { originalUri: change.originalUri, modifiedUri: change.uri ?? change.resourceUri ?? fileUri };
        }
      } catch {
        // Fall back to a direct git: URI below.
      }
    }

    try {
      const original = await this.readGitHeadContent(workspaceRoot, absolute);
      return { originalUri: this.snapshotReviewUri(`${path.relative(workspaceRoot, absolute)} (HEAD)`, original), modifiedUri: fileUri };
    } catch {
      return { originalUri: this.snapshotReviewUri(`${path.relative(workspaceRoot, absolute)} (empty)`, ""), modifiedUri: fileUri };
    }
  }

  private snapshotReviewUri(label: string, content: string): vscode.Uri {
    const uri = vscode.Uri.from({
      scheme: ChatViewProvider.reviewScheme,
      path: "/" + path.basename(label),
      query: `${Date.now()}-${Math.random().toString(36).slice(2)}`
    });
    this.reviewDocuments.set(uri.toString(), content);
    return uri;
  }

  private async readGitHeadContent(workspaceRoot: string, absolute: string): Promise<string> {
    const relative = path.relative(workspaceRoot, absolute).replace(/\\/g, "/");
    const { stdout } = await execFileUtf8("git", ["-C", workspaceRoot, "show", `HEAD:${relative}`]);
    return stdout;
  }

  private html(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist/webview/chat.js")
    );
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media/chat.css")
    );
    const katexCss = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist/webview/katex/katex.min.css")
    );
    const csp =
      `default-src 'none'; ` +
      `style-src ${webview.cspSource} 'unsafe-inline'; ` +
      `script-src 'nonce-${nonce}'; ` +
      `font-src ${webview.cspSource} data:; ` +
      `img-src ${webview.cspSource} data:;`;
    return `<!doctype html><html><head>
      <meta http-equiv="Content-Security-Policy" content="${csp}">
      <link rel="stylesheet" href="${katexCss}">
      <link rel="stylesheet" href="${cssUri}">
      <link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media/chatControls.css"))}">
    </head><body>
      <div id="app"></div>
      <script nonce="${nonce}" src="${scriptUri}"></script>
    </body></html>`;
  }
}

function makeNonce(): string {
  let s = ""; const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sameFsPath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}
