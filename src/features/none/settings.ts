import type * as vscode from "vscode";
export const featureSettingKeys: string[] = [];
export function readFeatureSettings(_cfg: vscode.WorkspaceConfiguration) { return {}; }
export async function seedFeatureSettings(): Promise<void> {}
