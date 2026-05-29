import { describe, expect, it } from "vitest";
import { renderLineDiff } from "../src/chat/diffPreview.js";

describe("renderLineDiff", () => {
  it("renders exact small diffs", () => {
    expect(renderLineDiff("a\nb\n", "a\nc\n")).toBe(" \t1\t1\ta\n-\t2\t\tb\n+\t\t2\tc");
  });

  it("includes one unchanged context line around changes", () => {
    expect(renderLineDiff("a\nb\nc\nd\n", "a\nb\nx\nd\n")).toBe(" \t2\t2\tb\n-\t3\t\tc\n+\t\t3\tx\n \t4\t4\td");
  });

  it("caps large diff previews", () => {
    const previous = Array.from({ length: 1300 }, (_, i) => `old ${i}`).join("\n");
    const next = Array.from({ length: 1300 }, (_, i) => `new ${i}`).join("\n");
    const diff = renderLineDiff(previous, next);

    expect(diff).toContain("large diff preview capped");
    expect(diff).toContain("-\t1\t\told 0");
    expect(diff).toContain("+\t\t1\tnew 0");
    expect(diff.split("\n").length).toBeLessThan(260);
  });
});
