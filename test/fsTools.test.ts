import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { formatFileForModel, glob, insertText, replaceRange } from "../src/tools/fsTools.js";

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

describe("line edit tools", () => {
  it("inserts text before a 1-based line", async () => {
    const file = path.join(ws, "app.ts");
    await fs.writeFile(file, "const a = 1;\nconst b = 2;\n", "utf8");

    const result = await insertText(
      { workspaceRoot: ws },
      { path: "app.ts", line: 1, text: "/** Header */\n" }
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
      { path: "app.ts", line: 3, text: "\nthree\n" }
    );

    await expect(fs.readFile(file, "utf8")).resolves.toBe("one\ntwo\nthree\n");
  });

  it("replaces an inclusive line range", async () => {
    const file = path.join(ws, "app.ts");
    await fs.writeFile(file, "one\ntwo\nthree\nfour\n", "utf8");

    const result = await replaceRange(
      { workspaceRoot: ws },
      { path: "app.ts", startLine: 2, endLine: 3, content: "TWO\nTHREE\n" }
    );

    await expect(fs.readFile(file, "utf8")).resolves.toBe("one\nTWO\nTHREE\nfour\n");
    expect(result.previous).toBe("one\ntwo\nthree\nfour\n");
    expect(result.next).toBe("one\nTWO\nTHREE\nfour\n");
  });

  it("rejects line edits outside the current file range", async () => {
    await fs.writeFile(path.join(ws, "app.ts"), "one\n", "utf8");

    await expect(insertText({ workspaceRoot: ws }, { path: "app.ts", line: 4, text: "x" }))
      .rejects.toThrow(/between 1 and 2/);
    await expect(replaceRange({ workspaceRoot: ws }, { path: "app.ts", startLine: 2, endLine: 2, content: "x\n" }))
      .rejects.toThrow(/lines 1-1/);
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

  it("numbers lines so replace_range targets the line the model sees", async () => {
    const file = path.join(ws, "app.ts");
    await fs.writeFile(file, "one\ntwo\nthree\nfour\n", "utf8");

    // The model reads this and sees "2\ttwo" / "3\tthree".
    expect(formatFileForModel("one\ntwo\nthree\nfour\n")).toContain("2\ttwo");

    // Passing those same numbers back edits exactly those lines.
    await replaceRange(
      { workspaceRoot: ws },
      { path: "app.ts", startLine: 2, endLine: 3, content: "TWO\nTHREE\n" }
    );
    await expect(fs.readFile(file, "utf8")).resolves.toBe("one\nTWO\nTHREE\nfour\n");
  });
});

async function writeFiles(count: number): Promise<void> {
  await Promise.all(Array.from({ length: count }, (_, i) =>
    fs.writeFile(path.join(ws, `${String(i).padStart(4, "0")}.txt`), "x", "utf8")
  ));
}
