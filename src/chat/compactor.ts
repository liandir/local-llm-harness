import { complete } from "../llm/client.js";
import { recomputeTokens } from "./contextTracker.js";
import type { ChatRecord, ChatMessage } from "./storage.js";

export const KEEP_TAIL = 4;
export const MIN_COMPACT_MESSAGES = KEEP_TAIL + 2;

export function compactAvailableForMessageCount(messageCount: number): boolean {
  return messageCount >= MIN_COMPACT_MESSAGES;
}

/**
 * Replace the bulk of history with a model-generated summary, keeping the
 * most recent `KEEP_TAIL` messages verbatim. The summary becomes a
 * `system` message at the head of the transcript so the model has the
 * prior context for downstream turns.
 */
export async function compact(endpoint: string, rec: ChatRecord, signal: AbortSignal): Promise<void> {
  if (!compactAvailableForMessageCount(rec.messages.length)) return;
  const tail = rec.messages.slice(-KEEP_TAIL);
  const head = rec.messages.slice(0, rec.messages.length - KEEP_TAIL);

  const summaryPrompt: ChatMessage[] = [
    {
      role: "system",
      ts: Date.now(),
      content:
        "You are summarizing a coding-assistant conversation so the assistant can keep working with less context. " +
        "The note you write becomes its ONLY memory of everything summarized, so keep every detail needed to continue. " +
        "Write a compact context note with exactly these sections:\n" +
        "GOAL: the user's objective and any constraints they stated.\n" +
        "STATE: files touched (exact workspace-relative paths) and the relevant functions or symbols; key decisions and why.\n" +
        "DONE: what is finished and how it was verified.\n" +
        "PENDING: open todos and known problems.\n" +
        "NEXT: the immediate next step.\n" +
        "Be specific — keep exact paths, names, and line numbers. Do not restate tool output or file contents verbatim."
    },
    // Demote every head message to `user`: the content is already prefixed
    // with its original `[role]`, so this is lossless for the summarizer and
    // guarantees the only `system` message is the instruction at index 0.
    // Chat templates (e.g. qwen3) raise if a system message appears later.
    ...head.map(m => ({ role: "user", content: `[${m.role}] ${m.content}`, ts: m.ts }) as ChatMessage)
  ];

  const summaryText = await complete(
    endpoint,
    { messages: summaryPrompt.map(m => ({ role: m.role, content: m.content })) },
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
