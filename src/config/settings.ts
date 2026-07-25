import * as vscode from "vscode";
import type { ModelFamily } from "../llm/parser/index.js";
import type { SafeCommandEntry } from "../tools/safeCommands.js";
import {
  decodeSandboxCommandRules,
  decodeSandboxDockerHost,
  decodeSandboxDockerPath,
  decodeSandboxImage,
  type SandboxCommandRule
} from "../tools/sandboxCommands.js";

const NS = "localLlmHarness";

export interface HarnessSettings {
  endpoint: string;
  modelFamily: ModelFamily;
  contextSize: number;
  temperature: number;
  topK: number;
  topP: number;
  autoCompact: boolean;
  autoCompactThresholdPercent: number;
  tailBudgetPercent: number;
  maxMessageTokensPercent: number;
  templateOverheadTokensPerMessage: number;
  autoapproveReads: boolean;
  autoapproveWrites: boolean;
  autoapproveSandboxCommands: boolean;
  sandboxDockerPath: string;
  sandboxDockerHost: string;
  sandboxImage: string;
  sandboxCommands: readonly SandboxCommandRule[];
  /** @deprecated Compatibility-only; never authorizes command execution. */
  autoapproveCommands: boolean;
  /** @deprecated Compatibility-only; regex entries are never evaluated. */
  safeCommands: SafeCommandEntry[];
}

export function readSettings(): HarnessSettings {
  const cfg = vscode.workspace.getConfiguration(NS);
  const configuredDockerHost = readApplicationSetting<unknown>(
    cfg,
    "sandboxDockerHost",
    ""
  );
  return {
    endpoint: readApplicationSetting(cfg, "endpoint", "http://localhost:8080/v1"),
    modelFamily: readApplicationSetting<ModelFamily>(cfg, "modelFamily", "gemma4"),
    contextSize: readApplicationSetting(cfg, "contextSize", 32768),
    // Low default on purpose: tool calls carry exact line numbers, and
    // sampling noise there directly produces mistargeted edits.
    temperature: clampNumber(readApplicationSetting(cfg, "temperature", 0.3), 0, 2, 0.3),
    topK: Math.round(clampNumber(readApplicationSetting(cfg, "topK", 40), 0, Number.MAX_SAFE_INTEGER, 40)),
    topP: clampNumber(readApplicationSetting(cfg, "topP", 0.95), 0, 1, 0.95),
    autoCompact: readApplicationSetting(cfg, "autoCompact", true),
    autoCompactThresholdPercent: clampPercent(readApplicationSetting(cfg, "autoCompactThresholdPercent", 80)),
    tailBudgetPercent: clampNumber(Math.round(readApplicationSetting(cfg, "tailBudgetPercent", 30)), 5, 60, 30),
    maxMessageTokensPercent: clampNumber(Math.round(readApplicationSetting(cfg, "maxMessageTokensPercent", 25)), 5, 50, 25),
    templateOverheadTokensPerMessage: clampNumber(Math.round(readApplicationSetting(cfg, "templateOverheadTokensPerMessage", 4)), 0, 64, 4),
    autoapproveReads: readApplicationSetting(cfg, "autoapproveReads", false),
    autoapproveWrites: readApplicationSetting(cfg, "autoapproveWrites", false),
    autoapproveSandboxCommands:
      readApplicationSetting<unknown>(cfg, "autoapproveSandboxCommands", false) === true,
    sandboxDockerPath: decodeSandboxDockerPath(
      readApplicationSetting<unknown>(cfg, "sandboxDockerPath", "")
    ),
    // Preserve a non-empty malformed endpoint so production preflight can
    // reject it. Collapsing it to the empty sentinel would silently select the
    // platform-local default and turn invalid configuration into authority.
    sandboxDockerHost: preserveConfiguredDockerHost(configuredDockerHost),
    sandboxImage: decodeSandboxImage(
      readApplicationSetting<unknown>(cfg, "sandboxImage", "")
    ),
    sandboxCommands: decodeSandboxCommandRules(
      readApplicationSetting<unknown>(cfg, "sandboxCommands", [])
    ),
    autoapproveCommands: readApplicationSetting(cfg, "autoapproveCommands", false),
    safeCommands: readApplicationSetting<SafeCommandEntry[]>(cfg, "safeCommands", [])
  };
}

function preserveConfiguredDockerHost(value: unknown): string {
  const decoded = decodeSandboxDockerHost(value);
  if (decoded || value === "") return decoded;
  return typeof value === "string" && value.length <= 4096
    ? value
    : "invalid://configured-docker-endpoint";
}

/**
 * Security policy is application-owned, never repository-owned. Reading only
 * the global/default layers prevents a workspace's `.vscode/settings.json`
 * from redirecting prompts or silently enabling tool approval. The manifest
 * also marks these settings application-scoped; this is defense in depth.
 */
