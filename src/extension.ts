import * as vscode from "vscode";
import { SideViewProvider } from "./ui/sideView/provider.js";
import { ChatViewProvider } from "./ui/chatView/provider.js";
import { ChatStorage, type ChatRecord } from "./chat/storage.js";
import { readSettings } from "./config/settings.js";
import { CommitMessageController } from "./scm/commitMessage.js";
import { captureToolPolicySnapshot } from "./chat/toolPolicySnapshot.js";
import { createConfiguredCommandPort } from "./security/sandboxCommandFactory.js";
import type { SandboxAvailabilityDto } from "./chat/protocol.js";
import { SandboxedGitInspector, type ScmInspectionPort } from "./scm/sandboxedGit.js";

let sideProvider: SideViewProvider;
let chatProvider: ChatViewProvider;
let storage: ChatStorage | undefined;
let openTabs: { id: string; title: string }[] = [];

export function activate(context: vscode.ExtensionContext): void {
  const ws = currentWorkspaceRoot();
  if (ws) storage = new ChatStorage(ws);

  chatProvider = new ChatViewProvider(
    context,
    () => storage,
    () => currentWorkspaceRoot(),
    (tab) => sideProvider.focusTab(tab),
    (rec) => {
      openTabs = [{ id: rec.id, title: rec.title }];
      sideProvider.refreshOpenTabs();
    },
    () => newChat(),
    () => void sideProvider.pushChats()
  );

  sideProvider = new SideViewProvider(
    context,
    () => storage,
    () => void newChat(),
    (id) => void openChatById(id),
    () => openTabs,
    () => configuredSandboxAvailability(context)
  );
  context.subscriptions.push(
    new CommitMessageController(
      () => currentWorkspaceRoot(),
      (root, signal) => configuredGitInspector(context, root, signal)
    ),
    vscode.window.registerWebviewViewProvider(SideViewProvider.viewType, sideProvider),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider),

    vscode.commands.registerCommand("localLlmHarness.newChat", () => newChat()),
    vscode.commands.registerCommand("localLlmHarness.openChat", (id?: string) => id ? openChatById(id) : undefined),
    vscode.commands.registerCommand("localLlmHarness.deleteChat", (id?: string) => deleteChat(id)),
    vscode.commands.registerCommand("localLlmHarness.openSettings", () => {
      sideProvider.focusTab("settings");
      return vscode.commands.executeCommand("workbench.view.extension.localLlmHarness");
    }),
    vscode.commands.registerCommand("localLlmHarness.togglePlanMode", () => chatProvider.togglePlanMode()),
    vscode.commands.registerCommand("localLlmHarness.compactNow", () => chatProvider.compactNow()),

    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      chatProvider.handleWorkspaceChanged();
      const r = currentWorkspaceRoot();
      storage = r ? new ChatStorage(r) : undefined;
      openTabs = [];
      void sideProvider.pushChats();
      sideProvider.refreshOpenTabs();
    })
  );
}

export function deactivate(): void { /* noop */ }

function currentWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  // Capabilities bind to exactly one explicit local filesystem root. Refuse an
  // ambiguous multi-root or virtual workspace instead of silently choosing the
  // first folder and making approval scope unclear.
  if (
    !folders ||
    folders.length !== 1 ||
    folders[0].uri.scheme !== "file" ||
    folders[0].uri.authority !== ""
  ) return undefined;
  return folders[0].uri.fsPath;
}

async function configuredSandboxAvailability(
  context: vscode.ExtensionContext
): Promise<SandboxAvailabilityDto> {
  const workspaceRoot = currentWorkspaceRoot();
  if (!workspaceRoot) {
    return { available: false, reason: "Open exactly one local folder to verify the sandbox." };
  }
  const settings = readSettings();
  const signal = new AbortController().signal;
  const snapshot = await captureToolPolicySnapshot(
    settings,
    (captured, factorySignal) => createConfiguredCommandPort(
      workspaceRoot,
      context.globalStorageUri.fsPath,
      captured,
      factorySignal
    ),
    signal
  );
  return snapshot.sandbox.available
    ? { available: true, backend: "docker" }
    : { available: false, reason: snapshot.sandbox.reason };
}

async function configuredGitInspector(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
  signal: AbortSignal
): Promise<ScmInspectionPort> {
  const commands = await createConfiguredCommandPort(
    workspaceRoot,
    context.globalStorageUri.fsPath,
    readSettings(),
    signal
  );
  const availability = await commands.availability(signal);
  if (!availability.available) throw new Error(availability.reason);
  return new SandboxedGitInspector(commands);
}

async function newChat(): Promise<ChatRecord | undefined> {
  if (!storage) {
    vscode.window.showWarningMessage("Local LLM Harness: open exactly one local folder first.");
    return undefined;
  }
  // If the chat view already shows an empty chat, reuse it instead of creating a duplicate.
  const current = chatProvider.getCurrentRecord();
  if (current && current.messages.length === 0) {
    chatProvider.reveal();
    return current;
  }
  // Garbage-collect any other empty chats so the list doesn't grow with leftovers.
  await storage.deleteEmpty();
  await pruneOpenTabs();
  const rec = storage.newRecord(readSettings().modelFamily);
  await storage.save(rec);
  await sideProvider.pushChats();
  chatProvider.openChat(rec);
  return rec;
}

async function openChatById(id: string): Promise<void> {
  if (!storage) return;
  const rec = await storage.load(id);
  if (rec) chatProvider.openChat(rec as ChatRecord);
}

async function deleteChat(id?: string): Promise<void> {
  if (!storage) return;
  const targetId = id ?? chatProvider.getCurrentRecord()?.id;
  if (!targetId) return;
  const rec = await storage.load(targetId);
  // Only prompt for non-empty chats — empty ones aren't worth confirming.
  if (rec && rec.messages.length > 0) {
    const choice = await vscode.window.showWarningMessage(
      `Delete chat "${rec.title}"? This cannot be undone.`,
      { modal: true },
      "Delete"
    );
    if (choice !== "Delete") return;
  }
  await storage.delete(targetId);
  openTabs = openTabs.filter(t => t.id !== targetId);
  if (chatProvider.getCurrentRecord()?.id === targetId) {
    chatProvider.closeCurrent();
  }
  await sideProvider.pushChats();
  sideProvider.refreshOpenTabs();
}

async function pruneOpenTabs(): Promise<void> {
  if (!storage || openTabs.length === 0) return;
  const chats = await storage.list();
  const existingIds = new Set(chats.map(c => c.id));
  openTabs = openTabs.filter(t => existingIds.has(t.id));
  sideProvider.refreshOpenTabs();
}
