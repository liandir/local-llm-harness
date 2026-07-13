import { createHash } from "node:crypto";
import type { InsertTextArgs, ReplaceRangeArgs } from "../tools/fsTools.js";
import {
  countLogicalLines,
  editRegionSnippet,
  looksLikeNumberedReadOutput
} from "../tools/fsTools.js";
import type {
  PreparedWorkspaceEdit,
  WorkspaceEditRequest,
  WorkspacePort
} from "./session/ports.js";
import type { ProposalScope } from "./approvalCoordinator.js";
import { renderExactEditDiff, type ExactEditDiff } from "./exactEditDiff.js";

export type PreparedWriteArgs =
  | { kind: "write_file"; path: string; content: string }
  | ({ kind: "insert_text" } & InsertTextArgs)
  | ({ kind: "replace_range" } & ReplaceRangeArgs);

export interface PreparedEditTransaction {
  readonly edit: PreparedWorkspaceEdit;
  readonly review: ExactEditDiff;
}

/** Prepare immutable bytes and the exact approval artifact without mutation. */
export async function prepareEditTransaction(
  workspace: WorkspacePort,
  args: PreparedWriteArgs,
  signal: AbortSignal
): Promise<PreparedEditTransaction> {
  assertNoDisplayLinePrefixes(args);
  const edit = await workspace.prepareEdit(toWorkspaceRequest(args), signal);
  try {
    signal.throwIfAborted();
    const review = renderExactEditDiff(edit.previous, edit.next);
    signal.throwIfAborted();
    return Object.freeze({ edit, review });
  } catch (error) {
    workspace.discardEdit(edit);
    throw error;
  }
}

/** Bind the visible artifact and private prepared revision to one host proposal scope. */
export function editReviewDigest(
  scope: ProposalScope,
  transaction: PreparedEditTransaction
): string {
  return digestFields([
    ["format", "local-llm-harness-edit-approval-v1"],
    ["session", scope.sessionId],
    ["turn", scope.turnId],
    ["proposal", scope.proposalId],
    ["decision-token", scope.decisionToken],
    ["tool", scope.toolId],
    ["transaction", transaction.edit.transactionId],
    ["operation", transaction.edit.kind],
    ["path", transaction.edit.path],
    ["base-revision", transaction.edit.baseRevision],
    ["base-sha256", transaction.review.previousSha256],
    ["next-sha256", transaction.review.nextSha256],
    ["base-bytes", String(transaction.review.previousBytes)],
    ["next-bytes", String(transaction.review.nextBytes)],
    ["artifact-sha256", transaction.review.artifactSha256]
  ]);
}

/** Bind non-edit approval cards to the same host-owned decision protocol. */
export function toolReviewDigest(
  scope: ProposalScope,
  toolName: string,
  normalizedArgsJson: string
): string {
  return digestFields([
    ["format", "local-llm-harness-tool-approval-v1"],
    ["session", scope.sessionId],
    ["turn", scope.turnId],
    ["proposal", scope.proposalId],
    ["decision-token", scope.decisionToken],
    ["tool-id", scope.toolId],
    ["tool-name", toolName],
    ["args", normalizedArgsJson]
  ]);
}

export function describeCommittedEdit(
  args: PreparedWriteArgs,
  edit: PreparedWorkspaceEdit
): { result: string; lineDelta: number } {
  const lineDelta = countLogicalLines(edit.next) - countLogicalLines(edit.previous);
  if (args.kind === "write_file") {
    return {
      result: `wrote ${edit.bytesWritten} bytes to ${edit.path}; the file now has ${countLogicalLines(edit.next)} lines`,
      lineDelta
    };
  }
  if (args.kind === "insert_text") {
    const insertedLines = Math.max(1, lineDelta);
    return {
      result: `inserted ${edit.bytesWritten} bytes into ${edit.path} before line ${args.line}`
        + autoBreakNotes(edit)
        + lineShiftNote(`at and after line ${args.line}`, edit.previous, edit.next)
        + editResultSnippet(edit.next, args.line, insertedLines),
      lineDelta
    };
  }
  const replacedCount = args.endLine - args.startLine + 1;
  const regionLines = replacedCount + lineDelta;
  return {
    result: `replaced lines ${args.startLine}-${args.endLine} in ${edit.path} with ${edit.bytesWritten} bytes`
      + autoBreakNotes(edit)
      + lineShiftNote(`after line ${args.endLine}`, edit.previous, edit.next)
      + editResultSnippet(edit.next, args.startLine, regionLines),
    lineDelta
  };
}

export function staleLineNumbersMessage(toolName: string, filePath: string, shift: number): string {
  const sign = shift > 0 ? `+${shift}` : `${shift}`;
  return [
    `line numbers in ${filePath} are stale: an earlier edit in this same reply already changed the file's line count by ${sign}.`,
    `This ${toolName} call was NOT applied because its line numbers were computed before that edit.`,
    "Use the updated line numbers shown in the earlier edit's result (or re-read the range), then re-emit this edit."
  ].join(" ");
}

function toWorkspaceRequest(args: PreparedWriteArgs): WorkspaceEditRequest {
  if (args.kind === "write_file") return args;
  if (args.kind === "insert_text") return args;
  return args;
}

function assertNoDisplayLinePrefixes(args: PreparedWriteArgs): void {
  const body = args.kind === "insert_text" ? args.text : args.content;
  const expectedFirstLine = args.kind === "insert_text"
    ? args.line
    : args.kind === "replace_range"
      ? args.startLine
      : undefined;
  if (looksLikeNumberedReadOutput(body, expectedFirstLine)) {
    throw new Error([
      `the ${args.kind} content looks like read_file output pasted back with its line-number prefixes (lines starting with a number and a tab).`,
      "Those prefixes are display-only and are not part of the file, so nothing was written.",
      "Re-emit the call with the code itself, without the number-tab prefixes."
    ].join(" "));
  }
}

function autoBreakNotes(edit: Pick<PreparedWorkspaceEdit, "addedLeadingBreak" | "addedTrailingBreak">): string {
  const notes: string[] = [];
  if (edit.addedLeadingBreak) {
    notes.push("the file did not end with a line break, so one was added before the inserted text to start it on its own line");
  }
  if (edit.addedTrailingBreak) {
    notes.push("the text did not end with a line break, so one was added to keep the following line separate");
  }
  return notes.length > 0 ? `. Note: ${notes.join("; ")}` : "";
}

function lineShiftNote(where: string, previous: string, next: string): string {
  const delta = countLogicalLines(next) - countLogicalLines(previous);
  if (delta === 0) return "";
  const sign = delta > 0 ? `+${delta}` : `${delta}`;
  return `. Line numbers ${where} have shifted by ${sign}; numbers from earlier reads are stale there — use the updated region below for any follow-up edit to this file.`;
}

function editResultSnippet(next: string, regionStart: number, regionLines: number): string {
  return `\nUpdated region with current line numbers (the number-tab prefixes are display-only, not file content):\n`
    + editRegionSnippet(next, regionStart, regionLines);
}

function digestFields(fields: readonly (readonly [string, string])[]): string {
  const hash = createHash("sha256");
  for (const [name, value] of fields) {
    const bytes = Buffer.from(value, "utf8");
    hash.update(`${name}:${bytes.length}:`, "utf8");
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}