function readApplicationSetting<T>(
  cfg: vscode.WorkspaceConfiguration,
  key: keyof HarnessSettings,
  fallback: T
): T {
  const inspected = cfg.inspect<T>(key);
  if (!inspected) return fallback;
  if (inspected.globalValue !== undefined) return inspected.globalValue;
  if (inspected.defaultValue !== undefined) return inspected.defaultValue;
  return fallback;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 80;
  return Math.min(95, Math.max(50, Math.round(value)));
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export async function writeSetting<K extends keyof HarnessSettings>(
  key: K,
  value: HarnessSettings[K]
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(NS);
  await cfg.update(key, value, vscode.ConfigurationTarget.Global);
}

/** Every harness setting key; maps 1:1 to the package.json configuration properties. */
const SETTING_KEYS: (keyof HarnessSettings)[] = [
  // Clear every auto-approval grant before attempting less-sensitive values.
  // A partially failed reset must bias toward requiring more approval.
  "autoapproveReads",
  "autoapproveWrites",
  "autoapproveSandboxCommands",
  "autoapproveCommands",
  "endpoint",
  "modelFamily",
  "contextSize",
  "temperature",
  "topK",
  "topP",
  "autoCompact",
  "autoCompactThresholdPercent",
  "tailBudgetPercent",
  "maxMessageTokensPercent",
  "templateOverheadTokensPerMessage",
  "sandboxDockerPath",
  "sandboxDockerHost",
  "sandboxImage",
  "sandboxCommands",
  "safeCommands"
];

export interface SettingResetFailure {
  readonly key: keyof HarnessSettings;
  readonly message: string;
}

/** Structured sandbox rules contributed as the package.json default. */
export function getDefaultSandboxCommands(): readonly SandboxCommandRule[] {
  const cfg = vscode.workspace.getConfiguration(NS);
  return decodeSandboxCommandRules(cfg.inspect<unknown>("sandboxCommands")?.defaultValue ?? []);
}

/** Seed editable structured rules only when no application override exists. */
export async function seedSandboxCommandsIfUnset(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(NS);
  const info = cfg.inspect<unknown>("sandboxCommands");
  if (info?.globalValue !== undefined) return;
  await cfg.update(
    "sandboxCommands",
    getDefaultSandboxCommands(),
    vscode.ConfigurationTarget.Global
  );
}

/** Restore the application-owned structured sandbox rule defaults. */
export async function restoreDefaultSandboxCommands(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(NS);
  await cfg.update(
    "sandboxCommands",
    getDefaultSandboxCommands(),
    vscode.ConfigurationTarget.Global
  );
}

/** The safe-command allow-list contributed as the package.json default (no user override). */
export function getDefaultSafeCommands(): SafeCommandEntry[] {
  const cfg = vscode.workspace.getConfiguration(NS);
  return cfg.inspect<SafeCommandEntry[]>("safeCommands")?.defaultValue ?? [];
}

/**
 * Write the default safe commands into user settings IFF the user has no override
 * yet. The package.json default is otherwise invisible in the JSON editor, leaving
 * nothing to edit; seeding gives the user a concrete starting point.
 */
export async function seedSafeCommandsIfUnset(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(NS);
  const info = cfg.inspect<SafeCommandEntry[]>("safeCommands");
  const hasOverride = info?.globalValue !== undefined;
  if (hasOverride) return;
  await cfg.update("safeCommands", getDefaultSafeCommands(), vscode.ConfigurationTarget.Global);
}

/** Overwrite the user's safe-command allow-list with the package.json defaults. */
export async function restoreDefaultSafeCommands(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(NS);
  await cfg.update("safeCommands", getDefaultSafeCommands(), vscode.ConfigurationTarget.Global);
}

/**
 * Reset every harness setting to its default by clearing the user override.
 *
 * Each update is attempted even when an earlier key fails. Callers receive a
 * bounded failure record for every rejected update so they can report the
 * partial reset and then re-read the authoritative configuration.
 */
export async function resetAllSettings(): Promise<readonly SettingResetFailure[]> {
  const cfg = vscode.workspace.getConfiguration(NS);
  const failures: SettingResetFailure[] = [];
  for (const key of SETTING_KEYS) {
    try {
      await cfg.update(key, undefined, vscode.ConfigurationTarget.Global);
    } catch (error) {
      failures.push(Object.freeze({
        key,
        message: boundedSettingUpdateError(error)
      }));
    }
  }
  return Object.freeze(failures);
}

function boundedSettingUpdateError(error: unknown): string {
  const fallback = "VS Code rejected the setting update.";
  const message = error instanceof Error ? error.message : fallback;
  const printable = [...message]
    .filter(character => {
      const code = character.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .trim()
    .slice(0, 256);
  return printable || fallback;
}

export function onSettingsChange(handler: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration(NS)) handler();
  });
}
