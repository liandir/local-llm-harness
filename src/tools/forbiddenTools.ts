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

export const ALLOWED_TOOL_NAMES = new Set([
  "read_file",
  "write_file",
  "list_dir",
  "glob",
  "run_command"
]);

export function classifyToolName(name: string): "allowed" | "forbidden" | "unknown" {
  if (ALLOWED_TOOL_NAMES.has(name)) return "allowed";
  if (isForbiddenToolName(name)) return "forbidden";
  return "unknown";
}
