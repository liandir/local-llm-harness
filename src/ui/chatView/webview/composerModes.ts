export interface ComposerModeMenus {
  planModeMenuOpen: boolean;
  thinkingModeMenuOpen: boolean;
}

/** Close each open drop-up when a pointer lands outside its selector group. */
export function modeMenusAfterPointerDown(
  current: ComposerModeMenus,
  target: { inPlanModeGroup: boolean; inThinkingModeGroup: boolean }
): ComposerModeMenus {
  return {
    planModeMenuOpen: current.planModeMenuOpen && target.inPlanModeGroup,
    thinkingModeMenuOpen: current.thinkingModeMenuOpen && target.inThinkingModeGroup
  };
}
