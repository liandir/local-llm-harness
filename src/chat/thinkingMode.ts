export const THINKING_MODES = [
  "novice",
  "apprentice",
  "adept",
  "master",
  "genius",
  "singularity"
] as const;

export type ThinkingMode = typeof THINKING_MODES[number];

export const DEFAULT_THINKING_MODE: ThinkingMode = "adept";
export const WORKSPACE_THINKING_MODE_KEY = "localLlmHarness.workspaceThinkingMode";

export function normalizeThinkingMode(value: unknown): ThinkingMode {
  if (THINKING_MODES.includes(value as ThinkingMode)) return value as ThinkingMode;
  const legacyNames: Record<string, ThinkingMode> = {
    instant: "novice",
    low: "apprentice",
    medium: "adept",
    high: "master",
    expert: "genius"
  };
  return typeof value === "string" ? legacyNames[value] ?? DEFAULT_THINKING_MODE : DEFAULT_THINKING_MODE;
}

/** Undefined deliberately omits llama.cpp's cap, leaving reasoning unlimited. */
export function thinkingBudgetTokens(mode: ThinkingMode): number | undefined {
  switch (mode) {
    case "novice": return 0;
    case "apprentice": return 2 ** 7;
    case "adept": return 2 ** 9;
    case "master": return 2 ** 11;
    case "genius": return 2 ** 13;
    case "singularity": return undefined;
  }
}
