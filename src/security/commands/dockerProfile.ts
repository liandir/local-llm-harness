import { createHash } from "node:crypto";
import * as path from "node:path";
import type { CommandRequest } from "../../chat/session/ports.js";
import { parseWorkspacePath } from "../workspace/pathPolicy.js";
import {
  DEFAULT_SANDBOX_SNAPSHOT_LIMITS,
  type SandboxSnapshotLimits
} from "../workspace/sandboxSnapshot.js";
import { SandboxCommandError } from "./errors.js";
import { SANDBOX_ENV_ARGUMENTS, SANDBOX_PROCESS_ENV } from "./sandboxEnvironment.js";
import type { DockerTransport } from "./transport.js";
import { PACKAGED_SUPERVISOR_SHA256 } from "./supervisorIntegrity.js";

export const DOCKER_BACKEND = "docker" as const;
export const SUPERVISOR_EXECUTABLE = "/usr/local/bin/node";
export const SUPERVISOR_SCRIPT = "/opt/local-llm-harness/supervisor.mjs";
export const SANDBOX_WORKSPACE = "/workspace";
export const SANDBOX_IMAGE_PROFILE_LABEL = "local-llm-harness.supervisor-profile";
export const SANDBOX_IMAGE_PROFILE_VERSION = "1";
export const SANDBOX_WORKSPACE_MODE = "ephemeral-copy" as const;
export const SANDBOX_NETWORK_MODE = "none" as const;

export const COMMAND_LIMIT_CEILING = Object.freeze({
  timeoutMs: 5 * 60 * 1000,
  maxOutputBytes: 16 * 1024 * 1024,
  maxArgs: 256,
  maxArgumentBytes: 16 * 1024,
  maxArgvBytes: 256 * 1024
});

export const DOCKER_OPERATION_LIMITS = Object.freeze({
  inspectTimeoutMs: 15_000,
  lifecycleTimeoutMs: 30_000,
  cleanupTimeoutMs: 15_000,
  metadataOutputBytes: 2 * 1024 * 1024
});

export const DOCKER_RESOURCE_PROFILE = Object.freeze({
  workspaceTmpfsBytes: 768 * 1024 * 1024,
  workspaceInodes: 131_072,
  temporaryTmpfsBytes: 128 * 1024 * 1024,
  temporaryInodes: 32_768,
  memoryBytes: 2 * 1024 * 1024 * 1024,
  pids: 256,
  nanoCpus: 2_000_000_000,
  nofile: 1_024
});

export type DockerSandboxPlatform = "linux/amd64" | "linux/arm64";

export interface DockerSandboxCommandPortOptions {
  readonly workspaceRoot: string;
  readonly dockerCliPath: string;
  readonly dockerHost: string;
  readonly dockerConfigDirectory: string;
  /** Immutable repo@sha256 reference or an immutable sha256 image ID. */
  readonly image: string;
  readonly platform: DockerSandboxPlatform;
  readonly transport?: DockerTransport;
  readonly hostEnvironment?: Readonly<Record<string, string>>;
  readonly snapshotLimits?: Readonly<SandboxSnapshotLimits>;
  readonly transactionIdFactory?: () => string;
  /** Test seam for endpoint syntax; production must leave this unset. */
  readonly hostPlatform?: NodeJS.Platform;
}

export interface DockerSandboxBootstrapOptions {
  readonly workspaceRoot: string;
  readonly dockerCliPath: string;
  readonly dockerHost: string;
  readonly dockerConfigDirectory: string;
  readonly image: string;
  readonly platform: DockerSandboxPlatform;
  readonly snapshotLimits: Readonly<SandboxSnapshotLimits>;
  readonly dockerArchitecture: "amd64" | "arm64";
}

export interface ResolvedDockerSandboxCommandPortOptions extends Omit<DockerSandboxCommandPortOptions, "image"> {
  readonly imageReference: string;
  readonly imageId: string;
}

export interface ValidatedDockerSandboxOptions {
  readonly workspaceRoot: string;
  readonly dockerCliPath: string;
  readonly dockerHost: string;
  readonly dockerConfigDirectory: string;
  readonly imageReference: string;
  readonly imageId: string;
  readonly platform: DockerSandboxPlatform;
  readonly dockerArchitecture: "amd64" | "arm64";
  readonly snapshotLimits: Readonly<SandboxSnapshotLimits>;
  readonly profileDigest: string;
}

