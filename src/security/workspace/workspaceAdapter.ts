import type {
  WorkspaceEntry,
  WorkspacePort,
  WorkspaceReadRequest,
  WorkspaceReadResult,
  WorkspaceWriteResult
} from "../../chat/session/ports.js";
import {
  WorkspaceBoundary,
  type GuardedPathResolution,
  type ResolvePathOptions
} from "./boundary.js";
import { WorkspaceSecurityError } from "./errors.js";
import { parseWorkspaceGlob, parseWorkspacePath } from "./pathPolicy.js";
import { insertWholeLines, replaceWholeLineRange, sliceLineRange } from "./text.js";

const MAX_RETURNED_READ_BYTES = 1024 * 1024;
const MAX_EDITABLE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_ENUMERATION_RESULT_BYTES = 1024 * 1024;
const DEFAULT_GLOB_RESULTS = 200;
const MAX_GLOB_RESULTS = 1000;
const MAX_GLOB_VISITS = 20_000;
const MAX_GLOB_DEPTH = 64;
const MAX_DIRECTORY_ENTRIES = 5000;

/** Additional compatibility metadata returned by guarded mutations. */
export interface GuardedWorkspaceWriteResult extends WorkspaceWriteResult {
  created: boolean;
  addedLeadingBreak?: boolean;
  addedTrailingBreak?: boolean;
}

/**
 * Guarded implementation of the session's {@link WorkspacePort}.
 *
 * Construct with `GuardedWorkspace.create`; construction binds the canonical
 * root identity before the object is exposed. All methods treat their path and
 * content arguments as untrusted, honor cancellation before their commit
 * point, and delegate every filesystem operation to {@link WorkspaceBoundary}.
 */
export class GuardedWorkspace implements WorkspacePort {
  private writeTail: Promise<void> = Promise.resolve();

  private constructor(private readonly boundary: WorkspaceBoundary) {}

  static async create(workspaceRoot: string, signal?: AbortSignal): Promise<GuardedWorkspace> {
    return new GuardedWorkspace(await WorkspaceBoundary.create(workspaceRoot, signal));
  }

  get root(): string {
    return this.boundary.root;
  }

  /**
   * Point-in-time guarded resolution for proposal grouping, diff review, and
   * VS Code file opening. The result must never be cached as authorization for
   * later I/O; call a workspace method again at execution time.
   */
  resolvePath(
    requested: string,
    signal: AbortSignal,
    options?: ResolvePathOptions
  ): Promise<GuardedPathResolution> {
    return this.boundary.resolvePath(requested, signal, options);
  }

  async readFile(request: WorkspaceReadRequest, signal: AbortSignal): Promise<WorkspaceReadResult> {
    signal.throwIfAborted();
    const parsed = parseWorkspacePath(request.path);
    const ranged = request.startLine !== undefined || request.endLine !== undefined;
    const snapshot = await this.boundary.readFileSnapshot(
      parsed,
      ranged ? MAX_EDITABLE_FILE_BYTES : MAX_RETURNED_READ_BYTES,
      false,
      signal
    );
    const result = sliceLineRange(snapshot.content, request.startLine, request.endLine, parsed.displayPath);
    if (Buffer.byteLength(result.content, "utf8") > MAX_RETURNED_READ_BYTES) {
      throw new WorkspaceSecurityError(
        "LIMIT_EXCEEDED",
        `Requested range exceeds the ${MAX_RETURNED_READ_BYTES}-byte result limit: ${parsed.displayPath}.`
      );
    }
    return result;
  }

  /** Read a complete edit-sized snapshot for an explicit VS Code review action. */
  async readFileForReview(requested: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const parsed = parseWorkspacePath(requested);
    return (await this.boundary.readFileSnapshot(
      parsed,
      MAX_EDITABLE_FILE_BYTES,
      false,
      signal
    )).content;
  }

  async listDirectory(requested: string, signal: AbortSignal): Promise<readonly WorkspaceEntry[]> {
    signal.throwIfAborted();
    const parsed = parseWorkspacePath(requested, true);
    const entries = await this.boundary.readDirectory(parsed, signal, MAX_DIRECTORY_ENTRIES);
    const result: WorkspaceEntry[] = entries.map(entry => ({
      name: entry.name,
      type: entry.isSymbolicLink()
        ? "other"
        : entry.isDirectory()
          ? "directory"
          : entry.isFile()
            ? "file"
            : "other"
    }));
    assertEnumerationBytes(
      result.reduce((bytes, entry) => bytes + Buffer.byteLength(entry.name, "utf8") + 16, 0)
    );
    return result;
  }

  async glob(
    pattern: string,
    maxResults: number | undefined,
    signal: AbortSignal
  ): Promise<readonly string[]> {
    signal.throwIfAborted();
    const { regex } = parseWorkspaceGlob(pattern);
    const maximum = normalizeGlobLimit(maxResults);
    const results: string[] = [];
    const state = { visited: 0, returnedBytes: 0 };
    await this.walkForGlob(parseWorkspacePath(".", true), regex, maximum, results, state, signal, 0);
    return results;
  }

  async writeFile(path: string, content: string, signal: AbortSignal): Promise<GuardedWorkspaceWriteResult> {
    return this.withWriteLock(signal, async () => {
      const parsed = parseWorkspacePath(path);
      this.assertEditableSize(content, parsed.displayPath);
      const previous = await this.boundary.readFileSnapshot(
        parsed,
        MAX_EDITABLE_FILE_BYTES,
        true,
        signal
      );
      await this.boundary.atomicReplace(parsed, content, previous, signal);
      return {
        bytesWritten: Buffer.byteLength(content, "utf8"),
        previous: previous.content,
        next: content,
        created: !previous.exists
      };
    });
  }

