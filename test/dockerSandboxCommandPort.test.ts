import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { CommandRequest } from "../src/chat/session/ports.js";
import {
  createDockerSandboxCommandPort,
  type DockerTransport,
  type DockerTransportResult,
  type DockerTransportRunOptions
} from "../src/security/commands/index.js";
import {
  DOCKER_RESOURCE_PROFILE,
  SANDBOX_IMAGE_PROFILE_LABEL,
  SANDBOX_IMAGE_PROFILE_VERSION,
  SUPERVISOR_EXECUTABLE,
  SUPERVISOR_SCRIPT
} from "../src/security/commands/dockerProfile.js";
import { SANDBOX_PROCESS_ENV } from "../src/security/commands/sandboxEnvironment.js";
import {
  PACKAGED_SUPERVISOR_SHA256,
  SANDBOX_SUPERVISOR_HASH_LABEL
} from "../src/security/commands/supervisorIntegrity.js";

const IMAGE_DIGEST = `sha256:${"1".repeat(64)}`;
const IMAGE = `registry.example/local-llm-harness@${IMAGE_DIGEST}`;
const IMAGE_ID = `sha256:${"2".repeat(64)}`;
const CONTAINER_ID = "3".repeat(64);

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llh-docker-port-"));
  await fs.writeFile(path.join(workspaceRoot, "tracked.txt"), "host remains unchanged\n");
});

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