export function validateDockerSandboxOptions(
  options: ResolvedDockerSandboxCommandPortOptions
): ValidatedDockerSandboxOptions {
  const bootstrap = validateDockerSandboxBootstrapOptions({ ...options, image: options.imageReference });
  if (!/^sha256:[0-9a-f]{64}$/.test(options.imageId)) {
    throw invalidConfiguration("The sandbox image ID must be an immutable SHA-256 identifier.");
  }
  if (options.imageReference.startsWith("sha256:") && options.imageReference !== options.imageId) {
    throw invalidConfiguration("The configured sandbox image ID changed during preflight.");
  }
  const snapshotLimits = bootstrap.snapshotLimits;
  if (snapshotLimits.maxTotalBytes >= DOCKER_RESOURCE_PROFILE.workspaceTmpfsBytes) {
    throw invalidConfiguration("The snapshot byte ceiling must leave bounded working space in /workspace tmpfs.");
  }
  const stable = {
    schema: 1,
    backend: DOCKER_BACKEND,
    dockerCliPath: bootstrap.dockerCliPath,
    dockerHost: bootstrap.dockerHost,
    dockerConfigDirectory: bootstrap.dockerConfigDirectory,
    imageReference: options.imageReference,
    imageId: options.imageId,
    platform: bootstrap.platform,
    supervisorExecutable: SUPERVISOR_EXECUTABLE,
    supervisorScript: SUPERVISOR_SCRIPT,
    supervisorSha256: PACKAGED_SUPERVISOR_SHA256,
    workspaceMode: SANDBOX_WORKSPACE_MODE,
    networkMode: SANDBOX_NETWORK_MODE,
    environment: SANDBOX_PROCESS_ENV,
    commandLimits: COMMAND_LIMIT_CEILING,
    snapshotLimits,
    resources: DOCKER_RESOURCE_PROFILE,
    createArguments: fixedCreateArguments(bootstrap.platform)
  };
  const profileDigest = createHash("sha256").update(JSON.stringify(stable), "utf8").digest("hex");
  return Object.freeze({
    workspaceRoot: bootstrap.workspaceRoot,
    dockerCliPath: bootstrap.dockerCliPath,
    dockerHost: bootstrap.dockerHost,
    dockerConfigDirectory: bootstrap.dockerConfigDirectory,
    imageReference: options.imageReference,
    imageId: options.imageId,
    platform: bootstrap.platform,
    dockerArchitecture: bootstrap.dockerArchitecture,
    snapshotLimits,
    profileDigest
  });
}

export function validateDockerSandboxBootstrapOptions(
  options: DockerSandboxCommandPortOptions
): DockerSandboxBootstrapOptions {
  const hostPlatform = options.hostPlatform ?? process.platform;
  const dockerCliPath = absoluteHostPath(options.dockerCliPath, "Docker CLI");
  const dockerConfigDirectory = absoluteHostPath(options.dockerConfigDirectory, "Docker configuration directory");
  const workspaceRoot = absoluteHostPath(options.workspaceRoot, "workspace root");
  if (
    isSameOrWithin(workspaceRoot, dockerCliPath, hostPlatform) ||
    isSameOrWithin(workspaceRoot, dockerConfigDirectory, hostPlatform)
  ) {
    throw invalidConfiguration(
      "The trusted Docker CLI and configuration directory must be outside the model-writable workspace."
    );
  }
  const dockerHost = validateLocalDockerHost(options.dockerHost, hostPlatform);
  if (!isImmutableImageSelector(options.image)) {
    throw invalidConfiguration("The sandbox image must be a canonical repo@sha256 reference or SHA-256 image ID.");
  }
  if (options.platform !== "linux/amd64" && options.platform !== "linux/arm64") {
    throw invalidConfiguration("The sandbox platform must be explicitly linux/amd64 or linux/arm64.");
  }
  const snapshotLimits = validateSnapshotLimits(options.snapshotLimits ?? DEFAULT_SANDBOX_SNAPSHOT_LIMITS);
  return Object.freeze({
    workspaceRoot,
    dockerCliPath,
    dockerHost,
    dockerConfigDirectory,
    image: options.image,
    platform: options.platform,
    snapshotLimits,
    dockerArchitecture: options.platform === "linux/amd64" ? "amd64" : "arm64"
  });
}

