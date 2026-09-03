import * as fs from "node:fs/promises";
import { assertInsideWorkspace } from "../../tools/workspaceGuard.js";
import type { WorkspacePathType } from "../messaging.js";

/** Classify a guarded workspace path without exposing filesystem access to the webview. */
export async function classifyWorkspacePath(
  workspaceRoot: string,
  requestedPath: string
): Promise<WorkspacePathType> {
  try {
    const resolved = await assertInsideWorkspace(workspaceRoot, requestedPath);
    const stat = await fs.stat(resolved);
    if (stat.isFile()) return "file";
    if (stat.isDirectory()) return "directory";
    return "other";
  } catch {
    return "missing";
  }
}
