import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Hard cap on how much AGENTS.md content we fold into the system prompt. The
 * block rides every model request and competes with the conversation for a
 * small local model's context window, so we keep it well under Codex's 32 KiB.
 * Oversized files are truncated with a marker rather than rejected.
 */
export const MAX_AGENTS_MD_BYTES = 16 * 1024;

const TRUNCATION_MARKER = "\n…[AGENTS.md truncated]";

interface CacheEntry {
  mtimeMs: number;
  value: string | undefined;
}

// Keyed by absolute AGENTS.md path. A stat() guards every read, so the cached
// value is reused only while the file is byte-for-byte unchanged — edits made
// mid-session are picked up on the next request.
const cache = new Map<string, CacheEntry>();

/**
 * Read the project's root `AGENTS.md` as standing instructions for the model.
 *
 * Returns the trimmed (and size-capped) contents, or `undefined` when the file
 * is missing, not a regular file, or empty — in which case no project-instruction
 * block is added to the system prompt.
 */
export async function loadRootAgentsMd(workspaceRoot: string): Promise<string | undefined> {
  const abs = path.join(workspaceRoot, "AGENTS.md");
  let mtimeMs: number;
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) return undefined;
    mtimeMs = stat.mtimeMs;
  } catch {
    // ENOENT or any stat failure: treat as "no AGENTS.md".
    cache.delete(abs);
    return undefined;
  }

  const cached = cache.get(abs);
  if (cached && cached.mtimeMs === mtimeMs) return cached.value;

  let value: string | undefined;
  try {
    const raw = await fs.readFile(abs, "utf-8");
    value = normalizeAgentsMd(raw);
  } catch {
    value = undefined;
  }
  cache.set(abs, { mtimeMs, value });
  return value;
}

function normalizeAgentsMd(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (Buffer.byteLength(trimmed, "utf-8") <= MAX_AGENTS_MD_BYTES) return trimmed;
  return truncateToBytes(trimmed, MAX_AGENTS_MD_BYTES) + TRUNCATION_MARKER;
}

/** Truncate to at most `maxBytes` UTF-8 bytes without splitting a code point. */
function truncateToBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  // Back off until we are not in the middle of a multi-byte sequence
  // (continuation bytes are 0b10xxxxxx).
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.toString("utf-8", 0, end);
}
