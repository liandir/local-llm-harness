import type * as vscode from "vscode";
export const featureSettingKeys = ["autoapproveCommands"];
export function readFeatureSettings(cfg: vscode.WorkspaceConfiguration) {
  return { autoapproveCommands: cfg.get<boolean>("autoapproveCommands") ?? false };
}
export async function seedFeatureSettings(): Promise<void> {}
