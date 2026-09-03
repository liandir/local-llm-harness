/**
 * Estimate streamed reasoning tokens when the server does not expose a live,
 * reasoning-only usage count. This matches the harness's mid-turn fallback.
 */
export function estimatedThoughtTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function thoughtTokenLabel(live: boolean, text: string): string {
  const state = live ? "Thinking" : "Thought";
  return `${state} — ${estimatedThoughtTokens(text)} tokens`;
}
