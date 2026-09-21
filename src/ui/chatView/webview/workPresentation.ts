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
  expanded: boolean,
  hasFollowingStatus = false
): boolean {
  return !conglomerate && partCount === 1 && !expanded && !hasFollowingStatus;
}

/** After a tool, further tools or statuses belong behind the session summary. */
export function workSectionPresentation(group: {
  live?: boolean;
  conglomerate?: boolean;
  expanded: boolean;
  parts: readonly { kind: string }[];
  liveStatus?: string;
}): { showSummary: boolean; showBody: boolean; currentOnly: boolean } {
  const toolCount = group.parts.filter(part => part.kind === "tool").length;
  const currentOnly = !!group.live && !group.conglomerate && !group.expanded
    && (toolCount === 0 || (toolCount === 1 && group.parts.at(-1)?.kind === "tool" && !group.liveStatus));
  return {
    showSummary: !currentOnly,
    showBody: group.expanded || currentOnly,
    currentOnly
  };
}
