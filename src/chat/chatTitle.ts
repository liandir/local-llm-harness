import { complete } from "../llm/client.js";
import type { HarnessSettings } from "../config/settings.js";

/** Best-effort chat naming. A naming failure must never block the real chat. */
export async function generateChatTitle(
  firstMessage: string,
  settings: Pick<HarnessSettings, "endpoint" | "topK" | "topP" | "titlePrompt">,
  signal: AbortSignal = new AbortController().signal
): Promise<string | undefined> {
  try {
    const raw = await complete(
      settings.endpoint,
      {
        temperature: 0.1,
        top_k: settings.topK,
        top_p: settings.topP,
        // A title is only a few words. Keep a hard ceiling because some local
        // models fail to emit EOS after the title, which would otherwise block
        // the real chat for hundreds of unnecessary tokens.
        messages: [{
          role: "user",
          content: [
            settings.titlePrompt,
            "",
            `User message: ${JSON.stringify(firstMessage.slice(0, 4_000))}`
          ].join("\n")
        }]
      },
      signal,
      { acceptPartialOnLength: true }
    );
    return normalizeGeneratedTitle(raw) || undefined;
  } catch {
    return undefined;
  }
}

export function normalizeGeneratedTitle(raw: string | undefined): string {
  if (!raw) return "";
  const firstLine = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^```(?:text|markdown)?\s*/i, "")
    .replace(/```$/i, "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean) ?? "";
  return firstLine
    .replace(/^title\s*:\s*/i, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.!?;:,]+$/g, "")
    .trim();
}
