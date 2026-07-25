import {
  DOCKER_RESOURCE_PROFILE,
  SANDBOX_IMAGE_PROFILE_LABEL,
  SANDBOX_IMAGE_PROFILE_VERSION,
  SANDBOX_WORKSPACE,
  SUPERVISOR_EXECUTABLE,
  SUPERVISOR_SCRIPT,
  type DockerSandboxBootstrapOptions,
  type ValidatedDockerSandboxOptions
} from "./dockerProfile.js";
import { SandboxCommandError } from "./errors.js";
import { SANDBOX_PROCESS_ENV } from "./sandboxEnvironment.js";
import type { DockerTransportResult } from "./transport.js";
import {
  PACKAGED_SUPERVISOR_SHA256,
  SANDBOX_SUPERVISOR_HASH_LABEL
} from "./supervisorIntegrity.js";

type JsonObject = Record<string, unknown>;

export interface BackendAttestation {
  readonly backend: "docker";
  readonly profileDigest: string;
  readonly imageReference: string;
  readonly imageId: string;
}

export interface ResolvedSandboxImage {
  readonly imageReference: string;
  readonly imageId: string;
}

export function attestDockerVersion(
  result: DockerTransportResult,
  options: Pick<ValidatedDockerSandboxOptions, "dockerArchitecture">
): void {
  requireSuccessfulMetadata(result, "Docker version verification");
  const value = parseJson(result.stdout, "Docker version output");
  const root = object(value, "Docker version output");
  const server = object(root.Server, "Docker server metadata");
  if (server.Os !== "linux" || server.Arch !== options.dockerArchitecture) {
    throw attestationFailure("The Docker daemon is not the expected local Linux sandbox architecture.");
  }
}

export function attestSandboxImage(
  result: DockerTransportResult,
  options: ValidatedDockerSandboxOptions
): BackendAttestation {
  const resolved = resolveSandboxImage(result, {
    ...options,
    image: options.imageReference
  });
  if (resolved.imageId !== options.imageId) {
    throw attestationFailure("The local sandbox image does not match its configured immutable digest and image ID.");
  }
  return Object.freeze({
    backend: "docker",
    profileDigest: options.profileDigest,
    imageReference: options.imageReference,
    imageId: options.imageId
  });
}

/** Resolve a repo digest to its immutable local image ID without pulling. */
export function resolveSandboxImage(
  result: DockerTransportResult,
  options: DockerSandboxBootstrapOptions
): ResolvedSandboxImage {
  requireSuccessfulMetadata(result, "Sandbox image verification");
  const inspected = singletonArray(parseJson(result.stdout, "Docker image inspection"), "Docker image inspection");
  const imageId = inspected.Id;
  const selectorMatches = typeof imageId === "string" && (
    options.image === imageId ||
    (options.image.includes("@sha256:") && stringArray(inspected.RepoDigests).includes(options.image))
  );
  if (
    !selectorMatches || !/^sha256:[0-9a-f]{64}$/.test(imageId as string) ||
    inspected.Os !== "linux" || inspected.Architecture !== options.dockerArchitecture
  ) {
    throw attestationFailure("The local sandbox image does not match its immutable selector and explicit platform.");
  }
  const config = object(inspected.Config, "sandbox image Config");
  requireExactArray(config.Entrypoint, [SUPERVISOR_EXECUTABLE], "sandbox image entrypoint");
  requireExactArray(config.Cmd, [SUPERVISOR_SCRIPT], "sandbox image command");
  if (config.User !== "65532:65532" || config.WorkingDir !== SANDBOX_WORKSPACE) {
    throw attestationFailure("The immutable sandbox image has an unexpected user or working directory.");
  }
  requireExactEnvironment(config.Env, "sandbox image environment");
  requireEmptyMap(config.Volumes, "sandbox image volumes");
  requireEmptyMap(config.ExposedPorts, "sandbox image exposed ports");
  if (config.Healthcheck !== undefined && config.Healthcheck !== null) {
    throw attestationFailure("The immutable sandbox image must not define a healthcheck.");
  }
  const labels = object(config.Labels, "sandbox image labels");
  if (labels[SANDBOX_IMAGE_PROFILE_LABEL] !== SANDBOX_IMAGE_PROFILE_VERSION) {
    throw attestationFailure("The immutable image is not labeled for the fixed packaged supervisor profile.");
  }
  if (labels[SANDBOX_SUPERVISOR_HASH_LABEL] !== PACKAGED_SUPERVISOR_SHA256) {
    throw attestationFailure("The immutable image label does not bind the packaged supervisor SHA-256.");
  }
  return Object.freeze({
    imageReference: options.image,
    imageId: imageId as string
  });
}

