import { createHash } from "node:crypto";
import type {
  CommandAvailability,
  CommandPort,
  CommandRequest,
  CommandResult
} from "../chat/session/ports.js";
import {
  gitBlobContentArgs,
  gitBlobSizeArgs,
  gitHeadTreeArgs,
  gitStagedPatchArgs,
  gitStagedStatusArgs,
  parseHeadBlobEntry
} from "./gitProfile.js";

const GIT_EXECUTABLE = "/usr/bin/git";
const GIT_TIMEOUT_MS = 30_000;
const SMALL_OUTPUT_LIMIT = 64 * 1024;
const DIFF_OUTPUT_LIMIT = 8 * 1024 * 1024;
const HEAD_FILE_LIMIT = 8 * 1024 * 1024;

/** Read-only Git operations which are safe to expose to extension features. */
export interface ScmInspectionPort {
  availability(signal: AbortSignal): Promise<CommandAvailability>;
  hasStagedChanges(signal: AbortSignal): Promise<boolean>;
  stagedDiff(signal: AbortSignal): Promise<string>;
  /** Returns undefined when the path does not name a regular file in HEAD. */
  readHeadFile(path: string, signal: AbortSignal): Promise<string | undefined>;
}

/**
 * Runs extension-owned Git inspection through the same attested sandbox as
 * model-proposed commands. Repository data is copied into an ephemeral
 * workspace; no Git process is ever started directly on the extension host.
 */
export class SandboxedGitInspector implements ScmInspectionPort {
  constructor(private readonly commands: CommandPort) {}

  availability(signal: AbortSignal): Promise<CommandAvailability> {
    return this.commands.availability(signal);
  }

  async hasStagedChanges(signal: AbortSignal): Promise<boolean> {
    const result = await this.run(
      "internal.git.staged-status",
      gitStagedStatusArgs(),
      SMALL_OUTPUT_LIMIT,
      signal,
      true
    );
    if (result.exitCode === 0) return false;
    if (result.exitCode === 1) return true;
    throw commandFailure("inspect the staged Git status", result);
  }

  async stagedDiff(signal: AbortSignal): Promise<string> {
    const result = await this.run(
      "internal.git.staged-patch",
      gitStagedPatchArgs(),
      DIFF_OUTPUT_LIMIT,
      signal
    );
    requireSuccess("read the staged Git diff", result);
    return result.stdout;
  }

  async readHeadFile(path: string, signal: AbortSignal): Promise<string | undefined> {
    const entry = await this.run(
      "internal.git.head-entry",
      gitHeadTreeArgs(path),
      SMALL_OUTPUT_LIMIT,
      signal
    );
    requireSuccess("inspect the HEAD tree", entry);
    const oid = parseHeadBlobEntry(entry.stdout, path);
    if (!oid) return undefined;

    const sizeResult = await this.run(
      "internal.git.blob-size",
      gitBlobSizeArgs(oid),
      SMALL_OUTPUT_LIMIT,
      signal
    );
    requireSuccess("inspect the HEAD blob size", sizeResult);
    const size = parseBlobSize(sizeResult.stdout);
    if (size > HEAD_FILE_LIMIT) {
      throw new Error(`The HEAD version is too large to review (${size} bytes; limit ${HEAD_FILE_LIMIT}).`);
    }

    const content = await this.run(
      "internal.git.blob-content",
      gitBlobContentArgs(oid),
      HEAD_FILE_LIMIT,
      signal
    );
    requireSuccess("read the HEAD blob", content);
    if (Buffer.byteLength(content.stdout, "utf8") > HEAD_FILE_LIMIT) {
      throw new Error("Git returned a HEAD blob larger than the review limit.");
    }
    return content.stdout;
  }

  private async run(
    ruleId: string,
    args: readonly string[],
    maxOutputBytes: number,
    signal: AbortSignal,
    allowNonZero = false
  ): Promise<CommandResult> {
    const request: CommandRequest = Object.freeze({
      ruleId,
      ruleRevision: internalRuleRevision(ruleId, args, maxOutputBytes),
      executable: GIT_EXECUTABLE,
      args: Object.freeze([...args]),
      limits: Object.freeze({ timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes })
    });
    const prepared = await this.commands.prepareCommand(request, signal);
    try {
      const result = await this.commands.executeCommand(prepared, signal);
      if (result.truncated) {
        throw new Error("Sandboxed Git output exceeded its fixed limit; partial output was discarded.");
      }
      if (!allowNonZero && result.exitCode !== 0) {
        throw commandFailure("run the sandboxed Git operation", result);
      }
      return result;
    } catch (error) {
      // executeCommand consumes before awaiting. This is intentionally harmless
      // after execution and invalidates a prepared handle if execution rejected
      // before the backend could consume it.
      this.commands.discardCommand(prepared);
      throw error;
    }
  }
}

function internalRuleRevision(
  ruleId: string,
  args: readonly string[],
  maxOutputBytes: number
): string {
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    ruleId,
    executable: GIT_EXECUTABLE,
    args,
    cwd: "/workspace",
    timeoutMs: GIT_TIMEOUT_MS,
    maxOutputBytes
  })).digest("hex");
}

function parseBlobSize(stdout: string): number {
  const text = stdout.trim();
  if (!/^(?:0|[1-9][0-9]{0,15})$/.test(text)) {
    throw new Error("Git returned an invalid HEAD blob size.");
  }
  const size = Number(text);
  if (!Number.isSafeInteger(size)) {
    throw new Error("Git returned an unsupported HEAD blob size.");
  }
  return size;
}

function requireSuccess(operation: string, result: CommandResult): void {
  if (result.exitCode !== 0) throw commandFailure(operation, result);
}

function commandFailure(operation: string, result: CommandResult): Error {
  const detail = result.stderr.trim();
  const suffix = detail ? `: ${detail.slice(0, 1_000)}` : "";
  return new Error(`Could not ${operation} (sandbox exit ${result.exitCode})${suffix}`);
}
