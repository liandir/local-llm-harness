import { describe, expect, it } from "vitest";
import { SHIMMER_PAUSE_MS, shimmerTiming } from "../src/ui/chatView/webview/shimmerTiming.js";

describe("shimmer timing", () => {
  it("keeps sweep speed constant as text width grows", () => {
    const short = shimmerTiming(90);
    const long = shimmerTiming(180);
    const shortSweep = short.durationMs - SHIMMER_PAUSE_MS;
    const longSweep = long.durationMs - SHIMMER_PAUSE_MS;

    expect(longSweep).toBeCloseTo(shortSweep * 2);
  });

  it("reserves an exact one-second pause after each sweep", () => {
    const timing = shimmerTiming(120);
    expect(timing.durationMs * (1 - timing.sweepEndOffset)).toBeCloseTo(SHIMMER_PAUSE_MS);
  });
});
