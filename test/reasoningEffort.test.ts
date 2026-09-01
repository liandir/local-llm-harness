import { describe, expect, it } from "vitest";
import {
  DEFAULT_REASONING_EFFORT,
  availableReasoningEffort,
  normalizeReasoningEffort,
  normalizeReasoningEfforts,
  reasoningEffortChoices,
  reasoningRequestOverrides
} from "../src/chat/reasoningEffort.js";

describe("reasoning effort migration", () => {
  it.each([
    ["instant", "none"],
    ["capped", "effort:medium"],
    ["unlimited", "effort:high"]
  ] as const)("maps legacy %s to %s", (legacy, expected) => {
    expect(normalizeReasoningEffort(legacy)).toBe(expected);
  });

  it("uses Default for missing or unknown values", () => {
    expect(normalizeReasoningEffort(undefined)).toBe(DEFAULT_REASONING_EFFORT);
    expect(normalizeReasoningEffort("unsupported")).toBe(DEFAULT_REASONING_EFFORT);
  });

  it("sanitizes configurable choices and reserves the built-in labels", () => {
    expect(normalizeReasoningEfforts({
      " Quick ": " minimal ",
      None: "none",
      Default: "server-default",
      Duplicate: "minimal",
      Empty: ""
    })).toEqual({ Quick: "minimal" });
  });

  it("builds None and Default ahead of configured choices", () => {
    expect(reasoningEffortChoices({ Fast: "low", Deep: "xhigh" })).toEqual([
      { label: "None", effort: "none" },
      { label: "Default", effort: "default" },
      { label: "Fast", effort: "effort:low" },
      { label: "Deep", effort: "effort:xhigh" }
    ]);
  });

  it("maps built-in and configured selections to request overrides", () => {
    const efforts = { Fast: "low", Deep: "xhigh" };
    expect(reasoningRequestOverrides("none", efforts)).toEqual({
      chat_template_kwargs: { enable_thinking: false }
    });
    expect(reasoningRequestOverrides("default", efforts)).toEqual({});
    expect(reasoningRequestOverrides("effort:xhigh", efforts)).toEqual({ reasoning_effort: "xhigh" });
    expect(reasoningRequestOverrides("effort:removed", efforts)).toEqual({});
    expect(availableReasoningEffort("effort:removed", efforts)).toBe("default");
  });
});
