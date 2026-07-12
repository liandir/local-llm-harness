import { beforeEach, describe, expect, it, vi } from "vitest";
import pkg from "../package.json";

const mockConfig = vi.hoisted(() => ({
  globalValues: {} as Record<string, unknown>,
  workspaceValues: {} as Record<string, unknown>
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
      update: vi.fn(async () => undefined)
    }),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() }))
  }
}));

import { readSettings } from "../src/config/settings.js";

describe("security-first setting defaults", () => {
  beforeEach(() => {
    mockConfig.globalValues = {};
    mockConfig.workspaceValues = {};
  });

  it("requires approval for every tool category when settings are absent", () => {
    const settings = readSettings();
    expect(settings.autoapproveReads).toBe(false);
    expect(settings.autoapproveWrites).toBe(false);
    expect(settings.autoapproveCommands).toBe(false);
  });

  it("keeps the extension manifest default aligned", () => {
    const properties = pkg.contributes.configuration.properties;
    expect(properties["localLlmHarness.autoapproveReads"].default).toBe(false);
    expect(properties["localLlmHarness.autoapproveWrites"].default).toBe(false);
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
    mockConfig.workspaceValues.autoapproveCommands = true;

    const settings = readSettings();
    expect(settings.endpoint).toBe("http://localhost:8080/v1");
    expect(settings.autoapproveReads).toBe(false);
    expect(settings.autoapproveWrites).toBe(false);
    expect(settings.autoapproveCommands).toBe(false);
  });

  it("declares every contributed setting application-scoped", () => {
    for (const setting of Object.values(pkg.contributes.configuration.properties)) {
      expect(setting.scope).toBe("application");
    }
  });
});
