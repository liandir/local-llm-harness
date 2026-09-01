import { describe, expect, it } from "vitest";
import {
  DEFAULT_REASONING_EFFORT,
  normalizeReasoningEffort
} from "../src/chat/reasoningEffort.js";

describe("reasoning effort migration", () => {
  it.each([
    ["instant", "none"],
    ["capped", "medium"],
    ["unlimited", "high"]
  ] as const)("maps legacy %s to %s", (legacy, expected) => {
    expect(normalizeReasoningEffort(legacy)).toBe(expected);
  });

  it("uses Medium for missing or unknown values", () => {
    expect(normalizeReasoningEffort(undefined)).toBe(DEFAULT_REASONING_EFFORT);
    expect(normalizeReasoningEffort("unsupported")).toBe(DEFAULT_REASONING_EFFORT);
  });
});
