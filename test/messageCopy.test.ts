import { describe, expect, it } from "vitest";
import { copyableAssistantText } from "../src/ui/chatView/webview/messageCopy.js";

describe("assistant answer copying", () => {
  it.each([false, true])("excludes intermediate answers when work history is expanded=%s", expanded => {
    const units = [
      {
        kind: "work" as const,
        expanded,
        parts: [
          { kind: "text" as const, text: "I will inspect the files." },
          { kind: "tool" as const },
          { kind: "text" as const, text: "Now I will make the change." },
          { kind: "thought" as const },
          { kind: "tool" as const }
        ]
      },
      { kind: "inline" as const, parts: [{ kind: "text" as const, text: "The change is complete." }] }
    ];
    expect(copyableAssistantText(units)).toBe("The change is complete.");
  });

  it("copies only the final bubble when several text runs are outside work groups", () => {
    expect(copyableAssistantText([
      { kind: "inline", parts: [{ kind: "text", text: "An earlier update." }] },
      { kind: "inline", parts: [{ kind: "text", text: "The final answer." }] }
    ])).toBe("The final answer.");
  });

  it("preserves the final answer's raw Markdown and spacing", () => {
    const answer = "## Result\n\n- **Done**\n\n```ts\n  return 42;\n```\n";
    expect(copyableAssistantText([
      { kind: "inline", parts: [{ kind: "text", text: answer }] }
    ])).toBe(answer);
  });

  it("does not fall back to intermediate text when the turn ends with work", () => {
    expect(copyableAssistantText([
      { kind: "inline", parts: [{ kind: "text", text: "I will run the command." }] },
      { kind: "work", parts: [{ kind: "tool" }] }
    ])).toBe("");
    expect(copyableAssistantText([])).toBe("");
  });

  it("copies a terminal abort without including the earlier partial response", () => {
    expect(copyableAssistantText([
      { kind: "inline", parts: [{ kind: "text", text: "Partially completed response" }] },
      { kind: "inline", parts: [{ kind: "abort", reason: "Request cancelled." }] }
    ])).toBe("Request cancelled.");
  });

  it("retains copying for standalone summary cards", () => {
    expect(copyableAssistantText([
      { kind: "work", parts: [{ kind: "tool" }] },
      { kind: "inline", parts: [{ kind: "summary", text: "Completed summary." }] }
    ])).toBe("Completed summary.");
  });
});
