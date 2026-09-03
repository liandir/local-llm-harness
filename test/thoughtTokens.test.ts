import { describe, expect, it } from "vitest";
import { estimatedThoughtTokens, thoughtTokenLabel } from "../src/ui/chatView/webview/thoughtTokens.js";

describe("thought token labels", () => {
  it("updates the live label from accumulated reasoning text", () => {
    expect(thoughtTokenLabel(true, "think")).toBe("Thinking — 2 tokens");
    expect(thoughtTokenLabel(true, "thinking through this")).toBe("Thinking — 6 tokens");
  });

  it("uses the settled Thought label without elapsed seconds", () => {
    expect(thoughtTokenLabel(false, "thinking through this")).toBe("Thought — 6 tokens");
  });

  it("handles empty and short reasoning consistently", () => {
    expect(estimatedThoughtTokens("")).toBe(0);
    expect(estimatedThoughtTokens("a")).toBe(1);
  });
});
