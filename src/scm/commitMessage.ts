import * as path from "node:path";
import * as vscode from "vscode";
import { readSettings } from "../config/settings.js";
import { complete } from "../llm/client.js";
import { execFileUtf8 } from "../util/exec.js";

const CTX_HAS_STAGED = "localLlmHarness.hasStagedChanges";
const CTX_BUSY = "localLlmHarness.commitMessageBusy";
const CTX_WIGGLE = "localLlmHarness.commitMessageWiggle";
const WIGGLE_MS = 900;

interface GitRepositoryApi {
  rootUri: vscode.Uri;
  inputBox?: { value: string };
}

interface GitApi {
  repositories?: GitRepositoryApi[];
}

interface GitExtensionApi {
  getAPI(version: number): GitApi;
}

export class CommitMessageController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly watcherDisposables: vscode.Disposable[] = [];
  private busy = false;
  private wiggleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private getWorkspaceRoot: () => string | undefined) {
    this.disposables.push(
      vscode.commands.registerCommand("localLlmHarness.generateCommitMessage", () => this.generate()),
      vscode.commands.registerCommand("localLlmHarness.generateCommitMessageNoStaged", () => this.pulseNoStaged()),
      vscode.commands.registerCommand("localLlmHarness.generateCommitMessageNoStagedWiggle", () => this.pulseNoStaged()),
      vscode.commands.registerCommand("localLlmHarness.generateCommitMessageBusy", () => undefined),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.resetGitWatcher()),
      vscode.window.onDidChangeWindowState(e => {
        if (e.focused) void this.refreshStagedContext();
      })
    );

    void this.setContext(CTX_BUSY, false);
    void this.setContext(CTX_WIGGLE, false);
    void this.setContext(CTX_HAS_STAGED, false);
    void this.resetGitWatcher();
  }

  dispose(): void {
    if (this.wiggleTimer) clearTimeout(this.wiggleTimer);
    this.disposeWatcher();
    this.disposables.forEach(d => d.dispose());
  }

  private async generate(): Promise<void> {
    if (this.busy) return;

    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      await this.pulseNoStaged();
      return;
    }

    let gitRoot: string;
    try {
      gitRoot = await findGitRoot(workspaceRoot);
    } catch {
      await this.pulseNoStaged();
      return;
    }

    const diff = await stagedDiff(gitRoot);
    if (!diff.trim()) {
      await this.setHasStagedChanges(false);
      await this.pulseNoStaged();
      return;
    }

    await this.setBusy(true);
    try {
      const message = await generateCommitMessage(diff);
      await writeCommitMessage(gitRoot, message);
      await vscode.commands.executeCommand("workbench.view.scm");
    } catch (err) {
      vscode.window.showErrorMessage(`Local LLM Harness: could not generate commit message: ${(err as Error).message}`);
    } finally {
      await this.setBusy(false);
      await this.refreshStagedContext();
    }
  }

  private async pulseNoStaged(): Promise<void> {
    if (this.wiggleTimer) clearTimeout(this.wiggleTimer);
    await this.setContext(CTX_WIGGLE, true);
    this.wiggleTimer = setTimeout(() => {
      this.wiggleTimer = undefined;
      void this.setContext(CTX_WIGGLE, false);
    }, WIGGLE_MS);
  }

  private async setBusy(on: boolean): Promise<void> {
    this.busy = on;
    await this.setContext(CTX_BUSY, on);
  }

  private async setHasStagedChanges(on: boolean): Promise<void> {
    await this.setContext(CTX_HAS_STAGED, on);
  }

  private async refreshStagedContext(): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      await this.setHasStagedChanges(false);
      return;
    }
    try {
      const gitRoot = await findGitRoot(workspaceRoot);
      await this.setHasStagedChanges(await hasStagedChanges(gitRoot));
    } catch {
      await this.setHasStagedChanges(false);
    }
  }

  private async resetGitWatcher(): Promise<void> {
    this.disposeWatcher();
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      await this.refreshStagedContext();
      return;
    }

    let gitRoot: string | undefined;
    try {
      gitRoot = await findGitRoot(workspaceRoot);
    } catch {
      await this.refreshStagedContext();
      return;
    }

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(gitRoot, ".git/index")
    );
    const refresh = (): void => void this.refreshStagedContext();
    this.watcherDisposables.push(
      watcher,
      watcher.onDidChange(refresh),
      watcher.onDidCreate(refresh),
      watcher.onDidDelete(refresh)
    );
    await this.refreshStagedContext();
  }

  private disposeWatcher(): void {
    while (this.watcherDisposables.length > 0) {
      this.watcherDisposables.pop()?.dispose();
    }
  }

  private setContext(key: string, value: boolean): Thenable<void> {
    return vscode.commands.executeCommand("setContext", key, value);
  }
}

async function generateCommitMessage(diff: string): Promise<string> {
  const settings = readSettings();
  const text = await complete(
    settings.endpoint,
    {
      temperature: 0.2,
      max_tokens: 256,
      messages: [
        {
          role: "system",
          content: "You write Git commit messages. Output only the commit message: no markdown, no code fence, no explanation."
        },
        {
          role: "user",
          content: [
            "Generate a commit message for these staged changes.",
            "Use an imperative, concise subject line. Add a short body only if it materially improves clarity.",
            "",
            "<staged_diff>",
            diff,
            "</staged_diff>"
          ].join("\n")
        }
      ]
    },
    new AbortController().signal
  );
  const message = text.trim();
  if (!message) throw new Error("the model returned an empty commit message.");
  return message;
}

async function findGitRoot(workspaceRoot: string): Promise<string> {
  const { stdout } = await execFileUtf8("git", ["-C", workspaceRoot, "rev-parse", "--show-toplevel"]);
  return stdout.trim();
}

async function hasStagedChanges(gitRoot: string): Promise<boolean> {
  const result = await execFileUtf8(
    "git",
    ["-C", gitRoot, "diff", "--cached", "--quiet", "--exit-code"],
    { allowNonZero: true, maxBuffer: 1024 * 1024 }
  );
  return result.exitCode === 1;
}

async function stagedDiff(gitRoot: string): Promise<string> {
  const { stdout } = await execFileUtf8(
    "git",
    ["-C", gitRoot, "diff", "--cached", "--no-ext-diff", "--no-color"]
  );
  return stdout;
}

async function writeCommitMessage(gitRoot: string, message: string): Promise<void> {
  const repo = await findGitRepository(gitRoot);
  if (repo?.inputBox) {
    repo.inputBox.value = message;
    return;
  }
  await vscode.env.clipboard.writeText(message);
  vscode.window.showWarningMessage("Local LLM Harness: generated commit message copied to clipboard because the Git input box was unavailable.");
}

async function findGitRepository(gitRoot: string): Promise<GitRepositoryApi | undefined> {
  const gitExtension = vscode.extensions.getExtension<GitExtensionApi>("vscode.git");
  if (!gitExtension) return undefined;
  const git = (await gitExtension.activate()).getAPI(1);
  return git.repositories?.find(repo => sameFsPath(repo.rootUri.fsPath, gitRoot));
}

function sameFsPath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
