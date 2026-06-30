import { describe, expect, it, vi } from "vitest";

// session.js transitively imports the terminal tool, which imports "vscode".
// The normalizer under test needs none of it; an empty module satisfies the graph.
vi.mock("vscode", () => ({}));

import { normalizeAskUserQuestionArgs } from "../src/chat/session.js";

describe("normalizeAskUserQuestionArgs", () => {
  it("accepts a question with two or more suggestions", () => {
    expect(normalizeAskUserQuestionArgs({ question: "Which DB?", suggestions: ["Postgres", "SQLite"] })).toEqual({
      question: "Which DB?",
      suggestions: ["Postgres", "SQLite"]
    });
  });

  it("accepts alternate key names and trims the question", () => {
    expect(normalizeAskUserQuestionArgs({ prompt: "  Pick one  ", options: ["A", "B", "C"] })).toEqual({
      question: "Pick one",
      suggestions: ["A", "B", "C"]
    });
  });

  it("trims, drops empties, and de-duplicates suggestions", () => {
    expect(
      normalizeAskUserQuestionArgs({ question: "q", suggestions: ["  A  ", "", "A", "B"] }).suggestions
    ).toEqual(["A", "B"]);
  });

  it("parses suggestions that arrive as a JSON-array string", () => {
    expect(normalizeAskUserQuestionArgs({ question: "q", suggestions: '["X","Y"]' }).suggestions).toEqual(["X", "Y"]);
  });

  it("rejects fewer than two distinct suggestions", () => {
    expect(() => normalizeAskUserQuestionArgs({ question: "q", suggestions: ["only one"] })).toThrow(/at least 2/);
    expect(() => normalizeAskUserQuestionArgs({ question: "q", suggestions: ["dup", "dup"] })).toThrow(/at least 2/);
  });

  it("rejects a missing or empty question", () => {
    expect(() => normalizeAskUserQuestionArgs({ suggestions: ["A", "B"] })).toThrow(/question/);
    expect(() => normalizeAskUserQuestionArgs({ question: "   ", suggestions: ["A", "B"] })).toThrow(/question/);
  });
});
