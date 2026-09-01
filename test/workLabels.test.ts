import { describe, expect, it } from "vitest";
import {
  activeToolLabel,
  commandToolLabel,
  editOperationLabel,
  erroredToolLabel,
  finishedWorkSummary,
  liveWorkSummary,
  liveWorkSummaryIncludesCurrent,
  settledToolLabel,
  workActivityIconType,
  type WorkActivity
} from "../src/ui/chatView/webview/workLabels.js";

describe("work session labels", () => {
  it("describes expanded edit operations and their applicable line numbers", () => {
    expect(editOperationLabel("replace_range", { startLine: 12, endLine: 18 }))
      .toBe("replace_range · lines 12–18");
    expect(editOperationLabel("replace_range", { start_line: "4", end_line: "7" }))
      .toBe("replace_range · lines 4–7");
    expect(editOperationLabel("insert_text", { line: 23 }))
      .toBe("insert_text · line 23");
    expect(editOperationLabel("write_file", {})).toBe("write_file");
    expect(editOperationLabel("create_file", {})).toBe("create_file");
    expect(editOperationLabel("edit_file", {})).toBe("edit_file");
    expect(editOperationLabel("read_file", { startLine: 1 })).toBe("");
  });

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
    expect(activeToolLabel("create_file")).toBe("Creating file");
    expect(activeToolLabel("create_file", true)).toBe("Creating file");
  });

  it("omits the generic file noun when a write label precedes a filename", () => {
    expect(activeToolLabel("replace_range", false, false)).toBe("Editing");
    expect(activeToolLabel("create_file", false, false)).toBe("Creating");
    expect(settledToolLabel("replace_range", false, false)).toBe("Edited");
    expect(settledToolLabel("create_file", false, false)).toBe("Created");
  });

  it("uses past tense for successfully settled tool cards", () => {
    expect(settledToolLabel("glob")).toBe("Found files");
    expect(settledToolLabel("update_todos")).toBe("Updated todos");
    expect(settledToolLabel("ask_user_question")).toBe("Asked question");
    expect(settledToolLabel("create_file")).toBe("Created file");
    expect(settledToolLabel("create_file", true)).toBe("Created file");
  });

  it("uses explicit labels for unsuccessful tool cards", () => {
    expect(erroredToolLabel("glob", "failed")).toBe("File search failed");
    expect(erroredToolLabel("read_file", "rejected")).toBe("Read rejected");
    expect(erroredToolLabel("ask_user_question", "rejected")).toBe("Question dismissed");
  });

  it("uses command tense appropriate to its execution state", () => {
    expect(commandToolLabel("pending")).toBe("Run command");
    expect(commandToolLabel("approved")).toBe("Running command");
    expect(commandToolLabel("streaming")).toBe("Running command");
    expect(commandToolLabel("executed")).toBe("Ran command");
    expect(commandToolLabel("failed")).toBe("Command failed");
    expect(commandToolLabel("rejected")).toBe("Command rejected");
  });

  it("groups tools by their rendered summary icon", () => {
    for (const toolName of ["run_command", "run_process", "wait_process", "stop_process"]) {
      expect(workActivityIconType({ kind: "tool", toolName })).toBe("command");
    }
    for (const toolName of ["write_file", "create_file", "edit_file", "insert_text", "replace_range"]) {
      expect(workActivityIconType({ kind: "tool", toolName })).toBe("write");
    }
    for (const toolName of ["list_dir", "glob"]) {
      expect(workActivityIconType({ kind: "tool", toolName })).toBe("search");
    }
    expect(workActivityIconType({ kind: "tool", toolName: "read_file" })).toBe("read_file");
    expect(workActivityIconType({ kind: "tool", toolName: "custom_tool" })).toBe("fallback");
    expect(workActivityIconType({ kind: "thought" })).toBe("thought");
  });

  it("distinguishes newly created files from edits in summaries", () => {
    const activities: WorkActivity[] = [
      { kind: "tool", toolName: "write_file", resource: "src/new.ts", createsNewFile: true }
    ];
    expect(finishedWorkSummary(activities)).toBe("Created file");
    expect(liveWorkSummary(activities)).toBe("Creating file");

    const nativeCreate: WorkActivity[] = [
      { kind: "tool", toolName: "create_file", resource: "src/new.ts", createsNewFile: true }
    ];
    expect(finishedWorkSummary(nativeCreate)).toBe("Created file");
    expect(liveWorkSummary(nativeCreate)).toBe("Creating file");
  });

  it("excludes failed and rejected tools from summaries", () => {
    expect(finishedWorkSummary([
      { kind: "tool", toolName: "read_file", resource: "a.ts", status: "failed" },
      { kind: "tool", toolName: "glob", status: "executed" },
      { kind: "tool", toolName: "run_command", status: "rejected" }
    ])).toBe("Found files");
    expect(finishedWorkSummary([
      { kind: "tool", toolName: "replace_range", resource: "a.ts", status: "failed" }
    ])).toBeUndefined();
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
