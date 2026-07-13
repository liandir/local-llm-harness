import { createHash } from "node:crypto";
import { computeDiffRows, type DiffRow } from "./diffPreview.js";

export const MAX_EXACT_EDIT_DIFF_BYTES = 16 * 1024 * 1024;
const MAX_EXACT_SEGMENTS = 200_000;
const CONTEXT_SEGMENTS = 1;

export interface ExactEditDiff {
  /** Complete authorization artifact; every changed UTF-8 segment is present. */
  readonly text: string;
  readonly artifactSha256: string;
  readonly previousSha256: string;
  readonly nextSha256: string;
  readonly previousBytes: number;
  readonly nextBytes: number;
  readonly added: number;
  readonly removed: number;
}

export class ExactEditDiffLimitError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Exact edit diff exceeds the ${maxBytes}-byte approval limit; split the edit into smaller operations.`);
    this.name = "ExactEditDiffLimitError";
  }
}

/**
 * Render a byte-faithful, bounded approval artifact.
 *
 * Rows contain JSON-quoted exact text segments including their `\r`, `\n`, or
 * `\r\n` terminators. Controls, tabs, BOMs, bidi marks, and other format
 * characters are therefore visible and unambiguous. Unchanged spans may be
 * collapsed, but no added or removed segment is ever omitted. If a complete
 * artifact cannot fit the budget, preparation fails closed.
 */
export function renderExactEditDiff(
  previous: string,
  next: string,
  maxBytes = MAX_EXACT_EDIT_DIFF_BYTES
): ExactEditDiff {
  const previousBytes = Buffer.byteLength(previous, "utf8");
  const nextBytes = Buffer.byteLength(next, "utf8");
  const previousSha256 = sha256(previous);
  const nextSha256 = sha256(next);
  const lines: string[] = [];
  let serializedBytes = 0;
  const push = (line: string): void => {
    serializedBytes += Buffer.byteLength(line, "utf8") + (lines.length === 0 ? 0 : 1);
    if (serializedBytes > maxBytes) throw new ExactEditDiffLimitError(maxBytes);
    lines.push(line);
  };

  push("@@ exact-edit-v1: JSON-quoted UTF-8 segments; unchanged spans may be omitted @@");
  push(`# base bytes=${previousBytes} sha256=${previousSha256}`);
  push(`# next bytes=${nextBytes} sha256=${nextSha256}`);

  let added = 0;
  let removed = 0;
  if (previous === next) {
    push("(no byte changes)");
  } else {
    const before = splitExactSegments(previous);
    const after = splitExactSegments(next);
    const rows = before.values && after.values
      ? computeDiffRows(before.values, after.values)
      : null;
    if (!rows) {
      // High-distance or extremely line-dense changes use two exact whole-text
      // rows. This is less pretty, but remains complete and bounded.
      if (previous !== "") {
        push(`-\t1\t\t${quoteExact(previous)}`);
        removed = before.count;
      }
      if (next !== "") {
        push(`+\t\t1\t${quoteExact(next)}`);
        added = after.count;
      }
    } else {
      const included = includedRows(rows);
      let last = -1;
      for (let index = 0; index < rows.length; index++) {
        if (!included.has(index)) continue;
        if (last >= 0 && index > last + 1) push("...\t\t\t(unchanged exact segments omitted)");
        const row = rows[index];
        push(formatExactRow(row));
        if (row.kind === "add") added++;
        else if (row.kind === "del") removed++;
        last = index;
      }
    }
  }

  const text = lines.join("\n");
  return Object.freeze({
    text,
    artifactSha256: sha256(text),
    previousSha256,
    nextSha256,
    previousBytes,
    nextBytes,
    added,
    removed
  });
}

function splitExactSegments(text: string): { values: string[] | null; count: number } {
  if (text === "") return { values: [], count: 0 };
  let values: string[] | null = [];
  let count = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character !== "\r" && character !== "\n") continue;
    if (character === "\r" && text[index + 1] === "\n") index++;
    count++;
    if (values) {
      if (count <= MAX_EXACT_SEGMENTS) values.push(text.slice(start, index + 1));
      else values = null;
    }
    start = index + 1;
  }
  if (start < text.length) {
    count++;
    if (values) {
      if (count <= MAX_EXACT_SEGMENTS) values.push(text.slice(start));
      else values = null;
    }
  }
  return { values, count };
}

function includedRows(rows: readonly DiffRow[]): Set<number> {
  const included = new Set<number>();
  rows.forEach((row, index) => {
    if (row.kind === "context") return;
    const start = Math.max(0, index - CONTEXT_SEGMENTS);
    const end = Math.min(rows.length - 1, index + CONTEXT_SEGMENTS);
    for (let cursor = start; cursor <= end; cursor++) included.add(cursor);
  });
  return included;
}

function formatExactRow(row: DiffRow): string {
  if (row.kind === "context") {
    return ` \t${row.oldLine}\t${row.newLine}\t${quoteExact(row.text)}`;
  }
  if (row.kind === "add") return `+\t\t${row.newLine}\t${quoteExact(row.text)}`;
  return `-\t${row.oldLine}\t\t${quoteExact(row.text)}`;
}

function quoteExact(segment: string): string {
  return JSON.stringify(segment).replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, character => {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0xffff) return `\\u${codePoint.toString(16).padStart(4, "0")}`;
    const offset = codePoint - 0x10000;
    const high = 0xd800 + (offset >> 10);
    const low = 0xdc00 + (offset & 0x3ff);
    return `\\u${high.toString(16)}\\u${low.toString(16)}`;
  });
}

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}
