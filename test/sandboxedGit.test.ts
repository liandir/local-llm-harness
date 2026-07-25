import { describe, expect, it } from "vitest";
import { SandboxedGitInspector } from "../src/scm/sandboxedGit.js";
import type {
  CommandAvailability,
  CommandPort,
  CommandRequest,
  CommandResult,
  PreparedSandboxCommand
} from "../src/chat/session/ports.js";

const signal = new AbortController().signal;

describe("SandboxedGitInspector", () => {
  it("interprets only the documented staged-status exit codes", async () => {
    const clean = new FakeCommandPort([{ exitCode: 0, stdout: "", stderr: "", truncated: false }]);
    await expect(new SandboxedGitInspector(clean).hasStagedChanges(signal)).resolves.toBe(false);
    expect(clean.requests[0].executable).toBe("/usr/bin/git");
    expect(clean.requests[0].args).toContain("--no-textconv");

    const changed = new FakeCommandPort([{ exitCode: 1, stdout: "", stderr: "", truncated: false }]);
    await expect(new SandboxedGitInspector(changed).hasStagedChanges(signal)).resolves.toBe(true);

    const failed = new FakeCommandPort([{ exitCode: 128, stdout: "", stderr: "not a repository", truncated: false }]);
    await expect(new SandboxedGitInspector(failed).hasStagedChanges(signal)).rejects.toThrow("sandbox exit 128");
  });

  it("rejects truncated diffs instead of returning a misleading partial patch", async () => {
    const port = new FakeCommandPort([{ exitCode: 0, stdout: "partial", stderr: "", truncated: true }]);
    await expect(new SandboxedGitInspector(port).stagedDiff(signal)).rejects.toThrow("partial output was discarded");
  });

  it("reads a regular HEAD blob by validated object id and size", async () => {
    const oid = "a".repeat(40);
    const port = new FakeCommandPort([
      { exitCode: 0, stdout: `100644 blob ${oid}\tsrc/a.ts\0`, stderr: "", truncated: false },
      { exitCode: 0, stdout: "5\n", stderr: "", truncated: false },
      { exitCode: 0, stdout: "hello", stderr: "", truncated: false }
    ]);

    await expect(new SandboxedGitInspector(port).readHeadFile("src/a.ts", signal)).resolves.toBe("hello");
    expect(port.requests).toHaveLength(3);
    expect(port.requests[2].args).toEqual(expect.arrayContaining(["cat-file", "blob", oid]));
  });

  it("does not fetch blob content for a path absent from HEAD", async () => {
    const port = new FakeCommandPort([{ exitCode: 0, stdout: "", stderr: "", truncated: false }]);
    await expect(new SandboxedGitInspector(port).readHeadFile("new.txt", signal)).resolves.toBeUndefined();
    expect(port.requests).toHaveLength(1);
  });
});

class FakeCommandPort implements CommandPort {
  readonly requests: CommandRequest[] = [];
  private sequence = 0;

  constructor(private readonly results: CommandResult[]) {}

  async availability(_signal: AbortSignal): Promise<CommandAvailability> {
    return {
      available: true,
      backend: "docker",
      profileDigest: "b".repeat(64),
      imageReference: "example.invalid/harness@sha256:" + "c".repeat(64),
      imageId: "sha256:" + "d".repeat(64)
    };
  }

  async prepareCommand(request: CommandRequest, _signal: AbortSignal): Promise<PreparedSandboxCommand> {
    this.requests.push(request);
    return Object.freeze({
      transactionId: `tx-${this.sequence++}`,
      ruleId: request.ruleId,
      ruleRevision: request.ruleRevision,
      executable: request.executable,
      args: Object.freeze([...request.args]),
      cwd: request.cwd,
      timeoutMs: request.limits.timeoutMs,
      maxOutputBytes: request.limits.maxOutputBytes,
      backend: "docker" as const,
      profileDigest: "b".repeat(64),
      imageReference: "example.invalid/harness@sha256:" + "c".repeat(64),
      imageId: "sha256:" + "d".repeat(64),
      workspaceMode: "ephemeral-copy" as const,
      networkMode: "none" as const
    });
  }

  async executeCommand(_command: PreparedSandboxCommand, _signal: AbortSignal): Promise<CommandResult> {
    const result = this.results.shift();
    if (!result) throw new Error("unexpected command");
    return result;
  }

  discardCommand(_command: PreparedSandboxCommand): boolean {
    return false;
  }
}