/** Verify the complete create-time isolation profile before starting PID 1. */
export function attestCreatedContainer(
  result: DockerTransportResult,
  options: ValidatedDockerSandboxOptions,
  containerId: string,
  containerName: string
): void {
  requireSuccessfulMetadata(result, "Created-container verification");
  const inspected = singletonArray(parseJson(result.stdout, "Docker container inspection"), "Docker container inspection");
  attestContainerIdentity(inspected, options, containerId, containerName);
  attestContainerConfig(object(inspected.Config, "container Config"), options, containerName);
  attestHostConfig(object(inspected.HostConfig, "container HostConfig"));
  attestMounts(inspected.Mounts);
  attestNetwork(object(inspected.NetworkSettings, "container NetworkSettings"));
  const state = object(inspected.State, "container State");
  if (
    state.Status !== "created" || state.Running !== false || state.Paused !== false ||
    state.Restarting !== false || state.Dead !== false || state.Pid !== 0 ||
    state.ExitCode !== 0 || state.OOMKilled !== false || state.Error !== ""
  ) {
    throw attestationFailure("The sandbox container was not in the exact inert created state.");
  }
}

/** Re-attest isolation and return the supervisor exit code before removal. */
export function attestExitedContainer(
  result: DockerTransportResult,
  options: ValidatedDockerSandboxOptions,
  containerId: string,
  containerName: string
): number {
  requireSuccessfulMetadata(result, "Exited-container verification");
  const inspected = singletonArray(parseJson(result.stdout, "Docker container inspection"), "Docker container inspection");
  attestContainerIdentity(inspected, options, containerId, containerName);
  attestContainerConfig(object(inspected.Config, "container Config"), options, containerName);
  attestHostConfig(object(inspected.HostConfig, "container HostConfig"));
  attestMounts(inspected.Mounts);
  attestNetwork(object(inspected.NetworkSettings, "container NetworkSettings"));
  const state = object(inspected.State, "container State");
  if (
    state.Status !== "exited" || state.Running !== false || state.Paused !== false ||
    state.Restarting !== false || state.Dead !== false || state.Pid !== 0 ||
    state.Error !== "" || !Number.isInteger(state.ExitCode) ||
    (state.ExitCode as number) < 0 || (state.ExitCode as number) > 255
  ) {
    throw attestationFailure("The sandbox container did not reach a valid exited state.");
  }
  return state.ExitCode as number;
}

export function attestContainerAbsent(result: DockerTransportResult): void {
  if (result.stdoutTruncated || result.stderrTruncated || result.exitCode === 0) {
    throw new SandboxCommandError("CLEANUP_FAILED", "Docker still reports the sandbox container after forced removal.");
  }
  const stderr = decodeUtf8(result.stderr, "Docker cleanup verification");
  if (!/No such (?:object|container)/i.test(stderr)) {
    throw new SandboxCommandError("CLEANUP_FAILED", "Docker could not prove that the sandbox container is absent.");
  }
}

