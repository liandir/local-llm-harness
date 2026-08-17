import { complete } from "../llm/client.js";
import type { HarnessSettings } from "../config/settings.js";

const TITLE_TOKEN_BUDGETS = [32, 32] as const;

export async function generateChatTitle(
  firstMessage: string,
  settings: Pick<HarnessSettings, "endpoint" | "modelFamily" | "topK" | "topP">
): Promise<string> {
  const titleSource = firstMessage.slice(0, 4_000);
  const attemptResults: string[] = [];

  for (let attempt = 0; attempt < TITLE_TOKEN_BUDGETS.length; attempt++) {
    try {
      const retryInstruction = attempt === 0
        ? ""
        : "A previous attempt produced no valid visible answer.\n";
      const raw = await complete(
        settings.endpoint,
        {
          temperature: 0.1,
          top_k: settings.topK,
          top_p: settings.topP,
          max_tokens: TITLE_TOKEN_BUDGETS[attempt],
          // llama.cpp supports disabling reasoning per request. `/no_think`
          // below is a harmless compatibility hint for older/model templates.
          thinking_budget_tokens: 0,
          messages: [
            {
              role: "user",
              content: [
                "/no_think",
                retryInstruction,
                "Please summarize the following using 2-6 words:",
                `<user_prompt>\n${titleSource}\n</user_prompt>`,
                "Output ONLY the 2-6 words."
              ].join("\n")
            }
          ]
        },
        new AbortController().signal
      );
      // `complete` collects visible text only; reasoning stays separate just
      // as it does in the normal chat UI.
      attemptResults.push(describeTitleOutput(raw));
      const title = normalizeGeneratedTitle(raw);
      if (title) return title;
    } catch (error) {
      attemptResults.push(`request error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(
    `The model did not produce a usable chat name after two attempts. ` +
    attemptResults.map((result, index) => `Attempt ${index + 1}: ${result}`).join("; ")
  );
}

export function normalizeGeneratedTitle(raw: string | undefined): string {
  if (!raw) return "";
  const withoutThinking = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const firstLine = withoutThinking
    .replace(/^```(?:text|markdown)?\s*/i, "")
    .replace(/```$/i, "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean) ?? "";
  const unwrapped = firstLine
    .replace(/^(?:title\s*:\s*)/i, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.!?;:,]+$/g, "")
    .trim();
  const words = unwrapped.split(/\s+/).filter(Boolean);
  if (words.length < 2) return "";
  return words.join(" ");
}

function describeTitleOutput(raw: string | undefined): string {
  const oneLine = raw?.replace(/\s+/g, " ").trim() ?? "";
  if (!oneLine) return "(empty visible response)";
  const limit = 240;
  const display = oneLine.length > limit ? `${oneLine.slice(0, limit - 1)}…` : oneLine;
  return JSON.stringify(display);
}
