const MAX_EXACT_DIFF_BYTES = 160 * 1024;
const MAX_EXACT_DIFF_LINES = 1200;
const MAX_EXACT_DIFF_CELLS = 250_000;
const MAX_CAPPED_SIDE_LINES = 120;
const CONTEXT_LINES = 1;

type DiffRow =
  | { kind: "context"; oldLine: number; newLine: number; text: string }
  | { kind: "add"; newLine: number; text: string }
  | { kind: "del"; oldLine: number; text: string };

export function renderLineDiff(previous: string, next: string): string {
  if (previous === next) return "(no line changes)";

  const a = splitLines(previous);
  const b = splitLines(next);
  const tooLarge =
    previous.length + next.length > MAX_EXACT_DIFF_BYTES ||
    a.length + b.length > MAX_EXACT_DIFF_LINES ||
    a.length * b.length > MAX_EXACT_DIFF_CELLS;

  if (tooLarge) return renderCappedDiff(a, b);

  const dp = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      rows.push({ kind: "context", oldLine: i + 1, newLine: j + 1, text: a[i] });
      i++;
      j++;
    } else if (j < b.length && (i === a.length || dp[i][j + 1] > dp[i + 1][j])) {
      rows.push({ kind: "add", newLine: j + 1, text: b[j] });
      j++;
    } else if (i < a.length) {
      rows.push({ kind: "del", oldLine: i + 1, text: a[i] });
      i++;
    }
  }
  const out = renderContextualRows(rows);
  return out.length === 0 ? "(no line changes)" : out.join("\n");
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
