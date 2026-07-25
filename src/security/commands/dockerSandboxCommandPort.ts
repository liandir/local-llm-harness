import { randomUUID } from "node:crypto";
import type {
  CommandAvailability,
  CommandPort,
  CommandRequest,
  CommandResult,
  PreparedSandboxCommand
} from "../../chat/session/ports.js";
import { createSandboxSnapshot } from "../workspace/sandboxSnapshot.js";
import {
  attestContainerAbsent,
  attestCreatedContainer,
  attestDockerVersion,
  attestExitedContainer,
  attestSandboxImage,
  decodeCommandOutput,
  resolveSandboxImage,
  type BackendAttestation
} from "./dockerAttestation.js";
import { DockerCliTransport } from "./dockerCliTransport.js";
import {
  DOCKER_BACKEND,
  DOCKER_OPERATION_LIMITS,
  SANDBOX_NETWORK_MODE,
  SANDBOX_WORKSPACE_MODE,
  dockerCreateArguments,
  dockerGlobalArguments,
  validateCommandRequest,
  validateDockerSandboxBootstrapOptions,
  validateDockerSandboxOptions,
  type DockerSandboxCommandPortOptions,
  type ValidatedDockerSandboxOptions
} from "./dockerProfile.js";
import { SandboxCommandError } from "./errors.js";
import { encodeSandboxInput } from "./framing.js";
import type { DockerTransport, DockerTransportResult } from "./transport.js";
import { TrustedDockerHostPaths } from "./trustedHostPaths.js";

interface PrivatePreparedCommand {
  readonly request: CommandRequest;
  readonly attestation: BackendAttestation;
  readonly containerName: string;
  consumed: boolean;
}

/** Process-lifetime quarantine; restart is the only automatic recovery path. */
const quarantinedBackends = new Map<string, string>();
const activeContainers = new Map<string, Set<string>>();

/**
 * Docker-only sandbox capability. It never interprets a command line: the
 * approved argv crosses the host boundary only in the supervisor input frame.
 */
export class DockerSandboxCommandPort implements CommandPort {
  private readonly options: ValidatedDockerSandboxOptions;
  private readonly transport: DockerTransport;
  private readonly transactionIdFactory: () => string;
  private readonly quarantineKey: string;
  private readonly prepared = new WeakMap<PreparedSandboxCommand, PrivatePreparedCommand>();
  private poisonedReason: string | undefined;

  private constructor(
    options: ValidatedDockerSandboxOptions,
    transport: DockerTransport,
    transactionIdFactory: () => string,
    quarantineKey: string
  ) {
    this.options = options;
    this.transport = transport;
    this.transactionIdFactory = transactionIdFactory;
    this.quarantineKey = quarantineKey;
  }

  /**
   * Fail-closed preflight. The local selector is inspected without pull/build,
   * resolved to one immutable image ID, and attested before a port exists.
   */
  static async create(
    options: DockerSandboxCommandPortOptions,
    signal: AbortSignal
  ): Promise<DockerSandboxCommandPort> {
    signal.throwIfAborted();
    const bootstrap = validateDockerSandboxBootstrapOptions(options);
    const quarantineKey = backendQuarantineKey(bootstrap.dockerCliPath, bootstrap.dockerHost);
    const quarantined = quarantinedBackends.get(quarantineKey);
    if (quarantined !== undefined) {
      throw new SandboxCommandError("BACKEND_UNAVAILABLE", quarantined);
    }
    let transport = options.transport;
    if (transport === undefined) {
      const hostPathGuard = await TrustedDockerHostPaths.create(
        bootstrap.dockerCliPath,
        bootstrap.dockerConfigDirectory,
        bootstrap.workspaceRoot
      );
      signal.throwIfAborted();
      transport = new DockerCliTransport({
        executablePath: bootstrap.dockerCliPath,
        hostPathGuard,
        hostEnvironment: options.hostEnvironment
      });
    }
    const version = await transport.run(
      [...dockerGlobalArguments(bootstrap), "version", "--format={{json .}}"],
      metadataRunOptions(signal, DOCKER_OPERATION_LIMITS.inspectTimeoutMs)
    );
    attestDockerVersion(version, bootstrap);
    const image = await transport.run(
      [...dockerGlobalArguments(bootstrap), "image", "inspect", "--no-trunc", bootstrap.image],
      metadataRunOptions(signal, DOCKER_OPERATION_LIMITS.inspectTimeoutMs)
    );
    const resolvedImage = resolveSandboxImage(image, bootstrap);
    await reconcileManagedContainers(transport, bootstrap, quarantineKey, signal);
    const validated = validateDockerSandboxOptions({
      workspaceRoot: bootstrap.workspaceRoot,
      dockerCliPath: bootstrap.dockerCliPath,
      dockerHost: bootstrap.dockerHost,
      dockerConfigDirectory: bootstrap.dockerConfigDirectory,
      imageReference: resolvedImage.imageReference,
      imageId: resolvedImage.imageId,
      platform: bootstrap.platform,
      transport,
      snapshotLimits: bootstrap.snapshotLimits,
      transactionIdFactory: options.transactionIdFactory,
      hostEnvironment: options.hostEnvironment,
      hostPlatform: options.hostPlatform
    });
    return new DockerSandboxCommandPort(
      validated,
      transport,
      options.transactionIdFactory ?? randomUUID,
      quarantineKey
    );
  }

