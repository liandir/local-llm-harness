import { tokenize } from "../llm/client.js";
import type { ChatMessage, ChatRecord } from "./storage.js";

/**
 * Exact token counts keyed by the exact string tokenized. Repeated guard and
 * trigger passes within a turn — and unchanged messages across turns — reuse
 * the count instead of re-hitting /tokenize. Bounded so a long session can't
 * grow it without limit.
 */
const tokenCountCache = new Map<string, number>();
const TOKEN_CACHE_MAX = 1024;

/** Authoritative token count for a single string, with a bounded content cache. */
export async function countTokens(endpoint: string, text: string): Promise<number> {
  const cached = tokenCountCache.get(text);
  if (cached !== undefined) return cached;
  const n = await tokenize(endpoint, text);
  if (tokenCountCache.size >= TOKEN_CACHE_MAX) tokenCountCache.clear();
  tokenCountCache.set(text, n);
  return n;
}

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
      m.tokens = await countTokens(endpoint, formatForCounting(m));
    }
    total += m.tokens;
  }
  rec.totalTokens = total;
  return total;
}

/**
 * Exact token count of the *rendered* prompt actually sent to the model, not
 * the sum of stored messages. buildPromptMessages transforms the transcript
 * (re-renders tool calls, wraps tool results, prepends the system prompt), so
 * the rendered messages are the only faithful thing to count. llama.cpp adds a
 * few template/special tokens per message that /tokenize on the content does
 * not see; `overheadPerMessage` approximates them so the guard doesn't
 * under-count and let the server overflow.
 */
export async function promptTokens(
  endpoint: string,
  messages: { role: string; content: string }[],
  overheadPerMessage: number
): Promise<number> {
  let total = 0;
  for (const m of messages) {
    total += await countTokens(endpoint, `<|${m.role}|>${m.content}`);
    total += overheadPerMessage;
  }
  return total;
}

export interface TruncationResult {
  text: string;
  truncated: boolean;
  elidedTokens: number;
  elidedLines: number;
}

/**
 * Middle-truncate `text` so its token count fits within `maxTokens`, leaving a
 * visible marker where content was elided. The head is favored (60% of the
 * kept budget) because a tool result's first lines — the path, command, or
 * opening of a file — usually carry the most orientation. Tokenization is
 * non-linear in characters, so we converge over a few measured passes rather
 * than trusting a single ratio estimate.
 */
export async function truncateToTokenBudget(
  endpoint: string,
  text: string,
  maxTokens: number
): Promise<TruncationResult> {
  const total = await countTokens(endpoint, text);
  if (maxTokens <= 0) {
    const marker = elisionMarker(total, countNewlines(text));
    return { text: marker, truncated: true, elidedTokens: total, elidedLines: countNewlines(text) };
  }
  if (total <= maxTokens) return { text, truncated: false, elidedTokens: 0, elidedLines: 0 };

  const markerReserve = 48; // leave room for the marker itself inside the budget
  let keepTokens = Math.max(1, maxTokens - markerReserve);
  const charsPerToken = text.length / Math.max(1, total);
  let out = text;
  let elidedLines = 0;

  for (let attempt = 0; attempt < 6; attempt++) {
    const keepChars = Math.max(0, Math.floor(keepTokens * charsPerToken));
    const headChars = Math.floor(keepChars * 0.6);
    const tailChars = Math.max(0, keepChars - headChars);
    const head = text.slice(0, headChars);
    const tail = tailChars > 0 ? text.slice(text.length - tailChars) : "";
    const elidedMiddle = text.slice(head.length, text.length - tail.length);
    elidedLines = countNewlines(elidedMiddle);
    const approxElidedTokens = Math.max(1, total - keepTokens);
    out = head + elisionMarker(approxElidedTokens, elidedLines) + tail;
    const measured = await countTokens(endpoint, out);
    if (measured <= maxTokens) break;
    // Overshot the budget — shrink proportionally and try again.
    keepTokens = Math.max(1, Math.floor(keepTokens * (maxTokens / measured)) - 4);
  }

  const finalTokens = await countTokens(endpoint, out);
  return { text: out, truncated: true, elidedTokens: Math.max(0, total - finalTokens), elidedLines };
}

function elisionMarker(tokens: number, lines: number): string {
  return `\n\n[… context guard elided ≈${tokens} tokens / ${lines} lines …]\n\n`;
}

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === "\n") n++;
  return n;
}

function formatForCounting(m: ChatMessage): string {
  return `<|${m.role}|>${m.content}`;
}
