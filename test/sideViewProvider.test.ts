import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type { ExtToSide, SideToExt } from "../src/ui/messaging.js";

const mocks = vi.hoisted(() => ({
  readSettings: vi.fn(),
  writeSetting: vi.fn(async () => undefined),
  resetAllSettings: vi.fn(async () => [] as { key: string; message: string }[]),
  seedSandboxCommandsIfUnset: vi.fn(async () => undefined),
  restoreDefaultSandboxCommands: vi.fn(async () => undefined),
  onSettingsChange: vi.fn(() => ({ dispose: vi.fn() })),
  validateEndpoint: vi.fn(),
  executeCommand: vi.fn(async () => undefined),
  showWarningMessage: vi.fn()
}));

vi.mock("vscode", () => ({
  commands: { executeCommand: mocks.executeCommand },
  window: { showWarningMessage: mocks.showWarningMessage }
}));

vi.mock("../src/config/settings.js", () => ({
  readSettings: mocks.readSettings,
  writeSetting: mocks.writeSetting,
  resetAllSettings: mocks.resetAllSettings,
  seedSandboxCommandsIfUnset: mocks.seedSandboxCommandsIfUnset,
  restoreDefaultSandboxCommands: mocks.restoreDefaultSandboxCommands,
  onSettingsChange: mocks.onSettingsChange
}));

vi.mock("../src/network/endpointValidator.js", () => ({
  validateEndpoint: mocks.validateEndpoint
}));

import { SideViewProvider } from "../src/ui/sideView/provider.js";

beforeEach(() => {
  mocks.readSettings.mockReset();
  mocks.readSettings.mockReturnValue({ autoapproveReads: false });
  mocks.writeSetting.mockReset();
  mocks.writeSetting.mockResolvedValue(undefined);
  mocks.resetAllSettings.mockReset();
  mocks.resetAllSettings.mockResolvedValue([]);
  mocks.seedSandboxCommandsIfUnset.mockReset();
  mocks.seedSandboxCommandsIfUnset.mockResolvedValue(undefined);
  mocks.restoreDefaultSandboxCommands.mockReset();
  mocks.restoreDefaultSandboxCommands.mockResolvedValue(undefined);
  mocks.validateEndpoint.mockReset();
  mocks.executeCommand.mockClear();
  mocks.showWarningMessage.mockReset();
});

describe("side-view settings reconciliation", () => {
  it("reports a bounded save failure and pushes the authoritative value", async () => {
    const error = `rejected\n${"x".repeat(2_000)}`;
    mocks.writeSetting.mockRejectedValueOnce(new Error(error));
    const { onMessage, posted } = providerHarness();

    await onMessage({ type: "saveSetting", key: "autoapproveReads", value: true });

    expect(mocks.writeSetting).toHaveBeenCalledWith("autoapproveReads", true);
    expect(posted).toHaveLength(2);
    expect(posted[0]).toMatchObject({
      type: "settingSaved",
      key: "autoapproveReads",
      ok: false
    });
    const failure = posted[0] as Extract<ExtToSide, { type: "settingSaved" }>;
    expect(failure.error).not.toContain("\n");
    expect(failure.error?.length).toBeLessThanOrEqual(1_024);
    expect(posted[1]).toEqual({
      type: "settings",
      settings: { autoapproveReads: false },
      sandboxAvailability: { available: true, backend: "docker" }
    });
  });

  it("acknowledges a successful save only alongside authoritative settings", async () => {
    mocks.readSettings.mockReturnValue({ autoapproveReads: true });
    const { onMessage, posted } = providerHarness();

    await onMessage({ type: "saveSetting", key: "autoapproveReads", value: true });

    expect(posted).toEqual([
      { type: "settingSaved", key: "autoapproveReads", ok: true },
      {
        type: "settings",
        settings: { autoapproveReads: true },
        sandboxAvailability: { available: true, backend: "docker" }
      }
    ]);
  });

  it("reports every partial reset key and refreshes persisted state", async () => {
    mocks.showWarningMessage.mockResolvedValueOnce("Restore defaults");
    mocks.resetAllSettings.mockResolvedValueOnce([
      { key: "autoapproveWrites", message: "rejected" },
      { key: "endpoint", message: "read only" }
    ]);
    mocks.readSettings.mockReturnValue({
      autoapproveWrites: true,
      endpoint: "http://localhost:8080/v1"
    });
    const { onMessage, posted } = providerHarness();

    await onMessage({ type: "resetAllDefaults" });

    expect(mocks.resetAllSettings).toHaveBeenCalledOnce();
    const outcome = posted[0] as Extract<ExtToSide, { type: "settingSaved" }>;
    expect(outcome).toMatchObject({ type: "settingSaved", key: "resetAllDefaults", ok: false });
    expect(outcome.error).toContain("autoapproveWrites");
    expect(outcome.error).toContain("endpoint");
    expect(posted[1]).toMatchObject({
      type: "settings",
      settings: {
        autoapproveWrites: true,
        endpoint: "http://localhost:8080/v1"
      }
    });
  });
});

function providerHarness(): {
  onMessage: (message: SideToExt) => Promise<void>;
  posted: ExtToSide[];
} {
  const posted: ExtToSide[] = [];
  const context = {} as vscode.ExtensionContext;
  const provider = new SideViewProvider(
    context,
    () => undefined,
    () => undefined,
    () => undefined,
    () => [],
    async () => ({ available: true, backend: "docker" })
  );
  (provider as unknown as {
    view: { webview: { postMessage(message: ExtToSide): void } };
  }).view = {
    webview: { postMessage: message => { posted.push(message); } }
  };
  const onMessage = (provider as unknown as {
    onMessage(message: SideToExt): Promise<void>;
  }).onMessage.bind(provider);
  return { onMessage, posted };
}