describe("DockerSandboxCommandPort capability", () => {
  it("preflights a pinned local image and returns an immutable authentic one-shot handle", async () => {
    const fake = new FakeDockerTransport();
    const port = await createDockerSandboxCommandPort(options(fake), signal());
    const prepared = await port.prepareCommand(request(), signal());

    expect(prepared).toMatchObject({
      ruleId: "git-status",
      ruleRevision: "4".repeat(64),
      executable: "/usr/bin/git",
      args: ["status", "--short"],
      timeoutMs: 2_000,
      maxOutputBytes: 8_192,
      backend: "docker",
      imageReference: IMAGE,
      imageId: IMAGE_ID,
      workspaceMode: "ephemeral-copy",
      networkMode: "none"
    });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.args)).toBe(true);
    await expect(port.executeCommand({ ...prepared }, signal())).rejects.toMatchObject({
      code: "INVALID_TRANSACTION"
    });
    expect(port.discardCommand(prepared)).toBe(true);
    expect(port.discardCommand(prepared)).toBe(false);
    await expect(port.executeCommand(prepared, signal())).rejects.toMatchObject({
      code: "INVALID_TRANSACTION"
    });
  });

  it("runs only create-inspect-start-inspect-rm-verify and keeps argv out of Docker arguments", async () => {
    const fake = new FakeDockerTransport();
    const port = await createDockerSandboxCommandPort(options(fake), signal());
    const prepared = await port.prepareCommand(request(), signal());
    const result = await port.executeCommand(prepared, signal());

    expect(result).toEqual({
      exitCode: 0,
      stdout: "sandbox stdout\n",
      stderr: "",
      truncated: false
    });
    const operations = fake.calls.map(call => operation(call.args));
    const createIndex = operations.indexOf("create");
    expect(operations.slice(createIndex, createIndex + 5)).toEqual([
      "create", "container-inspect", "start", "container-inspect", "rm"
    ]);
    expect(operations.slice(createIndex + 5).every(value =>
      value === "container-inspect" || value === "container-ls"
    )).toBe(true);
    const create = fake.calls.find(call => operation(call.args) === "create");
    expect(create).toBeDefined();
    expect(create?.args).toEqual(expect.arrayContaining([
      "--pull=never",
      "--network=none",
      "--read-only",
      "--user=65532:65532",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges=true",
      "--security-opt=seccomp=builtin",
      "--cgroupns=private",
      "--ipc=none",
      "--pids-limit=256",
      "--privileged=false"
    ]));
    expect(create?.args).not.toContain("/usr/bin/git");
    expect(create?.args).not.toContain("status");
    expect(create?.args.some(argument => /^--(?:volume|mount|device)(?:=|$)/.test(argument))).toBe(false);
    expect(fake.startInput?.includes(Buffer.from("/usr/bin/git"))).toBe(true);
    expect(fake.startInput?.includes(Buffer.from("status"))).toBe(true);
    expect(fake.calls.some(call => call.args.includes("pull") || call.args.includes("build"))).toBe(false);
    await expect(fs.readFile(path.join(workspaceRoot, "tracked.txt"), "utf8"))
      .resolves.toBe("host remains unchanged\n");
    await expect(port.executeCommand(prepared, signal())).rejects.toMatchObject({ code: "INVALID_TRANSACTION" });
  });

  it("refuses a weakened created-container inspection before PID 1 starts, then removes it", async () => {
    const fake = new FakeDockerTransport({ weakenCreatedContainer: true });
    const port = await createDockerSandboxCommandPort(options(fake), signal());
    const prepared = await port.prepareCommand(request(), signal());

    await expect(port.executeCommand(prepared, signal())).rejects.toMatchObject({
      code: "ATTESTATION_FAILED"
    });
    expect(fake.calls.some(call => operation(call.args) === "start")).toBe(false);
    expect(fake.calls.some(call => operation(call.args) === "rm")).toBe(true);
    expect(fake.removed).toBe(true);
  });

  it("rejects an attached Docker client status that disagrees with inspected supervisor exit", async () => {
    const fake = new FakeDockerTransport({ startExitCode: 125 });
    const port = await createDockerSandboxCommandPort(options(fake), signal());
    const prepared = await port.prepareCommand(request(), signal());

    await expect(port.executeCommand(prepared, signal())).rejects.toMatchObject({
      code: "LIFECYCLE_FAILED"
    });
    expect(fake.removed).toBe(true);
  });

  it("does not let user cancellation abandon a delayed create daemon request", async () => {
    const fake = new FakeDockerTransport({ delayCreate: true });
    const port = await createDockerSandboxCommandPort(options(fake), signal());
    const prepared = await port.prepareCommand(request(), signal());
    const controller = new AbortController();
    const stopped = new Error("user cancelled after create began");
    const execution = port.executeCommand(prepared, controller.signal);

    await fake.createStarted;
    controller.abort(stopped);
    fake.releaseCreate();

    await expect(execution).rejects.toBe(stopped);
    const create = fake.calls.find(call => operation(call.args) === "create");
    expect(create?.options.signal).not.toBe(controller.signal);
    expect(fake.calls.some(call => operation(call.args) === "start")).toBe(false);
    expect(fake.removed).toBe(true);
  });

  it("repeatedly reconciles and process-quarantines an indeterminate create response", async () => {
    const fake = new FakeDockerTransport({ failCreateAfterCommit: true });
    const capturedOptions = options(fake);
    const port = await createDockerSandboxCommandPort(capturedOptions, signal());
    const prepared = await port.prepareCommand(request(), signal());

    await expect(port.executeCommand(prepared, signal())).rejects.toMatchObject({
      code: "CLEANUP_FAILED"
    });
    expect(fake.calls.filter(call => operation(call.args) === "rm").length).toBeGreaterThanOrEqual(9);
    const nextTurn = new FakeDockerTransport();
    await expect(createDockerSandboxCommandPort({ ...capturedOptions, transport: nextTurn }, signal()))
      .rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
    expect(nextTurn.calls).toHaveLength(0);
  });

  it("poisons the backend if forced removal cannot prove absence", async () => {
    const fake = new FakeDockerTransport({ lingerAfterRemoval: true });
    const capturedOptions = options(fake);
    const port = await createDockerSandboxCommandPort(capturedOptions, signal());
    const prepared = await port.prepareCommand(request(), signal());

    await expect(port.executeCommand(prepared, signal())).rejects.toMatchObject({
      code: "CLEANUP_FAILED"
    });
    const callCount = fake.calls.length;
    await expect(port.availability(signal())).resolves.toMatchObject({ available: false });
    expect(fake.calls).toHaveLength(callCount);

    const nextTurn = new FakeDockerTransport();
    await expect(createDockerSandboxCommandPort({
      ...capturedOptions,
      transport: nextTurn
    }, signal())).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
    expect(nextTurn.calls).toHaveLength(0);
  });

  it("rejects remote endpoints, mutable image tags, and mismatched image IDs before execution", async () => {
    const remote = new FakeDockerTransport();
    await expect(createDockerSandboxCommandPort({
      ...options(remote),
      dockerHost: "tcp://127.0.0.1:2375"
    }, signal())).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    expect(remote.calls).toHaveLength(0);

    const formatted = new FakeDockerTransport();
    await expect(createDockerSandboxCommandPort({
      ...options(formatted),
      dockerHost: process.platform === "win32"
        ? "npipe:////./pipe/docker_engine\u202e"
        : "unix:///tmp/docker\nspoof.sock"
    }, signal())).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    expect(formatted.calls).toHaveLength(0);

    const mutable = new FakeDockerTransport();
    await expect(createDockerSandboxCommandPort({
      ...options(mutable),
      image: "node:latest"
    }, signal())).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    expect(mutable.calls).toHaveLength(0);

    const mismatch = new FakeDockerTransport({ imageId: `sha256:${"9".repeat(64)}` });
    await expect(createDockerSandboxCommandPort({
      ...options(mismatch),
      image: IMAGE_ID
    }, signal())).rejects.toMatchObject({ code: "ATTESTATION_FAILED" });
    expect(mismatch.calls.map(call => operation(call.args))).toEqual(["version", "image-inspect"]);
  });

  it("never treats a model-writable CLI or Docker configuration as trusted host code", async () => {
    const cliInside = new FakeDockerTransport();
    await expect(createDockerSandboxCommandPort({
      ...options(cliInside),
      dockerCliPath: path.join(workspaceRoot, "docker")
    }, signal())).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    expect(cliInside.calls).toHaveLength(0);

    const configInside = new FakeDockerTransport();
    await expect(createDockerSandboxCommandPort({
      ...options(configInside),
      dockerConfigDirectory: path.join(workspaceRoot, ".docker")
    }, signal())).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    expect(configInside.calls).toHaveLength(0);
  });

  it("quarantines but never deletes an unknown transaction discovered during preflight", async () => {
    const fake = new FakeDockerTransport({ unknownManagedContainer: true });
    await expect(createDockerSandboxCommandPort(options(fake), signal()))
      .rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
    expect(fake.calls.map(call => operation(call.args))).toEqual([
      "version", "image-inspect", "container-ls"
    ]);
    expect(fake.removed).toBe(false);
  });
});

