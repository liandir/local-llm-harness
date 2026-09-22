export const SERVER_PENDING_NOTICE_DELAY_MS = 3_000;
export const TITLE_BLOCKING_NOTICE_DELAY_MS = 3_000;

export interface ServerPendingVisibility {
  since?: number;
  visible: boolean;
  remainingMs: number;
}

/** Delay transient waits long enough to distinguish real blocking from handoff. */
export function serverPendingVisibility(
  reason: ChatTurnPreparation["reason"] | undefined,
  existingSince: number | undefined,
  now: number
): ServerPendingVisibility {
  const delayMs = reason === "server"
    ? SERVER_PENDING_NOTICE_DELAY_MS
    : reason === "title"
      ? TITLE_BLOCKING_NOTICE_DELAY_MS
      : 0;
  if (delayMs === 0) return { since: undefined, visible: true, remainingMs: 0 };
  const since = existingSince ?? now;
  const remainingMs = Math.max(0, delayMs - (now - since));
  return { since, visible: remainingMs === 0, remainingMs };
}

/** Shared wording for the transient row and its live summary suffix. */
export function serverPendingLabel(
  reason: ChatTurnPreparation["reason"] | undefined
): string | undefined {
  switch (reason) {
    case "server": return "Server pending";
    case "title": return "Generating title";
    case "context": return "Loading chat context";
    // The previous answer's live creation card already explains this wait.
    case "memory": return undefined;
    default: return undefined;
  }
}
import type { ChatTurnPreparation } from "../../messaging.js";
