import { describe, expect, it, vi } from "vitest";
import {
  createSandboxCommandCapabilitySnapshot,
  decodeSandboxCommandRules,
  decodeSandboxDockerHost,
  decodeSandboxDockerPath,
  decodeSandboxImage,
  findSandboxCommandRule,
  SANDBOX_COMMAND_LIMITS
} from "../src/tools/sandboxCommands.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

function validRules(): Array<Record<string, unknown>> {
  return [{
    id: "unit-tests",
    executable: "/usr/bin/npm",
    args: ["test", "--", "--runInBand"],
    cwd: "packages/app",
    description: "Run the unit test suite."
  }];
}

describe("structured sandbox command settings", () => {
  it("decodes, clones, and deeply freezes a closed fixed-argv rule list", () => {
    const source = validRules();
    const decoded = decodeSandboxCommandRules(source);

    expect(decoded).toEqual(source);
    expect(decoded).not.toBe(source);
    expect(decoded[0]).not.toBe(source[0]);
    expect(decoded[0].args).not.toBe(source[0].args);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded[0])).toBe(true);
    expect(Object.isFrozen(decoded[0].args)).toBe(true);

    (source[0].args as string[])[0] = "publish";
    source[0].id = "changed";
    expect(decoded[0].id).toBe("unit-tests");
    expect(decoded[0].args[0]).toBe("test");
  });

  it.each([
    [[{ ...validRules()[0], extra: true }], "unknown fields"],
    [[validRules()[0], validRules()[0]], "duplicate IDs"],
    [[{ ...validRules()[0], id: "Unit Tests" }], "non-ASCII IDs"],
    [[{ ...validRules()[0], executable: "npm" }], "non-absolute executables"],
    [[{ ...validRules()[0], executable: "/usr/../bin/npm" }], "non-canonical executables"],
    [[{ ...validRules()[0], cwd: "../host" }], "parent traversal"],
    [[{ ...validRules()[0], args: ["ok\nnot-ok"] }], "control characters"],
    [[{ ...validRules()[0], description: "" }], "empty descriptions"]
  ])("rejects the complete rule list on %s", (input) => {
    expect(decodeSandboxCommandRules(input)).toEqual([]);
  });

  it("rejects accessors without invoking them", () => {
    const getter = vi.fn(() => "/usr/bin/npm");
    const rule = validRules()[0];
    Object.defineProperty(rule, "executable", { enumerable: true, get: getter });

    expect(decodeSandboxCommandRules([rule])).toEqual([]);
    expect(getter).not.toHaveBeenCalled();
  });

  it("enforces list, argv, and aggregate bounds", () => {
    const tooMany = Array.from(
      { length: SANDBOX_COMMAND_LIMITS.maxRules + 1 },
      (_, index) => ({ id: `rule-${index}`, executable: "/usr/bin/npm", args: [] })
    );
    const tooManyArgs = [{
      id: "many-args",
      executable: "/usr/bin/npm",
      args: Array.from({ length: SANDBOX_COMMAND_LIMITS.maxArgsPerRule + 1 }, () => "x")
    }];
    const oversizedArgs = [{
      id: "large-args",
      executable: "/usr/bin/npm",
      args: ["x".repeat(SANDBOX_COMMAND_LIMITS.maxArgumentBytesPerRule + 1)]
    }];

    expect(decodeSandboxCommandRules(tooMany)).toEqual([]);
    expect(decodeSandboxCommandRules(tooManyArgs)).toEqual([]);
    expect(decodeSandboxCommandRules(oversizedArgs)).toEqual([]);
  });

  it("accepts only absolute Docker paths, local endpoints, and immutable images", () => {
    expect(decodeSandboxDockerPath("/usr/bin/docker")).toBe("/usr/bin/docker");
    expect(decodeSandboxDockerPath("C:\\Program Files\\Docker\\docker.exe"))
      .toBe("C:\\Program Files\\Docker\\docker.exe");
    expect(decodeSandboxDockerPath("docker")).toBe("");
    expect(decodeSandboxDockerPath("\\\\server\\share\\docker.exe")).toBe("");

    expect(decodeSandboxDockerHost("")).toBe("");
    expect(decodeSandboxDockerHost("unix:///var/run/docker.sock"))
      .toBe("unix:///var/run/docker.sock");
    expect(decodeSandboxDockerHost("npipe:////./pipe/docker_engine"))
      .toBe("npipe:////./pipe/docker_engine");
    expect(decodeSandboxDockerHost("tcp://127.0.0.1:2375")).toBe("");
    expect(decodeSandboxDockerHost("ssh://builder.example")).toBe("");

    expect(decodeSandboxImage(DIGEST)).toBe(DIGEST);
    expect(decodeSandboxImage(`repo/image@${DIGEST}`)).toBe(`repo/image@${DIGEST}`);
    expect(decodeSandboxImage("repo/image:latest")).toBe("");
  });
});

describe("sandbox command capability snapshot", () => {
  it("stays unavailable until configuration and runtime verification are complete", () => {
    const configured = {
      sandboxDockerPath: "/usr/bin/docker",
      sandboxDockerHost: "",
      sandboxImage: DIGEST,
      sandboxCommands: validRules()
    };

    const unverified = createSandboxCommandCapabilitySnapshot(configured, false, "probe failed");
    expect(unverified.available).toBe(false);
    expect(unverified.reason).toBe("probe failed");

    const mutableImage = createSandboxCommandCapabilitySnapshot(
      { ...configured, sandboxImage: "repo/image:latest" },
      true
    );
    expect(mutableImage.available).toBe(false);
    expect(mutableImage.reason).toContain("immutable sandbox image");

    const noRules = createSandboxCommandCapabilitySnapshot(
      { ...configured, sandboxCommands: [] },
      true
    );
    expect(noRules.available).toBe(false);

    for (const sandboxDockerHost of [
      "tcp://127.0.0.1:2375",
      "ssh://builder.example"
    ]) {
      const remoteEndpoint = createSandboxCommandCapabilitySnapshot(
        { ...configured, sandboxDockerHost },
        true
      );
      expect(remoteEndpoint.available).toBe(false);
      expect(remoteEndpoint.reason).toContain("canonical local socket");
    }
  });

  it("authorizes exact rule IDs only in a frozen verified snapshot", () => {
    const sourceRules = validRules();
    const capability = createSandboxCommandCapabilitySnapshot({
      sandboxDockerPath: "/usr/bin/docker",
      sandboxDockerHost: "unix:///var/run/docker.sock",
      sandboxImage: DIGEST,
      sandboxCommands: sourceRules
    }, true);

    expect(capability.available).toBe(true);
    expect(capability.reason).toBe("");
    expect(Object.isFrozen(capability)).toBe(true);
    expect(Object.isFrozen(capability.rules)).toBe(true);
    expect(findSandboxCommandRule(capability, "unit-tests")?.executable).toBe("/usr/bin/npm");
    expect(findSandboxCommandRule(capability, "UNIT-TESTS")).toBeUndefined();
    expect(findSandboxCommandRule(capability, "unit-tests ")).toBeUndefined();
    expect(findSandboxCommandRule(capability, { toString: () => "unit-tests" })).toBeUndefined();

    sourceRules[0].executable = "/bin/sh";
    expect(findSandboxCommandRule(capability, "unit-tests")?.executable).toBe("/usr/bin/npm");
  });
});