interface FakeOptions {
  readonly weakenCreatedContainer?: boolean;
  readonly lingerAfterRemoval?: boolean;
  readonly imageId?: string;
  readonly delayCreate?: boolean;
  readonly unknownManagedContainer?: boolean;
  readonly failCreateAfterCommit?: boolean;
  readonly startExitCode?: number;
}

class FakeDockerTransport implements DockerTransport {
  readonly fakeId = nextFakeId++;
  readonly calls: Array<{ args: readonly string[]; options: DockerTransportRunOptions }> = [];
  startInput: Buffer | undefined;
  removed = false;
  private inspectCount = 0;
  private profileDigest = "";
  private containerName = "";
  private unknownManagedPresent: boolean;
  private readonly createStartedResolve: () => void;
  readonly createStarted: Promise<void>;
  private readonly createRelease: Promise<void>;
  private readonly createReleaseResolve: () => void;

  constructor(private readonly behavior: FakeOptions = {}) {
    this.unknownManagedPresent = behavior.unknownManagedContainer === true;
    let started = (): void => undefined;
    this.createStarted = new Promise(resolve => { started = resolve; });
    this.createStartedResolve = started;
    let release = (): void => undefined;
    this.createRelease = new Promise(resolve => { release = resolve; });
    this.createReleaseResolve = release;
  }

  releaseCreate(): void {
    this.createReleaseResolve();
  }

