import * as path from "node:path";
import * as vscode from "vscode";
import { readSettings } from "../config/settings.js";
import { complete } from "../llm/client.js";
import { execFileUtf8 } from "../util/exec.js";

const CTX_HAS_STAGED = "localLlmHarness.hasStagedChanges";
const CTX_BUSY = "localLlmHarness.commitMessageBusy";
const CTX_WIGGLE = "localLlmHarness.commitMessageWiggle";
const WIGGLE_MS = 900;
const NO_STAGED_MESSAGE = "Local LLM Harness: stage the changes you want included, then generate the commit message again.";

interface GitRepositoryApi {
  rootUri: vscode.Uri;
  inputBox?: { value: string };
  state?: { onDidChange(listener: () => void): vscode.Disposable };
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
      vscode.commands.registerCommand("localLlmHarness.generateCommitMessage", (context?: unknown) => this.generate(context)),
      // Context keys only choose the icon variant. Every clickable variant
      // re-checks Git so a stale SCM context can never block generation.
      vscode.commands.registerCommand("localLlmHarness.generateCommitMessageNoStaged", (context?: unknown) => this.generate(context)),
      vscode.commands.registerCommand("localLlmHarness.generateCommitMessageNoStagedWiggle", (context?: unknown) => this.generate(context)),
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

  private async generate(context?: unknown): Promise<void> {
    if (this.busy) return;

    let gitRoot: string;
    let diff: string;
    try {
      const repository = await selectGitRepository(context);
      if (repository === null) return;
      if (repository) {
        gitRoot = repository.rootUri.fsPath;
      } else {
        // Keep the old path-based fallback for environments where the built-in
        // Git extension is unavailable or has not discovered the repository.
        const workspaceRoot = this.getWorkspaceRoot();
        if (!workspaceRoot) {
          await this.pulseNoStaged();
          return;
        }
        gitRoot = await findGitRoot(workspaceRoot);
      }
      diff = await stagedDiff(gitRoot);
    } catch (err) {
      await vscode.window.showErrorMessage(
        `Local LLM Harness: could not inspect staged changes: ${(err as Error).message}`
      );
      return;
    }

    if (!diff.trim()) {
      await this.refreshStagedContext();
      await this.pulseNoStaged();
      return;
    }

    await this.setBusy(true);
    try {
      const message = await generateCommitMessage(diff);
      // Initialize/reveal SCM before assigning the input. Opening the view after
      // the assignment can restore the Git commit template over our value.
      await vscode.commands.executeCommand("workbench.view.scm");
      await writeCommitMessage(gitRoot, message);
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
    await vscode.window.showInformationMessage(NO_STAGED_MESSAGE);
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
    try {
      const repositories = await gitRepositories();
      if (repositories.length > 0) {
        const staged = await Promise.all(repositories.map(repo => hasStagedChanges(repo.rootUri.fsPath)));
        await this.setHasStagedChanges(staged.some(Boolean));
        return;
      }
      const workspaceRoot = this.getWorkspaceRoot();
      if (!workspaceRoot) {
        await this.setHasStagedChanges(false);
        return;
      }
      await this.setHasStagedChanges(await hasStagedChanges(await findGitRoot(workspaceRoot)));
    } catch {
      await this.setHasStagedChanges(false);
    }
  }

  private async resetGitWatcher(): Promise<void> {
    this.disposeWatcher();
    const refresh = (): void => void this.refreshStagedContext();
    let repositories = await gitRepositories();
    if (repositories.length === 0) {
      const workspaceRoot = this.getWorkspaceRoot();
      if (workspaceRoot) {
        try {
          const gitRoot = await findGitRoot(workspaceRoot);
          repositories = [{ rootUri: vscode.Uri.file(gitRoot) }];
        } catch {
          // A parent workspace may legitimately contain only nested repos;
          // VS Code's Git API will supply them once discovery completes.
        }
      }
    }
    for (const repository of repositories) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(repository.rootUri.fsPath, ".git/index")
      );
      this.watcherDisposables.push(
        watcher,
        watcher.onDidChange(refresh),
        watcher.onDidCreate(refresh),
        watcher.onDidDelete(refresh)
      );
      // VS Code's Git extension observes index updates more reliably than a
      // raw .git/index watcher (notably for atomic replacement and worktrees).
      const repositoryChange = repository.state?.onDidChange(refresh);
      if (repositoryChange) this.watcherDisposables.push(repositoryChange);
    }
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
      model: settings.model,
      temperature: settings.temperature,
      top_k: settings.topK,
      top_p: settings.topP,
      // Enough for a concise subject and short body, while preventing a model
      // that misses EOS from generating a long essay in the SCM action.
      messages: [{
        role: "user",
        content: [
          settings.commitMessagePrompt,
          "",
          "<staged_diff>",
          diff,
          "</staged_diff>"
        ].join("\n")
      }]
    },
    new AbortController().signal,
    { acceptPartialOnLength: true }
  );
  const message = normalizeCommitMessage(text);
  if (!message) throw new Error("the model returned an empty commit message.");
  return message;
}

