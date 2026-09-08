import { describe, expect, it } from "vitest";
import { tooltipPosition } from "../src/ui/tooltips.js";

describe("tooltip placement", () => {
  const viewport = { width: 320, height: 600 };
  const tip = { width: 160, height: 28 };

  it("places top controls' help below them even when there is room above", () => {
    expect(tooltipPosition({ left: 100, top: 60, bottom: 84, width: 24 }, tip, viewport, true))
      .toEqual({ left: 32, top: 90 });
  });

  it("places composer help above its button", () => {
    expect(tooltipPosition({ left: 100, top: 550, bottom: 574, width: 24 }, tip, viewport, false))
      .toEqual({ left: 32, top: 516 });
  });

  it("keeps long memory help inside the right edge", () => {
    expect(tooltipPosition({ left: 280, top: 200, bottom: 224, width: 24 }, tip, viewport, false))
      .toEqual({ left: 152, top: 166 });
  });

  it("keeps help inside the left edge and flips below near the top", () => {
    expect(tooltipPosition({ left: 10, top: 10, bottom: 34, width: 24 }, tip, viewport, false))
      .toEqual({ left: 8, top: 40 });
  });

  it("keeps multiline help above the bottom viewport margin", () => {
    expect(tooltipPosition({ left: 10, top: 550, bottom: 574, width: 24 }, { width: 304, height: 100 }, viewport, true))
      .toEqual({ left: 8, top: 492 });
  });
});
