import type { WorkspacePort } from "../chat/session/ports.js";
import { GuardedWorkspace } from "../security/workspace/index.js";

/**
 * Hard cap on how much AGENTS.md content is folded into the system prompt.
 * The guarded reader applies its own larger source-file cap before this prompt
 * cap is enforced.
 */
export const MAX_AGENTS_MD_BYTES = 16 * 1024;

const TRUNCATION_MARKER = "\n…[AGENTS.md truncated]";

type WorkspaceReader = Pick<WorkspacePort, "readFile">;
type WorkspaceSource = WorkspaceReader | Promise<WorkspaceReader> | string;

/**
 * Read root AGENTS.md through the same workspace capability used by model
 * tools. Missing, linked, multiply-linked, non-file, oversized, or invalid
 * UTF-8 inputs are ignored instead of weakening the system-prompt boundary.
 */
export async function loadRootAgentsMd(
  source: WorkspaceSource,
  signal: AbortSignal = new AbortController().signal
): Promise<string | undefined> {
  try {
    const workspace = typeof source === "string"
      ? await GuardedWorkspace.create(source, signal)
      : await source;
    const raw = (await workspace.readFile({ path: "AGENTS.md" }, signal)).content;
    return normalizeAgentsMd(raw);
  } catch {
    return undefined;
  }
}

function normalizeAgentsMd(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (Buffer.byteLength(trimmed, "utf8") <= MAX_AGENTS_MD_BYTES) return trimmed;
  return truncateToBytes(trimmed, MAX_AGENTS_MD_BYTES) + TRUNCATION_MARKER;
}

/** Truncate to at most maxBytes UTF-8 bytes without splitting a code point. */
function truncateToBytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.toString("utf8", 0, end);
}
