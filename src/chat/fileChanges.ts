import { lineDiffStats, renderLineDiff } from "./diffPreview.js";
import { renderExactEditDiff } from "./exactEditDiff.js";

export interface FileChangeSummary {
  path: string;
  added: number;
  removed: number;
  diffPreview: string;
}

export interface TrackedFileWrite {
  path: string;
  previous: string;
  next: string;
  diffPreview?: string;
}

export function rememberFileWrite(
  changes: Map<string, TrackedFileWrite>,
  args: { key: string; path: string; previous: string; next: string; diffPreview?: string }
): void {
  const existing = changes.get(args.key);
  if (existing && existing.next === args.previous) {
    existing.path = args.path;
    existing.next = args.next;
    existing.diffPreview = existing.previous === args.previous ? args.diffPreview : undefined;
    return;
  }
  // If disk state changed outside this tracked run, do not attribute the
  // unrelated bytes to the model by folding both histories into one summary.
  let segmentKey = args.key;
  for (let segment = 2; changes.has(segmentKey); segment++) {
    segmentKey = `${args.key}\0segment:${segment}`;
  }
  changes.set(segmentKey, {
    path: args.path,
    previous: args.previous,
    next: args.next,
    diffPreview: args.diffPreview
  });
}

export function summarizeFileChanges(changes: Iterable<TrackedFileWrite>): FileChangeSummary[] {
  const out: FileChangeSummary[] = [];
  for (const change of changes) {
    if (change.previous === change.next) continue;
    let diffPreview = change.diffPreview ?? renderLineDiff(change.previous, change.next);
    // Count from the texts, not the (possibly capped) preview, so a small edit
    // to a large file isn't misreported as a full +N/-N rewrite.
    const stats = lineDiffStats(change.previous, change.next);
    if (stats.added === 0 && stats.removed === 0) continue;
    if (diffPreview === "(no line changes)") {
      // The legacy line preview intentionally normalizes some terminators.
      // Use the exact renderer for this byte-only case so final-newline changes
      // cannot contradict the non-zero attribution badge.
      try {
        diffPreview = renderExactEditDiff(change.previous, change.next).text;
      } catch {
        diffPreview = "(byte-level UTF-8 change; exact summary exceeds the display limit)";
      }
    }
    out.push({
      path: change.path,
      added: stats.added,
      removed: stats.removed,
      diffPreview
    });
  }
  return out;
}

export function diffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+ ") || line.startsWith("+\t")) added++;
    else if (line.startsWith("- ") || line.startsWith("-\t")) removed++;
  }
  return { added, removed };
}
