import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ApprovalCoordinator,
  type ApprovalBinding,
  type ApprovalDecision,
  type ProposalScope
} from "../src/chat/approvalCoordinator.js";

describe("ApprovalCoordinator", () => {
  it("accepts one exactly bound decision and makes its replay inert", async () => {
    const coordinator = coordinatorWithIds("session", "proposal", "token");
    const pending = coordinator.create("tool", "turn", digestScope);
    const decision = decide(pending.binding, true);

    expect(coordinator.decide(decision)).toBe(true);
    expect(await pending.decision).toBe(true);
    expect(coordinator.decide(decision)).toBe(false);
    expect(coordinator.hasPending).toBe(false);
  });

  it("does not consume a proposal when any approval binding field is wrong", async () => {
    const coordinator = coordinatorWithIds("session", "proposal", "token");
    const pending = coordinator.create("tool", "turn", digestScope);
    let settled = false;
    void pending.decision.then(() => { settled = true; });

    const wrongBindings: ApprovalBinding[] = [
      { ...pending.binding, sessionId: "other-session" },
      { ...pending.binding, turnId: "other-turn" },
      { ...pending.binding, proposalId: "other-proposal" },
      { ...pending.binding, decisionToken: "other-token" },
      { ...pending.binding, toolId: "other-tool" },
      { ...pending.binding, reviewDigest: "f".repeat(64) }
    ];
    for (const binding of wrongBindings) {
      expect(coordinator.decide(decide(binding, true))).toBe(false);
    }
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(coordinator.hasPending).toBe(true);

    expect(coordinator.decide(decide(pending.binding, false))).toBe(true);
    expect(await pending.decision).toBe(false);
  });

  it("rejects bindings swapped between concurrent proposals", async () => {
    const coordinator = coordinatorWithIds(
      "session",
      "proposal-a", "token-a",
      "proposal-b", "token-b"
    );
    const first = coordinator.create("tool-a", "turn", digestScope);
    const second = coordinator.create("tool-b", "turn", digestScope);

    expect(coordinator.decide(decide({
      ...first.binding,
      proposalId: second.binding.proposalId
    }, true))).toBe(false);
    expect(coordinator.decide(decide({
      ...second.binding,
      reviewDigest: first.binding.reviewDigest
    }, true))).toBe(false);
    expect(coordinator.hasPending).toBe(true);

    expect(coordinator.decide(decide(first.binding, true))).toBe(true);
    expect(coordinator.decide(decide(second.binding, false))).toBe(true);
    expect(await first.decision).toBe(true);
    expect(await second.decision).toBe(false);
  });

  it("makes approval after rejection inert", async () => {
    const coordinator = coordinatorWithIds("session", "proposal", "token");
    const pending = coordinator.create("tool", "turn", digestScope);

    expect(coordinator.decide(decide(pending.binding, false))).toBe(true);
    expect(await pending.decision).toBe(false);
    expect(coordinator.decide(decide(pending.binding, true))).toBe(false);
  });

  it("resolves every cancellation as rejection and ignores all late decisions", async () => {
    const coordinator = coordinatorWithIds(
      "session",
      "proposal-a", "token-a",
      "proposal-b", "token-b"
    );
    const first = coordinator.create("tool-a", "turn-a", digestScope);
    const second = coordinator.create("tool-b", "turn-b", digestScope);

    coordinator.cancelAll();
    coordinator.cancelAll();

    expect(await first.decision).toBe(false);
    expect(await second.decision).toBe(false);
    expect(coordinator.hasPending).toBe(false);
    expect(coordinator.decide(decide(first.binding, true))).toBe(false);
    expect(coordinator.decide(decide(second.binding, true))).toBe(false);
  });

  it("freezes proposal data before the review digest is calculated", () => {
    const coordinator = coordinatorWithIds("session", "proposal", "token");
    let receivedScope: ProposalScope | undefined;
    const pending = coordinator.create("tool", "turn", scope => {
      receivedScope = scope;
      return digestScope(scope);
    });

    expect(Object.isFrozen(receivedScope)).toBe(true);
    expect(Object.isFrozen(pending.binding)).toBe(true);
    expect(Object.isFrozen(pending)).toBe(true);
    coordinator.cancelAll();
  });

  it("fails closed instead of replacing a pending proposal on an id collision", async () => {
    const coordinator = coordinatorWithIds(
      "session",
      "same-proposal", "token-a",
      "same-proposal", "token-b"
    );
    const first = coordinator.create("tool-a", "turn", digestScope);

    expect(() => coordinator.create("tool-b", "turn", digestScope)).toThrow(/collision/i);
    expect(coordinator.hasPending).toBe(true);
    coordinator.cancelAll();
    expect(await first.decision).toBe(false);
  });
});

function coordinatorWithIds(...ids: string[]): ApprovalCoordinator {
  const remaining = [...ids];
  return new ApprovalCoordinator(() => {
    const next = remaining.shift();
    if (next === undefined) throw new Error("deterministic ID source exhausted");
    return next;
  });
}

function digestScope(scope: ProposalScope): string {
  return createHash("sha256").update(JSON.stringify(scope)).digest("hex");
}

function decide(binding: ApprovalBinding, approved: boolean): ApprovalDecision {
  return { ...binding, approved };
}
