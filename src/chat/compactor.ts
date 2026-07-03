import { complete } from "../llm/client.js";
import { countTokens, recomputeTokens, truncateToTokenBudget } from "./contextTracker.js";
import type { ChatRecord, ChatMessage } from "./storage.js";

/** Nominal minimum tail; the real tail is chosen by token budget (see CompactConfig). */
export const KEEP_TAIL = 4;
export const MIN_COMPACT_MESSAGES = KEEP_TAIL + 2;

const SUMMARY_SYSTEM =
  "You are summarizing a coding-assistant conversation so the assistant can keep working with less context. " +
  "The note you write becomes its ONLY memory of everything summarized, so keep every detail needed to continue. " +
  "Write a compact context note with exactly these sections:\n" +
  "GOAL: the user's objective and any constraints they stated.\n" +
  "STATE: files touched (exact workspace-relative paths) and the relevant functions or symbols; key decisions and why.\n" +
  "DONE: what is finished and how it was verified.\n" +
  "PENDING: open todos and known problems.\n" +
  "NEXT: the immediate next step.\n" +
  "Be specific — keep exact paths, names, and line numbers. Do not restate tool output or file contents verbatim.";

export interface CompactConfig {
  /** Effective context window in tokens (min of configured size and server n_ctx). */
  limit: number;
  /** Compact down toward this fraction of the limit. */
  thresholdPercent: number;
  /** Token budget for the verbatim recent tail. */
  tailBudgetPercent: number;
  /** Per-message truncation cap, as a fraction of the limit. */
  maxMessageTokensPercent: number;
  /** Template/special-token overhead llama.cpp adds per message. */
  overheadPerMessage: number;
}

export interface CompactResult {
  /** How many recent messages were kept verbatim after compaction. */
  keptTail: number;
}

export function compactAvailableForMessageCount(messageCount: number): boolean {
  return messageCount >= MIN_COMPACT_MESSAGES;
}

/**
 * Replace the bulk of history with a model-generated summary while keeping the
 * most recent messages that fit a token budget verbatim. Unlike a fixed tail,
 * this guarantees the result fits: oversized recent messages are middle-
 * truncated with a marker, the head is summarized in chunks so no single
 * summarization request overflows, and a final fit loop drops or truncates
 * anything still over budget. The summary becomes a leading `system` message.
 */
export async function compact(
  endpoint: string,
  rec: ChatRecord,
  signal: AbortSignal,
  cfg: CompactConfig
): Promise<CompactResult> {
  if (!compactAvailableForMessageCount(rec.messages.length)) {
    return { keptTail: rec.messages.length };
  }
  await recomputeTokens(endpoint, rec);

  const limit = Number.isFinite(cfg.limit) ? cfg.limit : Math.max(rec.totalTokens, 4096);
  const perMsgCap = Math.max(256, Math.floor((limit * cfg.maxMessageTokensPercent) / 100));
  const tailBudget = Math.max(perMsgCap, Math.floor((limit * cfg.tailBudgetPercent) / 100));

  // 1) Adaptive tail: the newest messages that fit within tailBudget.
  const split = selectTailStart(rec.messages, tailBudget, perMsgCap);
  const tail = rec.messages.slice(split);
  const head = rec.messages.slice(0, split);

  // 2) Truncate oversized verbatim-tail messages down to the per-message cap.
  for (const m of tail) {
    if ((m.tokens ?? 0) > perMsgCap) {
      const r = await truncateToTokenBudget(endpoint, m.content, perMsgCap);
      m.content = r.text;
      delete (m as { tokens?: number }).tokens;
    }
  }

  // 3) Summarize the head with map-reduce so no single request overflows.
  const summaryText = head.length > 0 ? await summarizeHead(endpoint, head, signal, cfg, limit, perMsgCap) : "";

  // 4) Assemble: [summary?] + verbatim tail.
  const next: ChatMessage[] = [];
  if (summaryText.trim()) {
    next.push({ role: "system", content: "[context summary]\n" + summaryText.trim(), ts: Date.now() });
  }
  next.push(...tail);
  rec.messages = next;
  for (const m of rec.messages) delete (m as { tokens?: number }).tokens;
  await recomputeTokens(endpoint, rec);

  // 5) Guarantee fit even if the summary + tail is still too big.
  await enforceFit(endpoint, rec, cfg, limit, perMsgCap);

  return { keptTail: rec.messages.length - (summaryText.trim() ? 1 : 0) };
}

/**
 * Index where the verbatim tail begins. Walks from the newest message, costing
 * oversized messages at the per-message cap (they'll be truncated to it), and
 * stops once the budget is spent — always keeping at least the last message and
 * always leaving at least one message in the head to summarize.
 */
