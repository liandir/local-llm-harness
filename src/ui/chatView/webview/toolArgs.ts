/**
 * Normalize compatibility envelopes for display without unwrapping legitimate
 * tool parameters. In particular, run_process owns an `args` array alongside
 * `program`; treating every `args` property as an envelope hides the command
 * from its card and approval prompt.
 */
export function normalizeToolArgsForDisplay(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("\"")) {
      try { return normalizeToolArgsForDisplay(JSON.parse(trimmed)); } catch { /* fall through */ }
    }
    return {};
  }
  if (Array.isArray(value) && value.length > 0) return normalizeToolArgsForDisplay(value[0]);
  if (!value || typeof value !== "object") return {};

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  const wrapper = ["arguments", "args", "input", "parameters"].find(key =>
    key in obj && (
      keys.length === 1 ||
      (key === "arguments" && keys.every(name => name === "name" || name === "arguments"))
    )
  );
  return wrapper ? normalizeToolArgsForDisplay(obj[wrapper]) : obj;
}
