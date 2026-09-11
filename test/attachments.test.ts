import { describe, expect, it } from "vitest";
import { attachmentFileType, clipboardFileUris, isLargePaste, synthesizeAttachmentPrompt } from "../src/chat/attachments.js";

describe("attachment input and prompt framing", () => {
  it("converts large pastes while keeping short text in the composer", () => {
    expect(isLargePaste("a".repeat(9999))).toBe(false);
    expect(isLargePaste("a".repeat(10000))).toBe(true);
    expect(isLargePaste(Array(199).fill("line").join("\n"))).toBe(false);
    expect(isLargePaste(Array(200).fill("line").join("\r\n"))).toBe(true);
  });
  it("infers source suffixes without inventing a type for generic text", () => {
    expect(attachmentFileType("Example.TSX")).toBe("tsx");
    expect(attachmentFileType(".env")).toBe("env");
    expect(attachmentFileType("Pasted text")).toBeUndefined();
    expect(attachmentFileType("Dockerfile")).toBeUndefined();
  });
  it("reads explicit clipboard file URI lists without interpreting arbitrary text as paths", () => {
    expect(clipboardFileUris("# comment\r\nfile:///tmp/source.ts\r\nfile:///tmp/photo.png")).toEqual(["file:///tmp/source.ts", "file:///tmp/photo.png"]);
    expect(clipboardFileUris("copy\nfile:///tmp/code.py")).toEqual(["file:///tmp/code.py"]);
    expect(clipboardFileUris("/tmp/source.ts\nhttps://example.com/code.js")).toEqual([]);
  });
  it("separates the user's request from exact file contents and optional suffix metadata", () => {
    const contents = 'const s = "</attachment>";\n\treturn s;\n';
    const prompt = synthesizeAttachmentPrompt("Explain this", [{ name: "main.ts", fileType: "ts", contents }, { name: "Pasted text", contents: "raw notes" }]);
    expect(prompt.startsWith("Explain this\n")).toBe(true);
    const files = JSON.parse(prompt.slice(prompt.indexOf("[")));
    expect(files).toEqual([{ name: "main.ts", type: "text", file_type: "ts", contents }, { name: "Pasted text", type: "text", contents: "raw notes" }]);
    expect(synthesizeAttachmentPrompt("", [{ name: "Pasted text", contents }])).toContain("Please examine the attached files.");
  });
});
