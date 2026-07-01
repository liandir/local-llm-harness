import * as vscode from "vscode";
import type { ModelFamily } from "../llm/parser/index.js";
import type { SafeCommandEntry } from "../tools/safeCommands.js";

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
  autoapproveCommands: boolean;
  safeCommands: SafeCommandEntry[];
}

export function readSettings(): HarnessSettings {
  const cfg = vscode.workspace.getConfiguration(NS);
  return {
    endpoint: cfg.get<string>("endpoint") ?? "http://localhost:8080/v1",
    modelFamily: (cfg.get<string>("modelFamily") as ModelFamily) ?? "gemma4",
    contextSize: cfg.get<number>("contextSize") ?? 32768,
    temperature: clampNumber(cfg.get<number>("temperature") ?? 0.7, 0, 2, 0.7),
    topK: Math.round(clampNumber(cfg.get<number>("topK") ?? 40, 0, Number.MAX_SAFE_INTEGER, 40)),
    topP: clampNumber(cfg.get<number>("topP") ?? 0.95, 0, 1, 0.95),
    autoCompact: cfg.get<boolean>("autoCompact") ?? true,
    autoCompactThresholdPercent: clampPercent(cfg.get<number>("autoCompactThresholdPercent") ?? 80),
    tailBudgetPercent: clampNumber(Math.round(cfg.get<number>("tailBudgetPercent") ?? 30), 5, 60, 30),
    maxMessageTokensPercent: clampNumber(Math.round(cfg.get<number>("maxMessageTokensPercent") ?? 25), 5, 50, 25),
    templateOverheadTokensPerMessage: clampNumber(Math.round(cfg.get<number>("templateOverheadTokensPerMessage") ?? 4), 0, 64, 4),
    autoapproveReads: cfg.get<boolean>("autoapproveReads") ?? true,
    autoapproveWrites: cfg.get<boolean>("autoapproveWrites") ?? false,
    autoapproveCommands: cfg.get<boolean>("autoapproveCommands") ?? false,
    safeCommands: cfg.get<SafeCommandEntry[]>("safeCommands") ?? []
  };
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
  "autoapproveReads",
  "autoapproveWrites",
  "autoapproveCommands",
  "safeCommands"
];

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
  const hasOverride =
    info?.globalValue !== undefined ||
    info?.workspaceValue !== undefined ||
    info?.workspaceFolderValue !== undefined;
  if (hasOverride) return;
  await cfg.update("safeCommands", getDefaultSafeCommands(), vscode.ConfigurationTarget.Global);
}

/** Overwrite the user's safe-command allow-list with the package.json defaults. */
export async function restoreDefaultSafeCommands(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(NS);
  await cfg.update("safeCommands", getDefaultSafeCommands(), vscode.ConfigurationTarget.Global);
}

/** Reset every harness setting to its default by clearing the user override. */
export async function resetAllSettings(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(NS);
  for (const key of SETTING_KEYS) {
    await cfg.update(key, undefined, vscode.ConfigurationTarget.Global);
  }
}

export function onSettingsChange(handler: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration(NS)) handler();
  });
}
