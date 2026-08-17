import * as vscode from "vscode";
import type { ModelFamily } from "../llm/parser/index.js";
import { migrateLegacyDefaultSafeCommands, type SafeCommandEntry } from "../tools/safeCommands.js";

const NS = "localLlmHarness";

export const DEFAULT_TITLE_PROMPT =
  "Summarize the user message in 2-6 words. Output ONLY the summary.";
export const DEFAULT_COMMIT_MESSAGE_PROMPT =
  "Write a concise Git commit message. Use an imperative subject line and add a short body only when it materially improves clarity.";

export interface HarnessSettings {
  endpoint: string;
  modelFamily: ModelFamily;
  toolCallingMode: "auto" | "native" | "legacy";
  temperature: number;
  topK: number;
  topP: number;
  titlePrompt: string;
  commitMessagePrompt: string;
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
    toolCallingMode: (cfg.get<string>("toolCallingMode") as HarnessSettings["toolCallingMode"]) ?? "auto",
    // Low default on purpose: tool calls carry exact line numbers, and
    // sampling noise there directly produces mistargeted edits.
    temperature: clampNumber(cfg.get<number>("temperature") ?? 0.3, 0, 2, 0.3),
    topK: Math.round(clampNumber(cfg.get<number>("topK") ?? 40, 0, Number.MAX_SAFE_INTEGER, 40)),
    topP: clampNumber(cfg.get<number>("topP") ?? 0.95, 0, 1, 0.95),
    titlePrompt: cfg.get<string>("titlePrompt")?.trim() || DEFAULT_TITLE_PROMPT,
    commitMessagePrompt: cfg.get<string>("commitMessagePrompt")?.trim() || DEFAULT_COMMIT_MESSAGE_PROMPT,
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
  "toolCallingMode",
  "temperature",
  "topK",
  "topP",
  "titlePrompt",
  "commitMessagePrompt",
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
 * Write the effective safe commands into workspace settings if the workspace has
 * no override yet. This gives the workspace JSON editor a concrete list to edit
 * while preserving any user-level customization as the initial value.
 */
export async function seedSafeCommandsIfUnset(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(NS);
  const info = cfg.inspect<SafeCommandEntry[]>("safeCommands");
  if (info?.workspaceValue !== undefined) return;
  const effective = cfg.get<SafeCommandEntry[]>("safeCommands") ?? getDefaultSafeCommands();
  await cfg.update("safeCommands", effective, vscode.ConfigurationTarget.Workspace);
}

/** Seed effective generated-text instructions into workspace JSON for editing. */
export async function seedGeneratedPromptsIfUnset(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(NS);
  const effective = readSettings();
  for (const key of ["titlePrompt", "commitMessagePrompt"] as const) {
    if (cfg.inspect<string>(key)?.workspaceValue !== undefined) continue;
    await cfg.update(key, effective[key], vscode.ConfigurationTarget.Workspace);
  }
}

/** Overwrite the workspace safe-command allow-list with the package.json defaults. */
export async function restoreDefaultSafeCommands(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(NS);
  await cfg.update("safeCommands", getDefaultSafeCommands(), vscode.ConfigurationTarget.Workspace);
}

/** Refresh exact historical defaults copied into workspace settings. */
export async function migrateLegacySafeCommands(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(NS);
  const workspaceValue = cfg.inspect<SafeCommandEntry[]>("safeCommands")?.workspaceValue;
  if (!workspaceValue) return;
  const migrated = migrateLegacyDefaultSafeCommands(workspaceValue);
  if (migrated) {
    await cfg.update("safeCommands", migrated, vscode.ConfigurationTarget.Workspace);
  }
}

/** Reset every harness setting to its default by clearing the user override. */
export async function resetAllSettings(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(NS);
  for (const key of SETTING_KEYS) {
    await cfg.update(key, undefined, vscode.ConfigurationTarget.Global);
    await cfg.update(key, undefined, vscode.ConfigurationTarget.Workspace);
  }
}

export function onSettingsChange(handler: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration(NS)) handler();
  });
}
