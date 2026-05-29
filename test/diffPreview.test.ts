import { describe, expect, it } from "vitest";
import { renderLineDiff } from "../src/chat/diffPreview.js";

describe("renderLineDiff", () => {
  it("renders exact small diffs", () => {
    expect(renderLineDiff("a\nb\n", "a\nc\n")).toBe("- b\n+ c");
  });

  it("caps large diff previews", () => {
    const previous = Array.from({ length: 1300 }, (_, i) => `old ${i}`).join("\n");
    const next = Array.from({ length: 1300 }, (_, i) => `new ${i}`).join("\n");
    const diff = renderLineDiff(previous, next);

    expect(diff).toContain("large diff preview capped");
    expect(diff).toContain("- old 0");
    expect(diff).toContain("+ new 0");
    expect(diff.split("\n").length).toBeLessThan(260);
  });
});
