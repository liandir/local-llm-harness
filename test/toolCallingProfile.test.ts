import { describe, expect, it } from "vitest";
import {
  compatibilityFamilyLabel,
  compatibilityFamily,
  normalizeToolCallingProfile,
  supportsLegacyToolFallback
} from "../src/llm/toolCallingProfile.js";

describe("tool calling profiles", () => {
  it("keeps every current profile unchanged", () => {
    for (const profile of ["native", "compat-gemma4", "compat-qwen3", "compat-muse-glimmer", "compat-gpt-oss"] as const) {
      expect(normalizeToolCallingProfile(profile)).toBe(profile);
    }
  });

  it("maps former auto and legacy modes through their family", () => {
    expect(normalizeToolCallingProfile("auto", "gemma4")).toBe("compat-gemma4");
    expect(normalizeToolCallingProfile("legacy", "qwen3")).toBe("compat-qwen3");
    expect(normalizeToolCallingProfile(undefined, "qwen3")).toBe("compat-qwen3");
    expect(normalizeToolCallingProfile("native", "qwen3")).toBe("native");
  });

  it("returns a recovery family only for compatibility profiles", () => {
    expect(compatibilityFamily("native")).toBeUndefined();
    expect(compatibilityFamily("compat-gemma4")).toBe("gemma4");
    expect(compatibilityFamily("compat-qwen3")).toBe("qwen3");
    expect(compatibilityFamily("compat-muse-glimmer")).toBe("muse-glimmer");
    expect(compatibilityFamily("compat-gpt-oss")).toBe("gpt-oss");
  });

  it("identifies and labels only families with reliable text fallbacks", () => {
    expect(supportsLegacyToolFallback("gemma4")).toBe(true);
    expect(supportsLegacyToolFallback("qwen3")).toBe(true);
    expect(supportsLegacyToolFallback("gpt-oss")).toBe(true);
    expect(supportsLegacyToolFallback("muse-glimmer")).toBe(false);
    expect(supportsLegacyToolFallback(undefined)).toBe(false);
    expect(compatibilityFamilyLabel("gpt-oss")).toBe("GPT-OSS");
  });
});
