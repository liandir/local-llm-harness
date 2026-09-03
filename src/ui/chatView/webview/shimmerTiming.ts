export const SHIMMER_SPEED_PX_PER_SECOND = 90;
export const SHIMMER_PAUSE_MS = 1_000;
export const SHIMMER_BAND_WIDTH_PX = 48;

/**
 * A fixed-width band travels from just beyond the text's left edge until it
 * clears the right edge. Convert that distance to time at a fixed pixel speed,
 * then reserve an exact one-second hold at the fully-cleared end position.
 */
export function shimmerTiming(widthPx: number): { durationMs: number; sweepEndOffset: number } {
  const distancePx = Math.max(1, widthPx) + SHIMMER_BAND_WIDTH_PX;
  const sweepMs = (distancePx / SHIMMER_SPEED_PX_PER_SECOND) * 1_000;
  const durationMs = sweepMs + SHIMMER_PAUSE_MS;
  return { durationMs, sweepEndOffset: sweepMs / durationMs };
}
