import * as vscode from "vscode";
import { DEFAULT_SAFE_PATTERNS } from "./defaults.js";
export const featureSettingKeys = ["safeCommandPatterns", "autoapproveSafeCommands"];
export function readFeatureSettings(cfg: vscode.WorkspaceConfiguration) {
  const configured = cfg.inspect<unknown>("safeCommandPatterns")?.globalValue;
  return {
    safeCommandPatterns: configured === undefined ? [...DEFAULT_SAFE_PATTERNS] : configured,
    autoapproveSafeCommands: cfg.inspect<boolean>("autoapproveSafeCommands")?.globalValue === true
  };
}
export async function seedFeatureSettings(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("localLlmHarness");
  if (cfg.inspect("safeCommandPatterns")?.globalValue === undefined) {
    await cfg.update("safeCommandPatterns", [...DEFAULT_SAFE_PATTERNS], vscode.ConfigurationTarget.Global);
  }
}
