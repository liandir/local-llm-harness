import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { createSandboxSnapshot } from "../src/security/workspace/sandboxSnapshot.js";
import {
  SANDBOX_PROTOCOL_MAGIC,
  SandboxFrameType,
  encodeSandboxInput,
  jsonFrame
} from "../src/security/commands/framing.js";
import { SANDBOX_PROCESS_ENV } from "../src/security/commands/sandboxEnvironment.js";
import { SANDBOX_GIT_ENV } from "../src/scm/gitProfile.js";
import { PACKAGED_SUPERVISOR_SHA256 } from "../src/security/commands/supervisorIntegrity.js";

interface SupervisorModule {
  SANDBOX_CHILD_ENV: Readonly<Record<string, string>>;
  attestRuntime(adapter?: Record<string, unknown>): Promise<{ profileDigest: string }>;
  extractSandboxInput(
    input: AsyncIterable<Uint8Array>,
    root: string,
    options?: Record<string, unknown>
  ): Promise<{
    command: Record<string, unknown>;
    workspaceRoot: string;
    cwd: string;
    entryCount: number;
    totalBytes: number;
  }>;
  executeSandboxCommand(
    extracted: Record<string, unknown>,
    io?: Record<string, unknown>
  ): Promise<number>;
}

let sourceRoot: string;
let extractionRoot: string;
let supervisor: SupervisorModule;
const profileDigest = "a".repeat(64);

beforeEach(async () => {
  sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llh-supervisor-source-"));
  extractionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llh-supervisor-target-"));
  // The packaged supervisor intentionally remains plain ESM outside tsconfig.
  // @ts-expect-error No TypeScript declarations are shipped into the container.
  supervisor = await import("../sandbox/supervisor.mjs") as SupervisorModule;
});

afterEach(async () => {
  await fs.rm(sourceRoot, { recursive: true, force: true });
  await fs.rm(extractionRoot, { recursive: true, force: true });
});

