export function reorderItemsById<T extends { id: string }>(items: T[], orderedIds: string[]): T[] {
  const byId = new Map(items.map(item => [item.id, item]));
  const seen = new Set<string>();
  const reordered: T[] = [];

  for (const id of orderedIds) {
    const item = byId.get(id);
    if (!item || seen.has(id)) continue;
    seen.add(id);
    reordered.push(item);
  }
  for (const item of items) {
    if (!seen.has(item.id)) reordered.push(item);
  }
  return reordered;
}

export function shouldDrainMessageQueue(options: {
  queueLength: number;
  messageLoopRunning: boolean;
  sessionCreationPending: boolean;
  turnActive: boolean;
}): boolean {
  return options.queueLength > 0
    && !options.messageLoopRunning
    && !options.sessionCreationPending
    && !options.turnActive;
}
