import * as fs from "node:fs/promises";
import { constants as fsConstants, type BigIntStats, type Dirent } from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";
import {
  crossesDeviceBoundary,
  identityOf,
  sameIdentity,
  sameVersion,
  versionOf,
  type FileIdentity,
  type FileVersion
} from "./fileIdentity.js";
import { WorkspaceSecurityError } from "./errors.js";
import { parseWorkspacePath } from "./pathPolicy.js";

export interface SandboxSnapshotLimits {
  readonly maxEntries: number;
  readonly maxTotalBytes: number;
  readonly maxFileBytes: number;
  readonly maxDepth: number;
}

export const DEFAULT_SANDBOX_SNAPSHOT_LIMITS: Readonly<SandboxSnapshotLimits> = Object.freeze({
  maxEntries: 50_000,
  maxTotalBytes: 256 * 1024 * 1024,
  maxFileBytes: 64 * 1024 * 1024,
  maxDepth: 128
});

export type SandboxSnapshotEntry =
  | Readonly<{ type: "directory"; path: string; mode: 0o700 }>
  | Readonly<{
      type: "file";
      path: string;
      mode: 0o600 | 0o700;
      size: number;
      sha256: string;
      /** A defensive copy; callers cannot mutate the authenticated snapshot. */
      content: Uint8Array;
    }>;

interface StoredDirectory {
  readonly type: "directory";
  readonly path: string;
  readonly mode: 0o700;
}

interface StoredFile {
  readonly type: "file";
  readonly path: string;
  readonly mode: 0o600 | 0o700;
  readonly size: number;
  readonly sha256: string;
  readonly content: Buffer;
}

type StoredEntry = StoredDirectory | StoredFile;

/**
 * A bounded, deterministic copy of one verified workspace tree. The mutable
 * bytes remain private and each iterator returns fresh copies, so the digest
 * cannot be invalidated after preparation.
 */
export class SandboxSnapshot {
  readonly entryCount: number;
  readonly totalBytes: number;
  readonly digest: string;
  readonly limits: Readonly<SandboxSnapshotLimits>;

  constructor(
    private readonly storedEntries: readonly StoredEntry[],
    summary: Readonly<{ entryCount: number; totalBytes: number; digest: string }>,
    limits: Readonly<SandboxSnapshotLimits>
  ) {
    this.entryCount = summary.entryCount;
    this.totalBytes = summary.totalBytes;
    this.digest = summary.digest;
    this.limits = Object.freeze({ ...limits });
  }

  *entries(): IterableIterator<SandboxSnapshotEntry> {
    for (const entry of this.storedEntries) {
      if (entry.type === "directory") {
        yield entry;
      } else {
        yield Object.freeze({
          type: "file" as const,
          path: entry.path,
          mode: entry.mode,
          size: entry.size,
          sha256: entry.sha256,
          content: Uint8Array.from(entry.content)
        });
      }
    }
  }
}

/**
 * Copy a workspace into memory only after rejecting every filesystem feature
 * that could alias or escape the selected root. The tree is revalidated around
 * every read; any concurrent topology/content change fails the whole snapshot.
 */
