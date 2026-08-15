export type WorkActivity =
  | { kind: "thought" }
  | { kind: "tool"; toolName: string; resource?: string };

const WRITE_TOOLS = new Set(["write_file", "insert_text", "replace_range"]);

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
  const groups = new Map<string, ActivityGroup>();
  for (const activity of activities) {
    const key = workActivityType(activity);
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
    : ordered.filter(group => group.key !== "thought").slice(0, 3);
  return labels.map(finishedGroupLabel).join(", ");
}

export function workActivityType(activity: WorkActivity): string {
  return activity.kind === "thought" ? "thought" : activityType(activity.toolName);
}

/** Present-progress label for the tool currently occupying a collapsed live session. */
export function activeToolLabel(toolName: string): string {
  if (WRITE_TOOLS.has(toolName)) return "Editing File";
  const labels: Record<string, string> = {
    read_file: "Reading File",
    list_dir: "Reading Directory",
    glob: "Finding Files",
    run_command: "Running Command",
    update_todos: "Updating Todos",
    ask_user_question: "Asking Question",
    compact_context: "Compacting Context"
  };
  return labels[toolName] ?? humanizeToolName(toolName);
}

function activityType(toolName: string): string {
  return WRITE_TOOLS.has(toolName) ? "write" : toolName;
}

function finishedGroupLabel(group: ActivityGroup): string {
  if (group.key === "thought") return "Thought";
  const count = subjectCount(group.activities);
  switch (group.key) {
    case "read_file": return count === 1 ? "Read File" : "Read Files";
    case "list_dir": return count === 1 ? "Read Directory" : "Read Directories";
    case "write": return count === 1 ? "Edited File" : "Edited Files";
    case "glob": return "Found Files";
    case "run_command": return count === 1 ? "Ran Command" : "Ran Commands";
    case "update_todos": return "Updated Todos";
    case "ask_user_question": return count === 1 ? "Asked Question" : "Asked Questions";
    case "compact_context": return "Compacted Context";
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
    .map(word => word[0]?.toUpperCase() + word.slice(1))
    .join(" ");
}
