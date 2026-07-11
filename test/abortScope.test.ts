import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AbortScope,
  AbortScopeCancelledError,
  AbortScopeTimeoutError,
  DerivedAbortSignalDisposedError
} from "../src/security/abortScope.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("AbortScope", () => {
  it("cancels every derived signal with the owner's first reason", () => {
    const scope = new AbortScope();
    const first = scope.derive();
    const second = scope.derive();
    const reason = new Error("stop");

    scope.cancel(reason);
    scope.cancel(new Error("too late"));

    expect(scope.signal.aborted).toBe(true);
    expect(scope.signal.reason).toBe(reason);
    expect(first.signal.reason).toBe(reason);
    expect(second.signal.reason).toBe(reason);
  });

  it("inherits cancellation from a parent without propagating back", () => {
    const parent = new AbortController();
    const scope = new AbortScope({ parent: parent.signal });

    scope.cancel();

    expect(scope.signal.reason).toBeInstanceOf(AbortScopeCancelledError);
    expect(parent.signal.aborted).toBe(false);
  });

  it("aborts from an already-cancelled parent", () => {
    const parent = new AbortController();
    const reason = new Error("parent stopped");
    parent.abort(reason);

    const scope = new AbortScope({ parent: parent.signal });

    expect(scope.signal.reason).toBe(reason);
  });

  it("allows local cancellation without cancelling the owner or siblings", () => {
    const scope = new AbortScope();
    const local = new AbortController();
    const localDerived = scope.derive(local.signal);
    const sibling = scope.derive();
    const reason = new Error("local stop");

    local.abort(reason);

    expect(localDerived.signal.reason).toBe(reason);
    expect(scope.signal.aborted).toBe(false);
    expect(sibling.signal.aborted).toBe(false);
  });

  it("fails closed when a derived signal is disposed", () => {
    const scope = new AbortScope();
    const derived = scope.derive();

    derived.dispose();

    expect(derived.signal.reason).toBeInstanceOf(DerivedAbortSignalDisposedError);
    expect(scope.signal.aborted).toBe(false);
  });

  it("uses a distinct timeout reason and clears the deadline after cancellation", () => {
    vi.useFakeTimers();
    const timed = new AbortScope({ timeoutMs: 50 });
    const cancelled = new AbortScope({ timeoutMs: 50 });
    cancelled.cancel(new Error("manual"));

    vi.advanceTimersByTime(50);

    expect(timed.signal.reason).toBeInstanceOf(AbortScopeTimeoutError);
    expect((timed.signal.reason as AbortScopeTimeoutError).timeoutMs).toBe(50);
    expect((cancelled.signal.reason as Error).message).toBe("manual");
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    "rejects an unsafe timeout value (%s)",
    timeoutMs => {
      expect(() => new AbortScope({ timeoutMs })).toThrow(RangeError);
    }
  );
});
