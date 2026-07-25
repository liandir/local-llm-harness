import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { once } from "node:events";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PROTOCOL_MAGIC = Buffer.from([0x4c, 0x4c, 0x48, 0x53, 0x42, 0x58, 0x30, 0x31]);
export const PROTOCOL_VERSION = 1;
export const FRAME = Object.freeze({
  COMMAND: 1,
  DIRECTORY: 2,
  FILE_START: 3,
  FILE_CHUNK: 4,
  FILE_END: 5,
  SNAPSHOT_END: 6
});

const LIMITS = Object.freeze({
  inputDeadlineMs: 20_000,
  maxControlFrameBytes: 1024 * 1024,
  maxChunkBytes: 64 * 1024,
  maxEntries: 50_000,
  maxTotalBytes: 256 * 1024 * 1024,
  maxFileBytes: 64 * 1024 * 1024,
  maxDepth: 128,
  maxArgs: 256,
  maxArgumentBytes: 16 * 1024,
  maxArgvBytes: 256 * 1024,
  maxTimeoutMs: 5 * 60 * 1000,
  maxOutputBytes: 16 * 1024 * 1024
});

/** Keep synchronized with src/security/commands/sandboxEnvironment.ts. */
export const SANDBOX_CHILD_ENV = Object.freeze({
  PATH: "/usr/bin:/bin",
  HOME: "/tmp/home",
  XDG_CONFIG_HOME: "/tmp/xdg",
  TMPDIR: "/tmp",
  LANG: "C",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "/bin/false",
  SSH_ASKPASS: "/bin/false",
  GIT_PAGER: "cat",
  PAGER: "cat",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_NO_LAZY_FETCH: "1",
  GIT_LITERAL_PATHSPECS: "1",
  GIT_CEILING_DIRECTORIES: "/workspace",
  GIT_EDITOR: "/bin/false",
  GIT_SEQUENCE_EDITOR: "/bin/false",
  GIT_SSH_COMMAND: "/bin/false",
  GIT_PROXY_COMMAND: "/bin/false",
  NO_COLOR: "1"
});

/**
 * Re-check the live container from inside PID 1. Host-side inspect is necessary
 * but not sufficient because daemon state could drift between inspect/start.
 */
