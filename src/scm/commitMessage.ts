import * as path from "node:path";
import * as vscode from "vscode";
import { readSettings } from "../config/settings.js";
import { complete } from "../llm/client.js";
import type { ScmInspectionPort } from "./sandboxedGit.js";

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

export type ScmInspectionFactory = (
  workspaceRoot: string,
  signal: AbortSignal
) => Promise<ScmInspectionPort>;

export class CommitMessageController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private busy = false;
  private disposed = false;
  private scopeGeneration = 0;
  private generationController: AbortController | undefined;
  private refreshController: AbortController | undefined;
  private refreshRequest = 0;
  private refreshSerial: Promise<void> = Promise.resolve();
  private wiggleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private getWorkspaceRoot: () => string | undefined,
    private createInspector: ScmInspectionFactory
  ) {
    this.disposables.push(
      vscode.commands.registerCommand("localLlmHarness.generateCommitMessage", () => this.generate()),
      // Context keys are presentation hints only. Staging can change while the
      // window remains focused, so every click performs a fresh sandbox check.
      vscode.commands.registerCommand("localLlmHarness.generateCommitMessageNoStaged", () => this.generate()),
      vscode.commands.registerCommand("localLlmHarness.generateCommitMessageNoStagedWiggle", () => this.generate()),
      vscode.commands.registerCommand("localLlmHarness.generateCommitMessageBusy", () => undefined),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.handleWorkspaceChanged()),
      vscode.window.onDidChangeWindowState(e => {
        if (e.focused) this.requestStagedRefresh();
      })
    );

    void this.setContext(CTX_BUSY, false);
    void this.setContext(CTX_WIGGLE, false);
    void this.setContext(CTX_HAS_STAGED, false);
    this.requestStagedRefresh();
  }

  dispose(): void {
    this.disposed = true;
    this.scopeGeneration++;
    this.generationController?.abort(operationCancelled("SCM controller disposed."));
    this.cancelPendingRefresh();
    if (this.wiggleTimer) clearTimeout(this.wiggleTimer);
    this.disposables.forEach(d => d.dispose());
  }

  private async generate(): Promise<void> {
    if (this.busy || this.disposed) return;

    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      await this.pulseNoStaged();
      return;
    }

    // Claim the operation synchronously, before the first await, so duplicate
    // command invocations cannot overlap their sandbox snapshots or model call.
    const controller = new AbortController();
    const generation = this.scopeGeneration;
    this.generationController = controller;
    this.busy = true;
    this.cancelPendingRefresh();
    let phase: "inspection" | "generation" = "inspection";
    try {
      await this.setContext(CTX_BUSY, true);
      // If a focus refresh was already using Docker, let its cancellation and
      // mandatory cleanup finish before starting the user-requested operation.
      await this.refreshSerial.catch(() => undefined);
      this.assertCurrentGeneration(controller, generation, workspaceRoot);

      const inspector = await this.createInspector(workspaceRoot, controller.signal);
      const diff = await inspector.stagedDiff(controller.signal);
      this.assertCurrentGeneration(controller, generation, workspaceRoot);
      if (!diff.trim()) {
        await this.setHasStagedChanges(false);
        this.assertCurrentGeneration(controller, generation, workspaceRoot);
        await this.pulseNoStaged();
        return;
      }

      phase = "generation";
      const message = await generateCommitMessage(diff, controller.signal);
      this.assertCurrentGeneration(controller, generation, workspaceRoot);
      await writeCommitMessage(
        workspaceRoot,
        message,
        controller.signal,
        () => this.isCurrentGeneration(controller, generation, workspaceRoot)
      );
      this.assertCurrentGeneration(controller, generation, workspaceRoot);
    } catch (err) {
      if (!isCancellation(err, controller.signal) && this.isCurrentGeneration(controller, generation, workspaceRoot)) {
        const prefix = phase === "inspection"
          ? "sandboxed Git inspection is unavailable"
          : "could not generate commit message";
        vscode.window.showErrorMessage(`Local LLM Harness: ${prefix}: ${(err as Error).message}`);
      }
    } finally {
      if (this.generationController === controller) this.generationController = undefined;
      this.busy = false;
      if (!this.disposed) {
        await this.setContext(CTX_BUSY, false);
        this.requestStagedRefresh();
      }
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

  private async setHasStagedChanges(on: boolean): Promise<void> {
    await this.setContext(CTX_HAS_STAGED, on);
  }

  private requestStagedRefresh(): void {
    if (this.disposed || this.busy) return;
    const request = ++this.refreshRequest;
    const generation = this.scopeGeneration;
    this.refreshController?.abort(operationCancelled("Superseded SCM refresh."));
    const task = this.refreshSerial
      .catch(() => undefined)
      .then(() => this.refreshStagedContext(request, generation));
    this.refreshSerial = task;
    void task;
  }

  private async refreshStagedContext(request: number, generation: number): Promise<void> {
    if (!this.isCurrentRefreshRequest(request, generation)) return;
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      if (this.isCurrentRefreshRequest(request, generation)) await this.setHasStagedChanges(false);
      return;
    }
    const controller = new AbortController();
    this.refreshController = controller;
    try {
      const inspector = await this.createInspector(workspaceRoot, controller.signal);
      const hasChanges = await inspector.hasStagedChanges(controller.signal);
      if (this.isCurrentRefresh(controller, request, generation, workspaceRoot)) {
        await this.setHasStagedChanges(hasChanges);
      }
    } catch (error) {
      if (!isCancellation(error, controller.signal) && this.isCurrentRefresh(controller, request, generation, workspaceRoot)) {
        await this.setHasStagedChanges(false);
      }
    } finally {
      if (this.refreshController === controller) this.refreshController = undefined;
    }
  }

  private handleWorkspaceChanged(): void {
    this.scopeGeneration++;
    this.generationController?.abort(operationCancelled("The selected workspace changed."));
    this.cancelPendingRefresh();
    if (this.wiggleTimer) {
      clearTimeout(this.wiggleTimer);
      this.wiggleTimer = undefined;
    }
    void this.setContext(CTX_WIGGLE, false);
    void this.setHasStagedChanges(false);
    if (!this.busy) this.requestStagedRefresh();
  }

  private cancelPendingRefresh(): void {
    this.refreshRequest++;
    this.refreshController?.abort(operationCancelled("SCM refresh cancelled."));
  }

  private isCurrentGeneration(
    controller: AbortController,
    generation: number,
    workspaceRoot: string
  ): boolean {
    return !this.disposed &&
      !controller.signal.aborted &&
      this.generationController === controller &&
      this.scopeGeneration === generation &&
      sameOptionalRoot(this.getWorkspaceRoot(), workspaceRoot);
  }

  private assertCurrentGeneration(
    controller: AbortController,
    generation: number,
    workspaceRoot: string
  ): void {
    if (!this.isCurrentGeneration(controller, generation, workspaceRoot)) {
      throw controller.signal.reason ?? operationCancelled("The selected workspace changed.");
    }
  }

  private isCurrentRefreshRequest(request: number, generation: number): boolean {
    return !this.disposed && !this.busy && this.refreshRequest === request && this.scopeGeneration === generation;
  }

  private isCurrentRefresh(
    controller: AbortController,
    request: number,
    generation: number,
    workspaceRoot: string
  ): boolean {
    return !controller.signal.aborted &&
      this.refreshController === controller &&
      this.isCurrentRefreshRequest(request, generation) &&
      sameOptionalRoot(this.getWorkspaceRoot(), workspaceRoot);
  }

  private setContext(key: string, value: boolean): Thenable<void> {
    return vscode.commands.executeCommand("setContext", key, value);
  }
}

