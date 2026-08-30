export const THINKING_MODES = [
  "instant",
  "capped",
  "unlimited"
] as const;

export type ThinkingMode = typeof THINKING_MODES[number];

export const DEFAULT_THINKING_MODE: ThinkingMode = "capped";
export const WORKSPACE_THINKING_MODE_KEY = "localLlmHarness.workspaceThinkingMode";

export function normalizeThinkingMode(value: unknown): ThinkingMode {
  if (THINKING_MODES.includes(value as ThinkingMode)) return value as ThinkingMode;
  const legacyNames: Record<string, ThinkingMode> = {
    novice: "instant",
    apprentice: "capped",
    adept: "capped",
    master: "capped",
    genius: "capped",
    singularity: "unlimited",
    low: "capped",
    medium: "capped",
    high: "capped",
    expert: "capped"
  };
  return typeof value === "string" ? legacyNames[value] ?? DEFAULT_THINKING_MODE : DEFAULT_THINKING_MODE;
}

/** Undefined deliberately omits llama.cpp's cap, leaving reasoning unlimited. */
export function thinkingBudgetTokens(mode: ThinkingMode, cappedTokens: number): number | undefined {
  switch (mode) {
    case "instant": return 0;
    case "capped": return cappedTokens;
    case "unlimited": return undefined;
  }
}
