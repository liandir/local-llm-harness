import { complete } from "../llm/client.js";
import { recomputeTokens } from "./contextTracker.js";
import type { ChatRecord, ChatMessage } from "./storage.js";

const KEEP_TAIL = 4;

/**
 * Replace the bulk of history with a model-generated summary, keeping the
 * most recent `KEEP_TAIL` messages verbatim. The summary becomes a
 * `system` message at the head of the transcript so the model has the
 * prior context for downstream turns.
 */
export async function compact(endpoint: string, rec: ChatRecord, signal: AbortSignal): Promise<void> {
  if (rec.messages.length <= KEEP_TAIL + 1) return;
  const tail = rec.messages.slice(-KEEP_TAIL);
  const head = rec.messages.slice(0, rec.messages.length - KEEP_TAIL);

  const summaryPrompt: ChatMessage[] = [
    {
      role: "system",
      ts: Date.now(),
      content:
        "Summarize the following coding-assistant conversation as a concise context note. " +
        "Preserve: the user's goal, files touched, decisions made, open todos. Avoid restating tool I/O verbatim."
    },
    ...head.map(m => ({ role: m.role, content: `[${m.role}] ${m.content}`, ts: m.ts }) as ChatMessage)
  ];

  const summaryText = await complete(
    endpoint,
    { messages: summaryPrompt.map(m => ({ role: m.role === "tool" ? "user" : m.role, content: m.content })) },
    signal
  );

  const replacement: ChatMessage = {
    role: "system",
    content: "[context summary]\n" + summaryText.trim(),
    ts: Date.now()
  };
  rec.messages = [replacement, ...tail];
  // force a re-tokenize on next read
  for (const m of rec.messages) delete (m as { tokens?: number }).tokens;
  await recomputeTokens(endpoint, rec);
}
