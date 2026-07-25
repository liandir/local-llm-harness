import { createHash } from "node:crypto";
import type { ProposalScope } from "./approvalCoordinator.js";
import type {
  CommandPort,
  CommandResult,
  CommandRequest,
  PreparedSandboxCommand
} from "./session/ports.js";
import {
  findSandboxCommandRule,
  type SandboxCommandCapabilitySnapshot,
  type SandboxCommandRule
} from "../tools/sandboxCommands.js";

export const MODEL_COMMAND_LIMITS = Object.freeze({
  timeoutMs: 30_000,
  maxOutputBytes: 2 * 1024 * 1024
});

export interface PreparedCommandTransaction {
  readonly transactionId: string;
  readonly ruleId: string;
  readonly argsJson: string;
  readonly commandDisplay: string;
  readonly review: Readonly<{
    text: string;
    format: "command-v1";
    sha256: string;
  }>;
}

interface PrivateCommandTransaction {
  readonly port: CommandPort;
  readonly prepared: PreparedSandboxCommand;
  readonly rule: SandboxCommandRule;
  readonly ruleRevision: string;
  readonly reviewHash: string;
  readonly dockerPath: string;
  readonly dockerHost: string;
}

const transactionAuthority = new WeakMap<PreparedCommandTransaction, PrivateCommandTransaction>();

/**
 * Resolve a model-supplied rule ID to immutable host-owned argv and ask the
 * sandbox to prepare an authentic one-shot handle. This performs no command
 * execution and is safe to call before displaying an approval proposal.
 */
export async function prepareCommandTransaction(
  port: CommandPort,
  capability: SandboxCommandCapabilitySnapshot,
  rawArgsJson: string,
  signal: AbortSignal
): Promise<PreparedCommandTransaction> {
  const { ruleId } = parseCommandToolArgs(rawArgsJson);
  const rule = findSandboxCommandRule(capability, ruleId);
  if (!rule) {
    throw new Error(`Sandbox command rule "${ruleId}" is unavailable in this turn's policy snapshot.`);
  }

  const ruleRevision = sandboxRuleRevision(rule);
  const request: CommandRequest = Object.freeze({
    ruleId: rule.id,
    ruleRevision,
    executable: rule.executable,
    args: Object.freeze([...rule.args]),
    ...(rule.cwd !== undefined ? { cwd: rule.cwd } : {}),
    limits: MODEL_COMMAND_LIMITS
  });
  const prepared = await port.prepareCommand(request, signal);
  try {
    assertPreparedCommand(prepared, request, capability);
  } catch (error) {
    port.discardCommand(prepared);
    throw error;
  }

  const reviewText = renderCommandReview(
    prepared,
    rule,
    capability.dockerPath,
    capability.dockerHost
  );
  const reviewHash = sha256(reviewText);
  const publicTransaction: PreparedCommandTransaction = Object.freeze({
    transactionId: prepared.transactionId,
    ruleId: rule.id,
    argsJson: JSON.stringify({ ruleId: rule.id }),
    commandDisplay: renderCommandDisplay(rule),
    review: Object.freeze({
      text: reviewText,
      format: "command-v1" as const,
      sha256: reviewHash
    })
  });
  transactionAuthority.set(publicTransaction, Object.freeze({
    port,
    prepared,
    rule,
    ruleRevision,
    reviewHash,
    dockerPath: capability.dockerPath,
    dockerHost: capability.dockerHost
  }));
  return publicTransaction;
}

/** Bind the user's one-shot decision to every executable sandbox field. */
export function commandReviewDigest(
  scope: ProposalScope,
  transaction: PreparedCommandTransaction
): string {
  const state = requireAuthenticTransaction(transaction);
  const command = state.prepared;
  return framedSha256([
    "sandbox-command-approval-v1",
    scope.sessionId,
    scope.turnId,
    scope.proposalId,
    scope.decisionToken,
    scope.toolId,
    command.transactionId,
    command.ruleId,
    state.ruleRevision,
    command.executable,
    String(command.args.length),
    ...command.args,
    command.cwd ?? "",
    String(command.timeoutMs),
    String(command.maxOutputBytes),
    command.backend,
    command.profileDigest,
    command.imageReference,
    command.imageId,
    command.workspaceMode,
    command.networkMode,
    state.dockerPath,
    state.dockerHost,
    state.reviewHash
  ]);
}

/** Execute an authentic transaction exactly once and return its full bounded result. */
export async function executeCommandTransaction(
  transaction: PreparedCommandTransaction,
  signal: AbortSignal
): Promise<string> {
  const state = consumeAuthenticTransaction(transaction);
  const result = await state.port.executeCommand(state.prepared, signal);
  return formatCommandResult(result, state.prepared.maxOutputBytes);
}

/** Permanently invalidate an authentic prepared command which will not run. */
export function discardCommandTransaction(transaction: PreparedCommandTransaction): boolean {
  const state = transactionAuthority.get(transaction);
  if (!state) return false;
  transactionAuthority.delete(transaction);
  state.port.discardCommand(state.prepared);
  return true;
}

export function sandboxRuleRevision(rule: SandboxCommandRule): string {
  return sha256(JSON.stringify({
    version: 1,
    id: rule.id,
    executable: rule.executable,
    args: rule.args,
    cwd: rule.cwd ?? "",
    description: rule.description ?? "",
    limits: MODEL_COMMAND_LIMITS
  }));
}

