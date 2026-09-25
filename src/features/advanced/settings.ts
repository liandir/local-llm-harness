import type * as vscode from "vscode";
import { readFeatureSettings as commands, featureSettingKeys as keys } from "../commands/full/settings.js";
export { seedFeatureSettings } from "../commands/full/settings.js";
export const featureSettingKeys = [...keys, "webSearchEndpoint"];
export function readFeatureSettings(cfg: vscode.WorkspaceConfiguration) {
  return { ...commands(cfg), webSearchEndpoint: cfg.inspect<string>("webSearchEndpoint")?.globalValue?.trim() ?? "" };
}
