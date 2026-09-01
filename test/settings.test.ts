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

describe("reasoning and model settings", () => {
  it("shows thinking by default and accepts an explicit hidden setting", async () => {
    const { readSettings } = await import("../src/config/settings.js");
    expect(readSettings().showThinking).toBe(true);
    mocks.values.set("showThinking", false);
    expect(readSettings().showThinking).toBe(false);
  });

  it("migrates an explicit legacy capped-token value to the reasoning budget", async () => {
    mocks.values.set("cappedThinkingTokens", 4096);
    mocks.explicit.set("cappedThinkingTokens", 4096);
    const { readSettings } = await import("../src/config/settings.js");
    expect(readSettings().reasoningBudget).toBe(4096);
  });

  it("accepts unlimited and instant reasoning budgets", async () => {
    const { readSettings } = await import("../src/config/settings.js");
    for (const budget of [-1, 0]) {
      mocks.values.set("reasoningBudget", budget);
      mocks.explicit.set("reasoningBudget", budget);
      expect(readSettings().reasoningBudget).toBe(budget);
    }
  });

  it("defaults to the backwards-compatible local model id", async () => {
    const { readSettings } = await import("../src/config/settings.js");
    expect(readSettings().model).toBe("local");
  });

  it("reads the configurable reasoning-effort dictionary", async () => {
    mocks.values.set("reasoningEfforts", { Quick: "minimal", Deep: "xhigh" });
    const { readSettings } = await import("../src/config/settings.js");
    expect(readSettings().reasoningEfforts).toEqual({ Quick: "minimal", Deep: "xhigh" });
  });
});
