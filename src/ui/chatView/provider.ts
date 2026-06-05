import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { ChatSession, type UiEvent } from "../../chat/session.js";
import { ChatStorage, type ChatRecord } from "../../chat/storage.js";
import { readSettings, writeSetting, onSettingsChange } from "../../config/settings.js";
import { assertInsideWorkspace } from "../../tools/workspaceGuard.js";
import { execFileUtf8 } from "../../util/exec.js";
import type { ChatToExt, ExtToChat, SideTab } from "../messaging.js";

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

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "localLlmHarness.chat";
  private static readonly reviewScheme = "local-llm-harness-review";
  private view?: vscode.WebviewView;
  private session?: ChatSession;
  private subs: vscode.Disposable[] = [];
  private chatFocusCtx = false;
  private reviewProviderRegistered = false;
  private reviewDocuments = new Map<string, string>();

  constructor(
    private context: vscode.ExtensionContext,
    private getStorage: () => ChatStorage | undefined,
    private getWorkspaceRoot: () => string | undefined,
    private onOpenSideTab: (tab: SideTab) => void,
    private onChatOpened: (rec: ChatRecord) => void,
    private onCreateChat: () => Promise<ChatRecord | undefined>,
    private onChatListChanged: () => void
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
        vscode.Uri.joinPath(this.context.extensionUri, "media")
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
      this.session?.cancel();
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

  post(msg: UiEvent | ExtToChat): void { this.view?.webview.postMessage(msg); }

  pushSettings(): void {
    const s = readSettings();
    this.post({
      type: "settings",
      autoapproveWrites: s.autoapproveWrites,
      planMode: this.session?.getRecord().planMode ?? false,
      autoCompact: s.autoCompact,
      autoCompactThresholdPercent: s.autoCompactThresholdPercent
    });
  }

  getCurrentRecord(): ChatRecord | undefined {
    return this.session?.getRecord();
  }

  closeCurrent(): void {
    this.session?.cancel();
    this.session = undefined;
    this.post({ kind: "chatClosed" });
  }

  openChat(rec: ChatRecord): void {
    this.session?.cancel();
    const storage = this.getStorage();
    const ws = this.getWorkspaceRoot();
    if (!storage || !ws) {
      vscode.window.showErrorMessage("Local LLM Harness: open a folder to start a chat.");
      return;
    }
    this.session = new ChatSession({
      storage, workspaceRoot: ws, record: rec,
      emit: e => this.post(e)
    });
    this.session.emitLoaded();
    this.pushSettings();
    this.reveal();
    this.onChatOpened(rec);
  }

  togglePlanMode(): void {
    if (!this.session) return;
    const rec = this.session.getRecord();
    this.session.setPlanMode(!rec.planMode);
  }

  async compactNow(): Promise<void> {
    await this.session?.compactNow();
  }

  async compactAfterInterrupt(): Promise<void> {
    await this.session?.compactAfterInterrupt();
  }

  private async onMessage(m: ChatToExt): Promise<void> {
    switch (m.type) {
      case "ready":
        this.pushSettings();
        if (this.session) this.session.emitLoaded();
        break;
      case "send":
        if (!this.session) {
          const rec = await this.onCreateChat();
          if (!rec || !this.session) return;
        }
        await this.session.sendUserMessage(m.text);
        if (this.session) this.onChatOpened(this.session.getRecord());
        break;
      case "cancel": this.session?.cancel(); break;
      case "approveTool": this.session?.approve(m.toolId, m.approved); break;
      case "togglePlanMode": this.togglePlanMode(); break;
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
      case "setAutoApproveWrites":
        await writeSetting("autoapproveWrites", m.on);
        break;
      case "acceptPlan":
        if (this.session) {
          this.session.setPlanMode(false);
          await this.session.sendUserMessage(
            "I accept your plan. Please implement."
          );
        }
        break;
      case "openFile":
        await this.openWorkspaceFile(m.path);
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
      case "renameChat": {
        const rec = this.session?.getRecord();
        if (!rec) break;
        const title = m.title.trim();
        if (!title || title === rec.title) break;
        rec.title = title;
        await this.getStorage()?.save(rec);   // storage.save bumps updatedAt
        this.onChatOpened(rec);               // refresh side "Open" tab label
        this.onChatListChanged();             // refresh side recent-chats list
        break;
      }
    }
  }

  private async openWorkspaceFile(filePath: string): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      vscode.window.showErrorMessage("Local LLM Harness: open a folder to open files.");
      return;
    }

    try {
      const absolute = await assertInsideWorkspace(workspaceRoot, filePath);
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absolute));
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (err) {
      vscode.window.showErrorMessage(`Local LLM Harness: could not open file: ${(err as Error).message}`);
    }
  }

  private async openReviewDiff(filePath: string): Promise<void> {
    try {
      const { workspaceRoot, absolute, relative } = this.resolveReviewPath(filePath);
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
      const { absolute, relative } = this.resolveReviewPath(filePath);
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

  private resolveReviewPath(filePath: string): { workspaceRoot: string; absolute: string; relative: string } {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) throw new Error("open a folder to review file changes.");
    const absolute = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(workspaceRoot, filePath);
    const relative = path.relative(workspaceRoot, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("can only review files inside the workspace.");
    }
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
      `font-src ${webview.cspSource}; ` +
      `img-src ${webview.cspSource} data:;`;
    return `<!doctype html><html><head>
      <meta http-equiv="Content-Security-Policy" content="${csp}">
      <link rel="stylesheet" href="${katexCss}">
      <link rel="stylesheet" href="${cssUri}">
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
