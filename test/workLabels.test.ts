import { describe, expect, it } from "vitest";
import {
  activeToolLabel,
  finishedWorkSummary,
  liveWorkSummary,
  liveWorkSummaryIncludesCurrent,
  type WorkActivity
} from "../src/ui/chatView/webview/workLabels.js";

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
    expect(activeToolLabel("write_file", true)).toBe("Creating file");
  });

  it("distinguishes newly created files from edits in summaries", () => {
    const activities: WorkActivity[] = [
      { kind: "tool", toolName: "write_file", resource: "src/new.ts", createsNewFile: true }
    ];
    expect(finishedWorkSummary(activities)).toBe("Created file");
    expect(liveWorkSummary(activities)).toBe("Creating file");
  });

  it("includes completed context compaction in settled summaries", () => {
    expect(finishedWorkSummary([
      { kind: "tool", toolName: "read_file", resource: "a.ts" },
      { kind: "tool", toolName: "compact_context" }
    ])).toBe("Read file, compacted context");
  });

  it("includes the current type in progressive tense while the completed-type buffer has room", () => {
    const activities = [
      { kind: "thought" } as const,
      { kind: "tool", toolName: "replace_range", resource: "a.ts" } as const
    ];
    expect(liveWorkSummaryIncludesCurrent(activities)).toBe(true);
    expect(liveWorkSummary(activities)).toBe("Thought, editing file");
  });

  it("leaves the current type out once three completed types occupy the buffer", () => {
    const activities = [
      { kind: "tool", toolName: "read_file", resource: "a.ts" } as const,
      { kind: "tool", toolName: "list_dir", resource: "src" } as const,
      { kind: "tool", toolName: "run_command" } as const,
      { kind: "tool", toolName: "compact_context" } as const
    ];
    expect(liveWorkSummaryIncludesCurrent(activities)).toBe(false);
    expect(liveWorkSummary(activities)).toBe("Read file, read directory, ran command");
  });
});
