/** Keep dividers separate from full-width, scrollable card contents. */
export const CARD_SEPARATOR_HTML = '<div class="card-separator" aria-hidden="true"></div>';

/** Shared filled container for expanded tool results, including memory activity. */
export function renderToolOutputSurface(content: string, error: boolean, extraClass = ""): string {
  if (!content) return "";
  return `<div class="tool-output-surface${error ? " error" : ""}${extraClass}">${content}</div>`;
}
