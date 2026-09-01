import { describe, expect, it } from "vitest";
import { modeMenusAfterPointerDown } from "../src/ui/chatView/webview/composerModes.js";

describe("composer mode drop-up dismissal", () => {
  it("closes open menus when the pointer lands outside both selectors", () => {
    expect(modeMenusAfterPointerDown(
      { planModeMenuOpen: true, reasoningEffortMenuOpen: true },
      { inPlanModeGroup: false, inReasoningEffortGroup: false }
    )).toEqual({ planModeMenuOpen: false, reasoningEffortMenuOpen: false });
  });

  it("keeps only the menu whose own selector contains the pointer", () => {
    expect(modeMenusAfterPointerDown(
      { planModeMenuOpen: true, reasoningEffortMenuOpen: true },
      { inPlanModeGroup: true, inReasoningEffortGroup: false }
    )).toEqual({ planModeMenuOpen: true, reasoningEffortMenuOpen: false });
  });
});
