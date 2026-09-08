import { describe, expect, it } from "vitest";
import { captureHistoryView, restoreHistoryView } from "../src/ui/chatView/historyViewState.js";

function message(id: string, responseToTs = 10) {
  return {
    id, role: "assistant", responseToTs,
    parts: [{ kind: "thought", userExpanded: true }, { kind: "text" }, { kind: "thought", userExpanded: false }],
    toolCards: [{ toolId: "read", expanded: true }, { toolId: "edit", expanded: false }],
    workGroupExpanded: new Map([[`${id}:worked:all`, true], [`${id}:worked:0`, false]]),
    fileChangesExpanded: true,
    expandedFileChanges: new Set(["src/main.ts"])
  };
}

describe("chat history disclosure state", () => {
  it("restores inspected sections when a live turn is reconstructed with a different message ID", () => {
    const saved = captureHistoryView([message("live")]);
    const restored = message("saved");
    restored.workGroupExpanded.clear();
    restored.parts.forEach(part => { part.userExpanded = undefined; });
    restored.toolCards.forEach(tool => { tool.expanded = false; });
    restored.fileChangesExpanded = false;
    restored.expandedFileChanges.clear();
    restoreHistoryView([restored], saved);
    expect(restored.workGroupExpanded).toEqual(new Map([["saved:worked:all", true], ["saved:worked:0", false]]));
    expect(restored.parts.map(part => part.userExpanded)).toEqual([true, undefined, false]);
    expect(restored.toolCards.map(tool => tool.expanded)).toEqual([true, false]);
    expect(restored.fileChangesExpanded).toBe(true);
    expect(restored.expandedFileChanges).toEqual(new Set(["src/main.ts"]));
  });

  it("leaves newly arrived messages and tools at their own default expansion state", () => {
    const saved = captureHistoryView([message("old")]);
    const current = message("rebuilt");
    current.toolCards.push({ toolId: "new-tool", expanded: true });
    const later = message("new-turn", 20);
    later.workGroupExpanded.clear();
    restoreHistoryView([current, later], saved);
    expect(current.toolCards.at(-1)?.expanded).toBe(true);
    expect(later.workGroupExpanded.size).toBe(0);
  });

  it("copies mutable state so later changes cannot alter another saved view", () => {
    const original = message("original");
    const saved = captureHistoryView([original]);
    original.workGroupExpanded.clear();
    original.expandedFileChanges.clear();
    original.toolCards[0].expanded = false;
    const restored = message("restored");
    restoreHistoryView([restored], saved);
    expect(restored.workGroupExpanded.get("restored:worked:all")).toBe(true);
    expect(restored.toolCards[0].expanded).toBe(true);
    restored.expandedFileChanges.clear();
    const reopened = message("again");
    restoreHistoryView([reopened], saved);
    expect(reopened.expandedFileChanges.size).toBe(1);
  });

  it("keeps identical turn timestamps isolated when each chat restores its own view", () => {
    const a = message("a"), b = message("b");
    b.toolCards[0].expanded = false;
    const aView = captureHistoryView([a]), bView = captureHistoryView([b]);
    const reopened = message("reopened");
    restoreHistoryView([reopened], bView);
    expect(reopened.toolCards[0].expanded).toBe(false);
    restoreHistoryView([reopened], aView);
    expect(reopened.toolCards[0].expanded).toBe(true);
  });
});
