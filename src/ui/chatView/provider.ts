import * as vscode from "vscode";
import * as path from "node:path";
import { ChatSession } from "../../chat/session.js";
import { ChatStorage, type ChatRecord } from "../../chat/storage.js";
import { readSettings, writeSetting, onSettingsChange } from "../../config/settings.js";
import { GuardedWorkspace } from "../../security/workspace/index.js";
import { openGuardedTextDocument } from "../../security/workspace/vscodeBridge.js";
import { execFileUtf8 } from "../../util/exec.js";
import { requireContainedGitRoot } from "../../scm/workspaceScope.js";
import { ReviewDocumentStore } from "./reviewDocumentStore.js";
import {
  parseChatToExt,
  type ChatToExt,
  type ExtToChat,
  type SideTab,
  type UiEvent
} from "../messaging.js";

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
  private reviewDocuments = new ReviewDocumentStore(24 * 1024 * 1024, 8 * 1024 * 1024, 12);
  private workspaceCache?: { requestedRoot: string; capability: Promise<GuardedWorkspace> };

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
      view.webview.onDidReceiveMessage((raw: unknown) => {
        const message = parseChatToExt(raw);
        if (message) void this.onMessage(message);
      }),
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

  private currentWorkspace(): Promise<GuardedWorkspace> {
    const requestedRoot = this.getWorkspaceRoot();
    if (!requestedRoot) throw new Error("open a folder to access workspace files.");
    if (this.workspaceCache?.requestedRoot !== requestedRoot) {
      const cache = { requestedRoot, capability: GuardedWorkspace.create(requestedRoot) };
      this.workspaceCache = cache;
      // A transient construction failure must not poison this root forever.
      void cache.capability.catch(() => {
        if (this.workspaceCache === cache) this.workspaceCache = undefined;
      });
    }
    return this.workspaceCache.capability;
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
      storage,
      workspaceRoot: ws,
      workspace: this.currentWorkspace(),
      record: rec,
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
        if (this.session) {
          // A reloaded webview has lost live approval/question controls. Cancel
          // the host-owned interaction instead of stranding a turn or
          // reconstructing authority from persisted chat history.
          const cancelledInteraction = this.session.hasPendingInteraction();
          if (cancelledInteraction) {
            this.session.cancel();
          }
          this.session.emitLoaded();
          if (cancelledInteraction) {
            this.post({
              kind: "notice",
              text: "The pending approval or question was cancelled because the chat view reloaded. Ask the model to propose it again."
            });
          }
        }
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
      case "approveTool": this.session?.approve({ ...m.approval, approved: m.approved }); break;
      case "answerQuestion": this.session?.answerQuestion(m.toolId, m.answer); break;
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
        await this.openWorkspaceFile(m.path, m.line);
        break;
      case "reviewFile":
        await this.openReviewDiff(m.path);
        break;
      case "reviewWorkspaceChanges":
        await vscode.commands.executeCommand("workbench.view.scm");
        break;
      case "requestToolDiff":
        this.session?.requestToolDiff(m.toolId);
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

  private async openWorkspaceFile(filePath: string, line?: number): Promise<void> {
    try {
      const workspace = await this.currentWorkspace();
      const { document: doc, absolutePath: absolute } = await openGuardedTextDocument(
        workspace,
        filePath,
        new AbortController().signal
      );
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
      const { workspace, workspaceRoot, absolute, relative } = await this.resolveReviewPath(filePath);
      const current = await workspace.readFileForReview(relative, new AbortController().signal);
      const currentUri = this.snapshotReviewUri(`${relative} (current)`, current);
      const { originalUri, modifiedUri } = await this.reviewUris(currentUri, absolute, workspaceRoot);
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

  private async resolveReviewPath(filePath: string, allowMissing = false) {
    const workspace = await this.currentWorkspace();
    const resolved = await workspace.resolvePath(
      filePath,
      new AbortController().signal,
      { allowMissing, expectedType: "file" }
    );
    return {
      workspace,
      workspaceRoot: workspace.root,
      absolute: resolved.absolutePath,
      relative: resolved.relativePath,
      type: resolved.type
    };
  }

  /** Drop every capability and virtual snapshot when VS Code changes scope. */
  handleWorkspaceChanged(): void {
    this.closeCurrent();
    this.workspaceCache = undefined;
    this.reviewDocuments.clear();
  }

  private async reviewUris(
    currentUri: vscode.Uri,
    absolute: string,
    workspaceRoot: string
  ): Promise<{ originalUri: vscode.Uri; modifiedUri: vscode.Uri }> {
    const gitExtension = vscode.extensions.getExtension<GitExtensionApi>("vscode.git");
    if (gitExtension) {
      try {
        const git = (await gitExtension.activate()).getAPI(1);
        const repo = git.repositories?.find(r =>
          isInside(workspaceRoot, r.rootUri.fsPath) && isInside(r.rootUri.fsPath, absolute)
        );
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
          return { originalUri: change.originalUri, modifiedUri: currentUri };
        }
      } catch {
        // Fall back to a direct git: URI below.
      }
    }

    try {
      const original = await this.readGitHeadContent(workspaceRoot, absolute);
      return { originalUri: this.snapshotReviewUri(`${path.relative(workspaceRoot, absolute)} (HEAD)`, original), modifiedUri: currentUri };
    } catch {
      return { originalUri: this.snapshotReviewUri(`${path.relative(workspaceRoot, absolute)} (empty)`, ""), modifiedUri: currentUri };
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
    const rootResult = await execFileUtf8("git", ["-C", workspaceRoot, "rev-parse", "--show-toplevel"]);
    const gitRoot = requireContainedGitRoot(workspaceRoot, rootResult.stdout.trim());
    const relative = path.relative(gitRoot, absolute).replace(/\\/g, "/");
    const { stdout } = await execFileUtf8(
      "git",
      ["-C", gitRoot, "show", `HEAD:${relative}`],
      { maxBuffer: 8 * 1024 * 1024 }
    );
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
