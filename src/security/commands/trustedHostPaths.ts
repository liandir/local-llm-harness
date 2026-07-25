import * as fs from "node:fs/promises";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { SandboxCommandError } from "./errors.js";

const MAX_DOCKER_CLI_BYTES = 256 * 1024 * 1024;

interface VersionFingerprint {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly mode: bigint;
  readonly modifiedNs: bigint;
  readonly changedNs: bigint;
}

interface ExecutableFingerprint extends VersionFingerprint {
  readonly sha256: string;
}

export interface TrustedDockerHostPathGuard {
  readonly executablePath: string;
  readonly trustedCwd: string;
  verify(): Promise<void>;
}

/**
 * Bind host code/config to canonical objects outside the model-writable tree.
 * Replacement by the local operator is outside the model threat boundary but
 * is still detected and fails closed until a new settings preflight.
 */
export class TrustedDockerHostPaths implements TrustedDockerHostPathGuard {
  private constructor(
    readonly executablePath: string,
    readonly trustedCwd: string,
    private readonly configDirectory: string,
    private readonly executable: ExecutableFingerprint,
    private readonly cwd: VersionFingerprint,
    private readonly config: VersionFingerprint
  ) {}

  static async create(
    executablePath: string,
    configDirectory: string,
    workspaceRoot: string
  ): Promise<TrustedDockerHostPaths> {
    const root = await canonicalDirectory(workspaceRoot, "workspace root");
    const executable = path.resolve(executablePath);
    const trustedCwd = path.dirname(executable);
    const initialCwd = await canonicalDirectory(trustedCwd, "Docker CLI directory");
    if (sameOrWithin(root.path, initialCwd.path)) {
      throw invalidHostPath("The trusted Docker CLI directory resolves inside the workspace.");
    }
    const executableProof = await fingerprintExecutable(executable);
    if (!samePath(executableProof.path, executable)) {
      throw invalidHostPath("The Docker CLI path is not canonical or resolves through a link.");
    }
    if (sameOrWithin(root.path, executableProof.path)) {
      throw invalidHostPath("The Docker CLI resolves inside the model-writable workspace.");
    }

    const config = await ensureEmptyConfigDirectory(configDirectory, root.path);
    const cwd = await canonicalDirectory(trustedCwd, "Docker CLI directory");
    return new TrustedDockerHostPaths(
      executable,
      trustedCwd,
      config.path,
      executableProof.fingerprint,
      cwd.fingerprint,
      config.fingerprint
    );
  }

  /** Revalidate identity, metadata, bytes, canonical path, and empty config. */
  async verify(): Promise<void> {
    const cwd = await canonicalDirectory(this.trustedCwd, "Docker CLI directory");
    if (!sameVersion(this.cwd, cwd.fingerprint)) {
      throw invalidHostPath("The trusted Docker CLI directory changed after preflight.");
    }
    const config = await canonicalDirectory(this.configDirectory, "Docker configuration directory");
    if (!sameVersion(this.config, config.fingerprint) || (await fs.readdir(config.path)).length !== 0) {
      throw invalidHostPath("The trusted empty Docker configuration changed after preflight.");
    }
    const executable = await fingerprintExecutable(this.executablePath);
    if (
      !samePath(executable.path, this.executablePath) ||
      !sameVersion(this.executable, executable.fingerprint) ||
      executable.fingerprint.sha256 !== this.executable.sha256
    ) {
      throw invalidHostPath("The trusted Docker CLI changed after preflight.");
    }
  }
}

