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
  toolActivityIsActive,
  workActivityIconType,
  workSummaryIcons,
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
    ])).toBe("Read files");

    expect(finishedWorkSummary([
      { kind: "tool", toolName: "list_dir", resource: "src" },
      { kind: "tool", toolName: "replace_range", resource: "src/a.ts" },
      { kind: "tool", toolName: "insert_text", resource: "src/b.ts" }
    ])).toBe("Listed src, edited files");
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
    ])).toBe("Asked question, listed src");
  });

  it("uses present-progress tense for active tool labels", () => {
    expect(activeToolLabel("read_file")).toBe("Reading file");
    expect(activeToolLabel("list_dir")).toBe("Listing directory");
    expect(activeToolLabel("glob")).toBe("Searching for files");
    expect(activeToolLabel("replace_range")).toBe("Editing file");
    expect(activeToolLabel("compact_context")).toBe("Compacting context");
    expect(activeToolLabel("write_file", true)).toBe("Creating file");
    expect(activeToolLabel("create_file")).toBe("Creating file");
    expect(activeToolLabel("create_file", true)).toBe("Creating file");
  });

  it("omits the generic file noun when an action label precedes a filename", () => {
    expect(activeToolLabel("list_dir", false, false)).toBe("Listing");
    expect(settledToolLabel("list_dir", false, false)).toBe("Listed");
    expect(activeToolLabel("read_file", false, false)).toBe("Reading");
    expect(activeToolLabel("replace_range", false, false)).toBe("Editing");
    expect(activeToolLabel("create_file", false, false)).toBe("Creating");
    expect(settledToolLabel("read_file", false, false)).toBe("Read");
    expect(settledToolLabel("replace_range", false, false)).toBe("Edited");
    expect(settledToolLabel("create_file", false, false)).toBe("Created");
  });

  it("uses past tense for successfully settled tool cards", () => {
    expect(settledToolLabel("glob")).toBe("Searched");
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
    expect(workActivityIconType({ kind: "tool", toolName: "list_dir" })).toBe("folder");
    expect(workActivityIconType({ kind: "tool", toolName: "glob" })).toBe("search");
    expect(workActivityIconType({ kind: "tool", toolName: "read_file" })).toBe("read_file");
    expect(workActivityIconType({ kind: "tool", toolName: "custom_tool" })).toBe("fallback");
    expect(workActivityIconType({ kind: "thought" })).toBeUndefined();
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
    ])).toBe("Searched for files");
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
    expect(liveWorkSummary(activities)).toBe("Editing file");
  });

  it("uses settled wording when a live session's latest tool has finished", () => {
    expect(toolActivityIsActive("list_dir", "executed")).toBe(false);
    expect(toolActivityIsActive("list_dir", "failed")).toBe(false);
    expect(toolActivityIsActive("list_dir", "rejected")).toBe(false);
    expect(toolActivityIsActive("list_dir", "pending")).toBe(true);
    expect(liveWorkSummary([
      { kind: "tool", toolName: "list_dir", resource: "src", status: "executed", active: false }
    ])).toBe("Listed src");
  });

  it("keeps a launched command active while its background process is running", () => {
    expect(liveWorkSummary([
      { kind: "tool", toolName: "run_process", status: "executed", active: true }
    ])).toBe("Running command");
  });

  it("settles a completed wait even when the checked process is still running", () => {
    expect(toolActivityIsActive("wait_process", "executed", true)).toBe(false);
    expect(toolActivityIsActive("run_process", "executed", true)).toBe(true);
    expect(liveWorkSummary([
      { kind: "tool", toolName: "wait_process", status: "executed", active: false }
    ])).toBe("Waited for process");
  });

  it("leaves the current type out once three completed types occupy the buffer", () => {
    const activities = [
      { kind: "tool", toolName: "read_file", resource: "a.ts" } as const,
      { kind: "tool", toolName: "list_dir", resource: "src" } as const,
      { kind: "tool", toolName: "run_command" } as const,
      { kind: "tool", toolName: "compact_context" } as const
    ];
    expect(liveWorkSummaryIncludesCurrent(activities)).toBe(false);
    expect(liveWorkSummary(activities)).toBe("Read file, listed src, ran command");
  });
});