  async availability(signal: AbortSignal): Promise<CommandAvailability> {
    signal.throwIfAborted();
    if (this.poisonedReason !== undefined) {
      return { available: false, reason: this.poisonedReason };
    }
    const quarantined = quarantinedBackends.get(this.quarantineKey);
    if (quarantined !== undefined) return { available: false, reason: quarantined };
    try {
      const attestation = await this.attestBackend(signal);
      return Object.freeze({ available: true, ...attestation });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      return Object.freeze({
        available: false,
        reason: error instanceof SandboxCommandError
          ? error.message
          : "The configured Docker sandbox backend could not be verified."
      });
    }
  }

  async prepareCommand(request: CommandRequest, signal: AbortSignal): Promise<PreparedSandboxCommand> {
    signal.throwIfAborted();
    this.assertHealthy();
    const canonical = validateCommandRequest(request);
    const attestation = await this.attestBackend(signal);
    const transactionId = this.transactionIdFactory();
    if (typeof transactionId !== "string" || transactionId.length === 0 || transactionId.length > 256) {
      throw new SandboxCommandError("INVALID_CONFIGURATION", "The command transaction identifier source returned an invalid value.");
    }
    const containerName = `local-llm-harness-${randomUUID().replaceAll("-", "")}`;
    const publicCommand: PreparedSandboxCommand = Object.freeze({
      transactionId,
      ruleId: canonical.ruleId,
      ruleRevision: canonical.ruleRevision,
      executable: canonical.executable,
      args: Object.freeze([...canonical.args]),
      ...(canonical.cwd === undefined ? {} : { cwd: canonical.cwd }),
      timeoutMs: canonical.limits.timeoutMs,
      maxOutputBytes: canonical.limits.maxOutputBytes,
      backend: DOCKER_BACKEND,
      profileDigest: attestation.profileDigest,
      imageReference: attestation.imageReference,
      imageId: attestation.imageId,
      workspaceMode: SANDBOX_WORKSPACE_MODE,
      networkMode: SANDBOX_NETWORK_MODE
    });
    this.prepared.set(publicCommand, {
      request: canonical,
      attestation,
      containerName,
      consumed: false
    });
    return publicCommand;
  }

