export const SERVER_PENDING_NOTICE_DELAY_MS = 3_000;

export interface ServerPendingVisibility {
  since?: number;
  visible: boolean;
  remainingMs: number;
}

/** Only the generic server wait is delayed; named preparation work is immediate. */
export function serverPendingVisibility(
  reason: "server" | "title" | "context" | undefined,
  existingSince: number | undefined,
  now: number
): ServerPendingVisibility {
  if (reason !== "server") return { since: undefined, visible: true, remainingMs: 0 };
  const since = existingSince ?? now;
  const remainingMs = Math.max(0, SERVER_PENDING_NOTICE_DELAY_MS - (now - since));
  return { since, visible: remainingMs === 0, remainingMs };
}

/** Pending states that take over the active slot of a collapsed sub-session. */
export function pendingNoticeReplacesCurrentActivity(
  reason: "server" | "title" | "context" | undefined
): boolean {
  return reason === "server" || reason === "title";
}
