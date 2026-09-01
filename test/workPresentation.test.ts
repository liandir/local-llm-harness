import { describe, expect, it } from "vitest";
import { workPresentationForTurn } from "../src/ui/chatView/webview/workPresentation.js";

describe("workPresentationForTurn", () => {
  it("keeps live activity visible without a turn-level disclosure", () => {
    expect(workPresentationForTurn(true)).toEqual({
      showTurnSummary: false,
      expandSessions: true,
      sessionsCollapsible: false
    });
  });

  it("shows a collapsible Worked-for summary after the turn settles", () => {
    expect(workPresentationForTurn(false)).toEqual({
      showTurnSummary: true,
      expandSessions: false,
      sessionsCollapsible: true
    });
  });
});
