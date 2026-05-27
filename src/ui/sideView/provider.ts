import * as vscode from "vscode";
import { readSettings, writeSetting, onSettingsChange } from "../../config/settings.js";
import { validateEndpoint } from "../../network/endpointValidator.js";
import { ChatStorage } from "../../chat/storage.js";
import type { ExtToSide, SideToExt } from "../messaging.js";

export class SideViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "localLlmHarness.side";
  private view?: vscode.WebviewView;
  private subs: vscode.Disposable[] = [];

  constructor(
    private context: vscode.ExtensionContext,
    private getStorage: () => ChatStorage | undefined,
    private onNewChat: () => void,
    private onOpenChat: (id: string) => void,
    private onOpenTabs: () => { id: string; title: string }[]
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "dist"),
        vscode.Uri.joinPath(this.context.extensionUri, "media")
      ]
    };
    view.webview.html = this.html(view.webview);
    this.subs.push(
      view.webview.onDidReceiveMessage((m: SideToExt) => this.onMessage(m)),
      onSettingsChange(() => this.pushSettings())
    );
    view.onDidDispose(() => { this.subs.forEach(d => d.dispose()); this.subs = []; });
  }

  post(msg: ExtToSide): void { this.view?.webview.postMessage(msg); }

  pushSettings(): void {
    const s = readSettings();
    this.post({ type: "settings", settings: s as unknown as Record<string, unknown> });
  }

  async pushChats(): Promise<void> {
    const storage = this.getStorage();
    if (!storage) return this.post({ type: "chats", chats: [] });
    this.post({ type: "chats", chats: await storage.list() });
  }

  focusTab(tab: "welcome" | "chats" | "settings"): void {
    this.post({ type: "focusTab", tab });
  }

  refreshOpenTabs(): void {
    this.post({ type: "openTabs", tabs: this.onOpenTabs() });
  }

  private async onMessage(m: SideToExt): Promise<void> {
    switch (m.type) {
      case "ready":
        this.pushSettings();
        await this.pushChats();
        this.refreshOpenTabs();
        break;
      case "newChat": this.onNewChat(); break;
      case "openChat": this.onOpenChat(m.id); break;
      case "deleteChat": {
        const s = this.getStorage();
        if (s) { await s.delete(m.id); await this.pushChats(); this.refreshOpenTabs(); }
        break;
      }
      case "openTab": /* purely cosmetic; webview tracks state itself */ break;
      case "saveSetting":
        try {
          await writeSetting(m.key as keyof ReturnType<typeof readSettings>, m.value as never);
        } catch (e) {
          this.post({ type: "settingSaved", key: m.key, ok: false, error: (e as Error).message });
        }
        break;
      case "validateEndpoint": {
        const v = await validateEndpoint(m.url);
        this.post({ type: "endpointValidation", ok: v.ok, error: v.error, resolved: v.resolved });
        if (v.ok) {
          await writeSetting("endpoint", m.url);
        }
        break;
      }
      case "editSafeCommandsJson":
        await vscode.commands.executeCommand(
          "workbench.action.openSettingsJson",
          { revealSetting: { key: "localLlmHarness.safeCommands" } }
        );
        break;
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist/webview/side.js")
    );
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media/side.css")
    );
    const csp =
      `default-src 'none'; ` +
      `style-src ${webview.cspSource} 'unsafe-inline'; ` +
      `script-src 'nonce-${nonce}'; ` +
      `font-src ${webview.cspSource}; ` +
      `img-src ${webview.cspSource} data:;`;
    return `<!doctype html><html><head>
      <meta http-equiv="Content-Security-Policy" content="${csp}">
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
