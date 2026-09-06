import { describe, expect, it } from "vitest";
import {
  SHIMMER_BAND_WIDTH_PX,
  SHIMMER_PAUSE_MS,
  SHIMMER_SPEED_PX_PER_SECOND,
  shimmerTiming
} from "../src/ui/chatView/webview/shimmerTiming.js";

describe("shimmer timing", () => {
  it("keeps sweep speed constant as text width grows", () => {
    const short = shimmerTiming(90);
    const long = shimmerTiming(180);
    const shortSweep = short.durationMs - SHIMMER_PAUSE_MS;
    const longSweep = long.durationMs - SHIMMER_PAUSE_MS;

    expect(shortSweep).toBeCloseTo(
      ((90 + SHIMMER_BAND_WIDTH_PX) / SHIMMER_SPEED_PX_PER_SECOND) * 1_000
    );
    expect(longSweep - shortSweep).toBeCloseTo(
      ((180 - 90) / SHIMMER_SPEED_PX_PER_SECOND) * 1_000
    );
  });

  it("uses one fixed-width shimmer band for every text length", () => {
    expect(SHIMMER_BAND_WIDTH_PX).toBe(48);
  });

  it("reserves an exact one-second pause after each sweep", () => {
    const timing = shimmerTiming(120);
    expect(timing.durationMs * (1 - timing.sweepEndOffset)).toBeCloseTo(SHIMMER_PAUSE_MS);
  });
});
