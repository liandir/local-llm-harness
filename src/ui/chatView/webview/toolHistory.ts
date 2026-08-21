import type { StoredToolStatus } from "../../../chat/storage.js";

/** Restore an explicit outcome, or conservatively infer records from older versions. */
export function restoredToolStatus(
  storedStatus: StoredToolStatus | undefined,
  content: string,
  malformedToolCall = false
): StoredToolStatus {
  if (malformedToolCall) return "rejected";
  if (storedStatus) return storedStatus;
  const trimmed = content.trimStart();
  if (trimmed.startsWith("error:")) return "failed";
  if (
    trimmed.startsWith("[blocked:") ||
    trimmed.startsWith("[rejected by user]") ||
    trimmed.startsWith("[ask_user_question dismissed]")
  ) return "rejected";
  return "executed";
}

/** create_file is creation by definition, including in records predating metadata. */
export function restoredCreatesNewFile(
  toolName: string,
  storedCreatesNewFile: boolean | undefined
): boolean | undefined {
  return storedCreatesNewFile ?? (toolName === "create_file" ? true : undefined);
}
