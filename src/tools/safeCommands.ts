export interface SafeCommandEntry {
  match: string;
  description?: string;
}

export interface SafeMatch {
  ok: boolean;
  matched?: SafeCommandEntry;
  reason?: string;
}

/**
 * Check the model-proposed command string against the user's allow-list.
 * `match` is a regex that must fully match the command string.
 * The command is NOT split or shell-expanded — we match it byte-for-byte.
 */
export function checkSafeCommand(
  command: string,
  allowlist: SafeCommandEntry[]
): SafeMatch {
  if (allowlist.length === 0) {
    return { ok: false, reason: "Safe-commands allow-list is empty." };
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
  return { ok: false, reason: "Command does not match any safe-list entry." };
}