function selectTailStart(messages: ChatMessage[], tailBudget: number, perMsgCap: number): number {
  let used = 0;
  let start = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = Math.min(messages[i].tokens ?? 0, perMsgCap) + 1;
    const firstPicked = start === messages.length;
    if (!firstPicked && used + cost > tailBudget) break;
    used += cost;
    start = i;
    if (used >= tailBudget) break;
  }
  // Never let the tail swallow the whole transcript — leave the oldest message
  // for the summary so compaction always reduces something.
  if (start === 0 && messages.length > 1) start = 1;
  return start;
}

/**
 * Summarize `head` in sequential windows that each fit the model's context,
 * carrying the running summary forward (map-reduce). A single oversized message
 * is truncated before chunking so it can't blow a window on its own.
 */
async function summarizeHead(
  endpoint: string,
  head: ChatMessage[],
  signal: AbortSignal,
  cfg: CompactConfig,
  limit: number,
  perMsgCap: number
): Promise<string> {
  // Reserve room for the instruction + the model's summary output; the rest is
  // the budget for the transcript portion of one summarization request.
  const outputReserve = Math.floor(limit * 0.25);
  const inputBudget = Math.max(512, Math.floor((limit * cfg.thresholdPercent) / 100) - outputReserve);

  // Demote every head message to `user` (content already prefixed with its
  // original role) so the only system message is the instruction — chat
  // templates like qwen3 raise on a later system message.
  const demoted: { content: string; tokens: number }[] = [];
  for (const m of head) {
    let content = `[${m.role}] ${m.content}`;
    let tokens = await countTokens(endpoint, `<|user|>${content}`);
    if (tokens > perMsgCap) {
      const r = await truncateToTokenBudget(endpoint, content, perMsgCap);
      content = r.text;
      tokens = await countTokens(endpoint, `<|user|>${content}`);
    }
    demoted.push({ content, tokens });
  }

  let running = "";
  let chunk: { content: string }[] = [];
  let chunkTokens = 0;
  const flush = async () => {
    if (chunk.length === 0) return;
    running = await summarizeChunk(endpoint, running, chunk, signal);
    chunk = [];
    chunkTokens = 0;
  };
  for (const m of demoted) {
    const runningCost = running ? await countTokens(endpoint, running) : 0;
    const cost = m.tokens + cfg.overheadPerMessage;
    if (chunk.length > 0 && chunkTokens + cost + runningCost > inputBudget) {
      await flush();
    }
    chunk.push({ content: m.content });
    chunkTokens += cost;
  }
  await flush();
  return running;
}

async function summarizeChunk(
  endpoint: string,
  priorSummary: string,
  chunk: { content: string }[],
  signal: AbortSignal
): Promise<string> {
  const instruction = priorSummary
    ? SUMMARY_SYSTEM +
      "\n\nA partial summary already exists. MERGE the transcript below into it, preserving every prior detail:\n" +
      "--- existing summary ---\n" +
      priorSummary +
      "\n--- end existing summary ---"
    : SUMMARY_SYSTEM;
  const messages: { role: "system" | "user"; content: string }[] = [
    { role: "system", content: instruction },
    ...chunk.map(m => ({ role: "user" as const, content: m.content }))
  ];
  const text = await complete(endpoint, { messages }, signal);
  return text.trim();
}

/**
 * Last-resort guarantee that the compacted transcript fits: drop the oldest
 * verbatim-tail messages (never the summary, never the final message) until at
 * or under the target, then truncate the surviving final message if it alone
 * still overflows the hard limit.
 */
async function enforceFit(
  endpoint: string,
  rec: ChatRecord,
  cfg: CompactConfig,
  limit: number,
  perMsgCap: number
): Promise<void> {
  const target = Math.max(perMsgCap, Math.floor((limit * cfg.thresholdPercent) / 100));
  const summaryOffset = rec.messages[0]?.content.startsWith("[context summary]") ? 1 : 0;

  while (rec.totalTokens > target && rec.messages.length - summaryOffset > 1) {
    rec.messages.splice(summaryOffset, 1);
    for (const m of rec.messages) delete (m as { tokens?: number }).tokens;
    await recomputeTokens(endpoint, rec);
  }

  const last = rec.messages[rec.messages.length - 1];
  if (last && rec.totalTokens > limit) {
    const r = await truncateToTokenBudget(endpoint, last.content, perMsgCap);
    last.content = r.text;
    delete (last as { tokens?: number }).tokens;
    await recomputeTokens(endpoint, rec);
  }
}
