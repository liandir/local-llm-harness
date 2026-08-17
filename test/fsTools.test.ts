import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  createFile,
  editFile,
  editRegionSnippet,
  formatFileForModel,
  glob,
  insertText,
  looksLikeNumberedReadOutput,
  readFile,
  replaceRange
} from "../src/tools/fsTools.js";

let ws: string;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), "llh-fs-"));
});

afterEach(async () => {
  await fs.rm(ws, { recursive: true, force: true });
});

describe("glob", () => {
  it("defaults malformed, zero, and negative maxResults to the standard cap", async () => {
    await writeFiles(3);

    await expect(glob({ workspaceRoot: ws }, { pattern: "*.txt", maxResults: "bad" as unknown as number }))
      .resolves.toHaveLength(3);
    await expect(glob({ workspaceRoot: ws }, { pattern: "*.txt", maxResults: 0 }))
      .resolves.toHaveLength(3);
    await expect(glob({ workspaceRoot: ws }, { pattern: "*.txt", maxResults: -1 }))
      .resolves.toHaveLength(3);
  });

  it("floors fractional maxResults and honors valid values", async () => {
    await writeFiles(5);

    await expect(glob({ workspaceRoot: ws }, { pattern: "*.txt", maxResults: 2.8 }))
      .resolves.toHaveLength(2);
    await expect(glob({ workspaceRoot: ws }, { pattern: "*.txt", maxResults: 4 }))
      .resolves.toHaveLength(4);
  });

  it("clamps huge maxResults to the hard cap", async () => {
    await writeFiles(1005);

    await expect(glob({ workspaceRoot: ws }, { pattern: "*.txt", maxResults: 5000 }))
      .resolves.toHaveLength(1000);
  });
});

