import type { BigIntStats } from "node:fs";
import { WorkspaceSecurityError } from "./errors.js";

/** Stable operating-system identity used to bind a path to one filesystem object. */
export interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

/** Identity plus metadata that invalidates a prepared read or write snapshot. */
export interface FileVersion extends FileIdentity {
  readonly size: bigint;
  readonly mode: bigint;
  readonly modifiedNs: bigint;
  readonly changedNs: bigint;
}

/**
 * Convert Node metadata into an identity, rejecting providers that do not
 * expose a usable file ID. Treating an all-zero/unsupported inode as equal
 * would make unrelated paths indistinguishable and weaken every revalidation.
 */
export function identityOf(stats: Pick<BigIntStats, "dev" | "ino">): FileIdentity {
  if (stats.ino === 0n) {
    throw new WorkspaceSecurityError(
      "IDENTITY_UNAVAILABLE",
      "The filesystem did not provide a usable file identity; guarded workspace access is unavailable."
    );
  }
  return { device: stats.dev, inode: stats.ino };
}

export function versionOf(stats: BigIntStats): FileVersion {
  return {
    ...identityOf(stats),
    size: stats.size,
    mode: stats.mode,
    modifiedNs: stats.mtimeNs,
    changedNs: stats.ctimeNs
  };
}

/** Compare identities without treating a missing Windows device number as failure. */
export function sameIdentity(
  a: Pick<BigIntStats, "dev" | "ino"> | FileIdentity,
  b: Pick<BigIntStats, "dev" | "ino"> | FileIdentity
): boolean {
  const left = "device" in a ? assertIdentity(a) : identityOf(a);
  const right = "device" in b ? assertIdentity(b) : identityOf(b);
  if (left.inode !== right.inode) return false;
  // On Windows, Node can report dev=0 for path-based lstat while handle.stat
  // returns the volume serial number for the same 128-bit file ID.
  if (process.platform === "win32" && (left.device === 0n || right.device === 0n)) return true;
  return left.device === right.device;
}

export function sameVersion(a: FileVersion, b: FileVersion): boolean {
  return sameIdentity(a, b) &&
    a.size === b.size &&
    a.mode === b.mode &&
    a.modifiedNs === b.modifiedNs &&
    a.changedNs === b.changedNs;
}

/** True when reliable device metadata proves that a path crosses the root filesystem. */
export function crossesDeviceBoundary(
  root: FileIdentity,
  candidate: Pick<BigIntStats, "dev">
): boolean {
  return root.device !== 0n && candidate.dev !== 0n && root.device !== candidate.dev;
}

function assertIdentity(identity: FileIdentity): FileIdentity {
  if (identity.inode === 0n) {
    throw new WorkspaceSecurityError(
      "IDENTITY_UNAVAILABLE",
      "The filesystem did not provide a usable file identity; guarded workspace access is unavailable."
    );
  }
  return identity;
}