  async executeCommand(command: PreparedSandboxCommand, signal: AbortSignal): Promise<CommandResult> {
    const authority = this.consume(command);
    signal.throwIfAborted();
    this.assertHealthy();

    const current = await this.attestBackend(signal);
    if (!sameAttestation(authority.attestation, current)) {
      throw new SandboxCommandError(
        "BACKEND_CHANGED",
        "The Docker sandbox backend or immutable profile changed after command preparation."
      );
    }

    let snapshot;
    try {
      snapshot = await createSandboxSnapshot(
        this.options.workspaceRoot,
        signal,
        this.options.snapshotLimits
      );
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw new SandboxCommandError(
        "SNAPSHOT_REJECTED",
        "The workspace could not be copied into a guarded ephemeral sandbox snapshot.",
        { cause: error }
      );
    }

    const containerName = authority.containerName;
    let containerId: string | undefined;
    let operationError: unknown;
    let commandResult: CommandResult | undefined;
    let createAttempted = false;
    let mutationUncertain = false;
    let cancellation: unknown;
    const recordCancellation = (): void => {
      cancellation = signal.reason ?? new DOMException("Sandbox command execution was aborted.", "AbortError");
    };
    signal.addEventListener("abort", recordCancellation, { once: true });
    if (signal.aborted) recordCancellation();
    if (cancellation !== undefined) {
      signal.removeEventListener("abort", recordCancellation);
      throw cancellation;
    }

    const lifecycle = new AbortController();
    const lifecycleTimer = setTimeout(() => lifecycle.abort(new SandboxCommandError(
      "LIFECYCLE_FAILED",
      "The bounded Docker sandbox lifecycle exceeded its internal deadline."
    )), authority.request.limits.timeoutMs + 3 * DOCKER_OPERATION_LIMITS.lifecycleTimeoutMs);
    lifecycleTimer.unref?.();
    try {
      activeFor(this.quarantineKey).add(containerName);
      createAttempted = true;
      let created: DockerTransportResult;
      try {
        created = await this.transport.run(
          dockerCreateArguments(this.options, containerName),
          metadataRunOptions(lifecycle.signal, DOCKER_OPERATION_LIMITS.lifecycleTimeoutMs)
        );
      } catch (error) {
        mutationUncertain = true;
        throw error;
      }
      containerId = parseCreatedContainerId(created);

      const inertInspect = await this.inspect(containerId, lifecycle.signal);
      attestCreatedContainer(inertInspect, this.options, containerId, containerName);
      if (cancellation !== undefined) throw cancellation;

      let started: DockerTransportResult;
      try {
        started = await this.transport.run(
          [
            ...dockerGlobalArguments(this.options),
            "container", "start", "-ai", containerId
          ],
          {
            signal: lifecycle.signal,
            stdin: encodeSandboxInput({ request: authority.request, profileDigest: current.profileDigest }, snapshot),
            timeoutMs: authority.request.limits.timeoutMs + DOCKER_OPERATION_LIMITS.lifecycleTimeoutMs,
            maxOutputBytes: authority.request.limits.maxOutputBytes
          }
        );
      } catch (error) {
        mutationUncertain = true;
        throw error;
      }

      const exitedInspect = await this.inspect(containerId, lifecycle.signal);
      const exitCode = attestExitedContainer(exitedInspect, this.options, containerId, containerName);
      if (started.exitCode !== exitCode) {
        throw new SandboxCommandError(
          "LIFECYCLE_FAILED",
          "The attached Docker client status did not match the inspected supervisor exit status."
        );
      }
      commandResult = Object.freeze({
        exitCode,
        stdout: decodeCommandOutput(started.stdout),
        stderr: decodeCommandOutput(started.stderr),
        truncated: started.stdoutTruncated || started.stderrTruncated
      });
      if (cancellation !== undefined) throw cancellation;
    } catch (error) {
      operationError = error;
    } finally {
      clearTimeout(lifecycleTimer);
      signal.removeEventListener("abort", recordCancellation);
    }

    if (createAttempted) {
      try {
        await this.removeAndVerifyAbsent(containerName, containerId, mutationUncertain);
      } catch (cleanupError) {
        this.quarantine("Sandbox execution is disabled because Docker could not prove that an ephemeral container was removed.");
        throw new SandboxCommandError(
          "CLEANUP_FAILED",
          this.poisonedReason ?? "Sandbox cleanup failed closed.",
          { cause: cleanupError }
        );
      }
      if (mutationUncertain) {
        this.quarantine("Sandbox execution is quarantined because a mutating Docker request ended without a definitive daemon response.");
        throw new SandboxCommandError(
          "CLEANUP_FAILED",
          this.poisonedReason ?? "A mutating Docker request became uncertain.",
          operationError === undefined ? undefined : { cause: operationError }
        );
      }
      activeFor(this.quarantineKey).delete(containerName);
    }
    if (operationError !== undefined) throw operationError;
    if (commandResult === undefined) {
      throw new SandboxCommandError("LIFECYCLE_FAILED", "The sandbox lifecycle ended without an authenticated command result.");
    }
    return commandResult;
  }

  discardCommand(command: PreparedSandboxCommand): boolean {
    const authority = this.prepared.get(command);
    if (authority === undefined || authority.consumed) return false;
    authority.consumed = true;
    this.prepared.delete(command);
    return true;
  }

  private consume(command: PreparedSandboxCommand): PrivatePreparedCommand {
    const authority = this.prepared.get(command);
    if (authority === undefined || authority.consumed) {
      throw new SandboxCommandError(
        "INVALID_TRANSACTION",
        "The prepared sandbox command is fabricated, belongs to another port, or was already consumed."
      );
    }
    authority.consumed = true;
    this.prepared.delete(command);
    return authority;
  }

  private assertHealthy(): void {
    const reason = this.poisonedReason ?? quarantinedBackends.get(this.quarantineKey);
    if (reason !== undefined) {
      throw new SandboxCommandError("BACKEND_UNAVAILABLE", reason);
    }
  }

