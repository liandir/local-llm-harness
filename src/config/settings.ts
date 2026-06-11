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
  autoapproveReads: boolean;
  autoapproveWrites: boolean;
  safeCommands: SafeCommandEntry[];
}

export function readSettings(): HarnessSettings {
  const cfg = vscode.workspace.getConfiguration(NS);
  return {
    endpoint: cfg.get<string>("endpoint") ?? "http://localhost:8080",
    modelFamily: (cfg.get<string>("modelFamily") as ModelFamily) ?? "gemma4",
    contextSize: cfg.get<number>("contextSize") ?? 32768,
    temperature: clampNumber(cfg.get<number>("temperature") ?? 0.7, 0, 2, 0.7),
    topK: Math.round(clampNumber(cfg.get<number>("topK") ?? 40, 0, Number.MAX_SAFE_INTEGER, 40)),
    topP: clampNumber(cfg.get<number>("topP") ?? 0.95, 0, 1, 0.95),
    autoCompact: cfg.get<boolean>("autoCompact") ?? true,
    autoCompactThresholdPercent: clampPercent(cfg.get<number>("autoCompactThresholdPercent") ?? 80),
    autoapproveReads: cfg.get<boolean>("autoapproveReads") ?? true,
    autoapproveWrites: cfg.get<boolean>("autoapproveWrites") ?? false,
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

export function onSettingsChange(handler: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration(NS)) handler();
  });
}