describe("packaged sandbox supervisor", () => {
  it("independently verifies and extracts a complete binary snapshot", async () => {
    await fs.mkdir(path.join(sourceRoot, "src"));
    await fs.writeFile(path.join(sourceRoot, "src", "data.bin"), Buffer.from([0, 255, 1, 2]));
    const snapshot = await createSandboxSnapshot(sourceRoot, signal());
    const request = commandRequest("src");

    const extracted = await supervisor.extractSandboxInput(
      encodeSandboxInput({ request, profileDigest }, snapshot),
      extractionRoot,
      { expectedProfileDigest: profileDigest, verifyExecutable: async () => undefined }
    );

    expect(extracted.command).toMatchObject({
      executable: "/usr/bin/git",
      args: ["status"],
      cwd: "src"
    });
    expect(extracted.entryCount).toBe(2);
    await expect(fs.readFile(path.join(extractionRoot, "src", "data.bin")))
      .resolves.toEqual(Buffer.from([0, 255, 1, 2]));
  });

  it("rejects a changed file chunk before executing anything", async () => {
    await fs.writeFile(path.join(sourceRoot, "data.bin"), Buffer.from([1, 2, 3]));
    const snapshot = await createSandboxSnapshot(sourceRoot, signal());
    const frames = await collect(encodeSandboxInput({ request: commandRequest(), profileDigest }, snapshot));
    const chunk = frames.find(frame => frame[0] === SandboxFrameType.FileChunk);
    expect(chunk).toBeDefined();
    if (chunk) chunk[5] ^= 0xff;

    await expect(supervisor.extractSandboxInput(stream(frames), extractionRoot, {
      expectedProfileDigest: profileDigest,
      verifyExecutable: async () => undefined
    })).rejects.toThrow(/digest/i);
  });

  it("rejects traversal, unknown fields, profile mismatch, and trailing bytes", async () => {
    const command = commandFrameValue();
    const traversal = [
      Uint8Array.from(SANDBOX_PROTOCOL_MAGIC),
      jsonFrame(SandboxFrameType.Command, command),
      jsonFrame(SandboxFrameType.Directory, { type: "directory", path: "../escape", mode: 0o700 })
    ];
    await expect(supervisor.extractSandboxInput(stream(traversal), extractionRoot, {
      expectedProfileDigest: profileDigest,
      verifyExecutable: async () => undefined
    })).rejects.toThrow(/path|forbidden|canonical/i);

    await resetExtractionRoot();
    const unknown = { ...command, environment: { TOKEN: "secret" } };
    await expect(supervisor.extractSandboxInput(stream([
      Uint8Array.from(SANDBOX_PROTOCOL_MAGIC),
      jsonFrame(SandboxFrameType.Command, unknown)
    ]), extractionRoot, { expectedProfileDigest: profileDigest }))
      .rejects.toThrow(/unknown fields/i);

    await resetExtractionRoot();
    await expect(supervisor.extractSandboxInput(stream([
      Uint8Array.from(SANDBOX_PROTOCOL_MAGIC),
      jsonFrame(SandboxFrameType.Command, command)
    ]), extractionRoot, { expectedProfileDigest: "b".repeat(64) }))
      .rejects.toThrow(/different sandbox profile/i);
  });

  it("spawns the exact argv without a shell and with only the fixed child environment", async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      pid: number;
      kill: () => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 424_242;
    child.kill = () => true;
    let invocation: { executable: string; args: string[]; options: Record<string, unknown> } | undefined;
    const spawn = (executable: string, args: string[], options: Record<string, unknown>) => {
      invocation = { executable, args, options };
      queueMicrotask(() => {
        child.stdout.end("ok");
        child.stderr.end();
        child.emit("close", 0, null);
      });
      return child;
    };

    const exitCode = await supervisor.executeSandboxCommand({
      command: {
        executable: "/usr/bin/git",
        args: ["status", "--short"],
        timeoutMs: 1_000,
        maxOutputBytes: 1_024
      },
      cwd: extractionRoot
    }, {
      spawn,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      killTree: async () => undefined,
      prepareEnvironment: async () => undefined
    });

    expect(exitCode).toBe(0);
    expect(invocation).toMatchObject({
      executable: "/usr/bin/git",
      args: ["status", "--short"],
      options: {
        shell: false,
        detached: true,
        cwd: extractionRoot,
        env: SANDBOX_PROCESS_ENV
      }
    });
  });

  it("keeps the supervisor child environment synchronized with the hardened Git profile", () => {
    expect(supervisor.SANDBOX_CHILD_ENV).toEqual(SANDBOX_PROCESS_ENV);
    expect(supervisor.SANDBOX_CHILD_ENV).toEqual(SANDBOX_GIT_ENV);
    expect(supervisor.SANDBOX_CHILD_ENV).not.toHaveProperty("HTTP_PROXY");
    expect(supervisor.SANDBOX_CHILD_ENV).not.toHaveProperty("NODE_OPTIONS");
  });

  it("binds host attestation and the image recipe to the exact packaged supervisor bytes", async () => {
    const bytes = await fs.readFile(path.resolve("sandbox", "supervisor.mjs"));
    const actual = createHash("sha256").update(bytes).digest("hex");
    expect(actual).toBe(PACKAGED_SUPERVISOR_SHA256);
    await expect(fs.readFile(path.resolve("sandbox", "Dockerfile"), "utf8"))
      .resolves.toContain(`local-llm-harness.supervisor-sha256="${PACKAGED_SUPERVISOR_SHA256}"`);
  });

  it("self-attests live uid, PID, caps, seccomp, mounts, cgroups, ulimits, env, and network", async () => {
    const fixture = runtimeFixture();
    await expect(supervisor.attestRuntime(fixture.adapter())).resolves.toEqual({ profileDigest });

    const attacks: Array<(value: RuntimeFixture) => void> = [
      value => { value.pid = 2; },
      value => { value.uid = 0; },
      value => { value.environment.TOKEN = "host-secret"; },
      value => { value.files["/proc/self/status"] = value.files["/proc/self/status"].replace("NoNewPrivs:\t1", "NoNewPrivs:\t0"); },
      value => { value.files["/proc/self/status"] = value.files["/proc/self/status"].replace("CapEff:\t0000000000000000", "CapEff:\t0000000000000001"); },
      value => { value.files["/proc/self/mountinfo"] = value.files["/proc/self/mountinfo"].replace("/ / ro,relatime", "/ / rw,relatime"); },
      value => { value.files["/proc/self/mountinfo"] = value.files["/proc/self/mountinfo"].replace("- tmpfs tmpfs rw,size=786432k", "- ext4 /dev/sda rw,size=786432k"); },
      value => { value.files["/proc/self/cgroup"] = "0::/docker/host-visible\n"; },
      value => { value.files["/sys/fs/cgroup/pids.max"] = "max\n"; },
      value => { value.interfaces = ["eth0", "lo"]; }
    ];
    for (const attack of attacks) {
      const attacked = runtimeFixture();
      attack(attacked);
      await expect(supervisor.attestRuntime(attacked.adapter())).rejects.toThrow();
    }
  });
});