describe("readFile", () => {
  it("reads the whole file with full-range metadata by default", async () => {
    const file = path.join(ws, "a.txt");
    await fs.writeFile(file, "one\ntwo\nthree\nfour\n", "utf8");

    const r = await readFile({ workspaceRoot: ws }, { path: "a.txt" });
    expect(r.content).toBe("one\ntwo\nthree\nfour\n");
    expect(r).toMatchObject({ startLine: 1, endLine: 4, totalLines: 4 });
    expect(r.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("reads an inclusive 1-based line range with real positions", async () => {
    await fs.writeFile(path.join(ws, "a.txt"), "one\ntwo\nthree\nfour\n", "utf8");

    const r = await readFile({ workspaceRoot: ws }, { path: "a.txt", startLine: 2, endLine: 3 });
    expect(r.content).toBe("two\nthree\n");
    expect(r).toMatchObject({ startLine: 2, endLine: 3, totalLines: 4 });
  });

  it("defaults an omitted bound to the file start / end and clamps endLine", async () => {
    await fs.writeFile(path.join(ws, "a.txt"), "one\ntwo\nthree\n", "utf8");

    const tail = await readFile({ workspaceRoot: ws }, { path: "a.txt", startLine: 2 });
    expect(tail.content).toBe("two\nthree\n");
    expect(tail).toMatchObject({ startLine: 2, endLine: 3 });

    const head = await readFile({ workspaceRoot: ws }, { path: "a.txt", endLine: 2 });
    expect(head.content).toBe("one\ntwo\n");
    expect(head).toMatchObject({ startLine: 1, endLine: 2 });

    const clamped = await readFile({ workspaceRoot: ws }, { path: "a.txt", startLine: 3, endLine: 99 });
    expect(clamped.content).toBe("three\n");
    expect(clamped).toMatchObject({ startLine: 3, endLine: 3, totalLines: 3 });
  });

  it("rejects ranges that start past the end of the file", async () => {
    await fs.writeFile(path.join(ws, "a.txt"), "one\ntwo\n", "utf8");

    await expect(readFile({ workspaceRoot: ws }, { path: "a.txt", startLine: 5 }))
      .rejects.toThrow(/has 2 lines.*startLine 5/);
  });

  it("rejects invalid bounds", async () => {
    await fs.writeFile(path.join(ws, "a.txt"), "one\ntwo\n", "utf8");

    await expect(readFile({ workspaceRoot: ws }, { path: "a.txt", startLine: 0 }))
      .rejects.toThrow(/startLine must be an integer/);
    await expect(readFile({ workspaceRoot: ws }, { path: "a.txt", startLine: 2, endLine: 1 }))
      .rejects.toThrow(/endLine must be an integer ≥ startLine/);
  });
});

describe("revision-based native edits", () => {
  it("creates only new files", async () => {
    await createFile({ workspaceRoot: ws }, { path: "new.txt", content: "one\n" });
    await expect(fs.readFile(path.join(ws, "new.txt"), "utf8")).resolves.toBe("one\n");
    await expect(createFile({ workspaceRoot: ws }, { path: "new.txt", content: "two\n" })).rejects.toThrow();
    await expect(fs.readFile(path.join(ws, "new.txt"), "utf8")).resolves.toBe("one\n");
  });

  it("applies ordered exact replacements atomically against the read revision", async () => {
    await fs.writeFile(path.join(ws, "a.txt"), "one\ntwo\n", "utf8");
    const read = await readFile({ workspaceRoot: ws }, { path: "a.txt" });
    const result = await editFile({ workspaceRoot: ws }, {
      path: "a.txt",
      baseRevision: read.revision,
      edits: [
        { oldText: "one", newText: "ONE" },
        { oldText: "two", newText: "TWO" }
      ]
    });
    expect(result.next).toBe("ONE\nTWO\n");
  });

  it("refuses stale or ambiguous edits without changing the file", async () => {
    const file = path.join(ws, "a.txt");
    await fs.writeFile(file, "same\nsame\n", "utf8");
    const read = await readFile({ workspaceRoot: ws }, { path: "a.txt" });
    await expect(editFile({ workspaceRoot: ws }, {
      path: "a.txt",
      baseRevision: read.revision,
      edits: [{ oldText: "same", newText: "changed" }]
    })).rejects.toThrow("ambiguous");
    await fs.writeFile(file, "new content\n", "utf8");
    await expect(editFile({ workspaceRoot: ws }, {
      path: "a.txt",
      baseRevision: read.revision,
      edits: [{ oldText: "new", newText: "old" }]
    })).rejects.toThrow("revision mismatch");
    await expect(fs.readFile(file, "utf8")).resolves.toBe("new content\n");
  });
});

describe("line edit tools", () => {
  it("inserts text before a 1-based line", async () => {
    const file = path.join(ws, "app.ts");
    await fs.writeFile(file, "const a = 1;\nconst b = 2;\n", "utf8");

    const result = await insertText(
      { workspaceRoot: ws },
      { path: "app.ts", line: 1, expectedLine: "const a = 1;", text: "/** Header */\n" }
    );

    await expect(fs.readFile(file, "utf8")).resolves.toBe("/** Header */\nconst a = 1;\nconst b = 2;\n");
    expect(result.previous).toBe("const a = 1;\nconst b = 2;\n");
    expect(result.next).toBe("/** Header */\nconst a = 1;\nconst b = 2;\n");
    expect(result.bytesWritten).toBe(Buffer.byteLength("/** Header */\n", "utf8"));
  });

  it("appends text at line_count plus one", async () => {
    const file = path.join(ws, "app.ts");
    await fs.writeFile(file, "one\ntwo", "utf8");

    await insertText(
      { workspaceRoot: ws },
      { path: "app.ts", line: 3, expectedLine: "<EOF>", text: "\nthree\n" }
    );

    await expect(fs.readFile(file, "utf8")).resolves.toBe("one\ntwo\nthree\n");
  });

  it("replaces an inclusive line range", async () => {
    const file = path.join(ws, "app.ts");
    await fs.writeFile(file, "one\ntwo\nthree\nfour\n", "utf8");

    const result = await replaceRange(
      { workspaceRoot: ws },
      { path: "app.ts", startLine: 2, endLine: 3, expectedContent: "two\nthree", content: "TWO\nTHREE\n" }
    );

    await expect(fs.readFile(file, "utf8")).resolves.toBe("one\nTWO\nTHREE\nfour\n");
    expect(result.previous).toBe("one\ntwo\nthree\nfour\n");
    expect(result.next).toBe("one\nTWO\nTHREE\nfour\n");
  });

  it("rejects line edits outside the current file range", async () => {
    await fs.writeFile(path.join(ws, "app.ts"), "one\n", "utf8");

    await expect(insertText({ workspaceRoot: ws }, { path: "app.ts", line: 4, expectedLine: "<EOF>", text: "x" }))
      .rejects.toThrow(/between 1 and 2/);
    await expect(replaceRange({ workspaceRoot: ws }, { path: "app.ts", startLine: 2, endLine: 2, expectedContent: "", content: "x\n" }))
      .rejects.toThrow(/lines 1-1/);
  });

  it("adds the missing separator when appending to a file without a trailing newline", async () => {
    const file = path.join(ws, "app.ts");
    await fs.writeFile(file, "one\ntwo", "utf8");

    const r = await insertText({ workspaceRoot: ws }, { path: "app.ts", line: 3, expectedLine: "<EOF>", text: "three\n" });

    await expect(fs.readFile(file, "utf8")).resolves.toBe("one\ntwo\nthree\n");
    expect(r.addedLeadingBreak).toBe(true);
  });

  it("does not double the separator when the appended text already starts with one", async () => {
    const file = path.join(ws, "app.ts");
    await fs.writeFile(file, "one\ntwo", "utf8");

    const r = await insertText({ workspaceRoot: ws }, { path: "app.ts", line: 3, expectedLine: "<EOF>", text: "\nthree\n" });

    await expect(fs.readFile(file, "utf8")).resolves.toBe("one\ntwo\nthree\n");
    expect(r.addedLeadingBreak).toBe(false);
  });

  it("adds a trailing newline to inserted text so the following line stays separate", async () => {
    const file = path.join(ws, "app.ts");
    await fs.writeFile(file, "one\ntwo\n", "utf8");

    const r = await insertText({ workspaceRoot: ws }, { path: "app.ts", line: 2, expectedLine: "two", text: "mid" });

    await expect(fs.readFile(file, "utf8")).resolves.toBe("one\nmid\ntwo\n");
    expect(r.addedTrailingBreak).toBe(true);
  });

  it("adds a trailing newline to replacement content when more lines follow", async () => {
    const file = path.join(ws, "app.ts");
    await fs.writeFile(file, "one\ntwo\nthree\n", "utf8");

    const r = await replaceRange({ workspaceRoot: ws }, { path: "app.ts", startLine: 2, endLine: 2, expectedContent: "two", content: "TWO" });

    await expect(fs.readFile(file, "utf8")).resolves.toBe("one\nTWO\nthree\n");
    expect(r.addedTrailingBreak).toBe(true);
  });

  it("leaves replacement content untouched when it replaces through the last line", async () => {
    const file = path.join(ws, "app.ts");
    await fs.writeFile(file, "one\ntwo", "utf8");

    const r = await replaceRange({ workspaceRoot: ws }, { path: "app.ts", startLine: 2, endLine: 2, expectedContent: "two", content: "TWO" });

    await expect(fs.readFile(file, "utf8")).resolves.toBe("one\nTWO");
    expect(r.addedTrailingBreak).toBe(false);
  });

  it("deletes lines when the replacement content is empty, without adding a newline", async () => {
    const file = path.join(ws, "app.ts");
    await fs.writeFile(file, "one\ntwo\nthree\n", "utf8");

    await replaceRange({ workspaceRoot: ws }, { path: "app.ts", startLine: 2, endLine: 2, expectedContent: "two", content: "" });

    await expect(fs.readFile(file, "utf8")).resolves.toBe("one\nthree\n");
  });

  it("refuses a replace_range whose expected old text does not match", async () => {
    const file = path.join(ws, "app.ts");
    await fs.writeFile(file, "one\ntwo\nthree\n", "utf8");

    await expect(replaceRange(
      { workspaceRoot: ws },
      { path: "app.ts", startLine: 2, endLine: 2, expectedContent: "three", content: "TWO\n" }
    )).rejects.toThrow(/precondition failed.*Nothing was written/);
    await expect(fs.readFile(file, "utf8")).resolves.toBe("one\ntwo\nthree\n");
  });

  it("explains an extra final newline in replace_range expectedContent", async () => {
    const file = path.join(ws, "app.ts");
    await fs.writeFile(file, "one\ntwo\nthree\n", "utf8");

    await expect(replaceRange(
      { workspaceRoot: ws },
      { path: "app.ts", startLine: 2, endLine: 3, expectedContent: "two\nthree\n", content: "TWO\n" }
    )).rejects.toThrow(/one extra trailing newline.*omit the final line break/);
    await expect(fs.readFile(file, "utf8")).resolves.toBe("one\ntwo\nthree\n");
  });

  it("explains literal backslash-n separators in replace_range expectedContent", async () => {
    const file = path.join(ws, "app.ts");
    await fs.writeFile(file, "one\ntwo\nthree\n", "utf8");

    await expect(replaceRange(
      { workspaceRoot: ws },
      { path: "app.ts", startLine: 2, endLine: 3, expectedContent: "two\\nthree", content: "TWO\n" }
    )).rejects.toThrow(/literal backslash-n line separators/);
  });

  it("explains copied read_file prefixes in replace_range expectedContent", async () => {
    const file = path.join(ws, "app.ts");
    await fs.writeFile(file, "one\ntwo\nthree\n", "utf8");

    await expect(replaceRange(
      { workspaceRoot: ws },
      { path: "app.ts", startLine: 2, endLine: 3, expectedContent: "2\ttwo\n3\tthree", content: "TWO\n" }
    )).rejects.toThrow(/display-only line-number and tab prefixes/);
  });

  it("reports line counts and the first differing character for a general range mismatch", async () => {
    const file = path.join(ws, "app.ts");
    await fs.writeFile(file, "one\ntwo\nthree\n", "utf8");

    await expect(replaceRange(
      { workspaceRoot: ws },
      { path: "app.ts", startLine: 2, endLine: 3, expectedContent: "two\nTHREE\nextra", content: "TWO\n" }
    )).rejects.toThrow(/expectedContent has 3 lines; the target has 2.*line 2, column 1.*expectedContent has "T".*target has "t"/);
  });

  it("refuses insert_text when the target line is not the expected line", async () => {
    const file = path.join(ws, "app.ts");
    await fs.writeFile(file, "one\ntwo\n", "utf8");

    await expect(insertText(
      { workspaceRoot: ws },
      { path: "app.ts", line: 1, expectedLine: "two", text: "zero\n" }
    )).rejects.toThrow(/precondition failed.*Nothing was written/);
    await expect(fs.readFile(file, "utf8")).resolves.toBe("one\ntwo\n");
  });

  it("explains when insert_text expectedLine dropped source indentation", async () => {
    const file = path.join(ws, "app.ts");
    await fs.writeFile(file, "export function run() {\n  const ready = true;\n}\n", "utf8");

    await expect(insertText(
      { workspaceRoot: ws },
      { path: "app.ts", line: 2, expectedLine: "const ready = true;", text: "  prepare();\n" }
    )).rejects.toThrow(/non-whitespace text matches.*no leading whitespace.*2 spaces.*Preserve every space or tab/s);
    await expect(fs.readFile(file, "utf8")).resolves.toBe("export function run() {\n  const ready = true;\n}\n");
  });

  it("explains when replace_range expectedContent dropped source indentation", async () => {
    const file = path.join(ws, "app.ts");
    const original = "export function run() {\n  const ready = true;\n  return ready;\n}\n";
    await fs.writeFile(file, original, "utf8");

    await expect(replaceRange(
      { workspaceRoot: ws },
      {
        path: "app.ts",
        startLine: 2,
        endLine: 3,
        expectedContent: "const ready = true;\nreturn ready;",
        content: "  return true;\n"
      }
    )).rejects.toThrow(/non-whitespace text matches.*leading indentation differs.*Preserve every space or tab/s);
    await expect(fs.readFile(file, "utf8")).resolves.toBe(original);
  });
});

describe("editRegionSnippet", () => {
  it("shows the edited region with real line numbers and context", () => {
    const next = ["a", "b", "c", "NEW1", "NEW2", "d", "e", "f", "g"].join("\n") + "\n";
    const snippet = editRegionSnippet(next, 4, 2);
    expect(snippet).toBe("1\ta\n2\tb\n3\tc\n4\tNEW1\n5\tNEW2\n6\td\n7\te\n8\tf");
  });

  it("clamps context to the file bounds", () => {
    const snippet = editRegionSnippet("a\nb\n", 1, 1);
    expect(snippet).toBe("1\ta\n2\tb");
  });

  it("shows the seam around a pure deletion", () => {
    const next = ["a", "b", "c", "d"].join("\n") + "\n";
    const snippet = editRegionSnippet(next, 2, 0);
    expect(snippet).toBe("1\ta\n2\tb\n3\tc\n4\td");
  });

  it("middle-elides very large regions with real numbers on both parts", () => {
    const next = Array.from({ length: 100 }, (_, i) => `L${i + 1}`).join("\n") + "\n";
    const snippet = editRegionSnippet(next, 10, 60);
    const lines = snippet.split("\n");
    expect(lines[0].trim()).toBe("7\tL7");
    expect(snippet).toContain("not shown");
    expect(lines[lines.length - 1]).toBe("72\tL72");
    expect(lines.length).toBeLessThanOrEqual(40);
  });

  it("reports an emptied file", () => {
    expect(editRegionSnippet("", 1, 0)).toBe("(the file is now empty)");
  });
});

describe("looksLikeNumberedReadOutput", () => {
  it("flags sequential numbered lines whose first number matches the edit target", () => {
    expect(looksLikeNumberedReadOutput("12\tconst a = 1;\n13\tconst b = 2;\n", 12)).toBe(true);
  });

  it("flags space-padded numbering even without an expected start", () => {
    expect(looksLikeNumberedReadOutput(" 9\tnine\n10\tten\n")).toBe(true);
  });

  it("does not flag plain code", () => {
    expect(looksLikeNumberedReadOutput("const a = 1;\nconst b = 2;\n", 1)).toBe(false);
  });

  it("does not flag tab-separated data whose ids don't match the target line", () => {
    expect(looksLikeNumberedReadOutput("1\talice\n2\tbob\n3\tcarol\n", 40)).toBe(false);
    expect(looksLikeNumberedReadOutput("1\talice\n2\tbob\n3\tcarol\n")).toBe(false);
  });

  it("does not flag non-sequential numbers or a single line", () => {
    expect(looksLikeNumberedReadOutput("12\ta\n14\tb\n", 12)).toBe(false);
    expect(looksLikeNumberedReadOutput("12\ta\n", 12)).toBe(false);
  });
});

describe("formatFileForModel", () => {
  it("prefixes each line with its 1-based number and a tab", () => {
    expect(formatFileForModel("const a = 1;\nconst b = 2;\n")).toBe(
      "1\tconst a = 1;\n2\tconst b = 2;"
    );
  });

  it("numbers a file with no trailing newline the same way", () => {
    expect(formatFileForModel("one\ntwo")).toBe("1\tone\n2\ttwo");
  });

  it("keeps interior blank lines as numbered empty lines", () => {
    expect(formatFileForModel("a\n\nb\n")).toBe("1\ta\n2\t\n3\tb");
  });

  it("right-aligns numbers to the widest line number", () => {
    const content = Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join("\n") + "\n";
    const lines = formatFileForModel(content).split("\n");
    expect(lines[0]).toBe(" 1\tL1");
    expect(lines[9]).toBe("10\tL10");
  });

  it("returns empty string for an empty file", () => {
    expect(formatFileForModel("")).toBe("");
  });

  it("numbers a range slice with its real file positions", () => {
    expect(formatFileForModel("two\nthree\n", 2)).toBe("2\ttwo\n3\tthree");
  });

  it("pads range numbering to the width of the last shown line", () => {
    expect(formatFileForModel("nine\nten\n", 9)).toBe(" 9\tnine\n10\tten");
  });

  it("numbers lines so replace_range targets the line the model sees", async () => {
    const file = path.join(ws, "app.ts");
    await fs.writeFile(file, "one\ntwo\nthree\nfour\n", "utf8");

    // The model reads this and sees "2\ttwo" / "3\tthree".
    expect(formatFileForModel("one\ntwo\nthree\nfour\n")).toContain("2\ttwo");

    // Passing those same numbers back edits exactly those lines.
    await replaceRange(
      { workspaceRoot: ws },
      { path: "app.ts", startLine: 2, endLine: 3, expectedContent: "two\nthree", content: "TWO\nTHREE\n" }
    );
    await expect(fs.readFile(file, "utf8")).resolves.toBe("one\nTWO\nTHREE\nfour\n");
  });

  it("range reads round-trip into replace_range edits on the same lines", async () => {
    const file = path.join(ws, "app.ts");
    await fs.writeFile(file, "one\ntwo\nthree\nfour\n", "utf8");

    // The model reads lines 2-3 and sees their REAL numbers...
    const r = await readFile({ workspaceRoot: ws }, { path: "app.ts", startLine: 2, endLine: 3 });
    expect(formatFileForModel(r.content, r.startLine)).toBe("2\ttwo\n3\tthree");

    // ...and passing those numbers back edits exactly those lines.
    await replaceRange(
      { workspaceRoot: ws },
      { path: "app.ts", startLine: r.startLine, endLine: r.endLine, expectedContent: "two\nthree", content: "TWO\nTHREE\n" }
    );
    await expect(fs.readFile(file, "utf8")).resolves.toBe("one\nTWO\nTHREE\nfour\n");
  });
});

async function writeFiles(count: number): Promise<void> {
  await Promise.all(Array.from({ length: count }, (_, i) =>
    fs.writeFile(path.join(ws, `${String(i).padStart(4, "0")}.txt`), "x", "utf8")
  ));
}