export async function createSandboxSnapshot(
  requestedRoot: string,
  signal: AbortSignal,
  requestedLimits: Readonly<SandboxSnapshotLimits> = DEFAULT_SANDBOX_SNAPSHOT_LIMITS
): Promise<SandboxSnapshot> {
  signal.throwIfAborted();
  const limits = validateLimits(requestedLimits);
  const root = validateAbsoluteRoot(requestedRoot);
  const rootBefore = await guardedLstat(root, "The workspace root is unavailable.");
  rejectLink(rootBefore, "The workspace root must not be a symbolic link or junction.");
  if (!rootBefore.isDirectory()) {
    throw securityError("TYPE_MISMATCH", "The workspace root is not a directory.");
  }
  const rootIdentity = identityOf(rootBefore);
  await assertCanonicalPath(root, root);
  const rootMountId = await proveRootMountIdentity(root, versionOf(rootBefore));

  const entries: StoredEntry[] = [];
  let totalBytes = 0;
  let scannedEntries = 0;
  await visitDirectory(root, "", 0, versionOf(rootBefore));

  signal.throwIfAborted();
  const rootAfter = await guardedLstat(root, "The workspace root changed while it was copied.");
  if (!sameVersion(versionOf(rootBefore), versionOf(rootAfter))) {
    throw securityError("ROOT_CHANGED", "The workspace root changed while the sandbox snapshot was prepared.");
  }

  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const digest = digestEntries(entries);
  return new SandboxSnapshot(
    Object.freeze(entries),
    Object.freeze({ entryCount: entries.length, totalBytes, digest }),
    limits
  );

  async function visitDirectory(
    absoluteDirectory: string,
    relativeDirectory: string,
    depth: number,
    directoryBefore: FileVersion
  ): Promise<void> {
    signal.throwIfAborted();
    if (depth > limits.maxDepth) {
      throw securityError("LIMIT_EXCEEDED", `Sandbox snapshot exceeds ${limits.maxDepth} path components.`);
    }
    const listed = await readBoundedDirectory(
      absoluteDirectory,
      limits.maxEntries - scannedEntries,
      limits.maxEntries,
      signal
    );
    scannedEntries += listed.length;
    listed.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

    for (const directoryEntry of listed) {
      signal.throwIfAborted();
      const displayPath = relativeDirectory === ""
        ? directoryEntry.name
        : `${relativeDirectory}/${directoryEntry.name}`;
      const parsed = parseWorkspacePath(displayPath);
      if (parsed.parts.length > limits.maxDepth) {
        throw securityError("LIMIT_EXCEEDED", `Sandbox snapshot exceeds ${limits.maxDepth} path components.`);
      }
      const absolutePath = path.join(root, parsed.relativePath);
      const before = await guardedLstat(absolutePath, `Workspace entry changed before it could be copied: ${displayPath}.`);
      rejectLink(before, `Links are not allowed in sandbox snapshots: ${displayPath}.`);
      assertSameDevice(rootIdentity, before, displayPath);
      await assertCanonicalPath(root, absolutePath);

      if (before.isDirectory()) {
        await assertPathMountIdentity(absolutePath, versionOf(before), rootMountId, true);
        addEntry(Object.freeze({ type: "directory", path: parsed.displayPath, mode: 0o700 }));
        await visitDirectory(absolutePath, parsed.displayPath, depth + 1, versionOf(before));
      } else if (before.isFile()) {
        if (before.nlink !== 1n) {
          throw securityError("HARDLINK_NOT_ALLOWED", `Hardlinked files are not allowed in sandbox snapshots: ${displayPath}.`);
        }
        const size = checkedFileSize(before, limits, displayPath);
        if (totalBytes + size > limits.maxTotalBytes) {
          throw securityError("LIMIT_EXCEEDED", `Sandbox snapshot exceeds ${limits.maxTotalBytes} total bytes.`);
        }
        const content = await readStableFile(absolutePath, versionOf(before), size, signal, rootMountId);
        const sha256 = createHash("sha256").update(content).digest("hex");
        const mode: 0o600 | 0o700 = (before.mode & 0o111n) === 0n ? 0o600 : 0o700;
        addEntry(Object.freeze({
          type: "file",
          path: parsed.displayPath,
          mode,
          size,
          sha256,
          content
        }));
        totalBytes += size;
      } else {
        throw securityError("TYPE_MISMATCH", `Special filesystem entries are not allowed in sandbox snapshots: ${displayPath}.`);
      }
    }

    const directoryAfter = await guardedLstat(
      absoluteDirectory,
      `Workspace directory changed while it was copied: ${relativeDirectory || "."}.`
    );
    if (!sameVersion(directoryBefore, versionOf(directoryAfter))) {
      throw securityError("PATH_CHANGED", `Workspace directory changed while it was copied: ${relativeDirectory || "."}.`);
    }
  }

  function addEntry(entry: StoredEntry): void {
    if (entries.length >= limits.maxEntries) {
      throw securityError("LIMIT_EXCEEDED", `Sandbox snapshot exceeds ${limits.maxEntries} entries.`);
    }
    entries.push(entry);
  }
}

async function readBoundedDirectory(
  absoluteDirectory: string,
  remainingEntries: number,
  globalLimit: number,
  signal: AbortSignal
): Promise<Dirent[]> {
  const handle = await fs.opendir(absoluteDirectory);
  const entries: Dirent[] = [];
  let operationError: unknown;
  try {
    let finished = false;
    while (!finished) {
      signal.throwIfAborted();
      const entry = await handle.read();
      if (entry === null) {
        finished = true;
        continue;
      }
      if (entries.length >= remainingEntries) {
        throw securityError("LIMIT_EXCEEDED", `Sandbox snapshot exceeds ${globalLimit} entries.`);
      }
      entries.push(entry);
    }
  } catch (error) {
    operationError = error;
  }
  try {
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ERR_DIR_CLOSED" && operationError === undefined) {
      operationError = error;
    }
  }
  if (operationError !== undefined) throw operationError;
  return entries;
}

