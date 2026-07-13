import { describe, expect, it } from "vitest";
import { rememberFileWrite, summarizeFileChanges, type TrackedFileWrite } from "../src/chat/fileChanges.js";

describe("file change summaries", () => {
  it("summarizes one edited file", () => {
    const changes: TrackedFileWrite[] = [
      { path: "src/app.ts", previous: "const a = 1;\n", next: "const a = 1;\nconst b = 2;\n" }
    ];

    expect(summarizeFileChanges(changes)).toEqual([
      {
        path: "src/app.ts",
        added: 1,
        removed: 0,
        diffPreview: " \t1\t1\tconst a = 1;\n+\t\t2\tconst b = 2;"
      }
    ]);
  });

  it("summarizes multiple edited files", () => {
    const changes: TrackedFileWrite[] = [
      { path: "src/a.ts", previous: "old\n", next: "new\n" },
      { path: "src/b.ts", previous: "", next: "created\n" }
    ];

    expect(summarizeFileChanges(changes).map(c => ({
      path: c.path,
      added: c.added,
      removed: c.removed
    }))).toEqual([
      { path: "src/a.ts", added: 1, removed: 1 },
      { path: "src/b.ts", added: 1, removed: 0 }
    ]);
  });

  it("collapses repeated edits to the same file into the final net diff", () => {
    const changes = new Map<string, TrackedFileWrite>();
    rememberFileWrite(changes, { key: "abs-a", path: "src/a.ts", previous: "first\n", next: "second\n" });
    rememberFileWrite(changes, { key: "abs-a", path: "src/a.ts", previous: "second\n", next: "third\n" });

    expect(summarizeFileChanges(changes.values())).toEqual([
      {
        path: "src/a.ts",
        added: 1,
        removed: 1,
        diffPreview: "-\t1\t\tfirst\n+\t\t1\tthird"
      }
    ]);
  });

  it("excludes no-op writes", () => {
    const changes: TrackedFileWrite[] = [
      { path: "src/noop.ts", previous: "same\n", next: "same\n" }
    ];

    expect(summarizeFileChanges(changes)).toEqual([]);
  });

  it("retains byte-only line-ending changes in attribution", () => {
    const changes: TrackedFileWrite[] = [
      { path: "src/eol.ts", previous: "same\r\n", next: "same\n" }
    ];

    const [summary] = summarizeFileChanges(changes);
    expect({ path: summary.path, added: summary.added, removed: summary.removed }).toEqual({
      path: "src/eol.ts",
      added: 1,
      removed: 1
    });
    expect(summary.diffPreview).not.toBe("(no line changes)");
  });

  it("renders a final-newline-only summary as an exact byte change", () => {
    const [summary] = summarizeFileChanges([{
      path: "src/eof.ts",
      previous: "same",
      next: "same\n"
    }]);

    expect({ added: summary.added, removed: summary.removed }).toEqual({ added: 1, removed: 1 });
    expect(summary.diffPreview).toContain('"same"');
    expect(summary.diffPreview).toContain('"same\\n"');
    expect(summary.diffPreview).not.toBe("(no line changes)");
  });

  it("starts a separate attribution segment when byte continuity breaks", () => {
    const changes = new Map<string, TrackedFileWrite>();
    rememberFileWrite(changes, { key: "abs-a", path: "src/a.ts", previous: "one\n", next: "model-one\n" });
    rememberFileWrite(changes, { key: "abs-a", path: "src/a.ts", previous: "external\n", next: "model-two\n" });

    expect([...changes.values()]).toHaveLength(2);
    expect(summarizeFileChanges(changes.values()).map(change => ({
      previousMarker: change.diffPreview.includes("model-one") ? "first" : "second",
      added: change.added,
      removed: change.removed
    }))).toEqual([
      { previousMarker: "first", added: 1, removed: 1 },
      { previousMarker: "second", added: 1, removed: 1 }
    ]);
  });
});
