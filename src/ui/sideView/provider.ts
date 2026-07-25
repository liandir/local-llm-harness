import * as vscode from "vscode";
import {
  readSettings,
  writeSetting,
  onSettingsChange,
  seedSandboxCommandsIfUnset,
  restoreDefaultSandboxCommands,
  resetAllSettings,
  type SettingResetFailure
} from "../../config/settings.js";
import { validateEndpoint } from "../../network/endpointValidator.js";
import { ChatStorage } from "../../chat/storage.js";
import {
  parseSideToExt,
  type ExtToSide,
  type SandboxAvailabilityDto,
  type SideSettingUpdate,
  type SideTab,
  type SideToExt
} from "../messaging.js";

export class SideViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "localLlmHarness.side";
  private view?: vscode.WebviewView;
  private subs: vscode.Disposable[] = [];
  private activeTab: SideTab = "welcome";
  private settingsPushVersion = 0;

  constructor(
    private context: vscode.ExtensionContext,
    private getStorage: () => ChatStorage | undefined,
    private onNewChat: () => void,
    private onOpenChat: (id: string) => void,
    private onOpenTabs: () => { id: string; title: string }[],
    private getSandboxAvailability: () => Promise<SandboxAvailabilityDto> = async () => ({
      available: false,
      reason: "No sandbox backend is configured."
    })
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
      view.webview.onDidReceiveMessage((raw: unknown) => {
        const message = parseSideToExt(raw);
        if (message) void this.onMessage(message);
      }),
      onSettingsChange(() => void this.pushSettings())
    );
    view.onDidDispose(() => { this.subs.forEach(d => d.dispose()); this.subs = []; });
  }

  post(msg: ExtToSide): void { this.view?.webview.postMessage(msg); }

  async pushSettings(): Promise<void> {
    // Availability probes may be asynchronous. Suppress an older probe when a
    // later settings change has already requested a fresher reconciliation.
    const version = ++this.settingsPushVersion;
    const sandboxAvailability = await this.readSandboxAvailability();
    if (version !== this.settingsPushVersion) return;
    const s = readSettings();
    this.post({
      type: "settings",
      settings: s as unknown as Record<string, unknown>,
      sandboxAvailability
    });
  }

  private async readSandboxAvailability(): Promise<SandboxAvailabilityDto> {
    try {
      const availability = await this.getSandboxAvailability();
      return availability.available
        ? {
            available: true,
            backend: boundedSettingsError(availability.backend, "sandbox", 128)
          }
        : {
            available: false,
            reason: boundedSettingsError(
              availability.reason,
              "The sandbox is unavailable.",
              512
            )
          };
    } catch (error) {
      return {
        available: false,
        reason: `Sandbox availability check failed: ${boundedSettingsError(
          error,
          "The availability probe failed.",
          512
        )}`
      };
    }
  }

  async pushChats(): Promise<void> {
    const storage = this.getStorage();
    if (!storage) return this.post({ type: "chats", chats: [] });
    this.post({ type: "chats", chats: await storage.list() });
  }

  focusTab(tab: SideTab): void {
    this.activeTab = tab;
    this.post({ type: "focusTab", tab });
  }

  refreshOpenTabs(): void {
    this.post({ type: "openTabs", tabs: this.onOpenTabs() });
  }

  private async onMessage(m: SideToExt): Promise<void> {
    switch (m.type) {
      case "ready":
        await this.pushSettings();
        await this.pushChats();
        this.refreshOpenTabs();
        this.post({ type: "focusTab", tab: this.activeTab });
        break;
      case "newChat": this.onNewChat(); break;
      case "openChat": this.onOpenChat(m.id); break;
      case "deleteChat": {
        await vscode.commands.executeCommand("localLlmHarness.deleteChat", m.id);
        break;
      }
      case "openTab": this.activeTab = m.tab; break;
      case "saveSetting": {
        let saveError: string | undefined;
        try {
          if (m.key === "autoapproveSandboxCommands" && m.value) {
            const availability = await this.readSandboxAvailability();
            if (!availability.available) {
              throw new Error("Cannot enable sandbox-command auto-approval while the sandbox is unavailable.");
            }
          }
          await writeSideSetting(m);
        } catch (error) {
          saveError = boundedSettingsError(error, "The setting could not be saved.");
        }
        this.post({
          type: "settingSaved",
          key: m.key,
          ok: saveError === undefined,
          ...(saveError === undefined ? {} : { error: saveError })
        });
        await this.pushSettings();
        break;
      }
      case "validateEndpoint": {
        try {
          const validation = await validateEndpoint(m.url);
          if (!validation.ok) {
            this.post({
              type: "endpointValidation",
              ok: false,
              error: boundedSettingsError(validation.error, "Endpoint validation failed."),
              resolved: validation.resolved
            });
          } else {
            await writeSetting("endpoint", m.url);
            this.post({
              type: "endpointValidation",
              ok: true,
              resolved: validation.resolved
            });
          }
        } catch (error) {
          this.post({
            type: "endpointValidation",
            ok: false,
            error: boundedSettingsError(error, "The endpoint could not be saved.")
          });
        }
        await this.pushSettings();
        break;
      }
      case "editSandboxCommandsJson":
        try {
          // Seed defaults first so the JSON editor reveals the complete current
          // structured policy rather than an absent setting.
          await seedSandboxCommandsIfUnset();
          await vscode.commands.executeCommand(
            "workbench.action.openSettingsJson",
            { revealSetting: { key: "localLlmHarness.sandboxCommands" } }
          );
          this.post({ type: "settingSaved", key: "sandboxCommands", ok: true });
        } catch (error) {
          this.post({
            type: "settingSaved",
            key: "sandboxCommands",
            ok: false,
            error: boundedSettingsError(error, "The sandbox-command settings could not be opened.")
          });
        }
        await this.pushSettings();
        break;
      case "restoreDefaultSandboxCommands": {
        const choice = await vscode.window.showWarningMessage(
          "Restore the default sandbox-command rules? Your custom command rules will be replaced. This cannot be undone.",
          { modal: true },
          "Restore"
        );
        if (choice === "Restore") {
          let restoreError: string | undefined;
          try {
            await restoreDefaultSandboxCommands();
          } catch (error) {
            restoreError = boundedSettingsError(
              error,
              "The default sandbox-command rules could not be restored."
            );
          }
          this.post({
            type: "settingSaved",
            key: "sandboxCommands",
            ok: restoreError === undefined,
            ...(restoreError === undefined ? {} : { error: restoreError })
          });
          await this.pushSettings();
        }
        break;
      }
      case "resetAllDefaults": {
        const choice = await vscode.window.showWarningMessage(
          "Restore all Local LLM Harness settings to defaults? This also resets the server URL and sandbox-command rules. This cannot be undone.",
          { modal: true },
          "Restore defaults"
        );
        if (choice === "Restore defaults") {
          let resetError: string | undefined;
          try {
            const failures = await resetAllSettings();
            if (failures.length > 0) resetError = describeResetFailures(failures);
          } catch (error) {
            resetError = boundedSettingsError(error, "The settings reset could not be completed.");
          }
          this.post({
            type: "settingSaved",
            key: "resetAllDefaults",
            ok: resetError === undefined,
            ...(resetError === undefined ? {} : { error: resetError })
          });
          await this.pushSettings();
        }
        break;
      }
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

async function writeSideSetting(update: SideSettingUpdate): Promise<void> {
  switch (update.key) {
    case "modelFamily": await writeSetting("modelFamily", update.value); break;
    case "contextSize": await writeSetting("contextSize", update.value); break;
    case "temperature": await writeSetting("temperature", update.value); break;
    case "topK": await writeSetting("topK", update.value); break;
    case "topP": await writeSetting("topP", update.value); break;
    case "autoCompact": await writeSetting("autoCompact", update.value); break;
    case "autoCompactThresholdPercent": await writeSetting("autoCompactThresholdPercent", update.value); break;
    case "autoapproveReads": await writeSetting("autoapproveReads", update.value); break;
    case "autoapproveWrites": await writeSetting("autoapproveWrites", update.value); break;
    case "autoapproveSandboxCommands": await writeSetting("autoapproveSandboxCommands", update.value); break;
  }
}

function describeResetFailures(failures: readonly SettingResetFailure[]): string {
  const keys = failures.map(failure => failure.key).join(", ");
  const details = failures
    .slice(0, 3)
    .map(failure => `${failure.key}: ${failure.message}`)
    .join("; ");
  const more = failures.length > 3
    ? `; ${failures.length - 3} additional update(s) failed`
    : "";
  return boundedSettingsError(
    `Some settings could not be reset (${keys}). ${details}${more}`,
    "Some settings could not be reset."
  );
}

function boundedSettingsError(error: unknown, fallback: string, limit = 1024): string {
  const message = typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : fallback;
  const printable = [...message]
    .filter(character => {
      const code = character.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .trim()
    .slice(0, limit);
  return printable || fallback;
}

function makeNonce(): string {
  let s = ""; const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