/** Canonical digest algorithm duplicated by the packaged supervisor. */
export function digestSandboxEntryMetadata(entries: readonly Omit<StoredFile, "content">[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) updateTreeDigest(hash, entry);
  return hash.digest("hex");
}

function digestEntries(entries: readonly StoredEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) updateTreeDigest(hash, entry);
  return hash.digest("hex");
}

function updateTreeDigest(hash: ReturnType<typeof createHash>, entry: StoredEntry | Omit<StoredFile, "content">): void {
  if (entry.type === "directory") {
    hash.update(`D\0${entry.path}\0${entry.mode.toString(8)}\n`, "utf8");
  } else {
    hash.update(`F\0${entry.path}\0${entry.mode.toString(8)}\0${entry.size}\0${entry.sha256}\n`, "utf8");
  }
}

async function readStableFile(
  absolutePath: string,
  expected: FileVersion,
  size: number,
  signal: AbortSignal,
  rootMountId: number | undefined
): Promise<Buffer> {
  signal.throwIfAborted();
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(absolutePath, fsConstants.O_RDONLY | noFollow);
    const handleBefore = await handle.stat({ bigint: true });
    rejectLink(handleBefore, "A workspace file became a link while it was copied.");
    if (!handleBefore.isFile() || handleBefore.nlink !== 1n || !sameVersion(expected, versionOf(handleBefore))) {
      throw securityError("PATH_CHANGED", "A workspace file changed while it was copied.");
    }
    await assertHandleMountIdentity(handle, rootMountId);

    const content = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      signal.throwIfAborted();
      const length = Math.min(64 * 1024, size - offset);
      const result = await handle.read(content, offset, length, offset);
      if (result.bytesRead === 0) {
        throw securityError("PATH_CHANGED", "A workspace file shrank while it was copied.");
      }
      offset += result.bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await handle.read(extra, 0, 1, size)).bytesRead !== 0) {
      throw securityError("PATH_CHANGED", "A workspace file grew while it was copied.");
    }
    const handleAfter = await handle.stat({ bigint: true });
    const pathAfter = await guardedLstat(absolutePath, "A workspace file was replaced while it was copied.");
    if (
      !sameVersion(expected, versionOf(handleAfter)) ||
      !sameVersion(expected, versionOf(pathAfter)) ||
      !sameIdentity(handleAfter, pathAfter)
    ) {
      throw securityError("PATH_CHANGED", "A workspace file changed while it was copied.");
    }
    return content;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw securityError("LINK_NOT_ALLOWED", "A workspace file became a link while it was copied.", error);
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

/**
 * Linux bind mounts can retain the root device number and survive realpath.
 * Kernel mount IDs are therefore part of every opened-object proof. Windows
 * mount points are reparse points (rejected above); other hosts fail closed.
 */
