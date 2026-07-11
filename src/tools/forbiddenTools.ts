const FORBIDDEN_PATTERNS = [
  /^web[_-]?search$/i,
  /^http[_-]?get$/i,
  /^http[_-]?post$/i,
  /^fetch$/i,
  /^curl$/i,
  /^wget$/i,
  /^browse$/i,
  /^url[_-]?fetch$/i,
  /^download$/i
];

export function isForbiddenToolName(name: string): boolean {
  return FORBIDDEN_PATTERNS.some(re => re.test(name));
}

/**
 * Tools recognized for compatibility with older transcripts/parsers but kept
 * unavailable until their security boundary can be enforced.
 */
const DISABLED_TOOL_NAMES = new Set(["run_command"]);

/** A stable, user-facing explanation for fail-closed command containment. */
export function disabledToolReason(name: string): string | undefined {
  if (!DISABLED_TOOL_NAMES.has(name)) return undefined;
  return [
    `Tool "${name}" is disabled because no verified sandbox backend is available.`,
    "No command was executed.",
    "Run the command manually if needed; command execution will remain unavailable until it can be isolated from the host."
  ].join("\n");
}

export const ALLOWED_TOOL_NAMES = new Set([
  "read_file",
  "write_file",
  "insert_text",
  "replace_range",
  "list_dir",
  "glob",
  "update_todos",
  "ask_user_question"
]);

export function classifyToolName(name: string): "allowed" | "disabled" | "forbidden" | "unknown" {
  if (ALLOWED_TOOL_NAMES.has(name)) return "allowed";
  if (DISABLED_TOOL_NAMES.has(name)) return "disabled";
  if (isForbiddenToolName(name)) return "forbidden";
  return "unknown";
}
