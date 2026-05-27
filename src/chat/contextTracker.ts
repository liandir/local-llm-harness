import { tokenize } from "../llm/client.js";
import type { ChatMessage, ChatRecord } from "./storage.js";

/**
 * Lazily attaches a token count to each message; returns the sum.
 * Uses the endpoint's /tokenize where reachable, falling back to a char/4
 * heuristic. Caching on each message means recompute is amortized.
 */
export async function recomputeTokens(
  endpoint: string,
  rec: ChatRecord
): Promise<number> {
  let total = 0;
  for (const m of rec.messages) {
    if (typeof m.tokens !== "number") {
      m.tokens = await tokenize(endpoint, formatForCounting(m));
    }
    total += m.tokens;
  }
  rec.totalTokens = total;
  return total;
}

function formatForCounting(m: ChatMessage): string {
  return `<|${m.role}|>${m.content}`;
}
