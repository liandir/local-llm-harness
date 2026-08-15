import { describe, expect, it } from "vitest";
import { activeToolLabel, finishedWorkSummary } from "../src/ui/chatView/webview/workLabels.js";

describe("work session labels", () => {
  it("summarizes one or two settled activity types in chronological order", () => {
    expect(finishedWorkSummary([
      { kind: "tool", toolName: "read_file", resource: "a.ts" },
      { kind: "tool", toolName: "read_file", resource: "b.ts" },
      { kind: "thought" }
    ])).toBe("Read files, thought");

    expect(finishedWorkSummary([
      { kind: "tool", toolName: "list_dir", resource: "src" },
      { kind: "tool", toolName: "replace_range", resource: "src/a.ts" },
      { kind: "tool", toolName: "insert_text", resource: "src/b.ts" }
    ])).toBe("Read directory, edited files");
  });

  it("uses singular labels when repeated calls target the same resource", () => {
    expect(finishedWorkSummary([
      { kind: "tool", toolName: "read_file", resource: "a.ts" },
      { kind: "tool", toolName: "read_file", resource: "a.ts" }
    ])).toBe("Read file");
  });

  it("omits thought and shows up to three concrete types in a busy session", () => {
    expect(finishedWorkSummary([
      { kind: "thought" },
      { kind: "tool", toolName: "read_file", resource: "a.ts" },
      { kind: "tool", toolName: "run_command" },
      { kind: "tool", toolName: "replace_range", resource: "b.ts" },
      { kind: "tool", toolName: "list_dir", resource: "src" }
    ])).toBe("Read file, ran command, edited file");
  });

  it("excludes the synthetic malformed tool-call type", () => {
    expect(finishedWorkSummary([
      { kind: "tool", toolName: "ask_user_question" },
      { kind: "tool", toolName: "tool_call" },
      { kind: "tool", toolName: "list_dir", resource: "src" }
    ])).toBe("Asked question, read directory");
  });

  it("uses present-progress tense for active tool labels", () => {
    expect(activeToolLabel("read_file")).toBe("Reading file");
    expect(activeToolLabel("list_dir")).toBe("Reading directory");
    expect(activeToolLabel("replace_range")).toBe("Editing file");
    expect(activeToolLabel("compact_context")).toBe("Compacting context");
  });

  it("includes completed context compaction in settled summaries", () => {
    expect(finishedWorkSummary([
      { kind: "tool", toolName: "read_file", resource: "a.ts" },
      { kind: "tool", toolName: "compact_context" }
    ])).toBe("Read file, compacted context");
  });
});
