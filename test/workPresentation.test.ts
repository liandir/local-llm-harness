import { describe, expect, it } from "vitest";
import {
  rendersSingleWorkItemDirectly,
  thinkingPresentation,
  workPresentationForTurn
} from "../src/ui/chatView/webview/workPresentation.js";

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

describe("thinkingPresentation", () => {
  it("keeps thinking visible in history and expandable when enabled", () => {
    expect(thinkingPresentation(true, false)).toEqual({
      visible: true,
      includeInHistory: true,
      expandable: true
    });
  });

  it("shows disabled thinking only while live without history or disclosure", () => {
    expect(thinkingPresentation(false, true)).toEqual({
      visible: true,
      includeInHistory: false,
      expandable: false
    });
    expect(thinkingPresentation(false, false)).toEqual({
      visible: false,
      includeInHistory: false,
      expandable: false
    });
  });
});

describe("rendersSingleWorkItemDirectly", () => {
  it("materializes a history container when a lone activity is expanded", () => {
    expect(rendersSingleWorkItemDirectly(false, 1, false)).toBe(true);
    expect(rendersSingleWorkItemDirectly(false, 1, true)).toBe(false);
  });

  it("never treats grouped or conglomerate work as a direct item", () => {
    expect(rendersSingleWorkItemDirectly(false, 2, false)).toBe(false);
    expect(rendersSingleWorkItemDirectly(true, 1, false)).toBe(false);
  });
});
