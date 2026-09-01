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
