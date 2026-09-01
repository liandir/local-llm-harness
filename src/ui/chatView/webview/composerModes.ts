export interface ComposerModeMenus {
  planModeMenuOpen: boolean;
  reasoningEffortMenuOpen: boolean;
}

/** Close each open drop-up when a pointer lands outside its selector group. */
export function modeMenusAfterPointerDown(
  current: ComposerModeMenus,
  target: { inPlanModeGroup: boolean; inReasoningEffortGroup: boolean }
): ComposerModeMenus {
  return {
    planModeMenuOpen: current.planModeMenuOpen && target.inPlanModeGroup,
    reasoningEffortMenuOpen: current.reasoningEffortMenuOpen && target.inReasoningEffortGroup
  };
}
