import * as vscode from "vscode";
import * as path from "node:path";

export interface GitChangeState {
  uri?: vscode.Uri;
  resourceUri?: vscode.Uri;
  originalUri?: vscode.Uri;
}

/** Fixed editor integration; never exposes a command runner to the model. */
export interface GitRepositoryApi {
  rootUri: vscode.Uri;
  inputBox?: { value: string };
  state?: {
    indexChanges?: GitChangeState[];
    workingTreeChanges?: GitChangeState[];
    mergeChanges?: GitChangeState[];
    onDidChange?(listener: () => void): vscode.Disposable;
  };
  diff(cached?: boolean): Promise<string>;
  show(ref: string, filePath: string): Promise<string>;
}

export interface GitExtensionApi {
  getAPI(version: number): { repositories?: GitRepositoryApi[] };
}

export async function gitRepositories(): Promise<GitRepositoryApi[]> {
  const extension = vscode.extensions.getExtension<GitExtensionApi>("vscode.git");
  if (!extension) return [];
  try { return (await extension.activate()).getAPI(1).repositories ?? []; }
  catch { return []; }
}

export async function readGitHeadContent(absolute: string): Promise<string> {
  const repositories = await gitRepositories();
  const repo = repositories.filter(candidate => {
    const relative = path.relative(candidate.rootUri.fsPath, absolute);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }).sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];
  if (!repo) throw new Error("VS Code Git repository is unavailable.");
  return repo.show("HEAD", path.relative(repo.rootUri.fsPath, absolute).replace(/\\/g, "/"));
}
