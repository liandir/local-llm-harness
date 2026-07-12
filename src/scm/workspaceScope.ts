import * as path from "node:path";

/**
 * Refuse repositories whose working-tree root escapes the selected workspace.
 * Opening a subdirectory of a larger parent repository is intentionally not
 * enough authority to send the parent's staged diff to the model.
 */
export function requireContainedGitRoot(workspaceRoot: string, reportedGitRoot: string): string {
  if (!workspaceRoot.trim() || !reportedGitRoot.trim() || reportedGitRoot.includes("\0")) {
    throw new Error("Git returned an invalid repository root.");
  }
  const workspace = path.resolve(workspaceRoot);
  const gitRoot = path.resolve(reportedGitRoot);
  const relative = path.relative(workspace, gitRoot);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return gitRoot;
  }
  throw new Error("The Git repository root is outside the selected workspace.");
}