async function generateCommitMessage(diff: string, signal: AbortSignal): Promise<string> {
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
    signal
  );
  const message = text.trim();
  if (!message) throw new Error("the model returned an empty commit message.");
  return message;
}

async function writeCommitMessage(
  gitRoot: string,
  message: string,
  signal: AbortSignal,
  isCurrent: () => boolean
): Promise<void> {
  signal.throwIfAborted();
  const repo = await findGitRepository(gitRoot);
  signal.throwIfAborted();
  if (!isCurrent()) throw operationCancelled("The selected workspace changed.");
  if (repo?.inputBox) {
    repo.inputBox.value = message;
    return;
  }
  await vscode.env.clipboard.writeText(message);
  vscode.window.showWarningMessage("Local LLM Harness: generated commit message copied to clipboard because the Git input box was unavailable.");
}

async function findGitRepository(gitRoot: string): Promise<GitRepositoryApi | undefined> {
  const gitExtension = vscode.extensions.getExtension<GitExtensionApi>("vscode.git");
  // Activating vscode.git can start host Git and interpret repository-owned
  // configuration. Sandboxed inspection must not cause that activation simply
  // to improve commit-message placement.
  if (!gitExtension?.isActive) return undefined;
  const git = gitExtension.exports.getAPI(1);
  return git.repositories?.find(repo => sameFsPath(repo.rootUri.fsPath, gitRoot));
}

function sameFsPath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function sameOptionalRoot(current: string | undefined, expected: string): boolean {
  return current !== undefined && sameFsPath(current, expected);
}

function operationCancelled(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof DOMException && error.name === "AbortError");
}
