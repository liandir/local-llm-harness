import { beforeEach, describe, expect, it, vi } from "vitest";
import pkg from "../package.json";

const mockConfig = vi.hoisted(() => ({
  globalValues: {} as Record<string, unknown>,
  workspaceValues: {} as Record<string, unknown>,
  update: vi.fn(async (_key: string, _value: unknown, _target: unknown) => undefined)
}));

vi.mock("vscode", () => ({
  ConfigurationTarget: { Global: 1 },
  workspace: {
    getConfiguration: () => ({
      get: (key: string) => mockConfig.workspaceValues[key] ?? mockConfig.globalValues[key],
      inspect: (key: string) => ({
        key: `localLlmHarness.${key}`,
        globalValue: mockConfig.globalValues[key],
        workspaceValue: mockConfig.workspaceValues[key]
      }),
      update: mockConfig.update
    }),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() }))
  }
}));

import { readSettings, resetAllSettings } from "../src/config/settings.js";

describe("security-first setting defaults", () => {
  beforeEach(() => {
    mockConfig.globalValues = {};
    mockConfig.workspaceValues = {};
    mockConfig.update.mockReset();
    mockConfig.update.mockResolvedValue(undefined);
  });

  it("requires approval for every tool category when settings are absent", () => {
    const settings = readSettings();
    expect(settings.autoapproveReads).toBe(false);
    expect(settings.autoapproveWrites).toBe(false);
    expect(settings.autoapproveSandboxCommands).toBe(false);
    expect(settings.sandboxDockerPath).toBe("");
    expect(settings.sandboxDockerHost).toBe("");
    expect(settings.sandboxImage).toBe("");
    expect(settings.sandboxCommands).toEqual([]);
    expect(settings.autoapproveCommands).toBe(false);
  });

  it("keeps the extension manifest default aligned", () => {
    const properties = pkg.contributes.configuration.properties;
    expect(properties["localLlmHarness.autoapproveReads"].default).toBe(false);
    expect(properties["localLlmHarness.autoapproveWrites"].default).toBe(false);
    expect(properties["localLlmHarness.autoapproveSandboxCommands"].default).toBe(false);
    expect(properties["localLlmHarness.sandboxDockerPath"].default).toBe("");
    expect(properties["localLlmHarness.sandboxDockerHost"].default).toBe("");
    expect(properties["localLlmHarness.sandboxImage"].default).toBe("");
    expect(properties["localLlmHarness.sandboxCommands"].default).toEqual([]);
    expect(properties["localLlmHarness.autoapproveCommands"].default).toBe(false);
  });

  it("still respects an explicit user opt-in", () => {
    mockConfig.globalValues.autoapproveReads = true;
    expect(readSettings().autoapproveReads).toBe(true);
  });

  it("ignores security-sensitive workspace overrides", () => {
    mockConfig.workspaceValues.endpoint = "http://192.168.1.99:8080/v1";
    mockConfig.workspaceValues.autoapproveReads = true;
    mockConfig.workspaceValues.autoapproveWrites = true;
    mockConfig.workspaceValues.autoapproveSandboxCommands = true;
    mockConfig.workspaceValues.sandboxDockerPath = "/untrusted/docker";
    mockConfig.workspaceValues.sandboxImage = `sha256:${"a".repeat(64)}`;
    mockConfig.workspaceValues.sandboxCommands = [{ id: "evil", executable: "sh", args: [] }];
    mockConfig.workspaceValues.autoapproveCommands = true;

    const settings = readSettings();
    expect(settings.endpoint).toBe("http://localhost:8080/v1");
    expect(settings.autoapproveReads).toBe(false);
    expect(settings.autoapproveWrites).toBe(false);
    expect(settings.autoapproveSandboxCommands).toBe(false);
    expect(settings.sandboxDockerPath).toBe("");
    expect(settings.sandboxImage).toBe("");
    expect(settings.sandboxCommands).toEqual([]);
    expect(settings.autoapproveCommands).toBe(false);
  });

  it("runtime-decodes and deep-clones structured application settings", () => {
    const sourceRules = [{
      id: "unit-tests",
      executable: "/usr/bin/npm",
      args: ["test"],
      cwd: "packages/app",
      description: "Run unit tests."
    }];
    mockConfig.globalValues.autoapproveSandboxCommands = true;
    mockConfig.globalValues.sandboxDockerPath = "/usr/bin/docker";
    mockConfig.globalValues.sandboxDockerHost = "unix:///var/run/docker.sock";
    mockConfig.globalValues.sandboxImage = `repo/image@sha256:${"a".repeat(64)}`;
    mockConfig.globalValues.sandboxCommands = sourceRules;

    const settings = readSettings();
    expect(settings.autoapproveSandboxCommands).toBe(true);
    expect(settings.sandboxDockerPath).toBe("/usr/bin/docker");
    expect(settings.sandboxDockerHost).toBe("unix:///var/run/docker.sock");
    expect(settings.sandboxImage).toBe(`repo/image@sha256:${"a".repeat(64)}`);
    expect(settings.sandboxCommands).toEqual(sourceRules);
    expect(settings.sandboxCommands).not.toBe(sourceRules);
    expect(Object.isFrozen(settings.sandboxCommands)).toBe(true);
    expect(Object.isFrozen(settings.sandboxCommands[0])).toBe(true);
    expect(Object.isFrozen(settings.sandboxCommands[0].args)).toBe(true);

    sourceRules[0].executable = "/bin/sh";
    sourceRules[0].args[0] = "publish";
    expect(settings.sandboxCommands[0].executable).toBe("/usr/bin/npm");
    expect(settings.sandboxCommands[0].args[0]).toBe("test");
  });

  it("fails malformed structured application values closed", () => {
    mockConfig.globalValues.autoapproveSandboxCommands = "true";
    mockConfig.globalValues.sandboxDockerPath = "docker";
    mockConfig.globalValues.sandboxDockerHost = "tcp://127.0.0.1:2375";
    mockConfig.globalValues.sandboxImage = "repo/image:latest";
    mockConfig.globalValues.sandboxCommands = [{
      id: "unit-tests",
      executable: "/usr/bin/npm",
      args: ["test"],
      unexpected: true
    }];

    const settings = readSettings();
    expect(settings.autoapproveSandboxCommands).toBe(false);
    expect(settings.sandboxDockerPath).toBe("");
    expect(settings.sandboxDockerHost).toBe("tcp://127.0.0.1:2375");
    expect(settings.sandboxImage).toBe("");
    expect(settings.sandboxCommands).toEqual([]);
  });

  it("declares every contributed setting application-scoped", () => {
    for (const setting of Object.values(pkg.contributes.configuration.properties)) {
      expect(setting.scope).toBe("application");
    }
  });

  it("resets security grants first and continues after individual update failures", async () => {
    mockConfig.update.mockImplementation(async (key: string) => {
      if (key === "autoapproveWrites") throw new Error("write grant failed\nwith controls");
      if (key === "endpoint") throw new Error("x".repeat(400));
    });

    const failures = await resetAllSettings();
    const keys = mockConfig.update.mock.calls.map(call => call[0]);

    expect(keys.slice(0, 4)).toEqual([
      "autoapproveReads",
      "autoapproveWrites",
      "autoapproveSandboxCommands",
      "autoapproveCommands"
    ]);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("safeCommands");
    expect(failures.map(failure => failure.key)).toEqual([
      "autoapproveWrites",
      "endpoint"
    ]);
    expect(failures[0].message).toBe("write grant failedwith controls");
    expect(failures[1].message).toHaveLength(256);
    expect(Object.isFrozen(failures)).toBe(true);
    expect(Object.isFrozen(failures[0])).toBe(true);
  });
});
