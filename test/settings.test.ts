import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  explicit: new Map<string, unknown>()
}));

vi.mock("vscode", () => ({
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  workspace: {
    getConfiguration: () => ({
      get: (key: string) => mocks.values.get(key),
      inspect: (key: string) => mocks.explicit.has(key)
        ? { globalValue: mocks.explicit.get(key) }
        : { defaultValue: mocks.values.get(key) },
      update: vi.fn()
    }),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() }))
  }
}));

beforeEach(() => {
  mocks.values.clear();
  mocks.explicit.clear();
  mocks.values.set("toolCallingMode", "compat-gemma4");
});

describe("settings profile migration", () => {
  it("uses an old explicit family when the profile has only its new default", async () => {
    mocks.values.set("modelFamily", "qwen3");
    mocks.explicit.set("modelFamily", "qwen3");
    const { readSettings } = await import("../src/config/settings.js");
    expect(readSettings().toolCallingMode).toBe("compat-qwen3");
  });

  it("prefers an explicitly selected current profile over stale legacy settings", async () => {
    mocks.values.set("toolCallingMode", "compat-muse-glimmer");
    mocks.explicit.set("toolCallingMode", "compat-muse-glimmer");
    mocks.values.set("modelFamily", "qwen3");
    mocks.explicit.set("modelFamily", "qwen3");
    const { readSettings } = await import("../src/config/settings.js");
    expect(readSettings().toolCallingMode).toBe("compat-muse-glimmer");
  });
});
