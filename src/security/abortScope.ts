/**
 * Error used when an operation scope is cancelled without a more specific
 * reason. Callers may supply their own reason to {@link AbortScope.cancel}; it
 * is then preserved verbatim on every linked signal.
 */
export class AbortScopeCancelledError extends Error {
  constructor(message = "Operation cancelled.") {
    super(message);
    this.name = "AbortScopeCancelledError";
  }
}

/** Error used when a scope reaches its configured deadline. */
export class AbortScopeTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Operation timed out after ${timeoutMs} ms.`);
    this.name = "AbortScopeTimeoutError";
  }
}

/** Error used when a derived signal is explicitly released. */
export class DerivedAbortSignalDisposedError extends Error {
  constructor() {
    super("Derived abort signal was disposed.");
    this.name = "DerivedAbortSignalDisposedError";
  }
}

export interface AbortScopeOptions {
  /**
   * Optional lifecycle above this scope. Aborting it aborts this scope; aborting
   * this scope never propagates back to the parent.
   */
  parent?: AbortSignal;
  /** Optional deadline relative to construction. Zero aborts on the next timer turn. */
  timeoutMs?: number;
}

/**
 * A read-only cancellation signal linked to an {@link AbortScope} and any
 * additional signals supplied to `derive`.
 *
 * `dispose` must be called when the consumer finishes before cancellation. It
 * detaches every source listener and aborts the derived signal, ensuring a
 * released signal can never remain usable after it stops following its owner.
 */
export interface DerivedAbortSignal {
  readonly signal: AbortSignal;
  dispose(): void;
}

/**
 * Owns cancellation for one logical operation (for example, one assistant
 * turn). Dependencies receive `signal` or a signal returned by `derive`; they
 * never receive the controller and therefore cannot cancel sibling work.
 *
 * Cancellation is idempotent and first-reason-wins. `dispose` is fail-closed:
 * if work is still active it cancels the scope and releases parent/deadline
 * listeners. A scope must not be reused for another logical operation.
 */
export class AbortScope {
  private readonly controller = new AbortController();
  private parentCleanup: (() => void) | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;

  constructor(options: AbortScopeOptions = {}) {
    const timeoutMs = options.timeoutMs;
    if (timeoutMs !== undefined) validateTimeout(timeoutMs);

    if (options.parent) {
      const parent = options.parent;
      if (parent.aborted) {
        this.cancel(parent.reason);
      } else {
        const onParentAbort = (): void => this.cancel(parent.reason);
        parent.addEventListener("abort", onParentAbort, { once: true });
        this.parentCleanup = () => parent.removeEventListener("abort", onParentAbort);
      }
    }

    if (timeoutMs !== undefined && !this.signal.aborted) {
      this.deadline = setTimeout(
        () => this.cancel(new AbortScopeTimeoutError(timeoutMs)),
        timeoutMs
      );
    }
  }

  /** The owner signal shared by every stage of this logical operation. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Abort the whole scope. Later calls cannot replace the first reason. */
  cancel(reason: unknown = new AbortScopeCancelledError()): void {
    if (this.signal.aborted) return;
    this.releaseSources();
    this.controller.abort(reason);
  }

  /** Throw the scope's cancellation reason when it has been aborted. */
  throwIfAborted(): void {
    this.signal.throwIfAborted();
  }

  /**
   * Create a consumer signal which follows this scope plus optional local
   * cancellation sources. A local source aborts only the derived signal, never
   * the owning scope or its siblings.
   */
  derive(...additionalSignals: readonly AbortSignal[]): DerivedAbortSignal {
    return new LinkedAbortSignal([this.signal, ...additionalSignals]);
  }

  /** Cancel unfinished work and release the scope's lifecycle listeners. */
  dispose(): void {
    this.cancel(new AbortScopeCancelledError("Operation scope disposed."));
    this.releaseSources();
  }

  private releaseSources(): void {
    this.parentCleanup?.();
    this.parentCleanup = undefined;
    if (this.deadline !== undefined) {
      clearTimeout(this.deadline);
      this.deadline = undefined;
    }
  }
}

class LinkedAbortSignal implements DerivedAbortSignal {
  private readonly controller = new AbortController();
  private cleanups: Array<() => void> = [];

  constructor(sources: readonly AbortSignal[]) {
    for (const source of sources) {
      if (source.aborted) {
        this.abort(source.reason);
        break;
      }
      const onAbort = (): void => this.abort(source.reason);
      source.addEventListener("abort", onAbort, { once: true });
      this.cleanups.push(() => source.removeEventListener("abort", onAbort));
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  dispose(): void {
    this.abort(new DerivedAbortSignalDisposedError());
  }

  private abort(reason: unknown): void {
    if (this.signal.aborted) return;
    this.releaseSources();
    this.controller.abort(reason);
  }

  private releaseSources(): void {
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups = [];
  }
}

function validateTimeout(timeoutMs: number): void {
  // Node clamps larger delays and would otherwise turn an intended long
  // deadline into an almost-immediate cancellation.
  const maxTimerDelayMs = 2_147_483_647;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > maxTimerDelayMs) {
    throw new RangeError(`timeoutMs must be between 0 and ${maxTimerDelayMs}; received ${timeoutMs}.`);
  }
}
