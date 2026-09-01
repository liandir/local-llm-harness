export interface TurnWorkPresentation {
  showTurnSummary: boolean;
  expandSessions: boolean;
  sessionsCollapsible: boolean;
}

/** Live turns expose their chronology directly; settled turns summarize it. */
export function workPresentationForTurn(live: boolean): TurnWorkPresentation {
  return live
    ? { showTurnSummary: false, expandSessions: true, sessionsCollapsible: false }
    : { showTurnSummary: true, expandSessions: false, sessionsCollapsible: true };
}
