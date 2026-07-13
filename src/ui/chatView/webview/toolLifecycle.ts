export type ToolLifecycleStatus =
  | "streaming"
  | "pending"
  | "approved"
  | "rejected"
  | "executed"
  | "failed";

export type ToolResolutionStatus = "approved" | "rejected" | "executed" | "failed";

/** Only a streaming placeholder may still receive streamed argument progress. */
export function canApplyToolProgress(current: ToolLifecycleStatus): boolean {
  return current === "streaming";
}

/** A proposal may create a card or finalize its one streaming placeholder once. */
export function canApplyToolProposal(current: ToolLifecycleStatus | undefined): boolean {
  return current === undefined || current === "streaming";
}

/** Tool-card lifecycle is monotonic; terminal cards can never be resurrected. */
export function canApplyToolResolution(
  current: ToolLifecycleStatus,
  next: ToolResolutionStatus
): boolean {
  if (current === "executed" || current === "rejected" || current === "failed") return false;
  if (current === "approved") return next === "executed" || next === "failed" || next === "rejected";
  return true;
}

/** Lazy historical diffs cannot replace an artifact while an approval is live. */
export function canApplyToolDiff(current: ToolLifecycleStatus, hasApproval: boolean): boolean {
  return current === "executed" && !hasApproval;
}
