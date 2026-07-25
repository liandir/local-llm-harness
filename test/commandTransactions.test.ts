import { describe, expect, it } from "vitest";
import {
  commandReviewDigest,
  discardCommandTransaction,
  executeCommandTransaction,
  parseCommandToolArgs,
  prepareCommandTransaction,
  quoteCommandReviewValue
} from "../src/chat/commandTransactions.js";
import type {
  CommandAvailability,
  CommandPort,
  CommandRequest,
  CommandResult,
  PreparedSandboxCommand
} from "../src/chat/session/ports.js";
import { createSandboxCommandCapabilitySnapshot } from "../src/tools/sandboxCommands.js";

const image = "example.invalid/harness@sha256:" + "a".repeat(64);
const capability = createSandboxCommandCapabilitySnapshot({
  sandboxDockerPath: "/usr/bin/docker",
  sandboxDockerHost: "unix:///var/run/docker.sock",
  sandboxImage: image,
  sandboxCommands: [{
    id: "unit-test",
    executable: "/usr/bin/npm",
    args: ["test", "--", "--runInBand"],
    cwd: "packages/core",
    description: "Run the fixed unit test suite."
  }]
}, true);
const signal = new AbortController().signal;

describe("sandbox command transactions", () => {
  it("accepts only the exact ruleId tool schema", () => {
    expect(parseCommandToolArgs('{"ruleId":"unit-test"}')).toEqual({ ruleId: "unit-test" });
    expect(() => parseCommandToolArgs('{"ruleId":"unit-test","command":"npm test"}')).toThrow("exactly");
    expect(() => parseCommandToolArgs('{"command":"npm test"}')).toThrow("exactly");
    expect(() => parseCommandToolArgs('[{"ruleId":"unit-test"}]')).toThrow("object");
  });

  it("renders Unicode format and non-ASCII characters as explicit code units", () => {
    const dangerous = `safe\u202egpj\u200b-${String.fromCodePoint(0x1f680)}`;
    const quoted = quoteCommandReviewValue(dangerous);
    expect(quoted).toBe('"safe\\u202egpj\\u200b-\\ud83d\\ude80"');
    expect(quoted).not.toContain("\u202e");
    expect(quoted).not.toContain("\u200b");
    expect(quoted).not.toContain(String.fromCodePoint(0x1f680));
  });

  it("binds exact argv, sandbox attestation, limits, and artifact to one approval", async () => {
    const port = new FakePort();
    const tx = await prepareCommandTransaction(port, capability, '{"ruleId":"unit-test"}', signal);

    expect(port.request?.executable).toBe("/usr/bin/npm");
    expect(port.request?.args).toEqual(["test", "--", "--runInBand"]);
    expect(tx.review.text).toContain('Executable: "/usr/bin/npm"');
    expect(tx.review.text).toContain('  [2] "--runInBand"');
    expect(tx.review.text).toContain("Network: none");
    expect(tx.review.text).toContain("filesystem changes are discarded");

    const digest = commandReviewDigest(scope("11111111-1111-4111-8111-111111111111"), tx);
    const other = commandReviewDigest(scope("22222222-2222-4222-8222-222222222222"), tx);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(other).not.toBe(digest);

    await expect(executeCommandTransaction(tx, signal)).resolves.toContain("complete output");
    await expect(executeCommandTransaction(tx, signal)).rejects.toThrow("already consumed");
    expect(discardCommandTransaction(tx)).toBe(false);
  });

  it("discards a backend handle whose public attestation does not match", async () => {
    const port = new FakePort({ imageReference: "sha256:" + "e".repeat(64) });
    await expect(
      prepareCommandTransaction(port, capability, '{"ruleId":"unit-test"}', signal)
    ).rejects.toThrow("does not match");
    expect(port.discarded).toBe(1);
  });

  it("invalidates an authentic transaction without executing it", async () => {
    const port = new FakePort();
    const tx = await prepareCommandTransaction(port, capability, '{"ruleId":"unit-test"}', signal);
    expect(discardCommandTransaction(tx)).toBe(true);
    await expect(executeCommandTransaction(tx, signal)).rejects.toThrow("already consumed");
    expect(port.executed).toBe(0);
  });
});

function scope(proposalId: string) {
  return {
    sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    turnId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    proposalId,
    decisionToken: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    toolId: "tool-1"
  };
}

class FakePort implements CommandPort {
  request?: CommandRequest;
  discarded = 0;
  executed = 0;

  constructor(private readonly overrides: Partial<PreparedSandboxCommand> = {}) {}

  async availability(_signal: AbortSignal): Promise<CommandAvailability> {
    return {
      available: true,
      backend: "docker",
      profileDigest: "b".repeat(64),
      imageReference: image,
      imageId: "sha256:" + "c".repeat(64)
    };
  }

  async prepareCommand(request: CommandRequest, _signal: AbortSignal): Promise<PreparedSandboxCommand> {
    this.request = request;
    return Object.freeze({
      transactionId: "prepared-1",
      ruleId: request.ruleId,
      ruleRevision: request.ruleRevision,
      executable: request.executable,
      args: Object.freeze([...request.args]),
      cwd: request.cwd,
      timeoutMs: request.limits.timeoutMs,
      maxOutputBytes: request.limits.maxOutputBytes,
      backend: "docker" as const,
      profileDigest: "b".repeat(64),
      imageReference: image,
      imageId: "sha256:" + "c".repeat(64),
      workspaceMode: "ephemeral-copy" as const,
      networkMode: "none" as const,
      ...this.overrides
    });
  }

  async executeCommand(_command: PreparedSandboxCommand, _signal: AbortSignal): Promise<CommandResult> {
    this.executed++;
    return {
      exitCode: 0,
      stdout: "complete output\n",
      stderr: "",
      truncated: false
    };
  }

  discardCommand(_command: PreparedSandboxCommand): boolean {
    this.discarded++;
    return true;
  }
}
