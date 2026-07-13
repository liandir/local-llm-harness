import { constants, type BigIntStats, type Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { WorkspaceSecurityError, isMissingPathError } from "./errors.js";
import {
  identityOf,
  crossesDeviceBoundary,
  sameIdentity,
  sameVersion,
  versionOf,
  type FileIdentity,
  type FileVersion
} from "./fileIdentity.js";
import { parseWorkspacePath, type ParsedWorkspacePath } from "./pathPolicy.js";
import { cleanupPublishedTemporary } from "./publication.js";

export type GuardedPathType = "file" | "directory" | "other" | "missing";

export interface GuardedPathResolution {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly type: GuardedPathType;
}

export interface ResolvePathOptions {
  allowMissing?: boolean;
  expectedType?: "file" | "directory" | "any";
}

/** Dependency seam used only by deterministic atomic-publication fault tests. */
export interface AtomicReplaceTestHooks {
  unlinkPublishedTemporary?: (path: string) => Promise<void>;
}

export interface FileSnapshot {
  readonly exists: boolean;
  readonly content: string;
  readonly version?: FileVersion;
  /** Existing path components, excluding the separately bound workspace root. */
  readonly topology: readonly PathComponentSnapshot[];
}

export interface PathComponentSnapshot {
  readonly path: string;
  readonly identity: FileIdentity;
  readonly type: "file" | "directory" | "other";
}

interface Inspection {
  readonly parsed: ParsedWorkspacePath;
  readonly absolutePath: string;
  readonly exists: boolean;
  readonly stats?: BigIntStats;
  readonly topology: readonly PathComponentSnapshot[];
}

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const READ_FLAGS = constants.O_RDONLY | NO_FOLLOW;
const CREATE_EXCLUSIVE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW;
const TEMP_PREFIX = ".local-llm-harness-write-";

/**
 * Low-level workspace boundary shared by all higher-level operations.
 *
 * Security invariants:
 *
 * - the canonical root is bound to its original filesystem identity;
 * - every existing component is checked with `lstat` and `realpath`;
 * - all symbolic links, junctions, redirected reparse paths, and regular-file
 *   hardlinks are rejected, including links whose target remains in-root;
 * - an opened file handle must match the final verified path before bytes are
 *   read; and
 * - writes use an exclusive same-directory temporary file, exact base
 *   revalidation, then one atomic rename.
 *
 * Node does not expose portable `openat`/directory-handle-relative operations.
 * Revalidation detects path replacement before and after critical operations,
 * while the root binding and process-wide per-path write serialization prevent
 * stale adapter state. A hostile process with simultaneous host filesystem
 * access is outside this application boundary and belongs to the OS sandbox
 * threat model.
 */
export class WorkspaceBoundary {
  private constructor(
    readonly root: string,
    private readonly rootIdentity: FileIdentity
  ) {}

  static async create(workspaceRoot: string, signal = neverAbortedSignal()): Promise<WorkspaceBoundary> {
    signal.throwIfAborted();
    if (typeof workspaceRoot !== "string" || workspaceRoot.trim() === "" || workspaceRoot.includes("\0")) {
      throw new WorkspaceSecurityError("INVALID_ROOT", "A non-empty workspace root is required.");
    }
    if (
      !path.isAbsolute(workspaceRoot) ||
      workspaceRoot.startsWith("\\\\") ||
      workspaceRoot.startsWith("//")
    ) {
      throw new WorkspaceSecurityError(
        "INVALID_ROOT",
        "The selected workspace root must be an absolute local filesystem path."
      );
    }
    const requestedRoot = path.resolve(workspaceRoot);
    let requestedStats: BigIntStats;
    let canonicalRoot: string;
    try {
      requestedStats = await fs.lstat(requestedRoot, { bigint: true });
      signal.throwIfAborted();
      canonicalRoot = await fs.realpath(requestedRoot);
    } catch (error) {
      if (isMissingPathError(error)) {
        throw new WorkspaceSecurityError("INVALID_ROOT", "The selected workspace root does not exist.", { cause: error });
      }
      throw error;
    }
    signal.throwIfAborted();
    if (requestedStats.isSymbolicLink() || !samePath(requestedRoot, canonicalRoot)) {
      throw new WorkspaceSecurityError(
        "LINK_NOT_ALLOWED",
        "The selected workspace root must not be a symlink, junction, or redirected reparse path."
      );
    }
    if (!requestedStats.isDirectory()) {
      throw new WorkspaceSecurityError("INVALID_ROOT", "The selected workspace root is not a directory.");
    }
    const boundary = new WorkspaceBoundary(canonicalRoot, identityOf(requestedStats));
    await boundary.assertRootStable(signal);
    return boundary;
  }

  /**
   * Resolve and verify one path for UI review/grouping.
   *
   * The returned absolute path is a point-in-time observation, not a durable
   * authorization. Any later I/O must call this boundary again so path changes
   * are detected at operation time.
   */
  async resolvePath(
    requested: string,
    signal: AbortSignal,
    options: ResolvePathOptions = {}
  ): Promise<GuardedPathResolution> {
    const parsed = parseWorkspacePath(requested, options.expectedType === "directory");
    const inspection = await this.inspect(parsed, signal);
    if (!inspection.exists && !options.allowMissing) {
      throw new WorkspaceSecurityError("PATH_NOT_FOUND", `Workspace path does not exist: ${parsed.displayPath || "."}.`);
    }
    const type = inspection.exists ? typeOf(inspection.stats!) : "missing";
    if (
      inspection.exists &&
      options.expectedType &&
      options.expectedType !== "any" &&
      type !== options.expectedType
    ) {
      throw new WorkspaceSecurityError(
        "TYPE_MISMATCH",
        `Expected ${options.expectedType} at ${parsed.displayPath || "."}, found ${type}.`
      );
    }
    return Object.freeze({
      relativePath: parsed.displayPath,
      absolutePath: inspection.absolutePath,
      type
    });
  }

  async readFileSnapshot(
    parsed: ParsedWorkspacePath,
    maxBytes: number,
    allowMissing: boolean,
    signal: AbortSignal
  ): Promise<FileSnapshot> {
    signal.throwIfAborted();
    const inspection = await this.inspect(parsed, signal);
    if (!inspection.exists) {
      if (allowMissing) return { exists: false, content: "", topology: inspection.topology };
      throw new WorkspaceSecurityError("PATH_NOT_FOUND", `File does not exist: ${parsed.displayPath}.`);
    }
    this.requireRegularFile(inspection.stats!, parsed.displayPath);
    if (inspection.stats!.size > BigInt(maxBytes)) {
      throw new WorkspaceSecurityError(
        "LIMIT_EXCEEDED",
        `File exceeds the ${maxBytes}-byte read limit: ${parsed.displayPath}.`
      );
    }

    const handle = await fs.open(inspection.absolutePath, READ_FLAGS);
    try {
      const before = await handle.stat({ bigint: true });
      this.requireRegularFile(before, parsed.displayPath);
      await this.verifyHandleAtPath(parsed, before, signal);
      if (before.size > BigInt(maxBytes)) {
        throw new WorkspaceSecurityError(
          "LIMIT_EXCEEDED",
          `File exceeds the ${maxBytes}-byte read limit: ${parsed.displayPath}.`
        );
      }
      const content = await readBoundedUtf8(handle, maxBytes, parsed.displayPath, signal);
      const after = await handle.stat({ bigint: true });
      if (!sameVersion(versionOf(before), versionOf(after))) {
        throw pathChanged(parsed.displayPath, "File changed while it was being read.");
      }
      const finalInspection = await this.verifyHandleAtPath(parsed, after, signal);
      return {
        exists: true,
        content,
        version: versionOf(after),
        topology: finalInspection.topology
      };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /** List a verified directory and reject replacement during the operation. */
  async readDirectory(
    parsed: ParsedWorkspacePath,
    signal: AbortSignal,
    maxEntries: number
  ): Promise<readonly Dirent[]> {
    signal.throwIfAborted();
    const before = await this.inspect(parsed, signal);
    if (!before.exists) {
      throw new WorkspaceSecurityError("PATH_NOT_FOUND", `Directory does not exist: ${parsed.displayPath || "."}.`);
    }
    if (!before.stats!.isDirectory()) {
      throw new WorkspaceSecurityError("TYPE_MISMATCH", `Not a directory: ${parsed.displayPath || "."}.`);
    }
    const entries: Dirent[] = [];
    const directory = await fs.opendir(before.absolutePath);
    try {
      for await (const entry of directory) {
        signal.throwIfAborted();
        if (entries.length >= maxEntries) {
          throw new WorkspaceSecurityError(
            "LIMIT_EXCEEDED",
            `Directory exceeds the ${maxEntries}-entry listing limit: ${parsed.displayPath || "."}.`
          );
        }
        entries.push(entry);
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    signal.throwIfAborted();
    const after = await this.inspect(parsed, signal);
    if (!after.exists || !after.stats!.isDirectory() || !sameIdentity(before.stats!, after.stats!)) {
      throw pathChanged(parsed.displayPath || ".", "Directory changed while it was being listed.");
    }
    return entries.sort((left, right) => left.name === right.name ? 0 : left.name < right.name ? -1 : 1);
  }

  /** Create missing parents one component at a time, verifying each result. */
  async ensureParentDirectories(parsed: ParsedWorkspacePath, signal: AbortSignal): Promise<void> {
    for (let index = 0; index < parsed.parts.length - 1; index++) {
      signal.throwIfAborted();
      const parent = parseWorkspacePath(parsed.parts.slice(0, index + 1).join("/"), true);
      const inspection = await this.inspect(parent, signal);
      if (!inspection.exists) {
        await this.assertRootStable(signal);
        try {
          await fs.mkdir(inspection.absolutePath, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      const verified = await this.inspect(parent, signal);
      if (!verified.exists || !verified.stats!.isDirectory()) {
        throw new WorkspaceSecurityError(
          "TYPE_MISMATCH",
          `Workspace parent is not a directory: ${parent.displayPath}.`
        );
      }
    }
  }

  /**
   * Atomically replace a target with exact prepared text.
   *
   * Cancellation before the final rename guarantees that the target is not
   * changed. Once rename begins it is the commit point: cleanup and verification
   * finish even if the signal becomes aborted, and the committed result is
   * returned rather than misreported as an unexecuted cancellation.
   */
  async atomicReplace(
    parsed: ParsedWorkspacePath,
    next: string,
    expectedBase: FileSnapshot,
    signal: AbortSignal,
    testHooks: AtomicReplaceTestHooks = {}
  ): Promise<void> {
    signal.throwIfAborted();
    await this.verifyPreparedTopology(parsed, expectedBase, signal);
    await this.ensureParentDirectories(parsed, signal);
    const parentParts = parsed.parts.slice(0, -1);
    const parent = parseWorkspacePath(parentParts.join("/") || ".", true);
    const verifiedParent = await this.inspect(parent, signal);
    if (!verifiedParent.exists || !verifiedParent.stats!.isDirectory()) {
      throw new WorkspaceSecurityError("TYPE_MISMATCH", `Target parent is not a directory: ${parent.displayPath || "."}.`);
    }

    const temporaryName = `${TEMP_PREFIX}${randomUUID()}.tmp`;
    const temporary = parseWorkspacePath([...parentParts, temporaryName].join("/"));
    const temporaryAbsolute = path.join(this.root, temporary.relativePath);
    let temporaryIdentity: FileIdentity | undefined;
    let temporaryVersion: FileVersion | undefined;
    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(temporaryAbsolute, CREATE_EXCLUSIVE_FLAGS, 0o600);
      if (expectedBase.version && process.platform !== "win32") {
        await handle.chmod(Number(expectedBase.version.mode & 0o777n));
      }
      const created = await handle.stat({ bigint: true });
      this.requireRegularFile(created, temporary.displayPath);
      temporaryIdentity = identityOf(created);
      await this.verifyHandleAtPath(temporary, created, signal);
      signal.throwIfAborted();
      await handle.writeFile(next, { encoding: "utf8", signal });
      await handle.sync();
      const written = await handle.stat({ bigint: true });
      this.requireRegularFile(written, temporary.displayPath);
      temporaryVersion = versionOf(written);
      await this.verifyHandleAtPath(temporary, written, signal);
      await handle.close();
      handle = undefined;

      await this.verifyExpectedBase(parsed, expectedBase, signal);
      const temporaryBeforeCommit = await this.inspect(temporary, signal);
      if (
        !temporaryBeforeCommit.exists ||
        !temporaryVersion ||
        !sameVersion(temporaryVersion, versionOf(temporaryBeforeCommit.stats!))
      ) {
        throw pathChanged(parsed.displayPath, "Prepared temporary file changed before commit.");
      }
      const parentBeforeCommit = await this.inspect(parent, signal);
      if (!parentBeforeCommit.exists || !sameIdentity(verifiedParent.stats!, parentBeforeCommit.stats!)) {
        throw pathChanged(parsed.displayPath, "Target parent changed before commit.");
      }
      signal.throwIfAborted();
      const targetAbsolute = path.join(this.root, parsed.relativePath);
      if (expectedBase.exists) {
        await fs.rename(temporaryAbsolute, targetAbsolute);
      } else {
        // This is an atomic no-clobber publication. A rename would overwrite a
        // target created after the final missing-base check.
        try {
          await fs.link(temporaryAbsolute, targetAbsolute);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw pathChanged(parsed.displayPath, "Target appeared before commit.");
          }
          throw error;
        }
        await cleanupPublishedTemporary(
          temporaryAbsolute,
          () => this.removeIfIdentityMatches(temporary, temporaryIdentity!),
          testHooks.unlinkPublishedTemporary
        );
      }

      // Do not honor a late abort between rename and verification: the target
      // has committed, so reporting cancellation would invite an unsafe retry.
      const verificationSignal = neverAbortedSignal();
      const target = await this.readFileSnapshot(
        parsed,
        Buffer.byteLength(next, "utf8"),
        false,
        verificationSignal
      );
      if (
        !target.exists ||
        target.content !== next ||
        !target.version ||
        !temporaryVersion ||
        !sameIdentity(temporaryVersion, target.version) ||
        temporaryVersion.size !== target.version.size
      ) {
        throw pathChanged(parsed.displayPath, "Committed file identity could not be verified.");
      }
    } finally {
      await handle?.close().catch(() => undefined);
      // This is intentionally unconditional. After a successful rename the
      // temporary path is missing; after no-clobber link publication it also
      // cleans up a transient first-unlink failure without touching the target.
      if (temporaryIdentity) {
        await this.removeIfIdentityMatches(temporary, temporaryIdentity).catch(() => undefined);
      }
    }
  }

  /** Revalidate a prepared snapshot without publishing or changing metadata. */
  async verifyFileSnapshot(
    parsed: ParsedWorkspacePath,
    expected: FileSnapshot,
    signal: AbortSignal
  ): Promise<void> {
    await this.verifyPreparedTopology(parsed, expected, signal);
    await this.verifyExpectedBase(parsed, expected, signal);
  }

  /**
   * Remove one extension-owned workspace file only if it still matches a
   * snapshot read through this boundary. This is intentionally not exposed by
   * the model-facing WorkspacePort.
   */
  async removeExactSnapshot(
    parsed: ParsedWorkspacePath,
    expected: FileSnapshot,
    signal: AbortSignal
  ): Promise<void> {
    if (!expected.exists || !expected.version) {
      throw new WorkspaceSecurityError("PATH_CHANGED", `Cannot remove an unverified file: ${parsed.displayPath}.`);
    }
    const current = await this.readFileSnapshot(
      parsed,
      Buffer.byteLength(expected.content, "utf8"),
      false,
      signal
    );
    if (
      !current.version ||
      current.content !== expected.content ||
      !sameVersion(current.version, expected.version)
    ) {
      throw pathChanged(parsed.displayPath, "File changed before guarded removal.");
    }
    signal.throwIfAborted();
    await this.removeIfIdentityMatches(parsed, expected.version);
  }

  private async verifyExpectedBase(
    parsed: ParsedWorkspacePath,
    expected: FileSnapshot,
    signal: AbortSignal
  ): Promise<void> {
    const expectedBytes = Buffer.byteLength(expected.content, "utf8");
    let current: FileSnapshot;
    try {
      current = await this.readFileSnapshot(parsed, expectedBytes, true, signal);
    } catch (error) {
      if (error instanceof WorkspaceSecurityError && error.code === "LIMIT_EXCEEDED") {
        throw pathChanged(parsed.displayPath, "Target size changed before commit.");
      }
      throw error;
    }
    if (current.exists !== expected.exists) {
      throw pathChanged(parsed.displayPath, "Target existence changed before commit.");
    }
    if (!expected.exists) return;
    if (
      current.content !== expected.content ||
      !current.version ||
      !expected.version ||
      !sameVersion(current.version, expected.version) ||
      !sameTopology(current.topology, expected.topology)
    ) {
      throw pathChanged(parsed.displayPath, "Target changed after the edit was prepared.");
    }
  }

  private async verifyPreparedTopology(
    parsed: ParsedWorkspacePath,
    expected: FileSnapshot,
    signal: AbortSignal
  ): Promise<void> {
    const current = await this.inspect(parsed, signal);
    if (!sameTopology(current.topology, expected.topology)) {
      throw pathChanged(parsed.displayPath, "Target path topology changed after the edit was prepared.");
    }
    if (current.exists !== expected.exists) {
      throw pathChanged(parsed.displayPath, "Target existence changed after the edit was prepared.");
    }
  }

  private async removeIfIdentityMatches(parsed: ParsedWorkspacePath, expected: FileIdentity): Promise<void> {
    const signal = neverAbortedSignal();
    // A freshly published no-clobber target temporarily gives its staging file
    // a link count of two. Cleanup is maintenance-only and still identity-bound.
    const inspection = await this.inspect(parsed, signal, true);
    if (!inspection.exists || !sameIdentity(inspection.stats!, expected)) return;
    await fs.unlink(inspection.absolutePath);
  }

  private async verifyHandleAtPath(
    parsed: ParsedWorkspacePath,
    handleStats: BigIntStats,
    signal: AbortSignal
  ): Promise<Inspection> {
    const current = await this.inspect(parsed, signal);
    if (!current.exists || !sameIdentity(current.stats!, handleStats)) {
      throw pathChanged(parsed.displayPath, "Opened file no longer matches its workspace path.");
    }
    return current;
  }

  private async inspect(
    parsed: ParsedWorkspacePath,
    signal: AbortSignal,
    allowFinalHardlink = false
  ): Promise<Inspection> {
    signal.throwIfAborted();
    await this.assertRootStable(signal);
    const absolutePath = path.join(this.root, parsed.relativePath);
    this.assertLexicallyInside(absolutePath, parsed.displayPath);
    let current = this.root;
    const topology: PathComponentSnapshot[] = [];
    for (let index = 0; index < parsed.parts.length; index++) {
      signal.throwIfAborted();
      current = path.join(current, parsed.parts[index]);
      let stats: BigIntStats;
      try {
        stats = await fs.lstat(current, { bigint: true });
      } catch (error) {
        if (isMissingPathError(error)) {
          await this.assertRootStable(signal);
          return { parsed, absolutePath, exists: false, topology };
        }
        throw error;
      }
      if (stats.isSymbolicLink()) {
        throw new WorkspaceSecurityError(
          "LINK_NOT_ALLOWED",
          `Links and junctions are not allowed in workspace paths: ${parsed.parts.slice(0, index + 1).join("/")}.`
        );
      }
      if (crossesDeviceBoundary(this.rootIdentity, stats)) {
        throw new WorkspaceSecurityError(
          "LINK_NOT_ALLOWED",
          `Filesystem mount crossings are not allowed: ${parsed.parts.slice(0, index + 1).join("/")}.`
        );
      }
      const canonical = await fs.realpath(current);
      if (!samePath(current, canonical) || !isInside(this.root, canonical)) {
        throw new WorkspaceSecurityError(
          "LINK_NOT_ALLOWED",
          `Redirected or reparse paths are not allowed: ${parsed.parts.slice(0, index + 1).join("/")}.`
        );
      }
      const final = index === parsed.parts.length - 1;
      if (!final && !stats.isDirectory()) {
        throw new WorkspaceSecurityError(
          "TYPE_MISMATCH",
          `Workspace path crosses a non-directory component: ${parsed.parts.slice(0, index + 1).join("/")}.`
        );
      }
      if (final && stats.isFile() && stats.nlink > 1n && !allowFinalHardlink) {
        throw new WorkspaceSecurityError(
          "HARDLINK_NOT_ALLOWED",
          `Regular-file hardlinks are not allowed: ${parsed.displayPath}.`
        );
      }
      topology.push({
        path: parsed.parts.slice(0, index + 1).join("/"),
        identity: identityOf(stats),
        type: stats.isFile() ? "file" : stats.isDirectory() ? "directory" : "other"
      });
      if (final) {
        await this.assertRootStable(signal);
        return { parsed, absolutePath, exists: true, stats, topology };
      }
    }
    const rootStats = await fs.lstat(this.root, { bigint: true });
    return { parsed, absolutePath, exists: true, stats: rootStats, topology };
  }

  private requireRegularFile(stats: BigIntStats, displayPath: string): void {
    if (!stats.isFile()) {
      throw new WorkspaceSecurityError("TYPE_MISMATCH", `Not a regular file: ${displayPath}.`);
    }
    if (stats.nlink > 1n) {
      throw new WorkspaceSecurityError("HARDLINK_NOT_ALLOWED", `Regular-file hardlinks are not allowed: ${displayPath}.`);
    }
  }

  private async assertRootStable(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    let stats: BigIntStats;
    let canonical: string;
    try {
      stats = await fs.lstat(this.root, { bigint: true });
      canonical = await fs.realpath(this.root);
    } catch (error) {
      throw new WorkspaceSecurityError("ROOT_CHANGED", "The selected workspace root is no longer available.", { cause: error });
    }
    signal.throwIfAborted();
    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      !samePath(this.root, canonical) ||
      !sameIdentity(stats, this.rootIdentity)
    ) {
      throw new WorkspaceSecurityError(
        "ROOT_CHANGED",
        "The selected workspace root was replaced or redirected; reopen the workspace before retrying."
      );
    }
  }

  private assertLexicallyInside(absolutePath: string, displayPath: string): void {
    if (!isInside(this.root, absolutePath)) {
      throw new WorkspaceSecurityError("INVALID_PATH", `Path escapes the workspace: ${displayPath}.`);
    }
  }
}

function typeOf(stats: BigIntStats): GuardedPathType {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  return "other";
}

function sameTopology(
  left: readonly PathComponentSnapshot[],
  right: readonly PathComponentSnapshot[]
): boolean {
  return left.length === right.length && left.every((component, index) => {
    const other = right[index];
    return component.path === other.path &&
      component.type === other.type &&
      sameIdentity(component.identity, other.identity);
  });
}

function samePath(a: string, b: string): boolean {
  const left = path.normalize(a);
  const right = path.normalize(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function pathChanged(displayPath: string, message: string): WorkspaceSecurityError {
  return new WorkspaceSecurityError("PATH_CHANGED", `${message} (${displayPath})`);
}

async function readBoundedUtf8(
  handle: FileHandle,
  maxBytes: number,
  displayPath: string,
  signal: AbortSignal
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  let position = 0;
  let reading = true;
  while (reading) {
    signal.throwIfAborted();
    const remaining = maxBytes + 1 - total;
    if (remaining <= 0) {
      throw new WorkspaceSecurityError(
        "LIMIT_EXCEEDED",
        `File grew beyond the ${maxBytes}-byte read limit: ${displayPath}.`
      );
    }
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) {
      reading = false;
      continue;
    }
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
    position += bytesRead;
    if (total > maxBytes) {
      throw new WorkspaceSecurityError(
        "LIMIT_EXCEEDED",
        `File grew beyond the ${maxBytes}-byte read limit: ${displayPath}.`
      );
    }
  }
  signal.throwIfAborted();
  try {
    // `ignoreBOM: true` preserves a leading BOM as file content, matching the
    // exact-text semantics of edits while fatal mode rejects malformed UTF-8.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      Buffer.concat(chunks, total)
    );
  } catch (error) {
    throw new WorkspaceSecurityError(
      "INVALID_ENCODING",
      `File is not valid UTF-8 text: ${displayPath}.`,
      { cause: error }
    );
  }
}

function neverAbortedSignal(): AbortSignal {
  return new AbortController().signal;
}
