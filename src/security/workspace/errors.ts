export type WorkspaceSecurityErrorCode =
  | "INVALID_ROOT"
  | "ROOT_CHANGED"
  | "INVALID_PATH"
  | "PATH_NOT_FOUND"
  | "TYPE_MISMATCH"
  | "INVALID_ENCODING"
  | "IDENTITY_UNAVAILABLE"
  | "INVALID_TRANSACTION"
  | "LINK_NOT_ALLOWED"
  | "HARDLINK_NOT_ALLOWED"
  | "PATH_CHANGED"
  | "LIMIT_EXCEEDED";

/**
 * Expected refusal from the guarded workspace boundary. Messages describe the
 * rejected workspace-relative input but deliberately avoid including a
 * canonical path outside the workspace.
 */
export class WorkspaceSecurityError extends Error {
  constructor(
    readonly code: WorkspaceSecurityErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "WorkspaceSecurityError";
  }
}

export function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
