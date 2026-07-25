import { describe, expect, it } from "vitest";
import {
  hasBoundCommandReview,
  renderCommandReviewArtifact
} from "../src/ui/chatView/webview/commandReview.js";

describe("sandbox command approval review", () => {
  const complete = {
    category: "safeCmd",
    approval: {
      sessionId: "session",
      turnId: "turn",
      proposalId: "proposal",
      decisionToken: "token",
      toolId: "tool",
      reviewDigest: "digest"
    },
    reviewFormat: "command-v1",
    reviewPreview: "sandbox command approval v1\ncommand: \"npm test\""
  } as const;

  it("allows a decision only for a bound, complete command-v1 review", () => {
    expect(hasBoundCommandReview(complete)).toBe(true);
  });

  it("fails closed when any authoritative review component is absent or wrong", () => {
    expect(hasBoundCommandReview({ ...complete, approval: undefined })).toBe(false);
    expect(hasBoundCommandReview({ ...complete, approval: { opaque: true } })).toBe(false);
    expect(hasBoundCommandReview({ ...complete, reviewFormat: undefined })).toBe(false);
    expect(hasBoundCommandReview({ ...complete, reviewFormat: "exact-v1" })).toBe(false);
    expect(hasBoundCommandReview({ ...complete, reviewPreview: "" })).toBe(false);
    expect(hasBoundCommandReview({ ...complete, category: "unsafeCmd" })).toBe(false);
  });

  it("renders the entire artifact as one escaped preformatted text payload", () => {
    const artifact = "command: \"</pre><script>alert(1)</script>\"\nargs: [\"a\\tb\"]";
    const html = renderCommandReviewArtifact(artifact);

    expect(html.match(/<pre/g)).toHaveLength(1);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;/pre&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("\nargs: [&quot;a\\tb&quot;]");
  });
});