export async function attestRuntime(adapter = {}) {
  const readFile = adapter.readFile ?? (file => fs.readFile(file, "utf8"));
  const readBinaryFile = adapter.readBinaryFile ?? (file => fs.readFile(file));
  const readDirectory = adapter.readDirectory ?? (directory => fs.readdir(directory));
  const pid = adapter.pid ?? process.pid;
  const uid = adapter.uid ?? process.getuid?.();
  const gid = adapter.gid ?? process.getgid?.();
  const environment = adapter.environment ?? process.env;
  if (pid !== 1 || uid !== 65532 || gid !== 65532) {
    throw new ProtocolError("The supervisor is not PID 1 under uid/gid 65532.");
  }

  const profileDigest = environment.LLH_SANDBOX_PROFILE;
  const expectedSupervisorHash = environment.LLH_SUPERVISOR_SHA256;
  if (!/^[0-9a-f]{64}$/.test(profileDigest ?? "") || !/^[0-9a-f]{64}$/.test(expectedSupervisorHash ?? "")) {
    throw new ProtocolError("The runtime profile binding is missing or invalid.");
  }
  const supervisorPath = adapter.supervisorPath ?? fileURLToPath(import.meta.url);
  const actualSupervisorHash = createHash("sha256")
    .update(await readBinaryFile(supervisorPath))
    .digest("hex");
  if (actualSupervisorHash !== expectedSupervisorHash) {
    throw new ProtocolError("The packaged supervisor bytes do not match the attested image profile.");
  }
  const expectedEnvironment = {
    ...SANDBOX_CHILD_ENV,
    LLH_SANDBOX_PROFILE: profileDigest,
    LLH_SUPERVISOR_SHA256: expectedSupervisorHash,
    HOSTNAME: "llh-sandbox"
  };
  const actualKeys = Object.keys(environment).sort();
  const expectedKeys = Object.keys(expectedEnvironment).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    expectedKeys.some(key => environment[key] !== expectedEnvironment[key])
  ) {
    throw new ProtocolError("The supervisor inherited an unexpected container environment.");
  }

  const status = parseProcStatus(await readFile("/proc/self/status"));
  for (const key of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) {
    if (!/^0+$/.test(status[key] ?? "")) throw new ProtocolError("The supervisor retained a Linux capability.");
  }
  if (
    status.NoNewPrivs !== "1" || status.Seccomp !== "2" ||
    Number(status.Seccomp_filters ?? "0") < 1 ||
    !allIdentityValues(status.Uid, 65532) || !allIdentityValues(status.Gid, 65532) ||
    (status.Groups ?? "").trim() !== "" ||
    !status.NSpid?.trim().split(/\s+/).every(value => value === "1")
  ) {
    throw new ProtocolError("The live process security status differs from the fixed sandbox profile.");
  }

  const mounts = parseMountInfo(await readFile("/proc/self/mountinfo"));
  attestRootMount(requiredMount(mounts, "/"));
  attestTmpfsMount(requiredMount(mounts, "/workspace"), {
    executable: true,
    bytes: 768 * 1024 * 1024,
    inodes: 131_072
  });
  attestTmpfsMount(requiredMount(mounts, "/tmp"), {
    executable: false,
    bytes: 128 * 1024 * 1024,
    inodes: 32_768
  });

  const cgroup = (await readFile("/proc/self/cgroup")).trim().split(/\r?\n/).filter(Boolean);
  if (cgroup.length !== 1 || cgroup[0] !== "0::/") {
    throw new ProtocolError("The supervisor is not in a private cgroup-v2 namespace.");
  }
  const pidsMax = (await readFile("/sys/fs/cgroup/pids.max")).trim();
  const memoryMax = (await readFile("/sys/fs/cgroup/memory.max")).trim();
  const swapMax = (await readFile("/sys/fs/cgroup/memory.swap.max")).trim();
  const cpuMax = (await readFile("/sys/fs/cgroup/cpu.max")).trim();
  if (pidsMax !== "256" || memoryMax !== String(2 * 1024 * 1024 * 1024) || swapMax !== "0") {
    throw new ProtocolError("The live cgroup memory, swap, or PID bounds are not the fixed profile.");
  }
  const [quotaText, periodText, ...cpuExtra] = cpuMax.split(/\s+/);
  const quota = Number(quotaText);
  const period = Number(periodText);
  if (cpuExtra.length !== 0 || !Number.isSafeInteger(quota) || !Number.isSafeInteger(period) || quota <= 0 || period <= 0 || quota !== period * 2) {
    throw new ProtocolError("The live cgroup CPU bound is not exactly two CPUs.");
  }

  const limits = parseProcLimits(await readFile("/proc/self/limits"));
  if (limits.get("Max open files") !== "1024 1024 files" || limits.get("Max core file size") !== "0 0 bytes") {
    throw new ProtocolError("The live process ulimits differ from the fixed sandbox profile.");
  }

  const interfaces = [...await readDirectory("/sys/class/net")].sort();
  if (interfaces.length !== 1 || interfaces[0] !== "lo") {
    throw new ProtocolError("The network-disabled sandbox has a non-loopback interface.");
  }
  attestOnlyLoopbackRoutes(await readFile("/proc/net/route"), false);
  attestOnlyLoopbackRoutes(await readFile("/proc/net/ipv6_route"), true);
  return Object.freeze({ profileDigest });
}

class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProtocolError";
  }
}

/**
 * Parse, authenticate, and extract a complete framed snapshot. No command is
 * started until the terminal digest/count frame and EOF have been verified.
 */
