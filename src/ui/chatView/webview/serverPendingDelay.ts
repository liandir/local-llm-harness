export const SERVER_PENDING_NOTICE_DELAY_MS = 1_000;
export const TITLE_BLOCKING_NOTICE_DELAY_MS = 1_000;

export interface ServerPendingVisibility {
  since?: number;
  visible: boolean;
  remainingMs: number;
}

/** Delay transient waits long enough to distinguish real blocking from handoff. */
export function serverPendingVisibility(
  reason: "server" | "title" | "context" | undefined,
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

/** Pending states that take over the active slot of a collapsed sub-session. */
export function pendingNoticeReplacesCurrentActivity(
  reason: "server" | "title" | "context" | undefined
): boolean {
  return reason === "server" || reason === "title";
}
