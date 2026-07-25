import * as path from "node:path";
import { parseWorkspacePath } from "../security/workspace/pathPolicy.js";

/**
 * Hard limits for application-owned sandbox configuration.
 *
 * These values bound settings decoding and prompt rendering. A rule is a fixed
 * argv vector selected by ID; no model-provided string is ever interpreted as
 * an executable, argument, working directory, or shell program.
 */
export const SANDBOX_COMMAND_LIMITS = Object.freeze({
  maxRules: 32,
  maxRuleIdLength: 64,
  maxExecutableLength: 1024,
  maxArgsPerRule: 32,
  maxArgumentLength: 2048,
  maxArgumentBytesPerRule: 4096,
  maxTotalRuleBytes: 32768,
  maxCwdLength: 4096,
  maxDescriptionLength: 512,
  maxDockerPathLength: 4096,
  maxDockerHostLength: 4096,
  maxImageLength: 1024
});

export interface SandboxCommandRule {
  /** Stable, ASCII identifier supplied by the model to `run_command`. */
  readonly id: string;
  /** Fixed argv[0], supplied only by application-owned configuration. */
  readonly executable: string;
  /** Fixed argv[1..n], supplied only by application-owned configuration. */
  readonly args: readonly string[];
  /** Optional canonical workspace-relative directory inside the disposable copy. */
  readonly cwd?: string;
  /** Optional prompt-facing explanation of the rule's purpose. */
  readonly description?: string;
}

export interface SandboxCommandConfiguration {
  readonly sandboxDockerPath: unknown;
  readonly sandboxDockerHost: unknown;
  readonly sandboxImage: unknown;
  readonly sandboxCommands: unknown;
}

/**
 * Immutable point-in-time capability used by both prompt and runtime policy.
 * `available` is true only after the caller has verified the configured local
 * sandbox backend. Omitting a snapshot therefore always fails closed.
 */
export interface SandboxCommandCapabilitySnapshot {
  readonly available: boolean;
  readonly reason: string;
  readonly dockerPath: string;
  readonly dockerHost: string;
  readonly image: string;
  readonly rules: readonly SandboxCommandRule[];
}

const EMPTY_RULES: readonly SandboxCommandRule[] = Object.freeze([]);
const RULE_KEYS = new Set(["id", "executable", "args", "cwd", "description"]);
const RULE_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const IMMUTABLE_IMAGE = /^(?:[a-z0-9][a-z0-9._/:+-]*@)?sha256:[a-f0-9]{64}$/;

export const NO_SANDBOX_COMMAND_CAPABILITY: SandboxCommandCapabilitySnapshot =
  freezeCapability({
    available: false,
    reason: "No verified sandbox command capability was supplied.",
    dockerPath: "",
    dockerHost: "",
    image: "",
    rules: EMPTY_RULES
  });

/** Decode an absolute, local Docker CLI path. Invalid values become empty. */
export function decodeSandboxDockerPath(value: unknown): string {
  if (!isBoundedPlainString(value, SANDBOX_COMMAND_LIMITS.maxDockerPathLength)) return "";
  if (value === "" || containsControlCharacter(value) || value.includes("\0")) return "";
  if (value.startsWith("\\\\") || value.startsWith("//")) return "";
  if (path.posix.isAbsolute(value)) {
    return path.posix.normalize(value) === value && !value.includes("//") && !value.endsWith("/")
      ? value
      : "";
  }
  if (path.win32.isAbsolute(value)) {
    return path.win32.normalize(value) === value && !/[\\/]$/.test(value) ? value : "";
  }
  return "";
}

/**
 * Decode a local Docker daemon endpoint. Empty means the platform-local Docker
 * default. Network transports such as tcp, http, and ssh are rejected.
 */