  private quarantine(reason: string): void {
    this.poisonedReason = reason;
    quarantinedBackends.set(this.quarantineKey, reason);
  }

  private async attestBackend(signal: AbortSignal): Promise<BackendAttestation> {
    this.assertHealthy();
    const version = await this.transport.run(
      [...dockerGlobalArguments(this.options), "version", "--format={{json .}}"],
      metadataRunOptions(signal, DOCKER_OPERATION_LIMITS.inspectTimeoutMs)
    );
    attestDockerVersion(version, this.options);
    const image = await this.transport.run(
      [...dockerGlobalArguments(this.options), "image", "inspect", "--no-trunc", this.options.imageReference],
      metadataRunOptions(signal, DOCKER_OPERATION_LIMITS.inspectTimeoutMs)
    );
    const attestation = attestSandboxImage(image, this.options);
    await this.reconcile(signal);
    return attestation;
  }

  private async reconcile(signal: AbortSignal): Promise<void> {
    await reconcileManagedContainers(this.transport, this.options, this.quarantineKey, signal);
  }

  private inspect(container: string, signal?: AbortSignal): Promise<DockerTransportResult> {
    return this.transport.run(
      [...dockerGlobalArguments(this.options), "container", "inspect", "--size=false", container],
      metadataRunOptions(signal, DOCKER_OPERATION_LIMITS.inspectTimeoutMs)
    );
  }

  private async removeAndVerifyAbsent(
    containerName: string,
    containerId: string | undefined,
    extendedReconciliation: boolean
  ): Promise<void> {
    let removalTransportUncertain = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.transport.run(
          [...dockerGlobalArguments(this.options), "container", "rm", "-fv", containerName],
          metadataRunOptions(undefined, DOCKER_OPERATION_LIMITS.cleanupTimeoutMs)
        );
      } catch {
        removalTransportUncertain = true;
      }

      let stable = true;
      for (const delayMs of [0, 100, 300]) {
        if (delayMs > 0) await delay(delayMs);
        if (!await this.isContainerAbsent(containerName)) {
          stable = false;
          break;
        }
        if (containerId !== undefined && !await this.isContainerAbsent(containerId)) {
          stable = false;
          break;
        }
        if (!await this.isTransactionLabelAbsent(containerName)) {
          stable = false;
          break;
        }
      }
      if (stable) {
        if (removalTransportUncertain) {
          throw new SandboxCommandError(
            "CLEANUP_FAILED",
            "A Docker removal request ended without a definitive daemon response."
          );
        }
        if (extendedReconciliation) {
          await this.verifyExtendedStableAbsence(containerName, containerId);
        }
        return;
      }
    }
    throw new SandboxCommandError(
      "CLEANUP_FAILED",
      "Docker could not establish stable absence for the sandbox transaction."
    );
  }

  private async verifyExtendedStableAbsence(containerName: string, containerId?: string): Promise<void> {
    let consecutiveAbsent = 0;
    for (let attempt = 0; attempt < 24 && consecutiveAbsent < 8; attempt++) {
      await delay(100);
      await this.transport.run(
        [...dockerGlobalArguments(this.options), "container", "rm", "-fv", containerName],
        metadataRunOptions(undefined, DOCKER_OPERATION_LIMITS.cleanupTimeoutMs)
      );
      const absent = await this.isContainerAbsent(containerName) &&
        (containerId === undefined || await this.isContainerAbsent(containerId)) &&
        await this.isTransactionLabelAbsent(containerName);
      consecutiveAbsent = absent ? consecutiveAbsent + 1 : 0;
    }
    if (consecutiveAbsent < 8) {
      throw new SandboxCommandError(
        "CLEANUP_FAILED",
        "A mutation-uncertain Docker transaction did not remain absent through its reconciliation window."
      );
    }
  }

  private async isContainerAbsent(container: string): Promise<boolean> {
    const inspected = await this.inspect(container);
    if (inspected.exitCode === 0) return false;
    attestContainerAbsent(inspected);
    return true;
  }

  private async isTransactionLabelAbsent(containerName: string): Promise<boolean> {
    const listed = await this.transport.run([
      ...dockerGlobalArguments(this.options),
      "container", "ls", "--all", "--no-trunc",
      `--filter=label=local-llm-harness.transaction=${containerName}`,
      "--format={{json .}}"
    ], metadataRunOptions(undefined, DOCKER_OPERATION_LIMITS.cleanupTimeoutMs));
    return parseManagedContainerRows(listed).length === 0;
  }
}

