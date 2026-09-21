export interface TurnWorkPresentation {
  showTurnSummary: boolean;
  expandSessions: boolean;
  sessionsCollapsible: boolean;
}

/** Live turns omit only the turn-level summary; sub-sessions stay collapsible. */
export function workPresentationForTurn(live: boolean): TurnWorkPresentation {
  return live
    ? { showTurnSummary: false, expandSessions: false, sessionsCollapsible: true }
    : { showTurnSummary: true, expandSessions: false, sessionsCollapsible: true };
}

export interface ThinkingPresentation {
  visible: boolean;
  includeInHistory: boolean;
  expandable: boolean;
}

/** Keep hidden thinking in storage while controlling only its chat presentation. */
export function thinkingPresentation(showThinking: boolean, live: boolean): ThinkingPresentation {
  if (showThinking) return { visible: true, includeInHistory: true, expandable: true };
  return live
    ? { visible: true, includeInHistory: false, expandable: false }
    : { visible: false, includeInHistory: false, expandable: false };
}

/** A lone activity stays compact until an explicit disclosure needs its history container. */
export function rendersSingleWorkItemDirectly(
  conglomerate: boolean,
  partCount: number,
  expanded: boolean
): boolean {
  return !conglomerate && partCount === 1 && !expanded;
}

/** Live sessions switch from the current activity to a summary at the second tool call. */
export function workSectionPresentation(group: {
  live?: boolean;
  conglomerate?: boolean;
  expanded: boolean;
  parts: readonly { kind: string }[];
}): { showSummary: boolean; showBody: boolean; currentOnly: boolean } {
  const currentOnly = !!group.live && !group.conglomerate && !group.expanded
    && group.parts.filter(part => part.kind === "tool").length < 2;
  return {
    showSummary: !currentOnly,
    showBody: group.expanded || currentOnly,
    currentOnly
  };
}
