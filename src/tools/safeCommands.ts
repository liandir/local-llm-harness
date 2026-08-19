export interface SafeCommandEntry {
  match: string;
  description?: string;
}

export interface SafeMatch {
  ok: boolean;
  matched?: SafeCommandEntry;
  reason?: string;
}

export const DEFAULT_LS_COMMAND_PATTERN =
  "ls(?: -[laF]{1,3})?(?: (?:\\.|(?:\\.[A-Za-z0-9][A-Za-z0-9._-]*|[A-Za-z0-9][A-Za-z0-9._-]*)(?:/(?:\\.[A-Za-z0-9][A-Za-z0-9._-]*|[A-Za-z0-9][A-Za-z0-9._-]*))*)/?)?";

export const DEFAULT_MKDIR_COMMAND_PATTERN =
  "mkdir(?: -p)? (?:\\.[A-Za-z0-9][A-Za-z0-9._-]*|[A-Za-z0-9][A-Za-z0-9._-]*)(?:/(?:\\.[A-Za-z0-9][A-Za-z0-9._-]*|[A-Za-z0-9][A-Za-z0-9._-]*))*(?: (?:\\.[A-Za-z0-9][A-Za-z0-9._-]*|[A-Za-z0-9][A-Za-z0-9._-]*)(?:/(?:\\.[A-Za-z0-9][A-Za-z0-9._-]*|[A-Za-z0-9][A-Za-z0-9._-]*))*){0,15}";

const LEGACY_DEFAULT_LS_PATTERNS = new Set([
  // Original default: no trailing slash.
  "ls(?: -(?:l|a|la|al))?(?: (?:\\.|(?:\\.[A-Za-z0-9][A-Za-z0-9._-]*|[A-Za-z0-9][A-Za-z0-9._-]*)(?:/(?:\\.[A-Za-z0-9][A-Za-z0-9._-]*|[A-Za-z0-9][A-Za-z0-9._-]*))*))?",
  // v1.5.x default before -F support.
  "ls(?: -(?:l|a|la|al))?(?: (?:\\.|(?:\\.[A-Za-z0-9][A-Za-z0-9._-]*|[A-Za-z0-9][A-Za-z0-9._-]*)(?:/(?:\\.[A-Za-z0-9][A-Za-z0-9._-]*|[A-Za-z0-9][A-Za-z0-9._-]*))*)/?)?"
]);

const LEGACY_DEFAULT_MKDIR_PATTERNS = new Set([
  "mkdir(?: -p)? (?:\\.[A-Za-z0-9][A-Za-z0-9._-]*|[A-Za-z0-9][A-Za-z0-9._-]*)(?:/(?:\\.[A-Za-z0-9][A-Za-z0-9._-]*|[A-Za-z0-9][A-Za-z0-9._-]*))*"
]);

/** Upgrade only exact historical defaults; never rewrite a customized regex. */
export function migrateLegacyDefaultSafeCommands(entries: SafeCommandEntry[]): SafeCommandEntry[] | undefined {
  let changed = false;
  const migrated = entries.map(entry => {
    if (LEGACY_DEFAULT_LS_PATTERNS.has(entry.match)) {
      changed = true;
      return {
        ...entry,
        match: DEFAULT_LS_COMMAND_PATTERN,
        description: "List the workspace root or a simple relative path, optionally with -l, -a, or -F."
      };
    }
    if (LEGACY_DEFAULT_MKDIR_PATTERNS.has(entry.match)) {
      changed = true;
      return {
        ...entry,
        match: DEFAULT_MKDIR_COMMAND_PATTERN,
        description: "Create up to sixteen directories at simple relative workspace paths."
      };
    }
    return entry;
  });
  return changed ? migrated : undefined;
}

/**
 * Check whether a model-proposed command is eligible for auto-approval.
 * `match` is a regex that must fully match the command string.
 * The command is NOT split or shell-expanded — we match it byte-for-byte.
 */
export function checkSafeCommand(
  command: string,
  allowlist: SafeCommandEntry[]
): SafeMatch {
  if (allowlist.length === 0) {
    return { ok: false, reason: "Safe-command auto-approval list is empty." };
  }
  for (const entry of allowlist) {
    let re: RegExp;
    try {
      re = new RegExp("^(?:" + entry.match + ")$");
    } catch {
      continue;
    }
    if (re.test(command)) {
      return { ok: true, matched: entry };
    }
  }
  return { ok: false, reason: "Command does not match any safe-command auto-approval entry." };
}
