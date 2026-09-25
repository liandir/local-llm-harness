import { describe, expect, it } from "vitest";
import MarkdownIt from "markdown-it";
import { answeredValue, parseQuestionPayload, renderQuestionResult } from "../src/ui/chatView/webview/questionResult.js";

const md = new MarkdownIt({ html: false });
const argsJson = JSON.stringify({ question: "Which **database** should we use?", suggestions: ["Postgres", "SQLite", "MySQL"] });
const answered = (answer: string) => ({
  argsJson, status: "executed", resultPreview: `the user has answered your question: "${answer}"`
});

describe("expanded question results", () => {
  it.each([["Postgres", "A"], ["SQLite", "B"], ["MySQL", "C"]])(
    "shows the question, original options, and selected option for %s",
    (answer, label) => {
      const html = renderQuestionResult(answered(answer), md);
      expect(html).toContain('class="tool-output-surface"');
      expect(html).toContain("Which <strong>database</strong> should we use?");
      expect(html).toContain("<li>Option A: Postgres</li><li>Option B: SQLite</li><li>Option C: MySQL</li>");
      expect(html).toContain(`The user chose option ${label}.`);
      expect(html.match(/class="tool-question-section/g)).toHaveLength(3);
      expect(html.indexOf("database")).toBeLessThan(html.indexOf("Option A:"));
      expect(html.indexOf("Option C:")).toBeLessThan(html.indexOf("The user chose"));
      expect(html).not.toContain("the user has answered your question");
      expect(html).not.toContain("The user answered:");
    }
  );

  it("preserves a long custom answer, including quotes, line breaks, and spacing", () => {
    const answer = `Use a different database.\n${'Keep "all" of this text.  '.repeat(40)}\nFinal detail.`;
    const card = answered(answer);
    expect(answeredValue(card)).toBe(answer);
    expect(renderQuestionResult(card, md)).toContain(`The user answered: ${md.utils.escapeHtml(answer)}`);
    expect(renderQuestionResult(card, md)).not.toContain("The user chose option");
  });

  it("does not mistake a partial or case-insensitive suggestion match for a selected option", () => {
    for (const answer of ["sqlite", "SQLite, with these changes"]) {
      expect(renderQuestionResult(answered(answer), md)).toContain(`The user answered: ${answer}`);
    }
  });

  it("escapes question, option, and answer HTML without treating the answer as Markdown", () => {
    const html = renderQuestionResult({
      argsJson: JSON.stringify({ question: "<script>alert(1)</script>", suggestions: ['<img src=x onerror="alert(1)">', "Safe"] }),
      status: "executed",
      resultPreview: 'the user has answered your question: "<img src=x> **literal**"'
    }, md);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Option A: &lt;img");
    expect(html).toContain("The user answered: &lt;img src=x&gt; **literal**");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<strong>literal</strong>");
  });

  it("shows unanswered questions without inventing a choice", () => {
    const html = renderQuestionResult({ argsJson, status: "pending" }, md);
    expect(html).toContain("Option A: Postgres");
    expect(html).toContain("Waiting for the user’s answer.");
    expect(html).not.toContain("The user chose");
  });

  it("retains the question and options when a question is dismissed", () => {
    const html = renderQuestionResult({
      argsJson, status: "rejected", resultPreview: "[ask_user_question dismissed] The user did not answer the question."
    }, md);
    expect(html).toContain('class="tool-output-surface error"');
    expect(html).toContain("Option B: SQLite");
    expect(html).toContain("The user did not answer the question.");
    expect(html).not.toContain("[ask_user_question dismissed]");
  });

  it("preserves diagnostics when arguments or result formats are unavailable", () => {
    const html = renderQuestionResult({ argsJson: "{", status: "failed", resultPreview: "error: Missing question" }, md);
    expect(html).toContain('class="tool-output-surface error"');
    expect(html).toContain("error: Missing question");
    expect(html).not.toContain("Option A:");
    expect(renderQuestionResult({ argsJson, status: "executed", resultPreview: "Legacy response" }, md)).toContain("Legacy response");
  });

  it("handles missing and malformed payloads used by the pending composer", () => {
    expect(parseQuestionPayload({ argsJson: "null" })).toEqual({ question: "", suggestions: [] });
    expect(parseQuestionPayload({ argsJson: '{"question":"Pick one","suggestions":["First",null,"Second"]}' }))
      .toEqual({ question: "Pick one", suggestions: ["First", "Second"] });
  });
});
