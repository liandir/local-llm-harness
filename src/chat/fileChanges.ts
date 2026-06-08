import { renderLineDiff } from "./diffPreview.js";

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
  if (existing) {
    existing.path = args.path;
    existing.next = args.next;
    existing.diffPreview = existing.previous === args.previous ? args.diffPreview : undefined;
    return;
  }
  changes.set(args.key, {
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
    const diffPreview = change.diffPreview ?? renderLineDiff(change.previous, change.next);
    const stats = diffStats(diffPreview);
    if (stats.added === 0 && stats.removed === 0) continue;
    out.push({
      path: change.path,
      added: stats.added,
      removed: stats.removed,
      diffPreview
    });
  }
  return out;
}

function diffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+ ") || line.startsWith("+\t")) added++;
    else if (line.startsWith("- ") || line.startsWith("-\t")) removed++;
  }
  return { added, removed };
}