async function proveRootMountIdentity(root: string, expected: FileVersion): Promise<number | undefined> {
  if (process.platform === "win32") return undefined;
  if (process.platform !== "linux") {
    throw securityError(
      "INVALID_ROOT",
      "Sandbox snapshots are unavailable because this platform cannot prove mount containment."
    );
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const directory = typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0;
  const handle = await fs.open(root, fsConstants.O_RDONLY | noFollow | directory);
  try {
    const current = await handle.stat({ bigint: true });
    if (!current.isDirectory() || !sameVersion(expected, versionOf(current))) {
      throw securityError("ROOT_CHANGED", "The workspace root changed during mount verification.");
    }
    return await linuxMountId(handle);
  } finally {
    await handle.close();
  }
}

async function assertPathMountIdentity(
  absolutePath: string,
  expected: FileVersion,
  rootMountId: number | undefined,
  directory: boolean
): Promise<void> {
  if (rootMountId === undefined) return;
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const directoryFlag = directory && typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0;
  const handle = await fs.open(absolutePath, fsConstants.O_RDONLY | noFollow | directoryFlag);
  try {
    const current = await handle.stat({ bigint: true });
    if (!sameVersion(expected, versionOf(current))) {
      throw securityError("PATH_CHANGED", "A workspace entry changed during mount verification.");
    }
    await assertHandleMountIdentity(handle, rootMountId);
  } finally {
    await handle.close();
  }
}

async function assertHandleMountIdentity(
  handle: fs.FileHandle,
  rootMountId: number | undefined
): Promise<void> {
  if (rootMountId === undefined) return;
  if (await linuxMountId(handle) !== rootMountId) {
    throw securityError(
      "LINK_NOT_ALLOWED",
      "Nested bind mounts and mount points are not allowed in sandbox snapshots."
    );
  }
}

async function linuxMountId(handle: fs.FileHandle): Promise<number> {
  let source: string;
  try {
    source = await fs.readFile(`/proc/self/fdinfo/${handle.fd}`, "utf8");
  } catch (error) {
    throw securityError(
      "IDENTITY_UNAVAILABLE",
      "The kernel did not expose a mount identity for guarded snapshot access.",
      error
    );
  }
  const matches = [...source.matchAll(/^mnt_id:\s*(\d+)\s*$/gm)];
  if (matches.length !== 1) {
    throw securityError(
      "IDENTITY_UNAVAILABLE",
      "The kernel returned an ambiguous mount identity for guarded snapshot access."
    );
  }
  const value = Number(matches[0][1]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw securityError("IDENTITY_UNAVAILABLE", "The kernel returned an invalid mount identity.");
  }
  return value;
}

function checkedFileSize(stats: BigIntStats, limits: SandboxSnapshotLimits, displayPath: string): number {
  if (stats.size < 0n || stats.size > BigInt(limits.maxFileBytes)) {
    throw securityError("LIMIT_EXCEEDED", `Sandbox file exceeds ${limits.maxFileBytes} bytes: ${displayPath}.`);
  }
  return Number(stats.size);
}

function validateLimits(limits: Readonly<SandboxSnapshotLimits>): Readonly<SandboxSnapshotLimits> {
  const values = [limits.maxEntries, limits.maxTotalBytes, limits.maxFileBytes, limits.maxDepth];
  if (values.some(value => !Number.isSafeInteger(value) || value <= 0)) {
    throw new TypeError("Sandbox snapshot limits must be positive safe integers.");
  }
  if (limits.maxFileBytes > limits.maxTotalBytes || limits.maxDepth > 128) {
    throw new TypeError("Sandbox snapshot limits are internally inconsistent.");
  }
  return Object.freeze({ ...limits });
}

function validateAbsoluteRoot(requestedRoot: string): string {
  if (typeof requestedRoot !== "string" || requestedRoot.includes("\0") || !path.isAbsolute(requestedRoot)) {
    throw securityError("INVALID_ROOT", "Sandbox snapshots require an absolute workspace root.");
  }
  if (path.win32.isAbsolute(requestedRoot) && requestedRoot.startsWith("\\\\")) {
    throw securityError("INVALID_ROOT", "UNC and device workspace roots are not allowed.");
  }
  return path.resolve(requestedRoot);
}

async function assertCanonicalPath(root: string, candidate: string): Promise<void> {
  const canonical = await fs.realpath(candidate);
  if (!samePath(canonical, candidate) || !isWithin(root, canonical)) {
    throw securityError("LINK_NOT_ALLOWED", "A sandbox snapshot path resolved through a link or outside the workspace.");
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function rejectLink(stats: BigIntStats, message: string): void {
  if (stats.isSymbolicLink()) throw securityError("LINK_NOT_ALLOWED", message);
}

function assertSameDevice(rootIdentity: FileIdentity, stats: BigIntStats, displayPath: string): void {
  if (crossesDeviceBoundary(rootIdentity, stats)) {
    throw securityError("LINK_NOT_ALLOWED", `Cross-device workspace entries are not allowed: ${displayPath}.`);
  }
}

async function guardedLstat(absolutePath: string, message: string): Promise<BigIntStats> {
  try {
    return await fs.lstat(absolutePath, { bigint: true });
  } catch (error) {
    throw securityError("PATH_CHANGED", message, error);
  }
}

function securityError(
  code: ConstructorParameters<typeof WorkspaceSecurityError>[0],
  message: string,
  cause?: unknown
): WorkspaceSecurityError {
  return new WorkspaceSecurityError(code, message, cause === undefined ? undefined : { cause });
}
