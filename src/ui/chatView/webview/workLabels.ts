export type WorkActivity =
  | { kind: "thought" }
  | {
      kind: "tool";
      toolName: string;
      resource?: string;
      createsNewFile?: boolean;
      status?: "streaming" | "pending" | "approved" | "rejected" | "executed" | "failed";
    };

const WRITE_TOOLS = new Set(["write_file", "create_file", "edit_file", "insert_text", "replace_range"]);
const COMMAND_TOOLS = new Set(["run_command", "run_process", "wait_process", "stop_process"]);

interface ActivityGroup {
  key: string;
  activities: Extract<WorkActivity, { kind: "tool" }>[];
}

/**
 * Summarize a settled sub-session in first-occurrence order. Thought remains
 * in a two-type summary, but gives way to up to three concrete tool types in a
 * busier sub-session.
 */
export function finishedWorkSummary(activities: WorkActivity[]): string | undefined {
  return workSummary(activities);
}

/**
 * Summarize a live sub-session. While fewer than three completed activity
 * types occupy the buffer, include the current type using progressive tense.
 * Once the buffer is full, leave the current activity to its dedicated row.
 */
export function liveWorkSummary(activities: WorkActivity[]): string | undefined {
  if (activities.length === 0) return undefined;
  const current = activities[activities.length - 1];
  if (!liveWorkSummaryIncludesCurrent(activities)) {
    return finishedWorkSummary(activities.slice(0, -1));
  }
  return workSummary(activities, workActivityType(current), current);
}

export function liveWorkSummaryIncludesCurrent(activities: WorkActivity[]): boolean {
  const current = activities[activities.length - 1];
  if (!current || !workActivityType(current)) return false;
  const completedTypes = new Set(activities
    .slice(0, -1)
    .map(workActivityType)
    .filter((type): type is string => type !== undefined));
  return completedTypes.size < 3;
}

function workSummary(
  activities: WorkActivity[],
  activeType?: string,
  activeActivity?: WorkActivity
): string | undefined {
  const groups = new Map<string, ActivityGroup>();
  for (const activity of activities) {
    const key = workActivityType(activity);
    if (!key) continue;
    const group = groups.get(key) ?? { key, activities: [] };
    if (activity.kind === "tool") group.activities.push(activity);
    groups.set(key, group);
  }
  if (groups.size === 0) return undefined;
  const ordered = [...groups.values()];
  // Thought is useful context beside one other activity. In a busier
  // sub-session, reserve the three text labels for concrete tool types; the
  // thought icon is still retained by the UI's complete icon strip.
  const labels = ordered.length <= 2
    ? ordered
    : ordered.filter(group => group.key !== "thought" || group.key === activeType).slice(0, 3);
  return capitalizeSentence(labels.map(group =>
    group.key === activeType && activeActivity
      ? activeActivityLabel(activeActivity)
      : finishedGroupLabel(group)
  ).join(", "));
}

export function workActivityType(activity: WorkActivity): string | undefined {
  if (activity.kind === "thought") return "thought";
  // Failed and rejected calls remain available in the expanded timeline, but
  // must not be described as completed work in the collapsed summary.
  if (activity.status === "failed" || activity.status === "rejected") return undefined;
  // `tool_call` is the synthetic card name for an unparseable tool block, not
  // an activity type the model successfully used. Keep its rejected card in
  // the expanded timeline, but never advertise it in the sub-session summary.
  if (activity.toolName === "tool_call") return undefined;
  return activityType(activity.toolName, activity.createsNewFile);
}

/** Visual category used to deduplicate icons in a sub-session summary. */
export function workActivityIconType(activity: WorkActivity): string | undefined {
  const type = workActivityType(activity);
  if (!type || activity.kind === "thought") return type;
  if (COMMAND_TOOLS.has(activity.toolName)) return "command";
  if (WRITE_TOOLS.has(activity.toolName)) return "write";
  if (activity.toolName === "read_file") return "read_file";
  if (activity.toolName === "list_dir" || activity.toolName === "glob") return "search";
  if (["update_todos", "ask_user_question", "compact_context"].includes(activity.toolName)) {
    return activity.toolName;
  }
  return "fallback";
}

/** Present-progress label for the tool currently occupying a collapsed live session. */
export function activeToolLabel(toolName: string, createsNewFile = false, includeFileNoun = true): string {
  if (toolName === "create_file" || (toolName === "write_file" && createsNewFile)) {
    return includeFileNoun ? "Creating file" : "Creating";
  }
  if (WRITE_TOOLS.has(toolName)) return includeFileNoun ? "Editing file" : "Editing";
  const labels: Record<string, string> = {
    read_file: "Reading file",
    list_dir: "Reading directory",
    glob: "Finding files",
    run_command: "Running command",
    run_process: "Running command",
    wait_process: "Waiting for process",
    stop_process: "Stopping process",
    update_todos: "Updating todos",
    ask_user_question: "Asking question",
    compact_context: "Compacting context"
  };
  return labels[toolName] ?? capitalizeSentence(humanizeToolName(toolName));
}