export function decodeCommandOutput(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function attestContainerIdentity(
  inspected: JsonObject,
  options: ValidatedDockerSandboxOptions,
  containerId: string,
  containerName: string
): void {
  if (
    inspected.Id !== containerId || inspected.Name !== `/${containerName}` ||
    inspected.Image !== options.imageId || inspected.Path !== SUPERVISOR_EXECUTABLE
  ) {
    throw attestationFailure("Docker inspected a different sandbox container, image, or entrypoint.");
  }
  requireExactArray(inspected.Args, [SUPERVISOR_SCRIPT], "container supervisor argv");
}

function attestContainerConfig(
  config: JsonObject,
  options: ValidatedDockerSandboxOptions,
  containerName: string
): void {
  if (
    config.Hostname !== "llh-sandbox" || config.User !== "65532:65532" ||
    config.AttachStdin !== true || config.AttachStdout !== true || config.AttachStderr !== true ||
    config.Tty !== false || config.OpenStdin !== true || config.StdinOnce !== false ||
    config.Image !== options.imageReference || config.WorkingDir !== SANDBOX_WORKSPACE
  ) {
    throw attestationFailure("Docker altered the sandbox container process configuration.");
  }
  requireExactArray(config.Entrypoint, [SUPERVISOR_EXECUTABLE], "container entrypoint");
  requireExactArray(config.Cmd, [SUPERVISOR_SCRIPT], "container command");
  requireExactEnvironment(config.Env, "container environment", {
    LLH_SANDBOX_PROFILE: options.profileDigest,
    LLH_SUPERVISOR_SHA256: PACKAGED_SUPERVISOR_SHA256
  });
  requireEmptyMap(config.Volumes, "container volumes");
  requireEmptyMap(config.ExposedPorts, "container exposed ports");
  if (config.Healthcheck !== undefined && config.Healthcheck !== null) {
    throw attestationFailure("The sandbox container unexpectedly has a healthcheck.");
  }
  const labels = object(config.Labels, "container labels");
  if (labels["local-llm-harness.profile"] !== options.profileDigest) {
    throw attestationFailure("The sandbox container profile label does not match the prepared backend.");
  }
  if (
    labels["local-llm-harness.managed"] !== "true" ||
    labels["local-llm-harness.transaction"] !== containerName
  ) {
    throw attestationFailure("The sandbox container transaction labels are missing or changed.");
  }
  if (
    labels[SANDBOX_IMAGE_PROFILE_LABEL] !== SANDBOX_IMAGE_PROFILE_VERSION ||
    labels[SANDBOX_SUPERVISOR_HASH_LABEL] !== PACKAGED_SUPERVISOR_SHA256
  ) {
    throw attestationFailure("The sandbox container lost its immutable supervisor labels.");
  }
}

function attestHostConfig(host: JsonObject): void {
  const resources = DOCKER_RESOURCE_PROFILE;
  if (
    host.NetworkMode !== "none" || host.ReadonlyRootfs !== true || host.Privileged !== false ||
    host.PublishAllPorts !== false || host.AutoRemove !== false || host.Runtime !== "runc" ||
    host.CgroupnsMode !== "private" || host.IpcMode !== "none" ||
    (host.PidMode !== "private" && host.PidMode !== "") ||
    host.Memory !== resources.memoryBytes || host.MemorySwap !== resources.memoryBytes ||
    host.NanoCpus !== resources.nanoCpus || host.PidsLimit !== resources.pids ||
    host.MemorySwappiness !== 0
  ) {
    throw attestationFailure("Docker altered the sandbox isolation or resource profile.");
  }
  if (host.UsernsMode === "host" || host.UTSMode === "host") {
    throw attestationFailure("Host user or UTS namespaces are forbidden.");
  }
  requireEmptyArray(host.Binds, "host binds");
  requireEmptyArray(host.Mounts, "host mounts");
  requireEmptyArray(host.VolumesFrom, "inherited volumes");
  requireEmptyArray(host.Devices, "host devices");
  requireEmptyArray(host.DeviceRequests, "host device requests");
  requireEmptyArray(host.DeviceCgroupRules, "device cgroup rules");
  requireEmptyArray(host.CapAdd, "added capabilities");
  requireExactArray(host.CapDrop, ["ALL"], "dropped capabilities");
  requireExactSet(host.SecurityOpt, ["no-new-privileges=true", "seccomp=builtin"], "security options");
  requireEmptyMap(host.PortBindings, "published ports");
  requireEmptyArray(host.Dns, "custom DNS servers");
  requireEmptyArray(host.DnsOptions, "custom DNS options");
  requireEmptyArray(host.DnsSearch, "custom DNS search domains");
  requireEmptyArray(host.ExtraHosts, "host aliases");
  requireEmptyArray(host.Links, "container links");
  requireEmptyArray(host.GroupAdd, "supplementary groups");

  const tmpfs = object(host.Tmpfs, "sandbox tmpfs");
  const expectedTmpfs = expectedTmpfsValues();
  if (Object.keys(tmpfs).length !== 2 || tmpfs["/workspace"] !== expectedTmpfs["/workspace"] || tmpfs["/tmp"] !== expectedTmpfs["/tmp"]) {
    throw attestationFailure("Docker altered the bounded sandbox tmpfs mounts.");
  }
  const restart = object(host.RestartPolicy, "restart policy");
  if (restart.Name !== "no" || restart.MaximumRetryCount !== 0) {
    throw attestationFailure("The sandbox container restart policy is not disabled.");
  }
  const logging = object(host.LogConfig, "logging configuration");
  if (logging.Type !== "none") throw attestationFailure("Persistent Docker logging is forbidden.");
  requireEmptyMap(logging.Config, "logging options");
  attestUlimits(host.Ulimits);
}

function attestMounts(value: unknown): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) throw attestationFailure("Docker returned invalid mount metadata.");
  for (const raw of value) {
    const mount = object(raw, "container mount");
    if (
      mount.Type !== "tmpfs" ||
      (mount.Destination !== "/workspace" && mount.Destination !== "/tmp") ||
      (mount.Source !== "" && mount.Source !== undefined) ||
      mount.RW !== true
    ) {
      throw attestationFailure("A host-backed, unknown, or read-only container mount was detected.");
    }
  }
  const destinations = value.map(raw => object(raw, "container mount").Destination);
  if (new Set(destinations).size !== destinations.length) {
    throw attestationFailure("Docker reported duplicate sandbox mount destinations.");
  }
}

