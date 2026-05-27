import * as vscode from "vscode";
import { SideViewProvider } from "./ui/sideView/provider.js";
import { ChatViewProvider } from "./ui/chatView/provider.js";
import { ChatStorage, type ChatRecord } from "./chat/storage.js";
import { readSettings } from "./config/settings.js";

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
      if (!openTabs.find(t => t.id === rec.id)) {
        openTabs.unshift({ id: rec.id, title: rec.title });
        openTabs = openTabs.slice(0, 8);
      }
      sideProvider.refreshOpenTabs();
    }
  );

  sideProvider = new SideViewProvider(
    context,
    () => storage,
    () => void newChat(),
    (id) => void openChatById(id),
    () => openTabs
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SideViewProvider.viewType, sideProvider),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider),

    vscode.commands.registerCommand("localLlmHarness.newChat", () => newChat()),
    vscode.commands.registerCommand("localLlmHarness.openChat", (id?: string) => id ? openChatById(id) : undefined),
    vscode.commands.registerCommand("localLlmHarness.openSettings", () => {
      sideProvider.focusTab("settings");
      return vscode.commands.executeCommand("workbench.view.extension.localLlmHarness");
    }),
    vscode.commands.registerCommand("localLlmHarness.togglePlanMode", () => chatProvider.togglePlanMode()),
    vscode.commands.registerCommand("localLlmHarness.compactNow", () => chatProvider.compactNow()),

    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const r = currentWorkspaceRoot();
      storage = r ? new ChatStorage(r) : undefined;
      void sideProvider.pushChats();
    })
  );
}

export function deactivate(): void { /* noop */ }

function currentWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  return folders[0].uri.fsPath;
}

async function newChat(): Promise<void> {
  if (!storage) {
    vscode.window.showWarningMessage("Local LLM Harness: open a folder first.");
    return;
  }
  const rec = storage.newRecord(readSettings().modelFamily);
  await storage.save(rec);
  await sideProvider.pushChats();
  chatProvider.openChat(rec);
}

async function openChatById(id: string): Promise<void> {
  if (!storage) return;
  const rec = await storage.load(id);
  if (rec) chatProvider.openChat(rec as ChatRecord);
}