export function validateCommandRequest(request: CommandRequest): CommandRequest {
  if (!request || typeof request !== "object") throw invalidRequest("A structured command request is required.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.ruleId)) {
    throw invalidRequest("The command rule identifier is invalid.");
  }
  if (!/^[0-9a-f]{64}$/.test(request.ruleRevision)) {
    throw invalidRequest("The command rule revision must be a SHA-256 digest.");
  }
  validateContainerExecutable(request.executable);
  if (!Array.isArray(request.args) || request.args.length > COMMAND_LIMIT_CEILING.maxArgs) {
    throw invalidRequest("The structured command argv exceeds its item limit.");
  }
  let argvBytes = Buffer.byteLength(request.executable, "utf8");
  const args = request.args.map(argument => {
    if (typeof argument !== "string" || argument.includes("\0")) {
      throw invalidRequest("Command arguments must be NUL-free strings.");
    }
    const bytes = Buffer.byteLength(argument, "utf8");
    if (bytes > COMMAND_LIMIT_CEILING.maxArgumentBytes) {
      throw invalidRequest("A command argument exceeds its byte limit.");
    }
    argvBytes += bytes;
    return argument;
  });
  if (argvBytes > COMMAND_LIMIT_CEILING.maxArgvBytes) {
    throw invalidRequest("The structured command argv exceeds its total byte limit.");
  }
  const cwd = request.cwd === undefined ? undefined : parseWorkspacePath(request.cwd, true).displayPath;
  const timeoutMs = checkedPositiveLimit(
    request.limits?.timeoutMs,
    COMMAND_LIMIT_CEILING.timeoutMs,
    "command timeout"
  );
  const maxOutputBytes = checkedPositiveLimit(
    request.limits?.maxOutputBytes,
    COMMAND_LIMIT_CEILING.maxOutputBytes,
    "command output"
  );
  return Object.freeze({
    ruleId: request.ruleId,
    ruleRevision: request.ruleRevision,
    executable: request.executable,
    args: Object.freeze(args),
    ...(cwd === undefined ? {} : { cwd }),
    limits: Object.freeze({ timeoutMs, maxOutputBytes })
  });
}

export function dockerGlobalArguments(
  options: Pick<ValidatedDockerSandboxOptions, "dockerConfigDirectory" | "dockerHost">
): readonly string[] {
  return ["--config", options.dockerConfigDirectory, "--host", options.dockerHost];
}

export function dockerCreateArguments(
  options: ValidatedDockerSandboxOptions,
  containerName: string
): readonly string[] {
  if (!/^local-llm-harness-[0-9a-f]{32}$/.test(containerName)) {
    throw invalidRequest("The internal sandbox container name is invalid.");
  }
  return [
    ...dockerGlobalArguments(options),
    "container", "create",
    `--name=${containerName}`,
    "--label=local-llm-harness.managed=true",
    `--label=local-llm-harness.transaction=${containerName}`,
    `--label=local-llm-harness.profile=${options.profileDigest}`,
    ...fixedCreateArguments(options.platform),
    ...SANDBOX_ENV_ARGUMENTS,
    `--env=LLH_SANDBOX_PROFILE=${options.profileDigest}`,
    `--env=LLH_SUPERVISOR_SHA256=${PACKAGED_SUPERVISOR_SHA256}`,
    options.imageReference,
    SUPERVISOR_SCRIPT
  ];
}

export function fixedCreateArguments(platform: DockerSandboxPlatform): readonly string[] {
  const resources = DOCKER_RESOURCE_PROFILE;
  return Object.freeze([
    "--pull=never",
    `--platform=${platform}`,
    "--runtime=runc",
    "--network=none",
    "--read-only",
    `--tmpfs=/workspace:rw,exec,nosuid,nodev,noatime,size=${resources.workspaceTmpfsBytes},nr_inodes=${resources.workspaceInodes},mode=0700,uid=65532,gid=65532`,
    `--tmpfs=/tmp:rw,noexec,nosuid,nodev,noatime,size=${resources.temporaryTmpfsBytes},nr_inodes=${resources.temporaryInodes},mode=0700,uid=65532,gid=65532`,
    "--workdir=/workspace",
    "--user=65532:65532",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges=true",
    "--security-opt=seccomp=builtin",
    "--cgroupns=private",
    "--ipc=none",
    "--pid=private",
    "--pids-limit=256",
    `--memory=${resources.memoryBytes}`,
    `--memory-swap=${resources.memoryBytes}`,
    "--memory-swappiness=0",
    "--cpus=2.0",
    `--ulimit=nofile=${resources.nofile}:${resources.nofile}`,
    "--ulimit=core=0:0",
    "--log-driver=none",
    "--restart=no",
    "--no-healthcheck",
    "--hostname=llh-sandbox",
    "--stop-timeout=1",
    "--privileged=false",
    "--interactive",
    "--attach=stdin",
    "--attach=stdout",
    "--attach=stderr",
    `--entrypoint=${SUPERVISOR_EXECUTABLE}`
  ]);
}