  async insertText(
    path: string,
    line: number,
    text: string,
    signal: AbortSignal
  ): Promise<GuardedWorkspaceWriteResult> {
    return this.withWriteLock(signal, async () => {
      const parsed = parseWorkspacePath(path);
      const previous = await this.boundary.readFileSnapshot(
        parsed,
        MAX_EDITABLE_FILE_BYTES,
        true,
        signal
      );
      const edit = insertWholeLines(previous.content, line, text);
      this.assertEditableSize(edit.next, parsed.displayPath);
      await this.boundary.atomicReplace(parsed, edit.next, previous, signal);
      return {
        bytesWritten: Buffer.byteLength(edit.effectiveText, "utf8"),
        previous: previous.content,
        next: edit.next,
        created: !previous.exists,
        addedLeadingBreak: edit.addedLeadingBreak,
        addedTrailingBreak: edit.addedTrailingBreak
      };
    });
  }

  async replaceRange(
    path: string,
    startLine: number,
    endLine: number,
    content: string,
    signal: AbortSignal
  ): Promise<GuardedWorkspaceWriteResult> {
    return this.withWriteLock(signal, async () => {
      const parsed = parseWorkspacePath(path);
      const previous = await this.boundary.readFileSnapshot(
        parsed,
        MAX_EDITABLE_FILE_BYTES,
        false,
        signal
      );
      const edit = replaceWholeLineRange(previous.content, startLine, endLine, content);
      this.assertEditableSize(edit.next, parsed.displayPath);
      await this.boundary.atomicReplace(parsed, edit.next, previous, signal);
      return {
        bytesWritten: Buffer.byteLength(edit.effectiveContent, "utf8"),
        previous: previous.content,
        next: edit.next,
        created: false,
        addedTrailingBreak: edit.addedTrailingBreak
      };
    });
  }

  private async walkForGlob(
    directory: ReturnType<typeof parseWorkspacePath>,
    regex: RegExp,
    maximum: number,
    output: string[],
    state: { visited: number; returnedBytes: number },
    signal: AbortSignal,
    depth: number
  ): Promise<void> {
    signal.throwIfAborted();
    if (output.length >= maximum) return;
    if (depth > MAX_GLOB_DEPTH) {
      throw new WorkspaceSecurityError("LIMIT_EXCEEDED", `Glob traversal exceeds ${MAX_GLOB_DEPTH} directory levels.`);
    }
    const entries = await this.boundary.readDirectory(directory, signal, MAX_DIRECTORY_ENTRIES);
    for (const entry of entries) {
      signal.throwIfAborted();
      if (++state.visited > MAX_GLOB_VISITS) {
        throw new WorkspaceSecurityError("LIMIT_EXCEEDED", `Glob traversal exceeds ${MAX_GLOB_VISITS} entries.`);
      }
      if (entry.name === ".git" || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
      const displayPath = directory.displayPath ? `${directory.displayPath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const child = parseWorkspacePath(displayPath, true);
        // The recursive readDirectory call performs the execution-time
        // component and identity checks; a separate resolution here would be
        // stale authority and double every traversal syscall.
        await this.walkForGlob(child, regex, maximum, output, state, signal, depth + 1);
      } else if (entry.isFile() && regex.test(displayPath)) {
        // Globbing returns a name only. Any later file I/O reopens and verifies
        // it through the boundary, so this Dirent is never treated as authority.
        state.returnedBytes += Buffer.byteLength(displayPath, "utf8") + 4;
        assertEnumerationBytes(state.returnedBytes);
        output.push(displayPath);
        if (output.length >= maximum) return;
      }
    }
  }

  private async withWriteLock<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const predecessor = this.writeTail;
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.writeTail = current;
    try {
      await waitFor(predecessor, signal);
    } catch (error) {
      void predecessor.finally(release);
      throw error;
    }
    try {
      signal.throwIfAborted();
      return await operation();
    } finally {
      release();
    }
  }

  private assertEditableSize(content: string, displayPath: string): void {
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_EDITABLE_FILE_BYTES) {
      throw new WorkspaceSecurityError(
        "LIMIT_EXCEEDED",
        `File exceeds the ${MAX_EDITABLE_FILE_BYTES}-byte write limit: ${displayPath}.`
      );
    }
    const roundTrip = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      Buffer.from(content, "utf8")
    );
    if (roundTrip !== content) {
      throw new WorkspaceSecurityError(
        "INVALID_ENCODING",
        `File content is not losslessly encodable as UTF-8: ${displayPath}.`
      );
    }
  }
}

function normalizeGlobLimit(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_GLOB_RESULTS;
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_GLOB_RESULTS;
  return Math.min(MAX_GLOB_RESULTS, Math.max(1, Math.floor(requested)));
}

function assertEnumerationBytes(bytes: number): void {
  if (bytes > MAX_ENUMERATION_RESULT_BYTES) {
    throw new WorkspaceSecurityError(
      "LIMIT_EXCEEDED",
      `Workspace enumeration exceeds the ${MAX_ENUMERATION_RESULT_BYTES}-byte result limit.`
    );
  }
}

function waitFor(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      () => { cleanup(); resolve(); },
      error => { cleanup(); reject(error); }
    );
  });
}
