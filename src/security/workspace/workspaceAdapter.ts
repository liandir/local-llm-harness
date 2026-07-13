import type {
  PreparedWorkspaceEdit,
  WorkspaceEntry,
  WorkspaceEditRequest,
  WorkspacePort,
  WorkspaceReadRequest,
  WorkspaceReadResult,
  WorkspaceWriteResult
} from "../../chat/session/ports.js";
import { createHash, randomUUID } from "node:crypto";
import {
  WorkspaceBoundary,
  type FileSnapshot,
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

interface InternalPreparedEdit {
  readonly parsed: ReturnType<typeof parseWorkspacePath>;
  readonly snapshot: FileSnapshot;
  readonly prepared: PreparedWorkspaceEdit;
  readonly lockKey: string;
}

/** Process-wide application lock so separate adapters cannot race one path. */
const workspaceWriteLocks = new Map<string, Promise<void>>();

/**
 * Guarded implementation of the session's {@link WorkspacePort}.
 *
 * Construct with `GuardedWorkspace.create`; construction binds the canonical
 * root identity before the object is exposed. All methods treat their path and
 * content arguments as untrusted, honor cancellation before their commit
 * point, and delegate every filesystem operation to {@link WorkspaceBoundary}.
 */
export class GuardedWorkspace implements WorkspacePort {
  private readonly preparedEdits = new WeakMap<PreparedWorkspaceEdit, InternalPreparedEdit>();

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

  /** Prepare exact next bytes from a verified base without mutating the target. */
  async prepareEdit(
    request: WorkspaceEditRequest,
    signal: AbortSignal
  ): Promise<PreparedWorkspaceEdit> {
    signal.throwIfAborted();
    const parsed = parseWorkspacePath(request.path);
    let snapshot: FileSnapshot;
    let next: string;
    let bytesWritten: number;
    let addedLeadingBreak: boolean | undefined;
    let addedTrailingBreak: boolean | undefined;

    if (request.kind === "write_file") {
      this.assertEditableSize(request.content, parsed.displayPath);
      snapshot = await this.boundary.readFileSnapshot(
        parsed,
        MAX_EDITABLE_FILE_BYTES,
        true,
        signal
      );
      next = request.content;
      bytesWritten = Buffer.byteLength(next, "utf8");
    } else if (request.kind === "insert_text") {
      snapshot = await this.boundary.readFileSnapshot(
        parsed,
        MAX_EDITABLE_FILE_BYTES,
        true,
        signal
      );
      const edit = insertWholeLines(snapshot.content, request.line, request.text);
      next = edit.next;
      bytesWritten = Buffer.byteLength(edit.effectiveText, "utf8");
      addedLeadingBreak = edit.addedLeadingBreak;
      addedTrailingBreak = edit.addedTrailingBreak;
    } else {
      snapshot = await this.boundary.readFileSnapshot(
        parsed,
        MAX_EDITABLE_FILE_BYTES,
        false,
        signal
      );
      const edit = replaceWholeLineRange(
        snapshot.content,
        request.startLine,
        request.endLine,
        request.content
      );
      next = edit.next;
      bytesWritten = Buffer.byteLength(edit.effectiveContent, "utf8");
      addedTrailingBreak = edit.addedTrailingBreak;
    }
    if (!snapshot.exists && snapshot.topology.length !== parsed.parts.length - 1) {
      throw new WorkspaceSecurityError(
        "PATH_NOT_FOUND",
        `The target parent must already exist before an edit can be reviewed: ${parsed.displayPath}.`
      );
    }
    this.assertEditableSize(next, parsed.displayPath);

    const prepared = Object.freeze({
      transactionId: randomUUID(),
      baseRevision: revisionOf(snapshot, parsed.displayPath),
      kind: request.kind,
      path: parsed.displayPath,
      previous: snapshot.content,
      next,
      bytesWritten,
      created: !snapshot.exists,
      ...(addedLeadingBreak === undefined ? {} : { addedLeadingBreak }),
      ...(addedTrailingBreak === undefined ? {} : { addedTrailingBreak })
    }) satisfies PreparedWorkspaceEdit;
    this.preparedEdits.set(prepared, {
      parsed,
      snapshot,
      prepared,
      lockKey: lockKeyFor(this.boundary.root, parsed.displayPath)
    });
    return prepared;
  }

  /** Consume and atomically commit one authentic prepared edit exactly once. */
  async commitEdit(
    edit: PreparedWorkspaceEdit,
    signal: AbortSignal
  ): Promise<GuardedWorkspaceWriteResult> {
    const internal = this.preparedEdits.get(edit);
    if (!internal || internal.prepared !== edit) {
      throw new WorkspaceSecurityError(
        "INVALID_TRANSACTION",
        "The prepared workspace edit is invalid, foreign, or already consumed."
      );
    }
    // Consumption happens before waiting or cancellation. A failed/cancelled
    // attempt must be re-prepared and reviewed; it can never be replayed.
    this.preparedEdits.delete(edit);
    signal.throwIfAborted();
    return withWorkspaceWriteLock(internal.lockKey, signal, async () => {
      if (internal.snapshot.exists && internal.prepared.previous === internal.prepared.next) {
        await this.boundary.verifyFileSnapshot(internal.parsed, internal.snapshot, signal);
      } else {
        await this.boundary.atomicReplace(
          internal.parsed,
          internal.prepared.next,
          internal.snapshot,
          signal
        );
      }
      return writeResultOf(internal.prepared);
    });
  }

  discardEdit(edit: PreparedWorkspaceEdit): boolean {
    return this.preparedEdits.delete(edit);
  }

  async writeFile(path: string, content: string, signal: AbortSignal): Promise<GuardedWorkspaceWriteResult> {
    return this.commitEdit(
      await this.prepareEdit({ kind: "write_file", path, content }, signal),
      signal
    );
  }

  async insertText(
    path: string,
    line: number,
    text: string,
    signal: AbortSignal
  ): Promise<GuardedWorkspaceWriteResult> {
    return this.commitEdit(
      await this.prepareEdit({ kind: "insert_text", path, line, text }, signal),
      signal
    );
  }

  async replaceRange(
    path: string,
    startLine: number,
    endLine: number,
    content: string,
    signal: AbortSignal
  ): Promise<GuardedWorkspaceWriteResult> {
    return this.commitEdit(
      await this.prepareEdit({ kind: "replace_range", path, startLine, endLine, content }, signal),
      signal
    );
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

function revisionOf(snapshot: FileSnapshot, displayPath: string): string {
  const hash = createHash("sha256");
  hash.update("local-llm-harness-workspace-revision-v1\0");
  hash.update(snapshot.exists ? "exists\0" : "missing\0");
  hash.update(displayPath);
  hash.update("\0");
  for (const component of snapshot.topology) {
    hash.update(component.path);
    hash.update("\0");
    hash.update(component.type);
    hash.update("\0");
    hash.update(component.identity.device.toString());
    hash.update("\0");
    hash.update(component.identity.inode.toString());
    hash.update("\0");
  }
  if (snapshot.version) {
    hash.update([
      snapshot.version.device,
      snapshot.version.inode,
      snapshot.version.size,
      snapshot.version.mode,
      snapshot.version.modifiedNs,
      snapshot.version.changedNs
    ].map(value => value.toString()).join("\0"));
    hash.update("\0");
  }
  hash.update(Buffer.from(snapshot.content, "utf8"));
  return hash.digest("hex");
}

function lockKeyFor(root: string, displayPath: string): string {
  const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const normalizedPath = process.platform === "win32" ? displayPath.toLowerCase() : displayPath;
  return `${normalizedRoot}\0${normalizedPath}`;
}

async function withWorkspaceWriteLock<T>(
  key: string,
  signal: AbortSignal,
  operation: () => Promise<T>
): Promise<T> {
  signal.throwIfAborted();
  const predecessor = workspaceWriteLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  workspaceWriteLocks.set(key, current);
  try {
    await waitFor(predecessor, signal);
  } catch (error) {
    void predecessor.finally(() => {
      release();
      if (workspaceWriteLocks.get(key) === current) workspaceWriteLocks.delete(key);
    });
    throw error;
  }
  try {
    signal.throwIfAborted();
    return await operation();
  } finally {
    release();
    if (workspaceWriteLocks.get(key) === current) workspaceWriteLocks.delete(key);
  }
}

function writeResultOf(edit: PreparedWorkspaceEdit): GuardedWorkspaceWriteResult {
  return {
    bytesWritten: edit.bytesWritten,
    previous: edit.previous,
    next: edit.next,
    created: edit.created,
    ...(edit.addedLeadingBreak === undefined ? {} : { addedLeadingBreak: edit.addedLeadingBreak }),
    ...(edit.addedTrailingBreak === undefined ? {} : { addedTrailingBreak: edit.addedTrailingBreak })
  };
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
