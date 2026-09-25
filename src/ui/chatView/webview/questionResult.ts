import type MarkdownIt from "markdown-it";
import { renderToolOutputSurface } from "./toolOutputSurface.js";

interface QuestionCard {
  argsJson: string;
  status: string;
  resultPreview?: string;
}

interface QuestionPayload {
  question: string;
  suggestions: string[];
}

export function parseQuestionPayload(card: Pick<QuestionCard, "argsJson">): QuestionPayload {
  try {
    const parsed = JSON.parse(card.argsJson) as { question?: unknown; suggestions?: unknown };
    const question = typeof parsed.question === "string" ? parsed.question : "";
    const suggestions = Array.isArray(parsed.suggestions)
      ? parsed.suggestions.filter((s): s is string => typeof s === "string")
      : [];
    return { question, suggestions };
  } catch {
    return { question: "", suggestions: [] };
  }
}

/** Decode the stored answer without changing its whitespace or quoted text. */
export function answeredValue(card: Pick<QuestionCard, "status" | "resultPreview">): string | undefined {
  if (card.status !== "executed" || !card.resultPreview) return undefined;
  return /^the user has answered your question: "([\s\S]*)"$/.exec(card.resultPreview)?.[1];
}

export function renderQuestionResult(card: QuestionCard, md: MarkdownIt): string {
  const { question, suggestions } = parseQuestionPayload(card);
  const answer = answeredValue(card);
  const selected = answer === undefined ? -1 : suggestions.indexOf(answer);
  const error = card.status === "failed" || card.status === "rejected";
  let response = card.resultPreview ?? (card.status === "executed" ? "" : "Waiting for the user’s answer.");
  if (answer !== undefined) {
    response = selected >= 0
      ? `The user chose option ${String.fromCharCode(65 + selected)}.`
      : `The user answered: ${answer}`;
  } else if (card.resultPreview?.startsWith("[ask_user_question dismissed]")) {
    response = "The user did not answer the question.";
  }

  const questionSection = `<div class="tool-question-section assistant-markdown">${md.render(question || "Question")}</div>`;
  const optionsSection = suggestions.length
    ? `<ul class="tool-question-section tool-question-options">${suggestions.map((suggestion, index) =>
      `<li>Option ${String.fromCharCode(65 + index)}: ${md.utils.escapeHtml(suggestion)}</li>`
    ).join("")}</ul>`
    : "";
  const answerSection = response
    ? `<div class="tool-question-section tool-question-answer">${md.utils.escapeHtml(response)}</div>`
    : "";
  return renderToolOutputSurface(questionSection + optionsSection + answerSection, error);
}
