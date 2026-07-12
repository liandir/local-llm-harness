import * as vscode from "vscode";
import type { GuardedWorkspace } from "./workspaceAdapter.js";

/**
 * Open a live VS Code document only after guarded file validation, then verify
 * the path again before returning it to UI code. Keeping the VS Code filesystem
 * entry point in this adapter prevents providers from bypassing the boundary.
 */
export async function openGuardedTextDocument(
  workspace: GuardedWorkspace,
  requested: string,
  signal: AbortSignal
): Promise<{ document: vscode.TextDocument; absolutePath: string }> {
  const before = await workspace.resolvePath(requested, signal, { expectedType: "file" });
  signal.throwIfAborted();
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(before.absolutePath));
  const after = await workspace.resolvePath(requested, signal, { expectedType: "file" });
  if (before.absolutePath !== after.absolutePath || document.uri.fsPath !== after.absolutePath) {
    throw new Error("Workspace file changed while it was being opened.");
  }
  return { document, absolutePath: after.absolutePath };
}
