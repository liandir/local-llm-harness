/** Minimal shape needed to decide whether a sandbox-command decision is safe to render. */
export interface CommandReviewState {
  readonly category: string;
  readonly approval?: unknown;
  readonly reviewPreview?: string;
  readonly reviewFormat?: string;
}

/**
 * A pending sandbox command is actionable only when the host supplied both its
 * opaque one-shot binding and the complete command-v1 review artifact.
 */
export function hasBoundCommandReview(review: CommandReviewState): boolean {
  return review.category === "safeCmd"
    && isApprovalBinding(review.approval)
    && review.reviewFormat === "command-v1"
    && typeof review.reviewPreview === "string"
    && review.reviewPreview.length > 0;
}

/** Render the complete artifact as one inert text node; never syntax-highlight it. */
export function renderCommandReviewArtifact(review: string): string {
  return `<pre class="approval-command-artifact">${escapeReviewText(review)}</pre>`;
}

function escapeReviewText(value: string): string {
  return value.replace(/[&<>"]/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;"
  }[character]!));
}

function isApprovalBinding(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  const keys = [
    "sessionId",
    "turnId",
    "proposalId",
    "decisionToken",
    "toolId",
    "reviewDigest"
  ];
  const ownKeys = Object.keys(binding);
  return ownKeys.length === keys.length
    && ownKeys.every(key => keys.includes(key))
    && keys.every(key => Object.prototype.hasOwnProperty.call(binding, key)
      && typeof binding[key] === "string"
      && binding[key].length > 0);
}