export function commandToolLabel(
  status: "streaming" | "pending" | "approved" | "rejected" | "executed" | "failed"
): string {
  switch (status) {
    case "pending": return "Run command";
    case "streaming":
    case "approved": return "Running command";
    case "executed": return "Ran command";
    case "failed": return "Command failed";
    case "rejected": return "Command rejected";
  }
}

/** Past-tense label for an individual successfully completed tool card. */
export function settledToolLabel(toolName: string, createsNewFile = false, includeFileNoun = true): string {
  if (WRITE_TOOLS.has(toolName)) {
    const created = toolName === "create_file" || createsNewFile;
    return created
      ? includeFileNoun ? "Created file" : "Created"
      : includeFileNoun ? "Edited file" : "Edited";
  }
  const labels: Record<string, string> = {
    read_file: "Read file",
    list_dir: "Read directory",
    glob: "Found files",
    wait_process: "Checked process",
    stop_process: "Stopped process",
    update_todos: "Updated todos",
    ask_user_question: "Asked question",
    compact_context: "Compacted context"
  };
  return labels[toolName] ?? capitalizeSentence(humanizeToolName(toolName));
}

/** Explicit outcome label for an individual unsuccessful tool card. */
export function erroredToolLabel(
  toolName: string,
  status: "failed" | "rejected"
): string {
  if (WRITE_TOOLS.has(toolName)) return status === "failed" ? "Edit failed" : "Edit rejected";
  if (toolName === "ask_user_question" && status === "rejected") return "Question dismissed";
  const outcome = status === "failed" ? "failed" : "rejected";
  const subjects: Record<string, string> = {
    read_file: "Read",
    list_dir: "Directory read",
    glob: "File search",
    update_todos: "Todo update",
    ask_user_question: "Question",
    compact_context: "Compaction"
  };
  const subject = subjects[toolName] ?? capitalizeSentence(humanizeToolName(toolName));
  return `${subject} ${outcome}`;
}

/** Muted operation detail shown beside the +/- stats in an expanded edit. */
export function editOperationLabel(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "replace_range") {
    const start = lineNumber(args.startLine ?? args.start_line ?? args.start);
    const end = lineNumber(args.endLine ?? args.end_line ?? args.end);
    if (start !== undefined && end !== undefined) return `replace_range · lines ${start}–${end}`;
    if (start !== undefined || end !== undefined) return `replace_range · line ${start ?? end}`;
    return "replace_range";
  }
  if (toolName === "insert_text") {
    const line = lineNumber(
      args.line ?? args.lineNumber ?? args.line_number ?? args.beforeLine ?? args.before_line
    );
    return line === undefined ? "insert_text" : `insert_text · line ${line}`;
  }
  return ["write_file", "create_file", "edit_file"].includes(toolName) ? toolName : "";
}

function lineNumber(value: unknown): number | undefined {
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : NaN;
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function activeActivityLabel(activity: WorkActivity): string {
  if (activity.kind === "thought") return "thinking";
  return lowerFirst(activeToolLabel(activity.toolName, activity.createsNewFile));
}

function activityType(toolName: string, createsNewFile = false): string {
  if ((toolName === "write_file" || toolName === "create_file") && createsNewFile) return "create";
  return WRITE_TOOLS.has(toolName) ? "write" : toolName;
}

function finishedGroupLabel(group: ActivityGroup): string {
  if (group.key === "thought") return "thought";
  const count = subjectCount(group.activities);
  switch (group.key) {
    case "read_file": return count === 1 ? "read file" : "read files";
    case "list_dir": return count === 1 ? "read directory" : "read directories";
    case "write": return count === 1 ? "edited file" : "edited files";
    case "create": return count === 1 ? "created file" : "created files";
    case "glob": return "found files";
    case "run_command": return count === 1 ? "ran command" : "ran commands";
    case "run_process": return count === 1 ? "ran command" : "ran commands";
    case "wait_process": return count === 1 ? "waited for process" : "waited for processes";
    case "stop_process": return count === 1 ? "stopped process" : "stopped processes";
    case "update_todos": return "updated todos";
    case "ask_user_question": return count === 1 ? "asked question" : "asked questions";
    case "compact_context": return "compacted context";
    default: return humanizeToolName(group.key);
  }
}

function subjectCount(activities: Extract<WorkActivity, { kind: "tool" }>[]): number {
  const resources = new Set(activities.map(activity => activity.resource).filter(Boolean));
  return resources.size > 0 ? resources.size : activities.length;
}

function humanizeToolName(toolName: string): string {
  return toolName
    .split("_")
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function capitalizeSentence(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function lowerFirst(text: string): string {
  return text ? text[0].toLowerCase() + text.slice(1) : text;
}
