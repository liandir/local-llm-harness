export function restoredRecordMessageId(index: number, ts: number): string {
  return `r_${index}_${safeTimestamp(ts)}`;
}

export function restoredToolCardId(index: number, ts: number): string {
  return `rt_${index}_${safeTimestamp(ts)}`;
}

function safeTimestamp(ts: number): string {
  return Number.isFinite(ts) ? String(ts) : "unknown";
}
