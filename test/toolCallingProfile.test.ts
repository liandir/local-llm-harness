import { describe, expect, it } from "vitest";
import {
  compatibilityFamily,
  normalizeToolCallingProfile
} from "../src/llm/toolCallingProfile.js";

describe("tool calling profiles", () => {
  it("keeps every current profile unchanged", () => {
    for (const profile of ["native", "compat-gemma4", "compat-qwen3", "compat-muse-glimmer"] as const) {
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
  });
});