describe("live statuses in work summaries", () => {
  const read: WorkActivity = { kind: "tool", toolName: "read_file", resource: "a.ts", status: "executed" };
  const listed: WorkActivity = { kind: "tool", toolName: "list_dir", resource: "src", status: "executed" };
  const command: WorkActivity = { kind: "tool", toolName: "run_command", status: "executed" };

  it.each(["Thinking", "Generating title", "Server pending", "Loading chat context"])(
    "appends %s after fewer than three distinct tool types",
    status => {
      const suffix = status.toLowerCase();
      expect(liveWorkSummary([read], status)).toBe(`Read file, ${suffix}`);
      expect(liveWorkSummary([read, listed], status)).toBe(`Read file, listed src, ${suffix}`);
      expect(liveWorkSummary([read, listed, command], status)).toBe("Read file, listed src, ran command");
    }
  );

  it("counts types rather than calls, thoughts, or unsuccessful tools", () => {
    expect(liveWorkSummary([
      read, { kind: "thought" }, read, listed, { ...command, status: "failed" },
      { kind: "tool", toolName: "compact_context", status: "rejected" }
    ], "Thinking")).toBe("Read file, listed src, thinking");
  });

  it("appends current thinking after the tools instead of retaining its earlier position", () => {
    expect(liveWorkSummary([{ kind: "thought" }, read, listed, { kind: "thought" }], "Thinking"))
      .toBe("Read file, listed src, thinking");
  });

  it("drops finished statuses without losing the tool summary", () => {
    const activities: WorkActivity[] = [{ kind: "thought" }, read, { kind: "thought" }];
    expect(liveWorkSummary(activities, "Thinking")).toBe("Read file, thinking");
    expect(liveWorkSummary(activities)).toBe("Read file");
    expect(finishedWorkSummary(activities)).toBe("Read file");
  });

  it.each(["Thinking", "Generating title", "Server pending", "Loading chat context"])(
    "shows only %s when unsuccessful calls have no summary text",
    liveStatus => {
      for (const status of ["failed", "rejected"] as const) {
        expect(liveWorkSummary([{ ...read, status }], liveStatus)).toBe(liveStatus);
        expect(liveWorkSummary([{ ...read, status }, { kind: "thought" }], liveStatus)).toBe(liveStatus);
      }
    }
  );

  it("shows thinking alone when there are no tools to summarize", () => {
    expect(liveWorkSummary([{ kind: "thought" }], "Thinking")).toBe("Thinking");
  });

  it("never adds thinking icons and preserves running tool animation", () => {
    expect(workSummaryIcons([
      { kind: "thought" }, { ...read, status: "approved" }, { kind: "thought" }
    ], true)).toEqual([{ activityIndex: 1, active: true }]);
    expect(workSummaryIcons([{ kind: "thought" }], true)).toEqual([]);
  });
});

describe("work summary icons", () => {
  it("animates the shared icon when a later call of the same visual category is active", () => {
    const activities: WorkActivity[] = [
      { kind: "tool", toolName: "replace_range", status: "executed" },
      { kind: "tool", toolName: "read_file", status: "executed" },
      { kind: "tool", toolName: "create_file", status: "approved" }
    ];
    expect(workSummaryIcons(activities, true)).toEqual([
      { activityIndex: 0, active: true },
      { activityIndex: 1, active: false }
    ]);
    expect(workSummaryIcons(activities, false)).toEqual([
      { activityIndex: 0, active: false },
      { activityIndex: 1, active: false }
    ]);
  });

  it("shows the running tool's icon even when the summary's text buffer is full", () => {
    const activities: WorkActivity[] = [
      { kind: "tool", toolName: "read_file", status: "executed" },
      { kind: "tool", toolName: "list_dir", resource: "src", status: "executed" },
      { kind: "tool", toolName: "run_command", status: "executed" },
      { kind: "tool", toolName: "compact_context", status: "pending" }
    ];
    expect(liveWorkSummary(activities)).toBe("Read file, listed src, ran command");
    expect(workSummaryIcons(activities, true)).toEqual([
      { activityIndex: 0, active: false },
      { activityIndex: 1, active: false },
      { activityIndex: 2, active: false },
      { activityIndex: 3, active: true }
    ]);
  });

  it("stops animation when calls finish and omits failed or rejected icons", () => {
    const activities: WorkActivity[] = [
      { kind: "tool", toolName: "read_file", status: "executed" },
      { kind: "tool", toolName: "list_dir", status: "failed" },
      { kind: "tool", toolName: "run_command", status: "rejected" }
    ];
    expect(workSummaryIcons(activities, true)).toEqual([{ activityIndex: 0, active: false }]);
  });

  it("keeps a background process animated while later tools have finished", () => {
    expect(workSummaryIcons([
      { kind: "tool", toolName: "run_process", status: "executed", active: true },
      { kind: "tool", toolName: "read_file", status: "executed", active: false }
    ], true)).toEqual([
      { activityIndex: 0, active: true },
      { activityIndex: 1, active: false }
    ]);
  });
});
