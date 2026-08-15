import { complete } from "../llm/client.js";
import type { HarnessSettings } from "../config/settings.js";
import { titleFromFirstMessage } from "./storage.js";

const TITLE_SYSTEM_PROMPT = [
  "Create a concise title for a coding-assistant chat from the user's first message.",
  "Output only the title: 2 to 6 words, sentence case, with no quotation marks, markdown, or ending punctuation.",
  "Preserve important file names, commands, and product names when they identify the request."
].join(" ");

export async function generateChatTitle(
  firstMessage: string,
  settings: Pick<HarnessSettings, "endpoint" | "modelFamily" | "topK" | "topP">
): Promise<string> {
  const noThink = settings.modelFamily === "qwen3" ? "/no_think\n" : "";
  const titleSource = firstMessage.slice(0, 4_000);
  try {
    const raw = await complete(
      settings.endpoint,
      {
        temperature: 0.1,
        top_k: settings.topK,
        top_p: settings.topP,
        max_tokens: 32,
        messages: [
          { role: "system", content: TITLE_SYSTEM_PROMPT },
          { role: "user", content: `${noThink}<first_message>\n${titleSource}\n</first_message>` }
        ]
      },
      new AbortController().signal
    );
    return normalizeGeneratedTitle(raw) || titleFromFirstMessage(firstMessage);
  } catch {
    return titleFromFirstMessage(firstMessage);
  }
}

export function normalizeGeneratedTitle(raw: string): string {
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
  return words.slice(0, 6).join(" ");
}