  async run(args: readonly string[], options: DockerTransportRunOptions): Promise<DockerTransportResult> {
    this.calls.push({ args: [...args], options });
    const op = operation(args);
    if (op === "version") {
      return jsonResult({ Server: { Os: "linux", Arch: "amd64" } });
    }
    if (op === "image-inspect") {
      return jsonResult([imageInspection(this.behavior.imageId ?? IMAGE_ID)]);
    }
    if (op === "create") {
      this.createStartedResolve();
      if (this.behavior.delayCreate) await this.createRelease;
      this.containerName = valueAfterPrefix(args, "--name=");
      this.profileDigest = valueAfterPrefix(args, "--label=local-llm-harness.profile=");
      if (this.behavior.failCreateAfterCommit) throw new Error("Docker client lost the create response");
      return result(0, `${CONTAINER_ID}\n`);
    }
    if (op === "container-inspect") {
      if (this.removed && !this.behavior.lingerAfterRemoval) {
        return result(1, "", `Error: No such object: ${args.at(-1) ?? "unknown"}\n`);
      }
      const state = this.inspectCount++ === 0 ? "created" : "exited";
      const inspected = containerInspection(state, this.profileDigest, this.containerName);
      if (this.behavior.weakenCreatedContainer && state === "created") {
        inspected.HostConfig.NetworkMode = "host";
      }
      return jsonResult([inspected]);
    }
    if (op === "container-ls") {
      if (this.unknownManagedPresent) {
        return result(0, `${JSON.stringify({
          Names: `local-llm-harness-${"f".repeat(32)}`,
          ID: "e".repeat(64)
        })}\n`);
      }
      return result(0, "");
    }
    if (op === "start") {
      this.startInput = Buffer.concat(await collectInput(options.stdin));
      return result(this.behavior.startExitCode ?? 0, "sandbox stdout\n");
    }
    if (op === "rm") {
      this.removed = true;
      this.unknownManagedPresent = false;
      return result(0, `${CONTAINER_ID}\n`);
    }
    throw new Error(`Unexpected fake Docker operation: ${op}`);
  }
}

function options(transport: DockerTransport) {
  const id = transport instanceof FakeDockerTransport ? transport.fakeId : 0;
  const dockerCliPath = path.join(
    os.tmpdir(),
    process.platform === "win32" ? `llh-fake-docker-${id}.exe` : `llh-fake-docker-${id}`
  );
  const dockerHost = process.platform === "win32"
    ? "npipe:////./pipe/docker_engine"
    : "unix:///var/run/docker.sock";
  return {
    workspaceRoot,
    dockerCliPath,
    dockerHost,
    dockerConfigDirectory: path.join(os.tmpdir(), `llh-fake-docker-config-${id}`),
    image: IMAGE,
    platform: "linux/amd64" as const,
    transport,
    transactionIdFactory: () => "transaction-1"
  };
}

let nextFakeId = 1;

function request(): CommandRequest {
  return {
    ruleId: "git-status",
    ruleRevision: "4".repeat(64),
    executable: "/usr/bin/git",
    args: ["status", "--short"],
    limits: { timeoutMs: 2_000, maxOutputBytes: 8_192 }
  };
}

function operation(args: readonly string[]): string {
  const command = args.slice(4);
  if (command[0] === "version") return "version";
  if (command[0] === "image" && command[1] === "inspect") return "image-inspect";
  if (command[0] !== "container") return "unknown";
  if (command[1] === "create") return "create";
  if (command[1] === "inspect") return "container-inspect";
  if (command[1] === "ls") return "container-ls";
  if (command[1] === "start") return "start";
  if (command[1] === "rm") return "rm";
  return "unknown";
}

function imageInspection(imageId: string) {
  return {
    Id: imageId,
    RepoDigests: [IMAGE],
    Os: "linux",
    Architecture: "amd64",
    Config: {
      Entrypoint: [SUPERVISOR_EXECUTABLE],
      Cmd: [SUPERVISOR_SCRIPT],
      User: "65532:65532",
      WorkingDir: "/workspace",
      Env: environment(),
      Volumes: null,
      ExposedPorts: null,
      Healthcheck: null,
      Labels: {
        [SANDBOX_IMAGE_PROFILE_LABEL]: SANDBOX_IMAGE_PROFILE_VERSION,
        [SANDBOX_SUPERVISOR_HASH_LABEL]: PACKAGED_SUPERVISOR_SHA256
      }
    }
  };
}

