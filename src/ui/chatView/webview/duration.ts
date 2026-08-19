const MINUTES_THRESHOLD_MS = 120_000;

/** Format elapsed work consistently for both thought and work-session labels. */
export function formatElapsedDuration(durationMs: number): string {
  if (durationMs >= MINUTES_THRESHOLD_MS) {
    const minutes = Math.max(2, Math.floor(durationMs / 60_000));
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  // Rounding preserves the existing short-duration behavior. Clamp at 119 so
  // the label never shows "120 seconds" immediately before changing units.
  const seconds = Math.min(119, Math.max(1, Math.round(durationMs / 1000)));
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}