async function ensureEmptyConfigDirectory(
  requested: string,
  workspaceRoot: string
): Promise<{ path: string; fingerprint: VersionFingerprint }> {
  const target = path.resolve(requested);
  const parent = await ensureCanonicalDirectoryChain(path.dirname(target), workspaceRoot);
  if (sameOrWithin(workspaceRoot, parent.path)) {
    throw invalidHostPath("The Docker configuration parent resolves inside the workspace.");
  }
  try {
    await fs.mkdir(target, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const config = await canonicalDirectory(target, "Docker configuration directory");
  if (!samePath(config.path, target) || sameOrWithin(workspaceRoot, config.path)) {
    throw invalidHostPath("The Docker configuration directory is linked or resolves inside the workspace.");
  }
  if ((await fs.readdir(config.path)).length !== 0) {
    throw invalidHostPath("The dedicated Docker configuration directory must remain empty.");
  }
  if (process.platform !== "win32" && (config.fingerprint.mode & 0o077n) !== 0n) {
    throw invalidHostPath("The dedicated Docker configuration directory is accessible to other users.");
  }
  return config;
}

async function ensureCanonicalDirectoryChain(
  requested: string,
  workspaceRoot: string
): Promise<{ path: string; fingerprint: VersionFingerprint }> {
  const missing: string[] = [];
  let cursor = path.resolve(requested);
  let foundAncestor = false;
  while (!foundAncestor) {
    try {
      await fs.lstat(cursor);
      foundAncestor = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw invalidHostPath("No trusted Docker configuration ancestor exists.");
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
  let current = await canonicalDirectory(cursor, "Docker configuration ancestor");
  if (sameOrWithin(workspaceRoot, current.path)) {
    throw invalidHostPath("The Docker configuration ancestor resolves inside the workspace.");
  }
  for (const component of missing) {
    const next = path.join(current.path, component);
    try {
      await fs.mkdir(next, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    current = await canonicalDirectory(next, "Docker configuration parent");
    if (!samePath(current.path, next) || sameOrWithin(workspaceRoot, current.path)) {
      throw invalidHostPath("A Docker configuration parent is linked or resolves inside the workspace.");
    }
  }
  return current;
}

async function canonicalDirectory(
  requested: string,
  label: string
): Promise<{ path: string; fingerprint: VersionFingerprint }> {
  const target = path.resolve(requested);
  const before = await fs.lstat(target, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink() || before.ino === 0n) {
    throw invalidHostPath(`The ${label} is not a canonical directory.`);
  }
  const canonical = await fs.realpath(target);
  if (!samePath(canonical, target)) {
    throw invalidHostPath(`The ${label} resolves through a link.`);
  }
  const after = await fs.lstat(target, { bigint: true });
  const first = version(before);
  const second = version(after);
  if (!sameVersion(first, second)) throw invalidHostPath(`The ${label} changed during preflight.`);
  return { path: path.resolve(canonical), fingerprint: second };
}

async function fingerprintExecutable(
  requested: string
): Promise<{ path: string; fingerprint: ExecutableFingerprint }> {
  const target = path.resolve(requested);
  const before = await fs.lstat(target, { bigint: true });
  if (
    !before.isFile() || before.isSymbolicLink() || before.ino === 0n || before.nlink !== 1n ||
    before.size <= 0n || before.size > BigInt(MAX_DOCKER_CLI_BYTES) ||
    (process.platform !== "win32" && (before.mode & 0o111n) === 0n)
  ) {
    throw invalidHostPath("The Docker CLI is not a bounded, unlinked executable regular file.");
  }
  const canonical = await fs.realpath(target);
  if (!samePath(canonical, target)) {
    throw invalidHostPath("The Docker CLI resolves through a symbolic link or path alias.");
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(target, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameVersion(version(before), version(opened)) || opened.nlink !== 1n) {
      throw invalidHostPath("The Docker CLI changed while it was opened.");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < Number(opened.size)) {
      const result = await handle.read(buffer, 0, Math.min(buffer.byteLength, Number(opened.size) - offset), offset);
      if (result.bytesRead <= 0) throw invalidHostPath("The Docker CLI changed while it was hashed.");
      hash.update(buffer.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    const extra = await handle.read(buffer, 0, 1, offset);
    const handleAfter = await handle.stat({ bigint: true });
    const pathAfter = await fs.lstat(target, { bigint: true });
    if (
      extra.bytesRead !== 0 || !sameVersion(version(opened), version(handleAfter)) ||
      !sameVersion(version(opened), version(pathAfter))
    ) {
      throw invalidHostPath("The Docker CLI changed while it was hashed.");
    }
    return {
      path: path.resolve(canonical),
      fingerprint: { ...version(handleAfter), sha256: hash.digest("hex") }
    };
  } finally {
    await handle.close();
  }
}

function version(stats: BigIntStats): VersionFingerprint {
  return {
    device: stats.dev,
    inode: stats.ino,
    size: stats.size,
    mode: stats.mode,
    modifiedNs: stats.mtimeNs,
    changedNs: stats.ctimeNs
  };
}

export function sameTrustedPathVersion(left: VersionFingerprint, right: VersionFingerprint): boolean {
  const sameDevice = left.device === right.device ||
    (process.platform === "win32" && (left.device === 0n || right.device === 0n));
  return sameDevice && left.inode !== 0n && left.inode === right.inode && left.size === right.size &&
    left.mode === right.mode && left.modifiedNs === right.modifiedNs && left.changedNs === right.changedNs;
}

const sameVersion = sameTrustedPathVersion;

function sameOrWithin(root: string, candidate: string): boolean {
  const relative = path.relative(normalized(root), normalized(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  return normalized(path.resolve(left)) === normalized(path.resolve(right));
}

function normalized(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function invalidHostPath(message: string): SandboxCommandError {
  return new SandboxCommandError("INVALID_CONFIGURATION", message);
}
