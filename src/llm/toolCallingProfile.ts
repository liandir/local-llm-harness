export type CompatibilityFamily = "gemma4" | "qwen3" | "muse-glimmer" | "gpt-oss";

export type ToolCallingProfile =
  | "native"
  | "compat-gemma4"
  | "compat-qwen3"
  | "compat-muse-glimmer"
  | "compat-gpt-oss";

const PROFILES = new Set<ToolCallingProfile>([
  "native",
  "compat-gemma4",
  "compat-qwen3",
  "compat-muse-glimmer",
  "compat-gpt-oss"
]);

/** Normalize current profiles and the former mode + family setting pair. */
export function normalizeToolCallingProfile(value: unknown, legacyFamily?: unknown): ToolCallingProfile {
  if (PROFILES.has(value as ToolCallingProfile)) return value as ToolCallingProfile;
  if (value === "native") return "native";
  const family = legacyFamily === "qwen3" ? "qwen3" : "gemma4";
  return `compat-${family}`;
}

export function compatibilityFamily(profile: ToolCallingProfile): CompatibilityFamily | undefined {
  switch (profile) {
    case "native": return undefined;
    case "compat-gemma4": return "gemma4";
    case "compat-qwen3": return "qwen3";
    case "compat-muse-glimmer": return "muse-glimmer";
    case "compat-gpt-oss": return "gpt-oss";
  }
}

export function supportsLegacyToolFallback(
  family: CompatibilityFamily | undefined
): family is Exclude<CompatibilityFamily, "muse-glimmer"> {
  return family === "gemma4" || family === "qwen3" || family === "gpt-oss";
}

export function compatibilityFamilyLabel(family: CompatibilityFamily): string {
  switch (family) {
    case "gemma4": return "Gemma 4";
    case "qwen3": return "Qwen 3";
    case "muse-glimmer": return "Muse Glimmer";
    case "gpt-oss": return "GPT-OSS";
  }
}