export async function extractSandboxInput(input, workspaceRoot, options = {}) {
  const limits = validateInternalLimits(options.limits ?? LIMITS);
  const root = await verifyEmptyWorkspaceRoot(workspaceRoot);
  const reader = new FrameReader(input, options.inputDeadlineMs ?? limits.inputDeadlineMs);
  const magic = await reader.readExact(PROTOCOL_MAGIC.byteLength);
  if (!magic.equals(PROTOCOL_MAGIC)) throw new ProtocolError("Invalid sandbox protocol magic.");

  const first = await reader.readFrame(limits);
  if (first.type !== FRAME.COMMAND) throw new ProtocolError("The command frame must be first.");
  const command = validateCommand(
    parseControl(first.payload, "command"),
    limits,
    options.expectedProfileDigest
  );

  const seen = new Set();
  const directories = new Set([""]);
  const treeHash = createHash("sha256");
  let previousPath = "";
  let entries = 0;
  let totalBytes = 0;
  let currentFile;
  let ended = false;

  while (!ended) {
    const frame = await reader.readFrame(limits);
    if (frame.type === FRAME.DIRECTORY) {
      requireNoOpenFile(currentFile);
      const metadata = validateDirectory(parseControl(frame.payload, "directory"), limits);
      assertEntryOrder(metadata.path, previousPath, seen);
      assertKnownParent(metadata.path, directories);
      entries = incrementEntries(entries, limits);
      const target = targetPath(root, metadata.path);
      await fs.mkdir(target, { recursive: false, mode: metadata.mode });
      await assertExtractedDirectory(target);
      directories.add(metadata.path);
      seen.add(metadata.path);
      previousPath = metadata.path;
      treeHash.update(`D\0${metadata.path}\0${metadata.mode.toString(8)}\n`, "utf8");
      continue;
    }

    if (frame.type === FRAME.FILE_START) {
      requireNoOpenFile(currentFile);
      const metadata = validateFileStart(parseControl(frame.payload, "file"), limits);
      assertEntryOrder(metadata.path, previousPath, seen);
      assertKnownParent(metadata.path, directories);
      if (totalBytes + metadata.size > limits.maxTotalBytes) {
        throw new ProtocolError("The snapshot exceeds its total byte ceiling.");
      }
      entries = incrementEntries(entries, limits);
      const target = targetPath(root, metadata.path);
      const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
      const handle = await fs.open(
        target,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
        metadata.mode
      );
      currentFile = {
        ...metadata,
        handle,
        target,
        written: 0,
        hash: createHash("sha256")
      };
      seen.add(metadata.path);
      previousPath = metadata.path;
      continue;
    }

    if (frame.type === FRAME.FILE_CHUNK) {
      if (!currentFile) throw new ProtocolError("A file chunk appeared outside a file frame sequence.");
      if (frame.payload.byteLength === 0 || frame.payload.byteLength > limits.maxChunkBytes) {
        throw new ProtocolError("A file chunk has an invalid length.");
      }
      if (currentFile.written + frame.payload.byteLength > currentFile.size) {
        throw new ProtocolError("A file frame exceeds its declared size.");
      }
      await writeWhole(currentFile.handle, frame.payload, currentFile.written);
      currentFile.hash.update(frame.payload);
      currentFile.written += frame.payload.byteLength;
      continue;
    }

    if (frame.type === FRAME.FILE_END) {
      if (!currentFile || frame.payload.byteLength !== 0) {
        throw new ProtocolError("A file-end frame is misplaced or non-empty.");
      }
      const completed = currentFile;
      currentFile = undefined;
      try {
        if (completed.written !== completed.size || completed.hash.digest("hex") !== completed.sha256) {
          throw new ProtocolError("A file size or SHA-256 digest does not match its declaration.");
        }
        await completed.handle.sync();
        await completed.handle.chmod(completed.mode);
      } finally {
        await completed.handle.close();
      }
      await assertExtractedFile(completed.target, completed.size);
      totalBytes += completed.size;
      treeHash.update(
        `F\0${completed.path}\0${completed.mode.toString(8)}\0${completed.size}\0${completed.sha256}\n`,
        "utf8"
      );
      continue;
    }

    if (frame.type === FRAME.SNAPSHOT_END) {
      requireNoOpenFile(currentFile);
      const summary = validateSummary(parseControl(frame.payload, "snapshot summary"));
      const actualDigest = treeHash.digest("hex");
      if (
        summary.entryCount !== entries || summary.totalBytes !== totalBytes ||
        summary.digest !== actualDigest
      ) {
        throw new ProtocolError("The terminal snapshot count, size, or digest does not match extracted data.");
      }
      ended = true;
      continue;
    }

    throw new ProtocolError("An unknown or out-of-order sandbox frame was received.");
  }

  await reader.requireEof();
  const cwd = command.cwd === "" ? root : targetPath(root, command.cwd);
  await assertCommandDirectory(cwd);
  const verifyExecutable = options.verifyExecutable ?? assertExecutable;
  await verifyExecutable(command.executable, root);
  return Object.freeze({ command, workspaceRoot: root, cwd, entryCount: entries, totalBytes });
}