/** Strict tool schema: an exact object containing one exact rule ID. */
export function parseCommandToolArgs(rawArgsJson: string): { readonly ruleId: string } {
  let value: unknown;
  try {
    value = JSON.parse(rawArgsJson);
  } catch {
    throw new Error("run_command requires valid JSON with exactly one ruleId field.");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error("run_command requires an object with exactly one ruleId field.");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(record, "ruleId") ||
    typeof record.ruleId !== "string" ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(record.ruleId)
  ) {
    throw new Error("run_command requires exactly {\"ruleId\":\"configured-rule-id\"}.");
  }
  return Object.freeze({ ruleId: record.ruleId });
}

function assertPreparedCommand(
  prepared: PreparedSandboxCommand,
  request: CommandRequest,
  capability: SandboxCommandCapabilitySnapshot
): void {
  const sameArgs = prepared.args.length === request.args.length &&
    prepared.args.every((arg, index) => arg === request.args[index]);
  if (
    !Object.isFrozen(prepared) ||
    !Object.isFrozen(prepared.args) ||
    prepared.ruleId !== request.ruleId ||
    prepared.ruleRevision !== request.ruleRevision ||
    prepared.executable !== request.executable ||
    !sameArgs ||
    prepared.cwd !== request.cwd ||
    prepared.timeoutMs !== request.limits.timeoutMs ||
    prepared.maxOutputBytes !== request.limits.maxOutputBytes ||
    prepared.backend !== "docker" ||
    prepared.imageReference !== capability.image ||
    prepared.workspaceMode !== "ephemeral-copy" ||
    prepared.networkMode !== "none" ||
    !/^[0-9a-f]{64}$/.test(prepared.profileDigest) ||
    !/^sha256:[0-9a-f]{64}$/.test(prepared.imageId) ||
    typeof prepared.transactionId !== "string" ||
    prepared.transactionId.length === 0 ||
    prepared.transactionId.length > 256
  ) {
    throw new Error("The sandbox returned a prepared command that does not match the requested policy.");
  }
}

function renderCommandReview(
  command: PreparedSandboxCommand,
  rule: SandboxCommandRule,
  dockerPath: string,
  dockerHost: string
): string {
  return [
    "Sandbox command approval v1",
    `Rule ID: ${rule.id}`,
    `Rule revision: ${command.ruleRevision}`,
    ...(rule.description ? [`Purpose: ${quoteCommandReviewValue(rule.description)}`] : []),
    `Executable: ${quoteCommandReviewValue(command.executable)}`,
    "Arguments:",
    ...(command.args.length > 0
      ? command.args.map((arg, index) => `  [${index}] ${quoteCommandReviewValue(arg)}`)
      : ["  (none)"]),
    `Working directory: ${quoteCommandReviewValue(command.cwd ? `/workspace/${command.cwd}` : "/workspace")}`,
    `Timeout: ${command.timeoutMs} ms`,
    `Maximum combined output: ${command.maxOutputBytes} bytes`,
    `Backend: ${command.backend}`,
    `Docker executable: ${quoteCommandReviewValue(dockerPath)}`,
    `Docker endpoint: ${dockerHost ? quoteCommandReviewValue(dockerHost) : "platform-local default"}`,
    `Sandbox profile SHA-256: ${command.profileDigest}`,
    `Image reference: ${quoteCommandReviewValue(command.imageReference)}`,
    `Verified image ID: ${quoteCommandReviewValue(command.imageId)}`,
    `Network: ${command.networkMode}`,
    "Workspace: ephemeral copy; command filesystem changes are discarded",
    `Prepared transaction: ${quoteCommandReviewValue(command.transactionId)}`
  ].join("\n");
}

function renderCommandDisplay(rule: SandboxCommandRule): string {
  return `[${rule.id}] ${[rule.executable, ...rule.args].map(quoteCommandReviewValue).join(" ")}`;
}

/**
 * Render an unambiguous JSON-style UTF-16 string for the approval surface.
 * Escaping every non-ASCII code unit prevents bidi controls, zero-width
 * format characters, and combining text from visually reordering fixed argv.
 */
export function quoteCommandReviewValue(value: string): string {
  let quoted = '"';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22) quoted += '\\"';
    else if (code === 0x5c) quoted += "\\\\";
    else if (code >= 0x20 && code <= 0x7e) quoted += value[index];
    else quoted += `\\u${code.toString(16).padStart(4, "0")}`;
  }
  return `${quoted}"`;
}

function formatCommandResult(result: CommandResult, maxOutputBytes: number): string {
  if (
    !Number.isSafeInteger(result.exitCode) ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string" ||
    typeof result.truncated !== "boolean"
  ) {
    throw new Error("The sandbox returned an invalid command result.");
  }
  const combinedBytes = Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8");
  if (combinedBytes > maxOutputBytes) {
    throw new Error("The sandbox returned command output above the approved byte limit.");
  }
  return [
    `exit code: ${result.exitCode}`,
    ...(result.exitCode === 124
      ? ["note: exit 124 is reserved for sandbox deadlines, but a child that exits 124 is indistinguishable"]
      : []),
    `output truncated: ${result.truncated ? "yes" : "no"}`,
    "stdout:",
    result.stdout,
    "stderr:",
    result.stderr
  ].join("\n");
}

function requireAuthenticTransaction(
  transaction: PreparedCommandTransaction
): PrivateCommandTransaction {
  const state = transactionAuthority.get(transaction);
  if (!state) throw new Error("Command transaction is invalid or already consumed.");
  return state;
}

function consumeAuthenticTransaction(
  transaction: PreparedCommandTransaction
): PrivateCommandTransaction {
  const state = requireAuthenticTransaction(transaction);
  transactionAuthority.delete(transaction);
  return state;
}

function framedSha256(fields: readonly string[]): string {
  const hash = createHash("sha256");
  for (const field of fields) {
    const bytes = Buffer.from(field, "utf8");
    const size = Buffer.allocUnsafe(8);
    size.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(size);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
