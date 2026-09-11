import { createHash } from "node:crypto";
import type { ChatRecord } from "./storage.js";
import { DEFAULT_MEMORY_MAX_COUNT, MAX_MEMORY_COUNT } from "./memoryLimits.js";

export const MEMORY_SUMMARY_TOKENS = 384;
export interface ChatMemory {
  text: string;
  sourceRevision: string;
  generatedAt: number;
  enabled: boolean;
  manual: boolean;
  error?: string;
}
export interface MemorySnapshot {
  sourceId: string;
  title: string;
  sourceRevision: string;
  generatedAt: number;
  text: string;
}
export interface MemoryListItem extends MemorySnapshot {
  status: "ready" | "manual" | "stale" | "missing" | "failed" | "queued" | "generating";
  enabled: boolean;
  /** Actual source eligibility, independent of queue/display status. */
  usable: boolean;
  error?: string;
}

export function transcriptRevision(rec: ChatRecord): string {
  // Exclude token caches, context summaries, imported memories and hidden reasoning.
  return createHash("sha256").update(JSON.stringify(rec.messages.map(m => ({
    role: m.role, content: m.content, ts: m.ts,
    attachments: m.attachments, toolCall: m.toolCall, fileChanges: m.fileChanges
  })))).digest("hex");
}
export function usableMemory(rec: ChatRecord): boolean {
  const memory = rec.memory;
  return !!memory?.enabled && !!memory.text.trim() && !memory.error
    && (memory.manual || memory.sourceRevision === transcriptRevision(rec));
}
export function validMemory(value: unknown): value is ChatMemory {
  if (!value || typeof value !== "object") return false;
  const m = value as ChatMemory;
  return typeof m.text === "string" && m.text.length <= 20000
    && typeof m.sourceRevision === "string" && /^[a-f0-9]{64}$/.test(m.sourceRevision)
    && validTimestamp(m.generatedAt) && typeof m.enabled === "boolean" && typeof m.manual === "boolean"
    && (m.error === undefined || typeof m.error === "string");
}
export function validSnapshot(value: unknown): value is MemorySnapshot {
  if (!value || typeof value !== "object") return false;
  const m = value as MemorySnapshot;
  return typeof m.sourceId === "string" && /^[a-f0-9-]{36}$/i.test(m.sourceId)
    && typeof m.title === "string" && typeof m.text === "string" && m.text.length <= 20000
    && typeof m.sourceRevision === "string" && /^[a-f0-9]{64}$/.test(m.sourceRevision)
    && validTimestamp(m.generatedAt);
}
function validTimestamp(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 8640000000000000;
}

const STOP_WORDS = new Set("a an and are as at be been but by can chat could do for from had has have how i in is it its me my of on or our please that the their them there these they this to use was we what when where which with would you your".split(" "));
function terms(text: string): string[] {
  return (text.normalize("NFKC").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])
    .filter(word => word.length > 1 && !STOP_WORDS.has(word));
}
/** BM25 over local titles and summaries; no network request for retrieval. */
export function rankMemories(query: string, records: ChatRecord[], currentId: string): MemorySnapshot[] {
  const candidates = records.filter(r => r.id !== currentId && usableMemory(r));
  const docs = candidates.map(r => terms(`${r.title} ${r.memory!.text}`));
  const words = [...new Set(terms(query))];
  const avgLength = docs.reduce((n, doc) => n + doc.length, 0) / Math.max(1, docs.length) || 1;
  const frequencies = words.map(word => docs.filter(doc => doc.includes(word)).length);
  return candidates.map((rec, i) => {
    const doc = docs[i];
    const score = words.reduce((sum, word, j) => {
      const tf = doc.filter(term => term === word).length;
      const idf = Math.log(1 + (docs.length - frequencies[j] + 0.5) / (frequencies[j] + 0.5));
      return sum + idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * doc.length / avgLength));
    }, 0);
    const titleWords = terms(rec.title);
    const titleBoost = words.filter(word => titleWords.includes(word)).length * 2;
    const phrase = terms(query).join(" ");
    const phraseBoost = words.length > 1 && doc.join(" ").includes(phrase) ? 2 : 0;
    return { rec, score: score + titleBoost + phraseBoost };
  }).filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || b.rec.memory!.generatedAt - a.rec.memory!.generatedAt || a.rec.id.localeCompare(b.rec.id))
    .map(({ rec }) => ({ sourceId: rec.id, title: rec.title, ...pickSnapshot(rec.memory!) }));
}
function pickSnapshot(m: ChatMemory): Omit<MemorySnapshot, "sourceId" | "title"> {
  return { text: m.text, sourceRevision: m.sourceRevision, generatedAt: m.generatedAt };
}
/** Versioned identity: source ID disambiguates identical names and contents. */
export function memoryId(memory: MemorySnapshot): string {
  return createHash("sha256").update(JSON.stringify([memory.sourceId, memory.title, memory.text])).digest("hex").slice(0, 16);
}

export function memoryMetadata(memory: MemorySnapshot): { id: string; name: string; date: string } {
  return { id: memoryId(memory), name: memory.title, date: new Date(memory.generatedAt).toISOString().replace(/:\d{2}\.\d{3}Z$/, "Z") };
}

export function searchMemories(query: string, records: ChatRecord[], currentId: string, limit = DEFAULT_MEMORY_MAX_COUNT): {
  memories: ReturnType<typeof memoryMetadata>[]; total: number; truncated: boolean;
} {
  if (typeof query !== "string" || !query.trim()) throw new Error("search_memories requires a non-empty query.");
  const ranked = rankMemories(query, records, currentId);
  const count = Number.isFinite(limit) ? Math.max(1, Math.min(MAX_MEMORY_COUNT, Math.floor(limit))) : DEFAULT_MEMORY_MAX_COUNT;
  return { memories: ranked.slice(0, count).map(memoryMetadata), total: ranked.length, truncated: ranked.length > count };
}

/** Re-resolve both fields against live eligible sources; never recall a cached search result. */
export function recallMemory(name: string, id: string, records: ChatRecord[], currentId: string): MemorySnapshot {
  if (typeof name !== "string" || !name.trim() || typeof id !== "string" || !id.trim()) {
    throw new Error("recall_memory requires the exact name and id returned by search_memories.");
  }
  const matches = records.filter(rec => rec.id !== currentId && usableMemory(rec) && rec.title === name)
    .map(rec => ({ sourceId: rec.id, title: rec.title, ...pickSnapshot(rec.memory!) }))
    .filter(memory => memoryId(memory) === id);
  if (matches.length !== 1) throw new Error("No unique active memory matches this name and id. Search memories again; the source may have changed or been deactivated.");
  return matches[0];
}

/** Remove common credential forms before summarization and from its output. */
export function redactMemorySecrets(text: string): string {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[credential omitted]")
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9_]{12,}|github_pat_[a-zA-Z0-9_]+|AKIA[A-Z0-9]{16})\b/g, "[credential omitted]")
    .replace(/\b(Bearer)\s+[^\s"'`]+/gi, "$1 [credential omitted]")
    .replace(/\b(password|passwd|secret|api[_-]?key|access[_-]?token|token)\b(["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, "$1$2[credential omitted]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[credential omitted]@");
}
