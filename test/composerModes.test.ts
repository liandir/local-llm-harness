import { describe, expect, it } from "vitest";
import { modeMenusAfterPointerDown } from "../src/ui/chatView/webview/composerModes.js";

describe("composer mode drop-up dismissal", () => {
  it("closes open menus when the pointer lands outside both selectors", () => {
    expect(modeMenusAfterPointerDown(
      { chatModeMenuOpen: true, reasoningEffortMenuOpen: true },
      { inChatModeGroup: false, inReasoningEffortGroup: false }
    )).toEqual({ chatModeMenuOpen: false, reasoningEffortMenuOpen: false });
  });

  it("keeps only the menu whose own selector contains the pointer", () => {
    expect(modeMenusAfterPointerDown(
      { chatModeMenuOpen: true, reasoningEffortMenuOpen: true },
      { inChatModeGroup: true, inReasoningEffortGroup: false }
    )).toEqual({ chatModeMenuOpen: true, reasoningEffortMenuOpen: false });
  });
});