/** Remove presentation wrappers some instruction-tuned models still add. */
function normalizeCommitMessage(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim()
    .replace(/^```(?:text|markdown)?\s*\n?/i, "")
    .replace(/\n?```$/i, "")
    .trim();
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
  return (await gitRepositories()).find(repo => sameFsPath(repo.rootUri.fsPath, gitRoot));
}

async function gitRepositories(): Promise<GitRepositoryApi[]> {
  const gitExtension = vscode.extensions.getExtension<GitExtensionApi>("vscode.git");
  if (!gitExtension) return [];
  try {
    const git = (await gitExtension.activate()).getAPI(1);
    return git.repositories ?? [];
  } catch {
    return [];
  }
}

/** Resolve the Git repository represented by the clicked SCM action. */
async function selectGitRepository(context: unknown): Promise<GitRepositoryApi | null | undefined> {
  const repositories = await gitRepositories();
  if (repositories.length === 0) return undefined;

  const contextPaths = scmContextPaths(context);
  const contextual = [...new Set(contextPaths
    .map(candidate => deepestContainingRepository(repositories, candidate))
    .filter((repo): repo is GitRepositoryApi => repo !== undefined))];
  if (contextual.length === 1) return contextual[0];

  const activePath = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (activePath) {
    const active = deepestContainingRepository(repositories, activePath);
    if (active) return active;
  }
  if (repositories.length === 1) return repositories[0];

  const picked = await vscode.window.showQuickPick(
    repositories.map(repository => ({
      label: path.basename(repository.rootUri.fsPath),
      description: repository.rootUri.fsPath,
      repository
    })),
    { placeHolder: "Select the Git repository for the commit message" }
  );
  return picked?.repository ?? null;
}

function scmContextPaths(context: unknown): string[] {
  const values = Array.isArray(context) ? context : [context];
  const paths: string[] = [];
  for (const value of values) {
    addUriPath(paths, value);
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    for (const key of ["rootUri", "resourceUri", "uri"]) addUriPath(paths, record[key]);
    for (const key of ["provider", "sourceControl", "repository"]) {
      const nested = record[key];
      if (!nested || typeof nested !== "object") continue;
      const nestedRecord = nested as Record<string, unknown>;
      for (const uriKey of ["rootUri", "resourceUri", "uri"]) addUriPath(paths, nestedRecord[uriKey]);
    }
  }
  return paths;
}

function addUriPath(paths: string[], value: unknown): void {
  if (!value || typeof value !== "object") return;
  const fsPath = (value as { fsPath?: unknown }).fsPath;
  if (typeof fsPath === "string" && fsPath) paths.push(fsPath);
}

function deepestContainingRepository(repositories: GitRepositoryApi[], candidate: string): GitRepositoryApi | undefined {
  return repositories
    .filter(repo => isPathInside(candidate, repo.rootUri.fsPath))
    .sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];
}

function isPathInside(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sameFsPath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
