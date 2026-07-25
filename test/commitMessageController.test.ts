import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandAvailability } from "../src/chat/session/ports.js";
import type { ScmInspectionPort } from "../src/scm/sandboxedGit.js";

type CommandHandler = (...args: unknown[]) => unknown;
type WorkspaceListener = () => void;
type WindowListener = (event: { focused: boolean }) => void;

const mocks = vi.hoisted(() => ({
  commandHandlers: new Map<string, CommandHandler>(),
  workspaceListeners: [] as WorkspaceListener[],
  windowListeners: [] as WindowListener[],
  executeCommand: vi.fn(async () => undefined),
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  clipboardWrite: vi.fn(async () => undefined),
  complete: vi.fn(),
  createFileSystemWatcher: vi.fn(),
  getExtension: vi.fn()
}));

vi.mock("vscode", () => ({
  commands: {
    registerCommand: (id: string, handler: CommandHandler) => {
      mocks.commandHandlers.set(id, handler);
      return { dispose: () => mocks.commandHandlers.delete(id) };
    },
    executeCommand: mocks.executeCommand
  },
  workspace: {
    onDidChangeWorkspaceFolders: (listener: WorkspaceListener) => {
      mocks.workspaceListeners.push(listener);
      return { dispose: vi.fn() };
    },
    createFileSystemWatcher: mocks.createFileSystemWatcher
  },
  window: {
    onDidChangeWindowState: (listener: WindowListener) => {
      mocks.windowListeners.push(listener);
      return { dispose: vi.fn() };
    },
    showErrorMessage: mocks.showErrorMessage,
    showWarningMessage: mocks.showWarningMessage
  },
  env: {
    clipboard: { writeText: mocks.clipboardWrite }
  },
  extensions: {
    getExtension: mocks.getExtension
  }
}));

vi.mock("../src/config/settings.js", () => ({
  readSettings: () => ({ endpoint: "http://127.0.0.1:8080/v1" })
}));

vi.mock("../src/llm/client.js", () => ({
  complete: mocks.complete
}));

import { CommitMessageController } from "../src/scm/commitMessage.js";

const AVAILABILITY: CommandAvailability = Object.freeze({
  available: true,
  backend: "docker",
  profileDigest: "a".repeat(64),
  imageReference: `sha256:${"b".repeat(64)}`,
  imageId: `sha256:${"b".repeat(64)}`
});

beforeEach(() => {
  mocks.commandHandlers.clear();
  mocks.workspaceListeners.length = 0;
  mocks.windowListeners.length = 0;
  mocks.executeCommand.mockClear();
  mocks.showErrorMessage.mockClear();
  mocks.showWarningMessage.mockClear();
  mocks.clipboardWrite.mockClear();
  mocks.complete.mockReset();
  mocks.createFileSystemWatcher.mockClear();
  mocks.getExtension.mockReset();
  mocks.getExtension.mockReturnValue(undefined);
  mocks.complete.mockResolvedValue("Describe the staged change");
});

describe("CommitMessageController operation scope", () => {
  it("claims busy before inspection and ignores a concurrent generate command", async () => {
    let releaseDiff!: (value: string) => void;
    const diff = new Promise<string>(resolve => { releaseDiff = resolve; });
    const stagedDiff = vi.fn((_signal: AbortSignal) => diff);
    const factory = vi.fn(async () => inspector({ stagedDiff }));
    const controller = new CommitMessageController(() => "C:\\workspace", factory);

    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1));
    const generate = requireCommand("localLlmHarness.generateCommitMessage");
    const first = Promise.resolve(generate());
    const duplicate = Promise.resolve(generate());

    await vi.waitFor(() => expect(stagedDiff).toHaveBeenCalledTimes(1));
    releaseDiff("diff --git a/a b/a\n");
    await Promise.all([first, duplicate]);

    expect(stagedDiff).toHaveBeenCalledTimes(1);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    expect(mocks.clipboardWrite).toHaveBeenCalledWith("Describe the staged change");
    expect(mocks.createFileSystemWatcher).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("aborts inspection/model work on a workspace change and suppresses stale output", async () => {
    let workspaceRoot = "C:\\workspace-a";
    let completeSignal: AbortSignal | undefined;
    let completeStarted!: () => void;
    const started = new Promise<void>(resolve => { completeStarted = resolve; });
    mocks.complete.mockImplementation(async (
      _endpoint: string,
      _request: unknown,
      signal: AbortSignal
    ) => {
      completeSignal = signal;
      completeStarted();
      return await new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const factory = vi.fn(async (_root: string, _signal: AbortSignal) => inspector({
      stagedDiff: async () => "diff --git a/a b/a\n"
    }));
    const controller = new CommitMessageController(() => workspaceRoot, factory);

    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1));
    const operation = Promise.resolve(requireCommand("localLlmHarness.generateCommitMessage")());
    await started;
    workspaceRoot = "C:\\workspace-b";
    for (const listener of mocks.workspaceListeners) listener();
    await operation;

    expect(completeSignal?.aborted).toBe(true);
    expect(mocks.clipboardWrite).not.toHaveBeenCalled();
    expect(mocks.showErrorMessage).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(factory.mock.calls.some(call => call[0] === "C:\\workspace-b")).toBe(true);
    });
    controller.dispose();
  });

  it("serializes focus refreshes and starts only the newest queued request", async () => {
    let active = 0;
    let maximumActive = 0;
    let refreshCalls = 0;
    const factory = vi.fn(async () => inspector({
      hasStagedChanges: async (signal: AbortSignal) => {
        refreshCalls++;
        active++;
        maximumActive = Math.max(maximumActive, active);
        try {
          if (refreshCalls === 1) {
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          }
          return false;
        } finally {
          active--;
        }
      }
    }));
    const controller = new CommitMessageController(() => "C:\\workspace", factory);

    await vi.waitFor(() => expect(refreshCalls).toBe(1));
    for (const listener of mocks.windowListeners) listener({ focused: true });
    for (const listener of mocks.windowListeners) listener({ focused: true });

    await vi.waitFor(() => expect(refreshCalls).toBe(2));
    expect(maximumActive).toBe(1);
    expect(mocks.createFileSystemWatcher).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("never activates host Git and rechecks a stale no-staged button in the sandbox", async () => {
    const activate = vi.fn();
    mocks.getExtension.mockReturnValue({
      isActive: false,
      activate
    });
    const stagedDiff = vi.fn(async () => "diff --git a/a b/a\n");
    const factory = vi.fn(async (_root: string, _signal: AbortSignal) => inspector({ stagedDiff }));
    const controller = new CommitMessageController(() => "C:\\workspace", factory);

    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1));
    await Promise.resolve(requireCommand("localLlmHarness.generateCommitMessageNoStaged")());

    expect(stagedDiff).toHaveBeenCalledTimes(1);
    expect(activate).not.toHaveBeenCalled();
    expect(mocks.clipboardWrite).toHaveBeenCalledWith("Describe the staged change");
    expect(mocks.executeCommand).not.toHaveBeenCalledWith("workbench.view.scm");
    controller.dispose();
  });
});

function inspector(overrides: Partial<ScmInspectionPort>): ScmInspectionPort {
  return {
    availability: async () => AVAILABILITY,
    hasStagedChanges: async () => false,
    stagedDiff: async () => "",
    readHeadFile: async () => undefined,
    ...overrides
  };
}

function requireCommand(id: string): CommandHandler {
  const handler = mocks.commandHandlers.get(id);
  if (!handler) throw new Error(`Missing registered command: ${id}`);
  return handler;
}
