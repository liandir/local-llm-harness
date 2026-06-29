import { describe, expect, it } from "vitest";
import { lineDiffStats, renderLineDiff } from "../src/chat/diffPreview.js";

describe("renderLineDiff", () => {
  it("renders exact small diffs", () => {
    expect(renderLineDiff("a\nb\n", "a\nc\n")).toBe(" \t1\t1\ta\n-\t2\t\tb\n+\t\t2\tc");
  });

  it("includes one unchanged context line around changes", () => {
    expect(renderLineDiff("a\nb\nc\nd\n", "a\nb\nx\nd\n")).toBe(" \t2\t2\tb\n-\t3\t\tc\n+\t\t3\tx\n \t4\t4\td");
  });

  it("diffs a small edit in a large file as a real hunk, not the cap", () => {
    // ~500 lines: the old O(n·m) path bailed to the +120/-120 cap here. Myers
    // runs in O((n+m)·D), so a one-line edit is a 2-distance diff and renders as
    // a single changed line with context — no cap.
    const previous = Array.from({ length: 520 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const next = previous.replace("line 300", "line 300 CHANGED");
    const diff = renderLineDiff(next === previous ? "" : previous, next);

    expect(diff).not.toContain("large diff preview capped");
    expect(diff).toContain("-\t301\t\tline 300");
    expect(diff).toContain("+\t\t301\tline 300 CHANGED");
    // Only the changed line plus a little context, not hundreds of rows.
    expect(diff.split("\n").length).toBeLessThan(10);
  });

  it("caps only a near-total rewrite that exceeds the distance budget", () => {
    const previous = Array.from({ length: 1300 }, (_, i) => `old ${i}`).join("\n");
    const next = Array.from({ length: 1300 }, (_, i) => `new ${i}`).join("\n");
    const diff = renderLineDiff(previous, next);

    expect(diff).toContain("large diff preview capped");
    expect(diff).toContain("-\t1\t\told 0");
    expect(diff).toContain("+\t\t1\tnew 0");
    expect(diff.split("\n").length).toBeLessThan(260);
  });
});

describe("lineDiffStats", () => {
  it("reports zero for an unchanged file", () => {
    const text = Array.from({ length: 800 }, (_, i) => `line ${i}`).join("\n") + "\n";
    expect(lineDiffStats(text, text)).toEqual({ added: 0, removed: 0 });
  });

  it("counts a small exact diff", () => {
    expect(lineDiffStats("a\nb\nc\n", "a\nX\nc\n")).toEqual({ added: 1, removed: 1 });
  });

  it("counts a one-line change in a large file as +1 -1", () => {
    const previous = Array.from({ length: 700 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const next = previous.replace("line 5", "line 5 CHANGED");

    expect(lineDiffStats(previous, next)).toEqual({ added: 1, removed: 1 });
  });

  it("falls back to the multiset count for a rewrite past the distance budget", () => {
    const previous = Array.from({ length: 1300 }, (_, i) => `old ${i}`).join("\n");
    const next = Array.from({ length: 1300 }, (_, i) => `new ${i}`).join("\n");

    expect(lineDiffStats(previous, next)).toEqual({ added: 1300, removed: 1300 });
  });
});
