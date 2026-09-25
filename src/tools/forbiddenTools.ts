import { ALL_TOOLS } from "./toolDefinitions.js";
export const ALLOWED_TOOL_NAMES = new Set(ALL_TOOLS.map(({ name }) => name));
export function classifyToolName(name: string): "allowed" | "unknown" {
  return ALLOWED_TOOL_NAMES.has(name) ? "allowed" : "unknown";
}
