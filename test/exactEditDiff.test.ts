import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ExactEditDiffLimitError,
  renderExactEditDiff
} from "../src/chat/exactEditDiff.js";

describe("exact edit approval diffs", () => {
  it("distinguishes a missing final newline from a final LF", () => {
    const diff = renderExactEditDiff("tail", "tail\n");

    expect(diff.text).toContain("\"tail\"");
    expect(diff.text).toContain("\"tail\\n\"");
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.previousSha256).not.toBe(diff.nextSha256);
  });

  it("makes LF, CRLF, and lone-CR terminators visible", () => {
    const diff = renderExactEditDiff("one\r\ntwo\r", "one\ntwo\n");

    expect(diff.text).toContain("\"one\\r\\n\"");
    expect(diff.text).toContain("\"two\\r\"");
    expect(diff.text).toContain("\"one\\n\"");
    expect(diff.text).toContain("\"two\\n\"");
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(2);
  });

  it("renders controls, format characters, tabs, and BOMs as explicit escapes", () => {
    const next = `\ufeffvalue\t\0\u0085\u202e\u2066\r\n`;
    const diff = renderExactEditDiff("value\n", next);

    expect(diff.text).toContain("\\ufeff");
    expect(diff.text).toContain("\\t");
    expect(diff.text).toContain("\\u0000");
    expect(diff.text).toContain("\\u0085");
    expect(diff.text).toContain("\\u202e");
    expect(diff.text).toContain("\\u2066");
    expect(diff.text).toContain("\\r\\n");
    expect(diff.text).not.toContain("\0");
    expect(diff.text).not.toContain("\u202e");
    expect(diff.text).not.toContain("\u2066");
  });

  it("uses a complete whole-text fallback for a high-distance edit", () => {
    const count = 1_200;
    const previous = Array.from({ length: count }, (_, index) => `old-${index.toString().padStart(4, "0")}`)
      .join("\n") + "\n";
    const next = Array.from({ length: count }, (_, index) => `new-${index.toString().padStart(4, "0")}`)
      .join("\n") + "\n";

    const diff = renderExactEditDiff(previous, next);

    for (const sentinel of ["old-0000", "old-0600", "old-1199", "new-0000", "new-0600", "new-1199"]) {
      expect(diff.text).toContain(sentinel);
    }
    expect(diff.text).not.toContain("large diff preview capped");
    expect(diff.text).not.toContain("...\t\t\t(unchanged exact segments omitted)");
    expect(diff.added).toBe(count);
    expect(diff.removed).toBe(count);
  });

  it("keeps exact segment counts when line density exceeds the row limit", () => {
    const count = 200_001;
    const previous = "a\n".repeat(count);
    const next = "b\n".repeat(count);

    const diff = renderExactEditDiff(previous, next);

    expect(diff.text).toContain('"a\\n');
    expect(diff.text).toContain('"b\\n');
    expect(diff.removed).toBe(count);
    expect(diff.added).toBe(count);
  });

  it("fails closed when the complete artifact exceeds its byte budget", () => {
    let thrown: unknown;
    try {
      renderExactEditDiff("before\n", "after\n", 64);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ExactEditDiffLimitError);
    expect(thrown).toMatchObject({ maxBytes: 64 });
  });

  it("freezes the artifact and hashes its exact serialized text", () => {
    const diff = renderExactEditDiff("before\n", "after\n");
    const expectedHash = createHash("sha256").update(Buffer.from(diff.text, "utf8")).digest("hex");

    expect(Object.isFrozen(diff)).toBe(true);
    expect(diff.artifactSha256).toBe(expectedHash);
    expect(diff.previousBytes).toBe(Buffer.byteLength("before\n", "utf8"));
    expect(diff.nextBytes).toBe(Buffer.byteLength("after\n", "utf8"));
  });

  it("changes the artifact commitment when either exact side changes", () => {
    const baseline = renderExactEditDiff("before\n", "after\n");
    const changedBase = renderExactEditDiff("BEFORE\n", "after\n");
    const changedNext = renderExactEditDiff("before\n", "AFTER\n");

    expect(changedBase.artifactSha256).not.toBe(baseline.artifactSha256);
    expect(changedBase.previousSha256).not.toBe(baseline.previousSha256);
    expect(changedNext.artifactSha256).not.toBe(baseline.artifactSha256);
    expect(changedNext.nextSha256).not.toBe(baseline.nextSha256);
  });
});
