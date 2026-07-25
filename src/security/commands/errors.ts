export type SandboxCommandErrorCode =
  | "INVALID_CONFIGURATION"
  | "BACKEND_UNAVAILABLE"
  | "BACKEND_CHANGED"
  | "INVALID_REQUEST"
  | "INVALID_TRANSACTION"
  | "SNAPSHOT_REJECTED"
  | "TRANSPORT_FAILED"
  | "ATTESTATION_FAILED"
  | "LIFECYCLE_FAILED"
  | "CLEANUP_FAILED";

/** Expected fail-closed refusal at the Docker sandbox boundary. */
export class SandboxCommandError extends Error {
  constructor(
    readonly code: SandboxCommandErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "SandboxCommandError";
  }
}

