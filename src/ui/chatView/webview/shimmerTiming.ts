export const SHIMMER_SPEED_PX_PER_SECOND = 80;
export const SHIMMER_PAUSE_MS = 1_000;

/**
 * A 200%-wide background moving from 200% to -100% carries its center across
 * three element widths. Convert that distance to time at a fixed pixel speed,
 * then reserve an exact one-second hold at the fully-cleared end position.
 */
export function shimmerTiming(widthPx: number): { durationMs: number; sweepEndOffset: number } {
  const distancePx = Math.max(1, widthPx) * 3;
  const sweepMs = (distancePx / SHIMMER_SPEED_PX_PER_SECOND) * 1_000;
  const durationMs = sweepMs + SHIMMER_PAUSE_MS;
  return { durationMs, sweepEndOffset: sweepMs / durationMs };
}