function containerInspection(state: "created" | "exited", profileDigest: string, containerName: string) {
  const resources = DOCKER_RESOURCE_PROFILE;
  return {
    Id: CONTAINER_ID,
    Name: `/${containerName}`,
    Image: IMAGE_ID,
    Path: SUPERVISOR_EXECUTABLE,
    Args: [SUPERVISOR_SCRIPT],
    Config: {
      Hostname: "llh-sandbox",
      User: "65532:65532",
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      OpenStdin: true,
      StdinOnce: false,
      Image: IMAGE,
      WorkingDir: "/workspace",
      Entrypoint: [SUPERVISOR_EXECUTABLE],
      Cmd: [SUPERVISOR_SCRIPT],
      Env: environment({
        LLH_SANDBOX_PROFILE: profileDigest,
        LLH_SUPERVISOR_SHA256: PACKAGED_SUPERVISOR_SHA256
      }),
      Volumes: null,
      ExposedPorts: null,
      Healthcheck: null,
      Labels: {
        "local-llm-harness.profile": profileDigest,
        "local-llm-harness.managed": "true",
        "local-llm-harness.transaction": containerName,
        [SANDBOX_IMAGE_PROFILE_LABEL]: SANDBOX_IMAGE_PROFILE_VERSION,
        [SANDBOX_SUPERVISOR_HASH_LABEL]: PACKAGED_SUPERVISOR_SHA256
      }
    },
    HostConfig: {
      NetworkMode: "none",
      ReadonlyRootfs: true,
      Privileged: false,
      PublishAllPorts: false,
      AutoRemove: false,
      Runtime: "runc",
      CgroupnsMode: "private",
      IpcMode: "none",
      PidMode: "private",
      UsernsMode: "",
      UTSMode: "",
      Memory: resources.memoryBytes,
      MemorySwap: resources.memoryBytes,
      NanoCpus: resources.nanoCpus,
      PidsLimit: resources.pids,
      MemorySwappiness: 0,
      Binds: null,
      Mounts: null,
      VolumesFrom: null,
      Devices: null,
      DeviceRequests: null,
      DeviceCgroupRules: null,
      CapAdd: null,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges=true", "seccomp=builtin"],
      PortBindings: {},
      Dns: [],
      DnsOptions: [],
      DnsSearch: [],
      ExtraHosts: null,
      Links: null,
      GroupAdd: null,
      Tmpfs: {
        "/workspace": `rw,exec,nosuid,nodev,noatime,size=${resources.workspaceTmpfsBytes},nr_inodes=${resources.workspaceInodes},mode=0700,uid=65532,gid=65532`,
        "/tmp": `rw,noexec,nosuid,nodev,noatime,size=${resources.temporaryTmpfsBytes},nr_inodes=${resources.temporaryInodes},mode=0700,uid=65532,gid=65532`
      },
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      LogConfig: { Type: "none", Config: {} },
      Ulimits: [
        { Name: "nofile", Soft: resources.nofile, Hard: resources.nofile },
        { Name: "core", Soft: 0, Hard: 0 }
      ]
    },
    Mounts: [],
    NetworkSettings: {
      Ports: {},
      Networks: {
        none: { IPAddress: "", GlobalIPv6Address: "", Gateway: "", IPv6Gateway: "", MacAddress: "" }
      }
    },
    State: state === "created"
      ? {
          Status: "created", Running: false, Paused: false, Restarting: false,
          Dead: false, Pid: 0, ExitCode: 0, OOMKilled: false, Error: ""
        }
      : {
          Status: "exited", Running: false, Paused: false, Restarting: false,
          Dead: false, Pid: 0, ExitCode: 0, OOMKilled: false, Error: ""
        }
  };
}

function environment(additions: Readonly<Record<string, string>> = {}): string[] {
  return Object.entries({ ...SANDBOX_PROCESS_ENV, ...additions }).map(([key, value]) => `${key}=${value}`);
}

function valueAfterPrefix(args: readonly string[], prefix: string): string {
  const value = args.find(argument => argument.startsWith(prefix));
  if (value === undefined) throw new Error(`Missing argument ${prefix}`);
  return value.slice(prefix.length);
}

async function collectInput(input: AsyncIterable<Uint8Array> | undefined): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  if (input) for await (const chunk of input) chunks.push(Buffer.from(chunk));
  return chunks;
}

function jsonResult(value: unknown): DockerTransportResult {
  return result(0, `${JSON.stringify(value)}\n`);
}

function result(exitCode: number, stdout = "", stderr = ""): DockerTransportResult {
  return Object.freeze({
    exitCode,
    stdout: Uint8Array.from(Buffer.from(stdout)),
    stderr: Uint8Array.from(Buffer.from(stderr)),
    stdoutTruncated: false,
    stderrTruncated: false
  });
}

function signal(): AbortSignal {
  return new AbortController().signal;
}
