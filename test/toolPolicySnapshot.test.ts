import { describe, expect, it, vi } from "vitest";
import { captureToolPolicySnapshot } from "../src/chat/toolPolicySnapshot.js";
import type { HarnessSettings } from "../src/config/settings.js";
import type {
  CommandAvailability,
  CommandPort,
  CommandRequest,
  CommandResult,
  PreparedSandboxCommand
} from "../src/chat/session/ports.js";

const digest = "a".repeat(64);
const image = `example.invalid/harness@sha256:${digest}`;

describe("tool policy snapshot", () => {
  it("does not touch a runtime when configuration is incomplete", async () => {
    const factory = vi.fn();
    const snapshot = await captureToolPolicySnapshot(
      settings({ sandboxDockerPath: "", sandboxImage: "", sandboxCommands: [] }),
      factory,
      new AbortController().signal
    );
    expect(snapshot.sandbox.available).toBe(false);
    expect(factory).not.toHaveBeenCalled();
  });

  it("returns the same verified port and immutable capability for the turn", async () => {
    const port = new AvailabilityPort({
      available: true,
      backend: "docker",
      profileDigest: "b".repeat(64),
      imageReference: image,
      imageId: "sha256:" + "c".repeat(64)
    });
    const snapshot = await captureToolPolicySnapshot(
      settings(),
      async () => port,
      new AbortController().signal
    );
    expect(snapshot.sandbox.available).toBe(true);
    expect(snapshot.sandbox.rules.map(rule => rule.id)).toEqual(["tests"]);
    expect(snapshot.commands).toBe(port);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("fails closed when attestation differs from captured settings", async () => {
    const port = new AvailabilityPort({
      available: true,
      backend: "docker",
      profileDigest: "b".repeat(64),
      imageReference: "other.invalid/harness@sha256:" + "d".repeat(64),
      imageId: "sha256:" + "e".repeat(64)
    });
    const snapshot = await captureToolPolicySnapshot(
      settings(),
      async () => port,
      new AbortController().signal
    );
    expect(snapshot.sandbox.available).toBe(false);
    expect(snapshot.commands).toBeUndefined();
    expect(snapshot.sandbox.reason).toContain("did not match");
  });
});

function settings(overrides: Partial<HarnessSettings> = {}): HarnessSettings {
  return {
    endpoint: "http://127.0.0.1:8080/v1",
    modelFamily: "gemma4",
    contextSize: 32_768,
    temperature: 0.3,
    topK: 40,
    topP: 0.95,
    autoCompact: true,
    autoCompactThresholdPercent: 80,
    tailBudgetPercent: 30,
    maxMessageTokensPercent: 25,
    templateOverheadTokensPerMessage: 4,
    autoapproveReads: false,
    autoapproveWrites: false,
    autoapproveSandboxCommands: false,
    sandboxDockerPath: "/usr/bin/docker",
    sandboxDockerHost: "unix:///var/run/docker.sock",
    sandboxImage: image,
    sandboxCommands: [{ id: "tests", executable: "/usr/bin/npm", args: ["test"] }],
    autoapproveCommands: false,
    safeCommands: [],
    ...overrides
  };
}

class AvailabilityPort implements CommandPort {
  constructor(private readonly result: CommandAvailability) {}
  async availability(_signal: AbortSignal): Promise<CommandAvailability> { return this.result; }
  async prepareCommand(_request: CommandRequest, _signal: AbortSignal): Promise<PreparedSandboxCommand> {
    throw new Error("not used");
  }
  async executeCommand(_command: PreparedSandboxCommand, _signal: AbortSignal): Promise<CommandResult> {
    throw new Error("not used");
  }
  discardCommand(_command: PreparedSandboxCommand): boolean { return false; }
}
