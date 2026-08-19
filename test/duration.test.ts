import { describe, expect, it } from "vitest";
import { formatElapsedDuration } from "../src/ui/chatView/webview/duration.js";

describe("elapsed duration labels", () => {
  it.each([
    [0, "1 second"],
    [1_000, "1 second"],
    [2_000, "2 seconds"],
    [119_000, "119 seconds"],
    [119_999, "119 seconds"],
    [120_000, "2 minutes"],
    [179_999, "2 minutes"],
    [180_000, "3 minutes"],
    [239_999, "3 minutes"],
    [240_000, "4 minutes"]
  ])("formats %d ms as %s", (durationMs, expected) => {
    expect(formatElapsedDuration(durationMs)).toBe(expected);
  });
});
