import { beforeEach, describe, expect, it, vi } from "vitest";
import pkg from "../package.json";

const mockConfig = vi.hoisted(() => ({
  values: {} as Record<string, unknown>
}));

vi.mock("vscode", () => ({
  ConfigurationTarget: { Global: 1 },
  workspace: {
    getConfiguration: () => ({
      get: (key: string) => mockConfig.values[key],
      inspect: () => undefined,
      update: vi.fn(async () => undefined)
    }),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() }))
  }
}));

import { readSettings } from "../src/config/settings.js";

describe("security-first setting defaults", () => {
  beforeEach(() => {
    mockConfig.values = {};
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
    mockConfig.values.autoapproveReads = true;
    expect(readSettings().autoapproveReads).toBe(true);
  });
});
