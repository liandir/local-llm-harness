import { randomUUID } from "node:crypto";

export interface ProposalScope {
  readonly sessionId: string;
  readonly turnId: string;
  readonly proposalId: string;
  readonly decisionToken: string;
  readonly toolId: string;
}

export interface ApprovalBinding extends ProposalScope {
  readonly reviewDigest: string;
}

export interface ApprovalDecision extends ApprovalBinding {
  readonly approved: boolean;
}

export interface PendingApproval {
  readonly binding: ApprovalBinding;
  readonly decision: Promise<boolean>;
}

interface PendingState {
  readonly binding: ApprovalBinding;
  resolve(approved: boolean): void;
}

/**
 * Host-owned, one-shot approval registry.
 *
 * Entries exist before a proposal is emitted, so an immediate decision cannot
 * be lost. Every decision must echo the complete session/turn/proposal/token/
 * digest binding. The entry is consumed before its waiter is released, making
 * duplicate, swapped, cancelled, and late decisions inert.
 */
export class ApprovalCoordinator {
  readonly sessionId: string;
  private readonly pending = new Map<string, PendingState>();

  constructor(private readonly nextId: () => string = randomUUID) {
    this.sessionId = this.nextId();
  }

  create(
    toolId: string,
    turnId: string,
    digestFor: (scope: ProposalScope) => string
  ): PendingApproval {
    const scope = Object.freeze({
      sessionId: this.sessionId,
      turnId,
      proposalId: this.nextId(),
      decisionToken: this.nextId(),
      toolId
    });
    if (this.pending.has(scope.proposalId)) {
      throw new Error("Approval proposal identifier collision; refusing to replace a pending decision.");
    }
    const binding = Object.freeze({ ...scope, reviewDigest: digestFor(scope) });
    let resolve!: (approved: boolean) => void;
    const decision = new Promise<boolean>(done => { resolve = done; });
    this.pending.set(binding.proposalId, { binding, resolve });
    return Object.freeze({ binding, decision });
  }

  decide(decision: ApprovalDecision): boolean {
    const state = this.pending.get(decision.proposalId);
    if (!state || !sameBinding(state.binding, decision)) return false;
    this.pending.delete(decision.proposalId);
    state.resolve(decision.approved);
    return true;
  }

  cancelAll(): void {
    const states = [...this.pending.values()];
    this.pending.clear();
    for (const state of states) state.resolve(false);
  }

  get hasPending(): boolean {
    return this.pending.size > 0;
  }
}

function sameBinding(expected: ApprovalBinding, received: ApprovalBinding): boolean {
  return expected.sessionId === received.sessionId &&
    expected.turnId === received.turnId &&
    expected.proposalId === received.proposalId &&
    expected.decisionToken === received.decisionToken &&
    expected.toolId === received.toolId &&
    expected.reviewDigest === received.reviewDigest;
}
