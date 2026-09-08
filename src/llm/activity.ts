/** Extension-local foreground activity; background inference yields immediately. */
let foreground = 0;
const listeners = new Set<() => void>();
export function foregroundBusy(): boolean { return foreground > 0; }
export function onForegroundChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function beginForeground(): () => void {
  foreground++;
  for (const listener of listeners) listener();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    foreground--;
    for (const listener of listeners) listener();
  };
}