export function createDockerSandboxCommandPort(
  options: DockerSandboxCommandPortOptions,
  signal: AbortSignal
): Promise<DockerSandboxCommandPort> {
  return DockerSandboxCommandPort.create(options, signal);
}

function metadataRunOptions(
  signal: AbortSignal | undefined,
  timeoutMs: number
): { signal?: AbortSignal; timeoutMs: number; maxOutputBytes: number } {
  return {
    ...(signal === undefined ? {} : { signal }),
    timeoutMs,
    maxOutputBytes: DOCKER_OPERATION_LIMITS.metadataOutputBytes
  };
}

function parseCreatedContainerId(result: DockerTransportResult): string {
  if (result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated) {
    throw new SandboxCommandError("LIFECYCLE_FAILED", "Docker refused to create the pinned sandbox container.");
  }
  let stdout: string;
  try {
    stdout = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout).trim();
  } catch (error) {
    throw new SandboxCommandError("LIFECYCLE_FAILED", "Docker returned an invalid container identifier.", { cause: error });
  }
  if (!/^[0-9a-f]{64}$/.test(stdout)) {
    throw new SandboxCommandError("LIFECYCLE_FAILED", "Docker returned an invalid container identifier.");
  }
  return stdout;
}

function sameAttestation(left: BackendAttestation, right: BackendAttestation): boolean {
  return left.backend === right.backend &&
    left.profileDigest === right.profileDigest &&
    left.imageReference === right.imageReference &&
    left.imageId === right.imageId;
}

function backendQuarantineKey(dockerCliPath: string, dockerHost: string): string {
  const cli = process.platform === "win32" ? dockerCliPath.toLowerCase() : dockerCliPath;
  return `${cli}\0${dockerHost}`;
}

async function reconcileManagedContainers(
  transport: DockerTransport,
  options: Pick<ValidatedDockerSandboxOptions, "dockerConfigDirectory" | "dockerHost">,
  quarantineKey: string,
  signal: AbortSignal
): Promise<void> {
  const known = activeContainers.get(quarantineKey) ?? new Set<string>();
  const listed = await transport.run([
    ...dockerGlobalArguments(options),
    "container", "ls", "--all", "--no-trunc",
    "--filter=label=local-llm-harness.managed=true",
    "--format={{json .}}"
  ], metadataRunOptions(signal, DOCKER_OPERATION_LIMITS.inspectTimeoutMs));
  if (parseManagedContainerRows(listed).some(row => !known.has(row.name))) {
    // Ownership cannot be proven across extension-host processes. Never delete
    // an unknown container; quarantine and require explicit operator cleanup.
    const reason = "Sandbox execution is quarantined because an unknown managed container exists on this Docker backend.";
    quarantinedBackends.set(quarantineKey, reason);
    throw new SandboxCommandError("BACKEND_UNAVAILABLE", reason);
  }
  signal.throwIfAborted();
}

function parseManagedContainerRows(result: DockerTransportResult): Array<{ name: string; id: string }> {
  if (result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated) {
    throw new SandboxCommandError("ATTESTATION_FAILED", "Docker could not enumerate managed sandbox containers.");
  }
  let output: string;
  try {
    output = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout).trim();
  } catch (error) {
    throw new SandboxCommandError("ATTESTATION_FAILED", "Docker returned invalid managed-container metadata.", { cause: error });
  }
  const rows: Array<{ name: string; id: string }> = [];
  for (const line of output === "" ? [] : output.split(/\r?\n/)) {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      throw new SandboxCommandError("ATTESTATION_FAILED", "Docker returned malformed managed-container metadata.", { cause: error });
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new SandboxCommandError("ATTESTATION_FAILED", "Docker returned malformed managed-container metadata.");
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.Names !== "string" || !/^local-llm-harness-[0-9a-f]{32}$/.test(record.Names) ||
      typeof record.ID !== "string" || !/^[0-9a-f]{64}$/.test(record.ID)
    ) {
      throw new SandboxCommandError("ATTESTATION_FAILED", "Docker returned malformed managed-container identity metadata.");
    }
    rows.push({ name: record.Names, id: record.ID });
  }
  return rows;
}

function activeFor(quarantineKey: string): Set<string> {
  let active = activeContainers.get(quarantineKey);
  if (active === undefined) {
    active = new Set<string>();
    activeContainers.set(quarantineKey, active);
  }
  return active;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
