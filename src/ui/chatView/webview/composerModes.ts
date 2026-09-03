export interface ComposerModeMenus {
  chatModeMenuOpen: boolean;
  reasoningEffortMenuOpen: boolean;
}

/** Close each open drop-up when a pointer lands outside its selector group. */
export function modeMenusAfterPointerDown(
  current: ComposerModeMenus,
  target: { inChatModeGroup: boolean; inReasoningEffortGroup: boolean }
): ComposerModeMenus {
  return {
    chatModeMenuOpen: current.chatModeMenuOpen && target.inChatModeGroup,
    reasoningEffortMenuOpen: current.reasoningEffortMenuOpen && target.inReasoningEffortGroup
  };
}
