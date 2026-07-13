import { describe, expect, it } from "vitest";
import type { PreparedWorkspaceEdit } from "../src/chat/session/ports.js";
import type { ProposalScope } from "../src/chat/approvalCoordinator.js";
import {
  editReviewDigest,
  toolReviewDigest,
  type PreparedEditTransaction
} from "../src/chat/editTransactions.js";
import { renderExactEditDiff, type ExactEditDiff } from "../src/chat/exactEditDiff.js";

describe("edit review digests", () => {
  it("is sensitive to every proposal-scope field", () => {
    const scope = baseScope();
    const transaction = baseTransaction();
    const baseline = editReviewDigest(scope, transaction);
    const variants: ProposalScope[] = [
      { ...scope, sessionId: "session-2" },
      { ...scope, turnId: "turn-2" },
      { ...scope, proposalId: "proposal-2" },
      { ...scope, decisionToken: "token-2" },
      { ...scope, toolId: "tool-2" }
    ];

    expect(baseline).toMatch(/^[0-9a-f]{64}$/);
    for (const variant of variants) {
      expect(editReviewDigest(variant, transaction)).not.toBe(baseline);
    }
  });

  it("binds transaction identity, operation, path, base revision, and exact review", () => {
    const scope = baseScope();
    const transaction = baseTransaction();
    const baseline = editReviewDigest(scope, transaction);
    const editVariants: PreparedWorkspaceEdit[] = [
      { ...transaction.edit, transactionId: "transaction-2" },
      { ...transaction.edit, kind: "insert_text" },
      { ...transaction.edit, path: "src/other.ts" },
      { ...transaction.edit, baseRevision: "base-2" }
    ];
    for (const edit of editVariants) {
      expect(editReviewDigest(scope, { ...transaction, edit })).not.toBe(baseline);
    }

    const changedBase = transactionWithReview("OLD\n", "new\n");
    const changedNext = transactionWithReview("old\n", "NEW\n");
    const changedArtifact: ExactEditDiff = {
      ...transaction.review,
      artifactSha256: "f".repeat(64)
    };
    expect(editReviewDigest(scope, changedBase)).not.toBe(baseline);
    expect(editReviewDigest(scope, changedNext)).not.toBe(baseline);
    expect(editReviewDigest(scope, { ...transaction, review: changedArtifact })).not.toBe(baseline);
  });

  it("length-prefixes tool approval fields so values cannot cross field boundaries", () => {
    const scope = baseScope();
    const baseline = toolReviewDigest(scope, "read_file", "{\"path\":\"a\"}");

    expect(baseline).toMatch(/^[0-9a-f]{64}$/);
    expect(toolReviewDigest({ ...scope, toolId: "tool-2" }, "read_file", "{\"path\":\"a\"}"))
      .not.toBe(baseline);
    expect(toolReviewDigest(scope, "list_dir", "{\"path\":\"a\"}"))
      .not.toBe(baseline);
    expect(toolReviewDigest(scope, "read_file", "{\"path\":\"b\"}"))
      .not.toBe(baseline);
    expect(toolReviewDigest(scope, "read_file:a", "b"))
      .not.toBe(toolReviewDigest(scope, "read_file", "a:b"));
  });
});

function baseScope(): ProposalScope {
  return {
    sessionId: "session",
    turnId: "turn",
    proposalId: "proposal",
    decisionToken: "token",
    toolId: "tool"
  };
}

function baseTransaction(): PreparedEditTransaction {
  return transactionWithReview("old\n", "new\n");
}

function transactionWithReview(previous: string, next: string): PreparedEditTransaction {
  const edit: PreparedWorkspaceEdit = Object.freeze({
    transactionId: "transaction",
    baseRevision: "base",
    kind: "write_file",
    path: "src/file.ts",
    created: false,
    previous,
    next,
    bytesWritten: Buffer.byteLength(next, "utf8")
  });
  return Object.freeze({ edit, review: renderExactEditDiff(previous, next) });
}