interface RuntimeFixture {
  pid: number;
  uid: number;
  gid: number;
  environment: Record<string, string>;
  interfaces: string[];
  files: Record<string, string>;
  adapter(): Record<string, unknown>;
}

function runtimeFixture(): RuntimeFixture {
  const supervisorBytes = Buffer.from("fixture supervisor bytes");
  const supervisorHash = createHash("sha256").update(supervisorBytes).digest("hex");
  const fixture: RuntimeFixture = {
    pid: 1,
    uid: 65532,
    gid: 65532,
    environment: {
      ...SANDBOX_PROCESS_ENV,
      LLH_SANDBOX_PROFILE: profileDigest,
      LLH_SUPERVISOR_SHA256: supervisorHash,
      HOSTNAME: "llh-sandbox"
    },
    interfaces: ["lo"],
    files: {
      "/proc/self/status": [
        "Name:\tnode",
        "Uid:\t65532\t65532\t65532\t65532",
        "Gid:\t65532\t65532\t65532\t65532",
        "Groups:\t",
        "NSpid:\t1",
        "CapInh:\t0000000000000000",
        "CapPrm:\t0000000000000000",
        "CapEff:\t0000000000000000",
        "CapBnd:\t0000000000000000",
        "CapAmb:\t0000000000000000",
        "NoNewPrivs:\t1",
        "Seccomp:\t2",
        "Seccomp_filters:\t1"
      ].join("\n"),
      "/proc/self/mountinfo": [
        "36 25 0:32 / / ro,relatime - overlay overlay ro",
        "37 36 0:33 / /workspace rw,nosuid,nodev,noatime - tmpfs tmpfs rw,size=786432k,nr_inodes=131072,mode=700,uid=65532,gid=65532",
        "38 36 0:34 / /tmp rw,nosuid,nodev,noexec,noatime - tmpfs tmpfs rw,size=131072k,nr_inodes=32768,mode=700,uid=65532,gid=65532"
      ].join("\n"),
      "/proc/self/cgroup": "0::/\n",
      "/sys/fs/cgroup/pids.max": "256\n",
      "/sys/fs/cgroup/memory.max": `${2 * 1024 * 1024 * 1024}\n`,
      "/sys/fs/cgroup/memory.swap.max": "0\n",
      "/sys/fs/cgroup/cpu.max": "200000 100000\n",
      "/proc/self/limits": [
        "Limit                     Soft Limit           Hard Limit           Units",
        "Max core file size        0                    0                    bytes",
        "Max open files            1024                 1024                 files"
      ].join("\n"),
      "/proc/net/route": "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\n",
      "/proc/net/ipv6_route": ""
    },
    adapter() {
      return {
        pid: this.pid,
        uid: this.uid,
        gid: this.gid,
        environment: this.environment,
        readFile: async (file: string) => {
          const value = this.files[file];
          if (value === undefined) throw new Error(`Unexpected runtime file: ${file}`);
          return value;
        },
        readBinaryFile: async () => supervisorBytes,
        supervisorPath: "/opt/local-llm-harness/supervisor.mjs",
        readDirectory: async () => this.interfaces
      };
    }
  };
  return fixture;
}

function commandRequest(cwd?: string) {
  return {
    ruleId: "git-status",
    ruleRevision: "1".repeat(64),
    executable: "/usr/bin/git",
    args: ["status"],
    ...(cwd === undefined ? {} : { cwd }),
    limits: { timeoutMs: 1_000, maxOutputBytes: 4_096 }
  } as const;
}

function commandFrameValue(): Record<string, unknown> {
  return {
    version: 1,
    profileDigest,
    ruleId: "git-status",
    ruleRevision: "1".repeat(64),
    executable: "/usr/bin/git",
    args: ["status"],
    cwd: "",
    timeoutMs: 1_000,
    maxOutputBytes: 4_096,
    workspaceMode: "ephemeral-copy",
    networkMode: "none"
  };
}

async function collect(input: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const values: Uint8Array[] = [];
  for await (const value of input) values.push(Uint8Array.from(value));
  return values;
}

async function* stream(values: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield value;
}

async function resetExtractionRoot(): Promise<void> {
  await fs.rm(extractionRoot, { recursive: true, force: true });
  await fs.mkdir(extractionRoot);
}

function signal(): AbortSignal {
  return new AbortController().signal;
}