export function decodeSandboxDockerHost(value: unknown): string {
  if (!isBoundedPlainString(value, SANDBOX_COMMAND_LIMITS.maxDockerHostLength)) return "";
  if (value === "") return "";
  if (containsControlCharacter(value) || value.includes("\0")) return "";
  if (value.startsWith("unix://")) {
    const socketPath = value.slice("unix://".length);
    if (!path.posix.isAbsolute(socketPath) || socketPath.startsWith("//")) return "";
    if (
      path.posix.normalize(socketPath) !== socketPath ||
      socketPath.includes("//") ||
      socketPath.endsWith("/") ||
      /[%?#]/.test(socketPath)
    ) return "";
    return value;
  }
  if (/^npipe:\/\/\/\/\.\/pipe\/[A-Za-z0-9._-]+$/.test(value)) return value;
  return "";
}

/** Decode an immutable image digest or image ID. Tags are intentionally inert. */
export function decodeSandboxImage(value: unknown): string {
  if (!isBoundedPlainString(value, SANDBOX_COMMAND_LIMITS.maxImageLength)) return "";
  return IMMUTABLE_IMAGE.test(value) ? value : "";
}

/**
 * Decode a closed list of fixed command rules.
 *
 * The operation is atomic: one malformed, duplicate, oversized, accessor, or
 * unknown field invalidates the whole list. Returned rules, argv arrays, and
 * the list itself are fresh frozen copies.
 */
export function decodeSandboxCommandRules(value: unknown): readonly SandboxCommandRule[] {
  try {
    if (!Array.isArray(value) || value.length === 0 || value.length > SANDBOX_COMMAND_LIMITS.maxRules) {
      return EMPTY_RULES;
    }

    const decoded: SandboxCommandRule[] = [];
    const ids = new Set<string>();
    let totalBytes = 0;

    for (let index = 0; index < value.length; index++) {
      const rule = decodeRule(readArrayDataElement(value, index));
      if (!rule || ids.has(rule.id)) return EMPTY_RULES;
      ids.add(rule.id);
      totalBytes += ruleByteLength(rule);
      if (totalBytes > SANDBOX_COMMAND_LIMITS.maxTotalRuleBytes) return EMPTY_RULES;
      decoded.push(rule);
    }

    return Object.freeze(decoded);
  } catch {
    return EMPTY_RULES;
  }
}

/**
 * Build the sole object that authorizes command advertisement and selection.
 * Configuration alone is insufficient: `runtimeVerified` must describe a
 * backend that enforces no network, a disposable workspace copy, and discarded
 * command mutations.
 */
export function createSandboxCommandCapabilitySnapshot(
  configuration: SandboxCommandConfiguration,
  runtimeVerified: boolean,
  unavailableReason = "The sandbox backend has not been verified."
): SandboxCommandCapabilitySnapshot {
  const dockerPath = decodeSandboxDockerPath(configuration.sandboxDockerPath);
  const dockerHost = decodeSandboxDockerHost(configuration.sandboxDockerHost);
  const image = decodeSandboxImage(configuration.sandboxImage);
  const rules = decodeSandboxCommandRules(configuration.sandboxCommands);

  let reason = "";
  if (!dockerPath) reason = "An absolute local Docker executable path is not configured.";
  else if (configuration.sandboxDockerHost !== "" && !dockerHost) {
    reason = "The configured Docker endpoint is not a canonical local socket or named pipe.";
  }
  else if (!image) reason = "An immutable sandbox image digest or image ID is not configured.";
  else if (rules.length === 0) reason = "No valid structured sandbox command rules are configured.";
  else if (runtimeVerified !== true) reason = boundedReason(unavailableReason);

  return freezeCapability({
    available: reason === "",
    reason,
    dockerPath,
    dockerHost,
    image,
    rules
  });
}

/** Resolve only an exact configured ID; all executable data stays host-owned. */
export function findSandboxCommandRule(
  capability: SandboxCommandCapabilitySnapshot,
  ruleId: unknown
): SandboxCommandRule | undefined {
  if (!capability.available || typeof ruleId !== "string" || !RULE_ID.test(ruleId)) return undefined;
  return capability.rules.find(rule => rule.id === ruleId);
}

function decodeRule(value: unknown): SandboxCommandRule | undefined {
  if (!isPlainRecord(value)) return undefined;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some(key => typeof key !== "string" || !RULE_KEYS.has(key))) return undefined;

  const id = readDataProperty(value, "id");
  const executable = readDataProperty(value, "executable");
  const rawArgs = readDataProperty(value, "args");
  if (
    !isBoundedPlainString(id, SANDBOX_COMMAND_LIMITS.maxRuleIdLength) ||
    !RULE_ID.test(id) ||
    !isBoundedPlainString(executable, SANDBOX_COMMAND_LIMITS.maxExecutableLength) ||
    !isCanonicalContainerExecutable(executable) ||
    !Array.isArray(rawArgs) ||
    rawArgs.length > SANDBOX_COMMAND_LIMITS.maxArgsPerRule
  ) {
    return undefined;
  }

  const args: string[] = [];
  let argumentBytes = 0;
  for (let index = 0; index < rawArgs.length; index++) {
    const arg = readArrayDataElement(rawArgs, index);
    if (
      !isBoundedPlainString(arg, SANDBOX_COMMAND_LIMITS.maxArgumentLength) ||
      containsControlCharacter(arg)
    ) {
      return undefined;
    }
    argumentBytes += Buffer.byteLength(arg, "utf8");
    if (argumentBytes > SANDBOX_COMMAND_LIMITS.maxArgumentBytesPerRule) return undefined;
    args.push(arg);
  }

  const rawCwd = hasOwn(value, "cwd") ? readDataProperty(value, "cwd") : undefined;
  let cwd: string | undefined;
  if (rawCwd !== undefined) {
    if (!isBoundedPlainString(rawCwd, SANDBOX_COMMAND_LIMITS.maxCwdLength)) return undefined;
    const parsed = parseWorkspacePath(rawCwd, true);
    if (parsed.displayPath !== rawCwd) return undefined;
    cwd = rawCwd;
  }

  const rawDescription = hasOwn(value, "description")
    ? readDataProperty(value, "description")
    : undefined;
  let description: string | undefined;
  if (rawDescription !== undefined) {
    if (
      !isBoundedPlainString(rawDescription, SANDBOX_COMMAND_LIMITS.maxDescriptionLength) ||
      rawDescription.length === 0 ||
      containsControlCharacter(rawDescription)
    ) {
      return undefined;
    }
    description = rawDescription;
  }

  const decoded: SandboxCommandRule = {
    id,
    executable,
    args: Object.freeze(args),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(description !== undefined ? { description } : {})
  };
  return Object.freeze(decoded);
}

function readArrayDataElement(value: unknown[], index: number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
  if (!descriptor || !("value" in descriptor)) throw new TypeError("Sparse or accessor array entry.");
  return descriptor.value;
}

function readDataProperty(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) throw new TypeError(`Missing or accessor property: ${key}`);
  return descriptor.value;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isBoundedPlainString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isCanonicalContainerExecutable(value: string): boolean {
  return value.length > 0 &&
    !containsControlCharacter(value) &&
    path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    !value.includes("//") &&
    !value.endsWith("/");
}

function ruleByteLength(rule: SandboxCommandRule): number {
  return Buffer.byteLength(
    [rule.id, rule.executable, ...rule.args, rule.cwd ?? "", rule.description ?? ""].join("\0"),
    "utf8"
  );
}

function boundedReason(value: string): string {
  if (typeof value !== "string" || value.length === 0 || containsControlCharacter(value)) {
    return "The sandbox backend has not been verified.";
  }
  return value.slice(0, 512);
}

function freezeCapability(
  capability: SandboxCommandCapabilitySnapshot
): SandboxCommandCapabilitySnapshot {
  return Object.freeze({ ...capability, rules: capability.rules });
}
