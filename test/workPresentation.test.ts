import { describe, expect, it } from "vitest";
import { workPresentationForTurn } from "../src/ui/chatView/webview/workPresentation.js";

describe("workPresentationForTurn", () => {
  it("hides only the turn-level summary while keeping live sub-sessions collapsed", () => {
    expect(workPresentationForTurn(true)).toEqual({
      showTurnSummary: false,
      expandSessions: false,
      sessionsCollapsible: true
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
