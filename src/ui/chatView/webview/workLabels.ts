export type ToolActivityStatus = "streaming" | "pending" | "approved" | "rejected" | "executed" | "failed";

export type WorkActivity =
  | { kind: "thought"; active?: boolean }
  | {
      kind: "tool";
      toolName: string;
      resource?: string;
      createsNewFile?: boolean;
      status?: ToolActivityStatus;
      /** True while the tool itself, or a process it launched, is still active. */
      active?: boolean;
    };

const WRITE_TOOLS = new Set(["write_file", "create_file", "edit_file", "insert_text", "replace_range"]);
const COMMAND_TOOLS = new Set(["run_command", "run_process", "wait_process", "stop_process"]);

/** Include prompt ingestion and any background process in the tool's activity. */
export function toolActivityIsActive(
  toolName: string,
  status: ToolActivityStatus,
  processRunning = false,
  contextPending = false
): boolean {
  return ["streaming", "pending", "approved"].includes(status)
    || (status === "executed" && contextPending)
    || toolOwnsRunningProcess(toolName, processRunning);
}

export function toolOwnsRunningProcess(toolName: string, processRunning = false): boolean {
  return processRunning && (toolName === "run_command" || toolName === "run_process");
}

interface ActivityGroup {
  key: string;
  activities: Extract<WorkActivity, { kind: "tool" }>[];
}

/**
 * Summarize up to three activity types in first-occurrence order, with tools
 * taking precedence over thoughts. Callers omit thoughts when they are hidden.
 */
export function finishedWorkSummary(activities: WorkActivity[]): string | undefined {
  return workSummary(activities);
}

/**
 * Summarize a live sub-session. While fewer than three completed activity
 * types occupy the buffer, include the current type using progressive tense.
 * Once the buffer is full, update a type already shown there; new types stay
 * in their dedicated rows.
 * Thoughts follow tool types; a live status may occupy a remaining text slot.
 */
export function liveWorkSummary(activities: WorkActivity[], liveStatus?: string): string | undefined {
  const tools = activities.filter(activity => activity.kind === "tool");
  const current = tools.at(-1);
  let summary = finishedWorkSummary(tools);
  if (current && workActivityIsActive(current)) {
    summary = liveWorkSummaryIncludesCurrent(tools)
      ? workSummary(tools, workActivityType(current), current)
      : finishedWorkSummary(tools.slice(0, -1));
  }
  const toolTypes = new Set(tools.map(workActivityType).filter(type => type !== undefined));
  const thoughts = activities.filter(activity => activity.kind === "thought");
  const labels = summary ? [summary] : [];
  let typeCount = toolTypes.size;
  if (thoughts.length && typeCount < 3) {
    labels.push(liveStatus === "Thinking" || thoughts.some(workActivityIsActive) ? "thinking" : "thought");
    typeCount++;
  }
  // A delayed title wait explains why the server is unavailable, even when
  // the completed-work summary has already filled its three activity slots.
  if (liveStatus && (typeCount < 3 || liveStatus === "Generating title") && !(liveStatus === "Thinking" && thoughts.length)) {
    labels.push(lowerFirst(liveStatus));
  }
  return labels.length ? capitalizeSentence(labels.join(", ")) : undefined;
}

export function liveWorkSummaryIncludesCurrent(activities: WorkActivity[]): boolean {
  const current = activities[activities.length - 1];
  const currentType = current && workActivityType(current);
  if (!currentType) return false;
  if (!workActivityIsActive(current)) return true;
  const completedTypes = new Set(activities
    .slice(0, -1)
    .filter(activity => activity.kind === "tool")
    .map(workActivityType)
    .filter((type): type is string => type !== undefined));
  return completedTypes.size < 3 || [...completedTypes].slice(0, 3).includes(currentType);
}

function workActivityIsActive(activity: WorkActivity): boolean {
  if (activity.kind === "thought") return activity.active ?? false;
  if (activity.active !== undefined) return activity.active;
  return activity.status === undefined || ["streaming", "pending", "approved"].includes(activity.status);
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
  const labels = [...groups.values()]
    .sort((a, b) => Number(a.key === "thought") - Number(b.key === "thought"))
    .slice(0, 3);
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
  if (activity.toolName === "view_image") return "view_image";
  if (activity.toolName === "read_file") return "read_file";
  if (activity.toolName === "search_memories" || activity.toolName === "recall_memory") return "memory";
  if (activity.toolName === "list_dir") return "folder";
  if (activity.toolName === "glob") return "search";
  if (["update_todos", "ask_user_question", "compact_context"].includes(activity.toolName)) {
    return activity.toolName;
  }
  return "fallback";
}

/** Keep every icon category, including active tools omitted by the summary's text limit. */
export function workSummaryIcons(
  activities: WorkActivity[],
  live: boolean
): { activityIndex: number; active: boolean }[] {
  const icons = new Map<string, { activityIndex: number; active: boolean }>();
  activities.forEach((activity, activityIndex) => {
    const type = workActivityIconType(activity);
    if (!type) return;
    const active = live && workActivityIsActive(activity);
    const existing = icons.get(type);
    if (existing) existing.active ||= active;
    else icons.set(type, { activityIndex, active });
  });
  return [...icons.entries()]
    .sort(([a], [b]) => Number(a === "thought") - Number(b === "thought"))
    .map(([, icon]) => icon);
}

/** Present-progress label for an actively executing tool or live summary. */
export function activeToolLabel(toolName: string, createsNewFile = false, includeFileNoun = true): string {
  if (toolName === "create_file" || (toolName === "write_file" && createsNewFile)) {
    return includeFileNoun ? "Creating file" : "Creating";
  }
  if (WRITE_TOOLS.has(toolName)) return includeFileNoun ? "Editing file" : "Editing";
  if (toolName === "view_image") return "Viewing image";
  if (toolName === "read_file") return includeFileNoun ? "Reading file" : "Reading";
  const labels: Record<string, string> = {
    search_memories: "Searching memories",
    recall_memory: "Recalling memory",
    list_dir: includeFileNoun ? "Listing directory" : "Listing",
    glob: "Searching for files",
    run_command: "Running command",
    run_process: "Running command",
    wait_process: "Checking process",
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
  if (toolName === "view_image") return "Viewed image";
  if (toolName === "read_file") return includeFileNoun ? "Read file" : "Read";
  const labels: Record<string, string> = {
    search_memories: "Searched memories",
    recall_memory: "Recalled memory",
    list_dir: includeFileNoun ? "Listed directory" : "Listed",
    glob: "Searched",
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
    view_image: "View image",
    read_file: "Read",
    search_memories: "Memory search",
    recall_memory: "Memory recall",
    list_dir: "Directory listing",
    glob: "File search",
    wait_process: "Process check",
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
    case "view_image": return count === 1 ? "viewed image" : "viewed images";
    case "read_file": return count === 1 ? "read file" : "read files";
    case "list_dir": return count === 1 ? "listed directory" : "listed directories";
    case "write": return count === 1 ? "edited file" : "edited files";
    case "create": return count === 1 ? "created file" : "created files";
    case "search_memories": return "searched memories";
    case "recall_memory": return count === 1 ? "recalled memory" : "recalled memories";
    case "glob": return "searched for files";
    case "run_command": return count === 1 ? "ran command" : "ran commands";
    case "run_process": return count === 1 ? "ran command" : "ran commands";
    case "wait_process": return count === 1 ? "checked process" : "checked processes";
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