function attestNetwork(network: JsonObject): void {
  requireEmptyMap(network.Ports, "network ports");
  const networks = object(network.Networks, "container networks");
  if (Object.keys(networks).some(name => name !== "none")) {
    throw attestationFailure("The sandbox container is connected to a network.");
  }
  for (const raw of Object.values(networks)) {
    const attachment = object(raw, "network attachment");
    for (const key of ["IPAddress", "GlobalIPv6Address", "Gateway", "IPv6Gateway", "MacAddress"]) {
      if (attachment[key] !== "" && attachment[key] !== undefined) {
        throw attestationFailure("The network-disabled sandbox unexpectedly has an address.");
      }
    }
  }
}

function attestUlimits(value: unknown): void {
  if (!Array.isArray(value) || value.length !== 2) {
    throw attestationFailure("The sandbox ulimit profile is incomplete.");
  }
  const normalized = value.map(raw => {
    const item = object(raw, "ulimit");
    return `${String(item.Name)}:${String(item.Soft)}:${String(item.Hard)}`;
  }).sort();
  const expected = ["core:0:0", `nofile:${DOCKER_RESOURCE_PROFILE.nofile}:${DOCKER_RESOURCE_PROFILE.nofile}`].sort();
  if (!sameStrings(normalized, expected)) throw attestationFailure("The sandbox ulimit profile changed.");
}

function expectedTmpfsValues(): Record<string, string> {
  const resources = DOCKER_RESOURCE_PROFILE;
  return {
    "/workspace": `rw,exec,nosuid,nodev,noatime,size=${resources.workspaceTmpfsBytes},nr_inodes=${resources.workspaceInodes},mode=0700,uid=65532,gid=65532`,
    "/tmp": `rw,noexec,nosuid,nodev,noatime,size=${resources.temporaryTmpfsBytes},nr_inodes=${resources.temporaryInodes},mode=0700,uid=65532,gid=65532`
  };
}

function requireSuccessfulMetadata(result: DockerTransportResult, label: string): void {
  if (result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated) {
    throw attestationFailure(`${label} failed or exceeded its output bound.`);
  }
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  const text = decodeUtf8(bytes, label);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new SandboxCommandError("ATTESTATION_FAILED", `${label} was not valid JSON.`, { cause: error });
  }
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new SandboxCommandError("ATTESTATION_FAILED", `${label} was not valid UTF-8.`, { cause: error });
  }
}

function singletonArray(value: unknown, label: string): JsonObject {
  if (!Array.isArray(value) || value.length !== 1) {
    throw attestationFailure(`${label} did not contain exactly one object.`);
  }
  return object(value[0], label);
}

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw attestationFailure(`${label} was not an object.`);
  }
  return value as JsonObject;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) return [];
  return value as string[];
}

function requireExactEnvironment(
  value: unknown,
  label: string,
  additions: Readonly<Record<string, string>> = {}
): void {
  const actual = stringArray(value).sort();
  const expected = Object.entries({ ...SANDBOX_PROCESS_ENV, ...additions })
    .map(([key, setting]) => `${key}=${setting}`)
    .sort();
  if (!sameStrings(actual, expected)) throw attestationFailure(`The ${label} is not the fixed sandbox environment.`);
}

function requireExactArray(value: unknown, expected: readonly unknown[], label: string): void {
  if (!Array.isArray(value) || value.length !== expected.length || value.some((item, index) => item !== expected[index])) {
    throw attestationFailure(`The ${label} differs from the fixed sandbox profile.`);
  }
}

function requireExactSet(value: unknown, expected: readonly string[], label: string): void {
  const actual = stringArray(value).sort();
  if (!sameStrings(actual, [...expected].sort())) throw attestationFailure(`The ${label} differs from the fixed sandbox profile.`);
}

function requireEmptyArray(value: unknown, label: string): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value) || value.length !== 0) throw attestationFailure(`The ${label} must be empty.`);
}

function requireEmptyMap(value: unknown, label: string): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(value as object).length !== 0) {
    throw attestationFailure(`The ${label} must be empty.`);
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function attestationFailure(message: string): SandboxCommandError {
  return new SandboxCommandError("ATTESTATION_FAILED", message);
}
