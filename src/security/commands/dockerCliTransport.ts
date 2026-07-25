import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import * as path from "node:path";
import { SandboxCommandError } from "./errors.js";
import type {
  DockerTransport,
  DockerTransportResult,
  DockerTransportRunOptions
} from "./transport.js";
import type { TrustedDockerHostPathGuard } from "./trustedHostPaths.js";

export interface DockerCliTransportOptions {
  /** Absolute, administrator-selected Docker CLI path. PATH lookup is forbidden. */
  readonly executablePath: string;
  readonly hostPathGuard: TrustedDockerHostPathGuard;
  /** Optional non-secret additions required by the host OS (for example SystemRoot). */
  readonly hostEnvironment?: Readonly<Record<string, string>>;
}

/**
 * The only source adapter allowed to create a host process. It invokes one
 * absolute Docker CLI without a shell and never inherits the extension's
 * environment wholesale.
 */
export class DockerCliTransport implements DockerTransport {
  private readonly executablePath: string;
  private readonly environment: Readonly<Record<string, string>>;
  private readonly hostPathGuard: TrustedDockerHostPathGuard;

  constructor(options: DockerCliTransportOptions) {
    if (
      typeof options.executablePath !== "string" ||
      !path.isAbsolute(options.executablePath) ||
      options.executablePath.includes("\0")
    ) {
      throw new SandboxCommandError(
        "INVALID_CONFIGURATION",
        "The Docker CLI must be configured with an absolute executable path."
      );
    }
    this.executablePath = path.resolve(options.executablePath);
    if (
      !options.hostPathGuard ||
      path.resolve(options.hostPathGuard.executablePath) !== this.executablePath ||
      !path.isAbsolute(options.hostPathGuard.trustedCwd)
    ) {
      throw new SandboxCommandError("INVALID_CONFIGURATION", "The Docker CLI host-path guard is missing or mismatched.");
    }
    this.hostPathGuard = options.hostPathGuard;
    const environment: Record<string, string> = {
      DOCKER_CLI_HINTS: "false",
      DOCKER_SCAN_SUGGEST: "false",
      NO_COLOR: "1"
    };
    for (const [key, value] of Object.entries(options.hostEnvironment ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0")) {
        throw new SandboxCommandError("INVALID_CONFIGURATION", "The Docker CLI environment is invalid.");
      }
      environment[key] = value;
    }
    this.environment = Object.freeze(environment);
  }

  async run(args: readonly string[], options: DockerTransportRunOptions): Promise<DockerTransportResult> {
    validateInvocation(args, options);
    options.signal?.throwIfAborted();
    await this.hostPathGuard.verify();
    options.signal?.throwIfAborted();

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.executablePath, [...args], {
        shell: false,
        windowsHide: true,
        env: { ...this.environment },
        cwd: this.hostPathGuard.trustedCwd,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      throw transportFailure("The Docker CLI could not be started.", error);
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let outputExceeded = false;
    let spawnError: unknown;
    let timedOut = false;
    let aborted = false;

    const stop = (): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };
    const stopForOutputLimit = (): void => {
      if (outputExceeded) return;
      outputExceeded = true;
      // The supervisor normally enforces the same limit. This independent
      // host stop also covers a same-UID child writing through PID 1's file
      // descriptors instead of its own captured stdout/stderr pipes.
      stop();
    };

    // Broken stdin is reported by the CLI exit/close path; keep a late EPIPE
    // from becoming an uncaught EventEmitter error after the writer finishes.
    child.stdin.on("error", () => undefined);

    child.stdout.on("data", (chunk: Buffer) => {
      const captured = captureChunk(chunk, options.maxOutputBytes - capturedBytes);
      if (captured.byteLength > 0) {
        stdout.push(captured);
        capturedBytes += captured.byteLength;
      }
      if (captured.byteLength !== chunk.byteLength) {
        stdoutTruncated = true;
        stopForOutputLimit();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const captured = captureChunk(chunk, options.maxOutputBytes - capturedBytes);
      if (captured.byteLength > 0) {
        stderr.push(captured);
        capturedBytes += captured.byteLength;
      }
      if (captured.byteLength !== chunk.byteLength) {
        stderrTruncated = true;
        stopForOutputLimit();
      }
    });
    child.once("error", error => {
      spawnError = error;
    });

    const abortListener = (): void => {
      aborted = true;
      stop();
    };
    options.signal?.addEventListener("abort", abortListener, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    timer.unref?.();

    const closed = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });
    let inputError: unknown;
    const input = writeDockerCliInput(child, options.stdin, closed.then(() => undefined), options.signal)
      .catch(error => {
        inputError = error;
        stop();
      });
    try {
      const { exitCode } = await closed;
      await input;
      if (aborted) {
        throw options.signal?.reason ?? new DOMException("The Docker CLI operation was aborted.", "AbortError");
      }
      if (timedOut) {
        throw transportFailure("The Docker CLI operation exceeded its fixed deadline.");
      }
      if (spawnError !== undefined) {
        throw transportFailure("The Docker CLI process failed.", spawnError);
      }
      if (inputError !== undefined) {
        throw transportFailure("The Docker CLI input stream failed.", inputError);
      }
      if (exitCode === null && !outputExceeded) {
        throw transportFailure("The Docker CLI terminated without an exit code.");
      }
      return Object.freeze({
        // 125 is the supervisor's resource-enforcement status. Returning it
        // for an independent host-side output stop keeps the lifecycle result
        // explicit even though a killed CLI has no ordinary process exit code.
        exitCode: outputExceeded ? 125 : exitCode!,
        stdout: Uint8Array.from(Buffer.concat(stdout)),
        stderr: Uint8Array.from(Buffer.concat(stderr)),
        stdoutTruncated,
        stderrTruncated
      });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortListener);
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
    }
  }
}

