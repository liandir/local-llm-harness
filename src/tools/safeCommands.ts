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
 * Legacy compatibility shim.
 *
 * String/regex command authorization is permanently inert: neither `command`
 * nor `allowlist` is inspected or evaluated. New code must select a fixed
 * structured rule from `sandboxCommands.ts` by exact rule ID.
 *
 * @deprecated Use a verified `SandboxCommandCapabilitySnapshot` and
 * `findSandboxCommandRule`.
 */
export function checkSafeCommand(
  _command: string,
  _allowlist: SafeCommandEntry[]
): SafeMatch {
  return {
    ok: false,
    reason: "Legacy safeCommands regex authorization is inactive; no command was authorized."
  };
}
