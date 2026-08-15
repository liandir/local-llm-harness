import { describe, expect, it } from "vitest";
import { activeToolLabel, finishedWorkSummary } from "../src/ui/chatView/webview/workLabels.js";

describe("work session labels", () => {
  it("summarizes one or two settled activity types in chronological order", () => {
    expect(finishedWorkSummary([
      { kind: "tool", toolName: "read_file", resource: "a.ts" },
      { kind: "tool", toolName: "read_file", resource: "b.ts" },
      { kind: "thought" }
    ])).toBe("Read Files, Thought");

    expect(finishedWorkSummary([
      { kind: "tool", toolName: "list_dir", resource: "src" },
      { kind: "tool", toolName: "replace_range", resource: "src/a.ts" },
      { kind: "tool", toolName: "insert_text", resource: "src/b.ts" }
    ])).toBe("Read Directory, Edited Files");
  });

  it("uses singular labels when repeated calls target the same resource", () => {
    expect(finishedWorkSummary([
      { kind: "tool", toolName: "read_file", resource: "a.ts" },
      { kind: "tool", toolName: "read_file", resource: "a.ts" }
    ])).toBe("Read File");
  });

  it("falls back when a session contains more than two activity types", () => {
    expect(finishedWorkSummary([
      { kind: "thought" },
      { kind: "tool", toolName: "read_file", resource: "a.ts" },
      { kind: "tool", toolName: "run_command" }
    ])).toBeUndefined();
  });

  it("uses present-progress tense for active tool labels", () => {
    expect(activeToolLabel("read_file")).toBe("Reading File");
    expect(activeToolLabel("list_dir")).toBe("Reading Directory");
    expect(activeToolLabel("replace_range")).toBe("Editing File");
  });
});