interface DockerInputChild {
  readonly stdin: ChildProcessWithoutNullStreams["stdin"];
}

/** Exported for a fake-child backpressure/close regression; production passes spawn(). */
export async function writeDockerCliInput(
  child: DockerInputChild,
  input: AsyncIterable<Uint8Array> | undefined,
  closed: Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  if (input === undefined) {
    child.stdin.end();
    return;
  }
  const iterator = input[Symbol.asyncIterator]();
  let unavailableResolve: (() => void) | undefined;
  const unavailable = new Promise<void>(resolve => { unavailableResolve = resolve; });
  const markUnavailable = (): void => unavailableResolve?.();
  child.stdin.once("close", markUnavailable);
  child.stdin.once("error", markUnavailable);
  signal?.addEventListener("abort", markUnavailable, { once: true });
  if (signal?.aborted) markUnavailable();
  void closed.then(markUnavailable, markUnavailable);
  try {
    let finished = false;
    while (!finished) {
      const next = iterator.next().then(
        value => ({ kind: "next" as const, value }),
        error => ({ kind: "error" as const, error })
      );
      const outcome = await Promise.race([
        next,
        unavailable.then(() => ({ kind: "unavailable" as const }))
      ]);
      if (outcome.kind === "unavailable") {
        cancelIterator(iterator);
        return;
      }
      if (outcome.kind === "error") throw outcome.error;
      if (outcome.value.done) {
        child.stdin.end();
        finished = true;
        continue;
      }
      let accepted: boolean;
      try {
        accepted = child.stdin.write(outcome.value.value);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") return;
        throw error;
      }
      if (!accepted) {
        const ready = await Promise.race([
          once(child.stdin, "drain").then(
            () => "drain" as const,
            () => "unavailable" as const
          ),
          unavailable.then(() => "unavailable" as const)
        ]);
        if (ready !== "drain") {
          cancelIterator(iterator);
          return;
        }
      }
    }
  } catch (error) {
    child.stdin.destroy();
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPIPE" && code !== "ERR_STREAM_DESTROYED") throw error;
  } finally {
    child.stdin.removeListener("close", markUnavailable);
    child.stdin.removeListener("error", markUnavailable);
    signal?.removeEventListener("abort", markUnavailable);
  }
}

function cancelIterator(iterator: AsyncIterator<Uint8Array>): void {
  try {
    const cancellation = iterator.return?.();
    if (cancellation) void cancellation.catch(() => undefined);
  } catch {
    // The child is already unavailable; iterator cleanup cannot restore it.
  }
}

function captureChunk(chunk: Buffer, remaining: number): Buffer {
  if (remaining <= 0) return Buffer.alloc(0);
  return Buffer.from(chunk.subarray(0, Math.min(chunk.byteLength, remaining)));
}

function validateInvocation(args: readonly string[], options: DockerTransportRunOptions): void {
  if (
    !Array.isArray(args) ||
    args.length === 0 ||
    args.length > 512 ||
    args.some(argument => typeof argument !== "string" || argument.includes("\0") || argument.length > 16_384)
  ) {
    throw new SandboxCommandError("INVALID_REQUEST", "The Docker CLI argv is invalid or exceeds its fixed limits.");
  }
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    !Number.isSafeInteger(options.maxOutputBytes) ||
    options.maxOutputBytes <= 0
  ) {
    throw new SandboxCommandError("INVALID_CONFIGURATION", "Docker transport limits must be positive safe integers.");
  }
}

function transportFailure(message: string, cause?: unknown): SandboxCommandError {
  return new SandboxCommandError(
    "TRANSPORT_FAILED",
    message,
    cause === undefined ? undefined : { cause }
  );
}
