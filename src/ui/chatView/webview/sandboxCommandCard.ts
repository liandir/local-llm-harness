const SANDBOX_COMMAND_RULE_ID = /^[a-z][a-z0-9_-]{0,63}$/;

export type SandboxCommandCardIdentity = Readonly<
  | { kind: "command"; label: string; value: string }
  | { kind: "rule"; label: string; value: string }
>;

/**
 * Return the descriptive identity shown on a sandbox-command card.
 *
 * Live proposals may carry a host-rendered command display. Persisted tool
 * messages intentionally retain only the model's exact `{ ruleId }` call, so a
 * restored card falls back to that immutable identifier. Historical free-form
 * command fields are deliberately ignored: this helper is presentation-only
 * and must never turn model-provided command text back into authority.
 */
export function sandboxCommandCardIdentity(
  argsJson: string | undefined,
  commandDisplay: string | undefined
): SandboxCommandCardIdentity | undefined {
  if (typeof commandDisplay === "string" && commandDisplay.length > 0) {
    return Object.freeze({ kind: "command", label: commandDisplay, value: commandDisplay });
  }

  const ruleId = exactSandboxCommandRuleId(argsJson);
  if (!ruleId) return undefined;
  return Object.freeze({ kind: "rule", label: `[${ruleId}]`, value: ruleId });
}

function exactSandboxCommandRuleId(argsJson: string | undefined): string | undefined {
  if (!argsJson) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(argsJson);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(record, "ruleId") ||
    typeof record.ruleId !== "string" ||
    !SANDBOX_COMMAND_RULE_ID.test(record.ruleId)
  ) {
    return undefined;
  }
  return record.ruleId;
}
