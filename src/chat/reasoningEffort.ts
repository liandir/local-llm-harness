export const REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high"
] as const;

export type ReasoningEffort = typeof REASONING_EFFORTS[number];

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";
export const WORKSPACE_REASONING_EFFORT_KEY = "localLlmHarness.workspaceReasoningEffort";

/** Normalize current values and migrate the previous Intelligence choices. */
export function normalizeReasoningEffort(value: unknown): ReasoningEffort {
  if (REASONING_EFFORTS.includes(value as ReasoningEffort)) return value as ReasoningEffort;
  const legacyNames: Record<string, ReasoningEffort> = {
    instant: "none",
    capped: "medium",
    unlimited: "high",
    novice: "none",
    apprentice: "low",
    adept: "medium",
    master: "medium",
    genius: "high",
    singularity: "high",
    expert: "high"
  };
  return typeof value === "string"
    ? legacyNames[value] ?? DEFAULT_REASONING_EFFORT
    : DEFAULT_REASONING_EFFORT;
}
