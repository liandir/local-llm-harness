import * as vscode from "vscode";
import type { ModelFamily } from "../llm/parser/index.js";
import type { SafeCommandEntry } from "../tools/safeCommands.js";

const NS = "localLlmHarness";

export interface HarnessSettings {
  endpoint: string;
  modelFamily: ModelFamily;
  contextSize: number;
  autoCompact: boolean;
  autoCompactThreshold: number;
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
    autoCompact: cfg.get<boolean>("autoCompact") ?? true,
    autoCompactThreshold: cfg.get<number>("autoCompactThreshold") ?? 28000,
    autoapproveReads: cfg.get<boolean>("autoapproveReads") ?? true,
    autoapproveWrites: cfg.get<boolean>("autoapproveWrites") ?? false,
    safeCommands: cfg.get<SafeCommandEntry[]>("safeCommands") ?? []
  };
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