function validateContainerExecutable(executable: string): void {
  if (
    typeof executable !== "string" ||
    executable.length === 0 ||
    executable.length > 4096 ||
    executable.includes("\0") ||
    !path.posix.isAbsolute(executable)
  ) {
    throw invalidRequest("The sandbox executable must be an absolute POSIX path.");
  }
  const normalized = path.posix.normalize(executable);
  if (normalized !== executable || executable.includes("//") || executable.endsWith("/")) {
    throw invalidRequest("The sandbox executable path must be canonical.");
  }
  if (!["/bin/", "/usr/bin/", "/usr/local/bin/"].some(prefix =>
    executable.startsWith(prefix) && !executable.slice(prefix.length).includes("/")
  )) {
    throw invalidRequest("The sandbox executable must come from an immutable command directory.");
  }
}

function isImmutableImageSelector(image: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(image) ||
    /^[a-z0-9][a-z0-9._/:+-]*@sha256:[0-9a-f]{64}$/.test(image);
}

function validateLocalDockerHost(host: string, platform: NodeJS.Platform): string {
  if (
    typeof host !== "string" || host.length > 4096 ||
    containsControlOrFormat(host)
  ) {
    throw invalidConfiguration("The Docker endpoint is invalid.");
  }
  if (platform === "win32") {
    if (!/^npipe:\/\/\/\/\.\/pipe\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(host)) {
      throw invalidConfiguration("Windows Docker access requires a canonical local npipe endpoint.");
    }
    return host;
  }
  if (!host.startsWith("unix:///") || host.includes("%") || /[?#]/.test(host)) {
    throw invalidConfiguration("Docker access requires a canonical local unix socket endpoint.");
  }
  const socketPath = host.slice("unix://".length);
  if (!path.posix.isAbsolute(socketPath) || path.posix.normalize(socketPath) !== socketPath || socketPath.includes("//")) {
    throw invalidConfiguration("The Docker unix socket path is not canonical.");
  }
  return host;
}

function containsControlOrFormat(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || /\p{Cf}/u.test(character)) return true;
  }
  return false;
}

function absoluteHostPath(value: string, label: string): string {
  if (typeof value !== "string" || value.includes("\0") || !path.isAbsolute(value)) {
    throw invalidConfiguration(`The ${label} must be an absolute local path.`);
  }
  return path.resolve(value);
}

function isSameOrWithin(root: string, candidate: string, platform: NodeJS.Platform): boolean {
  const normalize = (value: string): string => platform === "win32" ? value.toLowerCase() : value;
  const relative = path.relative(normalize(root), normalize(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function validateSnapshotLimits(limits: Readonly<SandboxSnapshotLimits>): Readonly<SandboxSnapshotLimits> {
  const values = [limits.maxEntries, limits.maxTotalBytes, limits.maxFileBytes, limits.maxDepth];
  if (
    values.some(value => !Number.isSafeInteger(value) || value <= 0) ||
    limits.maxFileBytes > limits.maxTotalBytes ||
    limits.maxDepth > 128
  ) {
    throw invalidConfiguration("The sandbox snapshot limits are invalid.");
  }
  return Object.freeze({ ...limits });
}

function checkedPositiveLimit(value: unknown, ceiling: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > ceiling) {
    throw invalidRequest(`The ${label} limit must be a positive integer no greater than ${ceiling}.`);
  }
  return value as number;
}

function invalidConfiguration(message: string): SandboxCommandError {
  return new SandboxCommandError("INVALID_CONFIGURATION", message);
}

function invalidRequest(message: string): SandboxCommandError {
  return new SandboxCommandError("INVALID_REQUEST", message);
}
