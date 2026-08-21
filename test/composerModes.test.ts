import { describe, expect, it } from "vitest";
import { modeMenusAfterPointerDown } from "../src/ui/chatView/webview/composerModes.js";

describe("composer mode drop-up dismissal", () => {
  it("closes open menus when the pointer lands outside both selectors", () => {
    expect(modeMenusAfterPointerDown(
      { planModeMenuOpen: true, thinkingModeMenuOpen: true },
      { inPlanModeGroup: false, inThinkingModeGroup: false }
    )).toEqual({ planModeMenuOpen: false, thinkingModeMenuOpen: false });
  });

  it("keeps only the menu whose own selector contains the pointer", () => {
    expect(modeMenusAfterPointerDown(
      { planModeMenuOpen: true, thinkingModeMenuOpen: true },
      { inPlanModeGroup: true, inThinkingModeGroup: false }
    )).toEqual({ planModeMenuOpen: true, thinkingModeMenuOpen: false });
  });
});