/** Execute one validated argv with no shell, fixed env, output cap, and deadline. */
export async function executeSandboxCommand(extracted, io = {}) {
  const childSpawn = io.spawn ?? spawn;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const killTree = io.killTree ?? killAllOtherProcesses;
  if (io.prepareEnvironment) {
    await io.prepareEnvironment();
  } else {
    await fs.mkdir("/tmp/home", { recursive: true, mode: 0o700 });
    await fs.mkdir("/tmp/xdg", { recursive: true, mode: 0o700 });
  }

  let child;
  try {
    child = childSpawn(extracted.command.executable, [...extracted.command.args], {
      cwd: extracted.cwd,
      env: { ...SANDBOX_CHILD_ENV },
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    await writeStream(stderr, Buffer.from("Sandbox supervisor could not start the approved executable.\n"));
    return 126;
  }

  let timedOut = false;
  let outputExceeded = false;
  let outputBytes = 0;
  let terminationStarted = false;
  const terminate = async () => {
    if (terminationStarted) return;
    terminationStarted = true;
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {}
    try {
      child.kill("SIGKILL");
    } catch {}
    await killTree();
  };

  const forward = async (readable, writable) => {
    if (!readable) return;
    for await (const raw of readable) {
      const chunk = Buffer.from(raw);
      const remaining = extracted.command.maxOutputBytes - outputBytes;
      if (remaining > 0) {
        const allowed = chunk.subarray(0, Math.min(remaining, chunk.byteLength));
        outputBytes += allowed.byteLength;
        await writeStream(writable, allowed);
      }
      if (chunk.byteLength > Math.max(remaining, 0)) {
        outputExceeded = true;
        // One extra byte makes the host's independent bounded capture report
        // truncation without trusting a command-controlled marker.
        await writeStream(writable, Buffer.from([0]));
        await terminate();
        return;
      }
    }
  };

  const timer = setTimeout(() => {
    timedOut = true;
    void terminate();
  }, extracted.command.timeoutMs);
  timer.unref?.();
  const outputs = Promise.all([
    forward(child.stdout, stdout),
    forward(child.stderr, stderr)
  ]);
  let exitCode = 125;
  try {
    const [code, signal] = await once(child, "close");
    await outputs;
    if (timedOut) exitCode = 124;
    else if (outputExceeded) exitCode = 125;
    else if (Number.isInteger(code) && code >= 0 && code <= 255) exitCode = code;
    else exitCode = signalNumber(signal);
  } finally {
    clearTimeout(timer);
    await terminate();
  }
  return exitCode;
}

/** Kill every remaining container PID; the supervisor is expected to be PID 1. */
export async function killAllOtherProcesses() {
  let entries;
  try {
    entries = await fs.readdir("/proc");
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!/^[0-9]+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid <= 1 || pid === process.pid) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

class FrameReader {
  constructor(input, deadlineMs) {
    if (!input || typeof input[Symbol.asyncIterator] !== "function") {
      throw new ProtocolError("Supervisor input must be an asynchronous byte stream.");
    }
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > LIMITS.inputDeadlineMs) {
      throw new ProtocolError("The supervisor input deadline is invalid.");
    }
    this.iterator = input[Symbol.asyncIterator]();
    this.deadline = Date.now() + deadlineMs;
    this.buffer = Buffer.alloc(0);
    this.ended = false;
  }

  async readFrame(limits) {
    const header = await this.readExact(5);
    const type = header[0];
    const length = header.readUInt32BE(1);
    const control = type !== FRAME.FILE_CHUNK && type !== FRAME.FILE_END;
    const maximum = control ? limits.maxControlFrameBytes : limits.maxChunkBytes;
    if (length > maximum) throw new ProtocolError("A sandbox frame exceeds its type-specific byte limit.");
    return { type, payload: await this.readExact(length) };
  }

  async readExact(length) {
    if (!Number.isSafeInteger(length) || length < 0) throw new ProtocolError("Invalid frame length.");
    while (this.buffer.byteLength < length) {
      if (this.ended) throw new ProtocolError("Sandbox input ended inside a frame.");
      const next = await this.nextBeforeDeadline();
      if (next.done) {
        this.ended = true;
        continue;
      }
      if (!(next.value instanceof Uint8Array) || next.value.byteLength === 0) {
        throw new ProtocolError("Sandbox input yielded an invalid byte chunk.");
      }
      this.buffer = Buffer.concat([this.buffer, Buffer.from(next.value)]);
      if (this.buffer.byteLength > LIMITS.maxControlFrameBytes + LIMITS.maxChunkBytes + 5) {
        throw new ProtocolError("The supervisor input buffer exceeded its fixed bound.");
      }
    }
    const value = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return value;
  }

  async requireEof() {
    if (this.buffer.byteLength !== 0) throw new ProtocolError("Trailing bytes followed the snapshot summary.");
    if (this.ended) return;
    const next = await this.nextBeforeDeadline();
    if (!next.done) throw new ProtocolError("Trailing frames followed the snapshot summary.");
    this.ended = true;
  }

  async nextBeforeDeadline() {
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) throw new ProtocolError("Sandbox input exceeded its extraction deadline.");
    let timer;
    try {
      return await Promise.race([
        this.iterator.next(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new ProtocolError("Sandbox input exceeded its extraction deadline.")), remaining);
          timer.unref?.();
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function validateCommand(value, limits, expectedProfileDigest) {
  requireObject(value, "command");
  requireExactKeys(value, [
    "version", "profileDigest", "ruleId", "ruleRevision", "executable", "args", "cwd",
    "timeoutMs", "maxOutputBytes", "workspaceMode", "networkMode"
  ], "command");
  if (value.version !== PROTOCOL_VERSION || !/^[0-9a-f]{64}$/.test(value.profileDigest)) {
    throw new ProtocolError("The command protocol version or profile digest is invalid.");
  }
  if (expectedProfileDigest !== undefined && value.profileDigest !== expectedProfileDigest) {
    throw new ProtocolError("The command frame is bound to a different sandbox profile.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.ruleId) || !/^[0-9a-f]{64}$/.test(value.ruleRevision)) {
    throw new ProtocolError("The command rule identity is invalid.");
  }
  validateExecutable(value.executable);
  if (!Array.isArray(value.args) || value.args.length > limits.maxArgs) {
    throw new ProtocolError("The structured command argv exceeds its item limit.");
  }
  let bytes = Buffer.byteLength(value.executable, "utf8");
  const args = value.args.map(argument => {
    if (typeof argument !== "string" || argument.includes("\0")) {
      throw new ProtocolError("Command arguments must be NUL-free strings.");
    }
    const length = Buffer.byteLength(argument, "utf8");
    if (length > limits.maxArgumentBytes) throw new ProtocolError("A command argument exceeds its byte limit.");
    bytes += length;
    return argument;
  });
  if (bytes > limits.maxArgvBytes) throw new ProtocolError("The structured argv exceeds its total byte limit.");
  const cwd = validateRelativePath(value.cwd, true, limits.maxDepth);
  if (!isPositiveBound(value.timeoutMs, limits.maxTimeoutMs) || !isPositiveBound(value.maxOutputBytes, limits.maxOutputBytes)) {
    throw new ProtocolError("The command resource limits are invalid.");
  }
  if (value.workspaceMode !== "ephemeral-copy" || value.networkMode !== "none") {
    throw new ProtocolError("The command requested an unsupported sandbox mode.");
  }
  return Object.freeze({
    profileDigest: value.profileDigest,
    ruleId: value.ruleId,
    ruleRevision: value.ruleRevision,
    executable: value.executable,
    args: Object.freeze(args),
    cwd,
    timeoutMs: value.timeoutMs,
    maxOutputBytes: value.maxOutputBytes
  });
}

function validateDirectory(value, limits) {
  requireObject(value, "directory");
  requireExactKeys(value, ["type", "path", "mode"], "directory");
  if (value.type !== "directory" || value.mode !== 0o700) throw new ProtocolError("Invalid directory metadata.");
  return { type: "directory", path: validateRelativePath(value.path, false, limits.maxDepth), mode: 0o700 };
}

function validateFileStart(value, limits) {
  requireObject(value, "file");
  requireExactKeys(value, ["type", "path", "mode", "size", "sha256"], "file");
  if (value.type !== "file" || (value.mode !== 0o600 && value.mode !== 0o700)) {
    throw new ProtocolError("Invalid file metadata.");
  }
  if (!Number.isSafeInteger(value.size) || value.size < 0 || value.size > limits.maxFileBytes) {
    throw new ProtocolError("A file size exceeds its fixed bound.");
  }
  if (!/^[0-9a-f]{64}$/.test(value.sha256)) throw new ProtocolError("A file digest is invalid.");
  return {
    type: "file",
    path: validateRelativePath(value.path, false, limits.maxDepth),
    mode: value.mode,
    size: value.size,
    sha256: value.sha256
  };
}

function validateSummary(value) {
  requireObject(value, "snapshot summary");
  requireExactKeys(value, ["entryCount", "totalBytes", "digest"], "snapshot summary");
  if (
    !Number.isSafeInteger(value.entryCount) || value.entryCount < 0 ||
    !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 0 ||
    !/^[0-9a-f]{64}$/.test(value.digest)
  ) {
    throw new ProtocolError("The terminal snapshot summary is invalid.");
  }
  return value;
}

function validateRelativePath(value, allowRoot, maxDepth) {
  if (typeof value !== "string" || value.length > 4096 || /[\0-\x1f\x7f\\:]/.test(value)) {
    throw new ProtocolError("A snapshot path contains a forbidden character.");
  }
  if (value === "") {
    if (allowRoot) return "";
    throw new ProtocolError("A snapshot entry cannot name the workspace root.");
  }
  if (value.startsWith("/") || value.startsWith("//") || /^[A-Za-z]:/.test(value)) {
    throw new ProtocolError("Absolute or drive paths are forbidden.");
  }
  const parts = value.split("/");
  if (parts.length > maxDepth) throw new ProtocolError("A snapshot path exceeds its depth bound.");
  for (const part of parts) {
    if (part === "" || part === "." || part === ".." || part.endsWith(".") || part.endsWith(" ") || isWindowsDevice(part)) {
      throw new ProtocolError("A snapshot path is non-canonical or platform-sensitive.");
    }
  }
  return parts.join("/");
}

function validateExecutable(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\0")) {
    throw new ProtocolError("The executable path is invalid.");
  }
  if (!path.posix.isAbsolute(value) || path.posix.normalize(value) !== value || value.includes("//") || value.endsWith("/")) {
    throw new ProtocolError("The executable must be a canonical absolute POSIX path.");
  }
  if (!["/bin/", "/usr/bin/", "/usr/local/bin/"].some(prefix => value.startsWith(prefix) && !value.slice(prefix.length).includes("/"))) {
    throw new ProtocolError("The executable is outside the immutable command directories.");
  }
}

async function verifyEmptyWorkspaceRoot(workspaceRoot) {
  if (typeof workspaceRoot !== "string" || !path.isAbsolute(workspaceRoot) || workspaceRoot.includes("\0")) {
    throw new ProtocolError("The supervisor workspace root is invalid.");
  }
  const root = path.resolve(workspaceRoot);
  const stats = await fs.lstat(root, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new ProtocolError("The supervisor workspace is not a real directory.");
  const canonical = await fs.realpath(root);
  if (!sameHostPath(root, canonical)) throw new ProtocolError("The supervisor workspace root resolves through a link.");
  if ((await fs.readdir(root)).length !== 0) throw new ProtocolError("The ephemeral workspace tmpfs was not empty.");
  return root;
}

async function assertExtractedDirectory(target) {
  const stats = await fs.lstat(target, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new ProtocolError("An extracted directory changed type.");
  const canonical = await fs.realpath(target);
  if (!sameHostPath(target, canonical)) throw new ProtocolError("An extracted directory resolves through a link.");
}

async function assertExtractedFile(target, expectedSize) {
  const stats = await fs.lstat(target, { bigint: true });
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n || stats.size !== BigInt(expectedSize)) {
    throw new ProtocolError("An extracted file changed identity, type, or size.");
  }
}

async function assertCommandDirectory(target) {
  const stats = await fs.lstat(target, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new ProtocolError("The command working directory is not an extracted directory.");
  const canonical = await fs.realpath(target);
  if (!sameHostPath(target, canonical)) throw new ProtocolError("The command working directory resolves through a link.");
}

async function assertExecutable(executable, workspaceRoot) {
  validateExecutable(executable);
  if (isWithin(workspaceRoot, executable)) throw new ProtocolError("Executables must come from the immutable image, not the copied workspace.");
  const stats = await fs.lstat(executable, { bigint: true });
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o111n) === 0n) {
    throw new ProtocolError("The approved executable is missing, linked, or not executable.");
  }
  const canonical = await fs.realpath(executable);
  if (!sameHostPath(canonical, executable)) throw new ProtocolError("The approved executable resolves through a link.");
}

async function writeWhole(handle, bytes, position) {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, position + offset);
    if (result.bytesWritten <= 0) throw new ProtocolError("The tmpfs refused a file write.");
    offset += result.bytesWritten;
  }
}

async function writeStream(stream, bytes) {
  if (bytes.byteLength === 0) return;
  if (!stream.write(bytes)) await once(stream, "drain");
}

function parseControl(payload, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch (error) {
    throw new ProtocolError(`The ${label} frame is not valid UTF-8.`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ProtocolError(`The ${label} frame is not valid JSON.`);
  }
}

function parseProcStatus(source) {
  const values = {};
  for (const line of source.split(/\r?\n/)) {
    const match = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

function allIdentityValues(value, expected) {
  const fields = value?.trim().split(/\s+/) ?? [];
  return fields.length === 4 && fields.every(field => field === String(expected));
}

function parseMountInfo(source) {
  const mounts = [];
  for (const line of source.trim().split(/\r?\n/)) {
    if (line === "") continue;
    const separator = line.indexOf(" - ");
    if (separator < 0) throw new ProtocolError("The kernel mount table is malformed.");
    const left = line.slice(0, separator).split(" ");
    const right = line.slice(separator + 3).split(" ");
    if (left.length < 6 || right.length < 3) throw new ProtocolError("The kernel mount table is incomplete.");
    mounts.push({
      root: decodeMountField(left[3]),
      mountPoint: decodeMountField(left[4]),
      mountOptions: new Set(left[5].split(",")),
      optionalFields: left.slice(6),
      fileSystem: right[0],
      source: decodeMountField(right[1]),
      superOptions: new Set(right[2].split(","))
    });
  }
  return mounts;
}

function decodeMountField(value) {
  return value.replace(/\\(040|011|012|134)/g, (_, code) => ({
    "040": " ", "011": "\t", "012": "\n", "134": "\\"
  })[code]);
}

function requiredMount(mounts, mountPoint) {
  const matches = mounts.filter(mount => mount.mountPoint === mountPoint);
  if (matches.length !== 1) throw new ProtocolError(`The required ${mountPoint} mount is missing or ambiguous.`);
  return matches[0];
}

function attestRootMount(mount) {
  // A container root can be a read-only VFS mount over a writable overlay
  // superblock; the per-mount flag is the authority enforced for this process.
  if (!mount.mountOptions.has("ro") || mount.mountOptions.has("rw")) {
    throw new ProtocolError("The container root filesystem is not read-only.");
  }
}

function attestTmpfsMount(mount, expected) {
  const allOptions = new Set([...mount.mountOptions, ...mount.superOptions]);
  if (
    mount.fileSystem !== "tmpfs" || mount.source !== "tmpfs" || mount.root !== "/" ||
    !allOptions.has("rw") || !allOptions.has("nosuid") || !allOptions.has("nodev") ||
    !allOptions.has("noatime") ||
    (expected.executable ? allOptions.has("noexec") : !allOptions.has("noexec")) ||
    mount.optionalFields.some(field => /^(?:shared|master|propagate_from):/.test(field)) ||
    mountOptionValue(allOptions, "nr_inodes") !== String(expected.inodes) ||
    !["700", "0700"].includes(mountOptionValue(allOptions, "mode") ?? "") ||
    mountOptionValue(allOptions, "uid") !== "65532" || mountOptionValue(allOptions, "gid") !== "65532" ||
    parseByteSize(mountOptionValue(allOptions, "size")) !== expected.bytes
  ) {
    throw new ProtocolError(`The live ${mount.mountPoint} tmpfs differs from the fixed sandbox profile.`);
  }
}

function mountOptionValue(options, key) {
  const prefix = `${key}=`;
  const values = [...options].filter(option => option.startsWith(prefix));
  return values.length === 1 ? values[0].slice(prefix.length) : undefined;
}

function parseByteSize(value) {
  const match = /^(\d+)([kKmMgG]?)$/.exec(value ?? "");
  if (!match) return undefined;
  const multiplier = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match[2].toLowerCase()];
  const number = Number(match[1]);
  return Number.isSafeInteger(number) ? number * multiplier : undefined;
}

function parseProcLimits(source) {
  const values = new Map();
  for (const line of source.split(/\r?\n/)) {
    const match = /^(Max open files|Max core file size)\s+(\S+)\s+(\S+)\s+(\S+)\s*$/.exec(line);
    if (match) values.set(match[1], `${match[2]} ${match[3]} ${match[4]}`);
  }
  return values;
}

function attestOnlyLoopbackRoutes(source, ipv6) {
  const lines = source.trim().split(/\r?\n/).filter(Boolean);
  const routes = ipv6 ? lines : lines.slice(1);
  for (const line of routes) {
    const fields = line.trim().split(/\s+/);
    const iface = ipv6 ? fields.at(-1) : fields[0];
    if (iface !== "lo") throw new ProtocolError("The network-disabled sandbox has a non-loopback route.");
  }
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ProtocolError(`The ${label} frame is not a plain object.`);
  }
}

function requireExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new ProtocolError(`The ${label} frame has missing or unknown fields.`);
  }
}

function assertEntryOrder(current, previous, seen) {
  if (seen.has(current) || (previous !== "" && current <= previous)) {
    throw new ProtocolError("Snapshot entries are duplicated or not in canonical order.");
  }
}

function assertKnownParent(relative, directories) {
  const slash = relative.lastIndexOf("/");
  const parent = slash < 0 ? "" : relative.slice(0, slash);
  if (!directories.has(parent)) throw new ProtocolError("A snapshot entry appeared before its parent directory.");
}

function requireNoOpenFile(current) {
  if (current) throw new ProtocolError("A file frame sequence was interrupted.");
}

function incrementEntries(current, limits) {
  if (current >= limits.maxEntries) throw new ProtocolError("The snapshot entry ceiling was exceeded.");
  return current + 1;
}

function targetPath(root, relative) {
  const target = path.join(root, ...relative.split("/"));
  if (!isWithin(root, target)) throw new ProtocolError("A snapshot target escaped the workspace root.");
  return target;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function sameHostPath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isWindowsDevice(component) {
  const base = component.split(".", 1)[0].replace(/[ .]+$/u, "").toUpperCase();
  return /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])$/u.test(base);
}

function isPositiveBound(value, maximum) {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function validateInternalLimits(limits) {
  const required = [
    "inputDeadlineMs", "maxControlFrameBytes", "maxChunkBytes", "maxEntries", "maxTotalBytes",
    "maxFileBytes", "maxDepth", "maxArgs", "maxArgumentBytes", "maxArgvBytes",
    "maxTimeoutMs", "maxOutputBytes"
  ];
  if (required.some(key => !Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > LIMITS[key])) {
    throw new ProtocolError("Internal supervisor limits are invalid.");
  }
  return Object.freeze({ ...limits });
}

function signalNumber(signal) {
  const numbers = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
  return 128 + (numbers[signal] ?? 0);
}

async function main() {
  let exitCode = 125;
  try {
    const runtime = await attestRuntime();
    const extracted = await extractSandboxInput(process.stdin, "/workspace", {
      expectedProfileDigest: runtime.profileDigest
    });
    exitCode = await executeSandboxCommand(extracted);
  } catch (error) {
    const message = error instanceof ProtocolError
      ? error.message
      : "The sandbox supervisor failed closed.";
    process.stderr.write(`Sandbox supervisor refused execution: ${message}\n`);
  } finally {
    await killAllOtherProcesses();
  }
  process.exitCode = exitCode;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) await main();
