const MAX_CAPPED_SIDE_LINES = 120;
const CONTEXT_LINES = 1;
// Myers runs in O((n+m)·D), so the only real cost is the edit distance D, which
// is tiny for the edits we care about (a few changed lines in a large file).
// We cap D by a trace-memory budget — past it the change is a near-total
// rewrite, where the capped summary is the honest fallback anyway.
const MAX_DIFF_TOTAL_LINES = 200_000;
const MAX_TRACE_CELLS = 4_000_000;
const MAX_DIFF_DISTANCE = 5000;

type DiffRow =
  | { kind: "context"; oldLine: number; newLine: number; text: string }
  | { kind: "add"; newLine: number; text: string }
  | { kind: "del"; oldLine: number; text: string };

/**
 * Accurate added/removed line counts, computed straight from the two texts —
 * NOT by parsing a rendered diff. The rendered preview is capped for an
 * enormous rewrite (renderCappedDiff just shows the first MAX_CAPPED_SIDE_LINES
 * of each side), so counting its `+`/`-` rows would report a constant +120/-120,
 * hiding what actually changed. Derived from the same Myers diff the preview
 * uses so the badge and the expanded diff always agree; an order-insensitive
 * multiset count covers the rare case the diff exceeds the distance budget.
 */
export function lineDiffStats(previous: string, next: string): { added: number; removed: number } {
  if (previous === next) return { added: 0, removed: 0 };
  const a = splitLines(previous);
  const b = splitLines(next);
  const rows = diffRows(a, b);
  if (!rows) return multisetLineStats(a, b);
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.kind === "add") added++;
    else if (row.kind === "del") removed++;
  }
  return { added, removed };
}

/**
 * Order-insensitive line counts for the rare diff past the distance budget: the
 * net surplus of each distinct line in one side over the other. Exact when no
 * identical lines are merely reordered, and always 0 for an unchanged file.
 */
function multisetLineStats(a: string[], b: string[]): { added: number; removed: number } {
  const counts = new Map<string, number>();
  for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
  for (const line of b) counts.set(line, (counts.get(line) ?? 0) - 1);
  let added = 0;
  let removed = 0;
  for (const surplus of counts.values()) {
    if (surplus > 0) removed += surplus;
    else if (surplus < 0) added += -surplus;
  }
  return { added, removed };
}

export function renderLineDiff(previous: string, next: string): string {
  if (previous === next) return "(no line changes)";

  const a = splitLines(previous);
  const b = splitLines(next);
  const rows = diffRows(a, b);
  if (!rows) return renderCappedDiff(a, b);
  const out = renderContextualRows(rows);
  return out.length === 0 ? "(no line changes)" : out.join("\n");
}

/**
 * The Myers O((n+m)·D) line diff. Returns the full add/del/context row sequence,
 * or null when the edit distance would exceed the trace budget (a near-total
 * rewrite the caller should summarize instead). The favour-deletions tie-break
 * keeps a deleted line ordered before the line that replaced it.
 */
function diffRows(a: string[], b: string[]): DiffRow[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  if (max > MAX_DIFF_TOTAL_LINES) return null;
  const maxD = Math.max(1, Math.min(MAX_DIFF_DISTANCE, Math.floor(MAX_TRACE_CELLS / (2 * max + 1))));
  const offset = max;
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= maxD; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1] // insertion: move down
          : v[offset + k - 1] + 1; // deletion: move right
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, offset);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], a: string[], b: string[], offset: number): DiffRow[] {
  const rows: DiffRow[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      rows.push({ kind: "context", oldLine: x, newLine: y, text: a[x - 1] });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) rows.push({ kind: "add", newLine: y, text: b[y - 1] });
      else rows.push({ kind: "del", oldLine: x, text: a[x - 1] });
    }
    x = prevX;
    y = prevY;
  }
  rows.reverse();
  return rows;
}

function renderCappedDiff(previousLines: string[], nextLines: string[]): string {
  const removed = previousLines
    .slice(0, MAX_CAPPED_SIDE_LINES)
    .map((line, i) => formatDiffRow({ kind: "del", oldLine: i + 1, text: line }));
  const added = nextLines
    .slice(0, MAX_CAPPED_SIDE_LINES)
    .map((line, i) => formatDiffRow({ kind: "add", newLine: i + 1, text: line }));
  const omittedRemoved = Math.max(0, previousLines.length - removed.length);
  const omittedAdded = Math.max(0, nextLines.length - added.length);
  const note = [
    `(large diff preview capped: showing ${removed.length} removed and ${added.length} added lines`,
    omittedRemoved || omittedAdded
      ? `; omitted ${omittedRemoved} removed and ${omittedAdded} added lines)`
      : ")"
  ].join("");
  return [note, ...removed, ...added].join("\n");
}

function renderContextualRows(rows: DiffRow[]): string[] {
  const included = new Set<number>();
  rows.forEach((row, index) => {
    if (row.kind === "context") return;
    const start = Math.max(0, index - CONTEXT_LINES);
    const end = Math.min(rows.length - 1, index + CONTEXT_LINES);
    for (let i = start; i <= end; i++) included.add(i);
  });

  const out: string[] = [];
  let last = -1;
  for (let i = 0; i < rows.length; i++) {
    if (!included.has(i)) continue;
    if (last >= 0 && i > last + 1) out.push("...\t\t\t...");
    out.push(formatDiffRow(rows[i]));
    last = i;
  }
  return out;
}

function formatDiffRow(row: DiffRow): string {
  if (row.kind === "context") return ` \t${row.oldLine}\t${row.newLine}\t${row.text}`;
  if (row.kind === "add") return `+\t\t${row.newLine}\t${row.text}`;
  return `-\t${row.oldLine}\t\t${row.text}`;
}

function splitLines(s: string): string[] {
  if (!s) return [];
  const withoutFinalNewline = s.endsWith("\n") ? s.slice(0, -1) : s;
  return withoutFinalNewline.split(/\r?\n/);
}
