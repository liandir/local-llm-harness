import * as vscode from "vscode";
import { normalizeToolCallingProfile, type ToolCallingProfile } from "../llm/toolCallingProfile.js";
import { migrateLegacyDefaultSafeCommands, type SafeCommandEntry } from "../tools/safeCommands.js";
import { normalizeReasoningEfforts, type ReasoningEfforts } from "../chat/reasoningEffort.js";

const NS = "localLlmHarness";

export const DEFAULT_TITLE_PROMPT =
  "Summarize the user message in 2-6 words. Output ONLY the summary.";
export const DEFAULT_COMMIT_MESSAGE_PROMPT =
  "Write a concise Git commit message. Use an imperative subject line and add a short body only when it materially improves clarity.";

export interface HarnessSettings {
  endpoint: string;
  model: string;
  toolCallingMode: ToolCallingProfile;
  temperature: number;
  topK: number;
  topP: number;
  reasoningBudget: number;
  reasoningEfforts: ReasoningEfforts;
  titlePrompt: string;
  commitMessagePrompt: string;
  showThinking: boolean;
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
  const legacyFamily = cfg.get<string>("modelFamily");
  const explicitProfile = explicitConfigurationValue(cfg, "toolCallingMode");
  const explicitLegacyFamily = explicitConfigurationValue(cfg, "modelFamily");
  const explicitReasoningBudget = explicitConfigurationValue(cfg, "reasoningBudget");
  const legacyCappedTokens = explicitConfigurationValue(cfg, "cappedThinkingTokens");
  return {
    endpoint: cfg.get<string>("endpoint") ?? "http://localhost:8080/v1",
    model: cfg.get<string>("model")?.trim() || "local",
    toolCallingMode: normalizeToolCallingProfile(
      explicitProfile ?? (explicitLegacyFamily === undefined ? cfg.get<string>("toolCallingMode") : "auto"),
      legacyFamily
    ),
    // Low default on purpose: tool calls carry exact line numbers, and
    // sampling noise there directly produces mistargeted edits.
    temperature: clampNumber(cfg.get<number>("temperature") ?? 0.3, 0, 2, 0.3),
    topK: Math.round(clampNumber(cfg.get<number>("topK") ?? 40, 0, Number.MAX_SAFE_INTEGER, 40)),
    topP: clampNumber(cfg.get<number>("topP") ?? 0.95, 0, 1, 0.95),
    reasoningBudget: Math.round(clampNumber(
      Number(explicitReasoningBudget ?? legacyCappedTokens ?? cfg.get<number>("reasoningBudget") ?? 16384),
      -1,
      Number.MAX_SAFE_INTEGER,
      16384
    )),
    reasoningEfforts: normalizeReasoningEfforts(cfg.get<unknown>("reasoningEfforts")),
    titlePrompt: cfg.get<string>("titlePrompt")?.trim() || DEFAULT_TITLE_PROMPT,
    commitMessagePrompt: cfg.get<string>("commitMessagePrompt")?.trim() || DEFAULT_COMMIT_MESSAGE_PROMPT,
    showThinking: cfg.get<boolean>("showThinking") ?? true,
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

function explicitConfigurationValue(cfg: vscode.WorkspaceConfiguration, key: string): unknown {
  if (typeof cfg.inspect !== "function") return undefined;
  const inspect = cfg.inspect<unknown>(key);
  return inspect?.workspaceFolderLanguageValue
    ?? inspect?.workspaceFolderValue
    ?? inspect?.workspaceLanguageValue
    ?? inspect?.workspaceValue
    ?? inspect?.globalLanguageValue
    ?? inspect?.globalValue;
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
  "model",
  "toolCallingMode",
  "temperature",
  "topK",
  "topP",
  "reasoningBudget",
  "reasoningEfforts",
  "titlePrompt",
  "commitMessagePrompt",
  "showThinking",
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

/** The safe-command auto-approval list contributed as the package.json default. */
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

/** Restore both generated-text instruction settings to their defaults. */
export async function restoreDefaultGeneratedPrompts(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(NS);
  await cfg.update("titlePrompt", DEFAULT_TITLE_PROMPT, vscode.ConfigurationTarget.Workspace);
  await cfg.update("commitMessagePrompt", DEFAULT_COMMIT_MESSAGE_PROMPT, vscode.ConfigurationTarget.Workspace);
}

/** Overwrite the workspace safe-command auto-approval list with the defaults. */
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
  // Removed in the unified-profile migration; clear stale overrides too.
  await cfg.update("modelFamily", undefined, vscode.ConfigurationTarget.Global);
  await cfg.update("modelFamily", undefined, vscode.ConfigurationTarget.Workspace);
  await cfg.update("cappedThinkingTokens", undefined, vscode.ConfigurationTarget.Global);
  await cfg.update("cappedThinkingTokens", undefined, vscode.ConfigurationTarget.Workspace);
}

export function onSettingsChange(handler: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration(NS)) handler();
  });
}
