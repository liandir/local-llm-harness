import { GuardedWorkspace, WorkspaceSecurityError } from "../security/workspace/index.js";

/** Compatibility error retained for callers of the historical guard API. */
export class WorkspaceGuardError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceGuardError";
  }
}

/**
 * Compatibility facade for point-in-time path resolution.
 *
 * The returned path is not durable authorization. Security-sensitive I/O must
 * call `GuardedWorkspace` directly so validation and the operation share the
 * same boundary and identity checks.
 */
export async function assertInsideWorkspace(
  workspaceRoot: string,
  requested: string
): Promise<string> {
  const signal = new AbortController().signal;
  try {
    const workspace = await GuardedWorkspace.create(workspaceRoot, signal);
    return (await workspace.resolvePath(requested, signal, { allowMissing: true })).absolutePath;
  } catch (error) {
    if (error instanceof WorkspaceSecurityError) {
      throw new WorkspaceGuardError(error.message, { cause: error });
    }
    throw error;
  }
}
