import type { CommandRequest } from "../../chat/session/ports.js";
import type { SandboxSnapshot } from "../workspace/sandboxSnapshot.js";
import { SandboxCommandError } from "./errors.js";

export const SANDBOX_PROTOCOL_MAGIC = Uint8Array.from([0x4c, 0x4c, 0x48, 0x53, 0x42, 0x58, 0x30, 0x31]);
export const SANDBOX_PROTOCOL_VERSION = 1;
export const SANDBOX_FILE_CHUNK_BYTES = 64 * 1024;
export const SANDBOX_MAX_CONTROL_FRAME_BYTES = 1024 * 1024;

export const enum SandboxFrameType {
  Command = 1,
  Directory = 2,
  FileStart = 3,
  FileChunk = 4,
  FileEnd = 5,
  SnapshotEnd = 6
}

export interface SandboxInputCommand {
  readonly request: CommandRequest;
  readonly profileDigest: string;
}

/**
 * Encode command authority and the verified workspace copy into one bounded
 * binary stream. User argv never appears in Docker CLI arguments.
 */
export async function* encodeSandboxInput(
  command: SandboxInputCommand,
  snapshot: SandboxSnapshot
): AsyncIterable<Uint8Array> {
  yield SANDBOX_PROTOCOL_MAGIC;
  yield jsonFrame(SandboxFrameType.Command, {
    version: SANDBOX_PROTOCOL_VERSION,
    profileDigest: command.profileDigest,
    ruleId: command.request.ruleId,
    ruleRevision: command.request.ruleRevision,
    executable: command.request.executable,
    args: [...command.request.args],
    cwd: command.request.cwd ?? "",
    timeoutMs: command.request.limits.timeoutMs,
    maxOutputBytes: command.request.limits.maxOutputBytes,
    workspaceMode: "ephemeral-copy",
    networkMode: "none"
  });

  for (const entry of snapshot.entries()) {
    if (entry.type === "directory") {
      yield jsonFrame(SandboxFrameType.Directory, entry);
      continue;
    }
    yield jsonFrame(SandboxFrameType.FileStart, {
      type: entry.type,
      path: entry.path,
      mode: entry.mode,
      size: entry.size,
      sha256: entry.sha256
    });
    for (let offset = 0; offset < entry.content.byteLength; offset += SANDBOX_FILE_CHUNK_BYTES) {
      yield binaryFrame(
        SandboxFrameType.FileChunk,
        entry.content.subarray(offset, Math.min(entry.content.byteLength, offset + SANDBOX_FILE_CHUNK_BYTES))
      );
    }
    yield binaryFrame(SandboxFrameType.FileEnd, new Uint8Array());
  }
  yield jsonFrame(SandboxFrameType.SnapshotEnd, {
    entryCount: snapshot.entryCount,
    totalBytes: snapshot.totalBytes,
    digest: snapshot.digest
  });
}

export function jsonFrame(type: SandboxFrameType, value: unknown): Uint8Array {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.byteLength > SANDBOX_MAX_CONTROL_FRAME_BYTES) {
    throw new SandboxCommandError("INVALID_REQUEST", "A sandbox control frame exceeds its fixed byte limit.");
  }
  return binaryFrame(type, payload);
}

export function binaryFrame(type: SandboxFrameType, payload: Uint8Array): Uint8Array {
  if (!Number.isSafeInteger(payload.byteLength) || payload.byteLength > 0xffff_ffff) {
    throw new SandboxCommandError("INVALID_REQUEST", "A sandbox frame length is invalid.");
  }
  const framed = Buffer.allocUnsafe(5 + payload.byteLength);
  framed[0] = type;
  framed.writeUInt32BE(payload.byteLength, 1);
  framed.set(payload, 5);
  return framed;
}

