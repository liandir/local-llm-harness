import type { ChatRecord, FileChangeSummary, StoredToolStatus } from "../../../chat/storage.js";
import { normalizeToolArgsForDisplay } from "./toolArgs.js";

/** Restore exact call diffs; older turn diffs are safe only for a single edit of that file. */
export function restoredToolFileChanges(record: ChatRecord): Map<number, FileChangeSummary> {
  const restored = new Map<number, FileChangeSummary>();
  const edits = new Map<string, number[]>();
  const summaries = new Map<string, FileChangeSummary[]>();
  let unknownEditPath = false;
  const finishTurn = (): void => {
    if (!unknownEditPath) {
      for (const [key, indexes] of edits) {
        const changes = summaries.get(key);
        if (indexes.length === 1 && changes?.length === 1 && !restored.has(indexes[0])) {
          restored.set(indexes[0], changes[0]);
        }
      }
    }
    edits.clear();
    summaries.clear();
    unknownEditPath = false;
  };
  for (const [index, message] of record.messages.entries()) {
    if (message.role === "user") finishTurn();
    for (const change of message.fileChanges ?? []) {
      const key = fileChangeKey(change.path, record.workspaceRoot);
      summaries.set(key, [...summaries.get(key) ?? [], change]);
    }
    const call = message.toolCall;
    if (message.role !== "tool" || !call ||
        !["write_file", "create_file", "edit_file", "insert_text", "replace_range"].includes(call.name) ||
        restoredToolStatus(call.status, message.content) !== "executed") continue;
    if (call.fileChange) restored.set(index, call.fileChange);
    let args: Record<string, unknown>;
    try { args = normalizeToolArgsForDisplay(JSON.parse(call.argsJson)); }
    catch { args = normalizeToolArgsForDisplay(call.argsJson); }
    const path = args.path ?? args.file_path ?? args.filePath ?? args.filename ?? args.file;
    if (typeof path !== "string" || !path.trim()) {
      unknownEditPath = true;
      continue;
    }
    const key = fileChangeKey(path, record.workspaceRoot);
    edits.set(key, [...edits.get(key) ?? [], index]);
  }
  finishTurn();
  return restored;
}

function fileChangeKey(filePath: string, workspaceRoot: string): string {
  const path = filePath.replace(/\\/g, "/");
  const absolute = /^(?:\/|[a-z]:\/)/i.test(path) ? path : `${workspaceRoot.replace(/\\/g, "/")}/${path}`;
  const parts: string[] = [];
  for (const part of absolute.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  const key = parts.join("/");
  return /^[a-z]:\//i.test(absolute) ? key.toLowerCase() : key;
}

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
