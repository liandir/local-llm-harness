import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, () => unknown>(),
  execFileUtf8: vi.fn(),
  showErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  executeCommand: vi.fn()
}));

const disposable = (): { dispose(): void } => ({ dispose: vi.fn() });

vi.mock("vscode", () => ({
  RelativePattern: class {
    constructor(_base: string, _pattern: string) {}
  },
  commands: {
    registerCommand: vi.fn((name: string, handler: () => unknown) => {
      mocks.handlers.set(name, handler);
      return disposable();
    }),
    executeCommand: mocks.executeCommand
  },
  workspace: {
    onDidChangeWorkspaceFolders: vi.fn(disposable),
    createFileSystemWatcher: vi.fn(() => ({
      ...disposable(),
      onDidChange: vi.fn(disposable),
      onDidCreate: vi.fn(disposable),
      onDidDelete: vi.fn(disposable)
    }))
  },
  window: {
    onDidChangeWindowState: vi.fn(disposable),
    showErrorMessage: mocks.showErrorMessage,
    showInformationMessage: mocks.showInformationMessage
  },
  extensions: { getExtension: vi.fn() },
  env: { clipboard: { writeText: vi.fn() } }
}));

vi.mock("../src/util/exec.js", () => ({ execFileUtf8: mocks.execFileUtf8 }));
vi.mock("../src/llm/client.js", () => ({ complete: vi.fn() }));
vi.mock("../src/config/settings.js", () => ({ readSettings: vi.fn() }));

beforeEach(() => {
  mocks.handlers.clear();
  mocks.execFileUtf8.mockReset();
  mocks.showErrorMessage.mockReset();
  mocks.showInformationMessage.mockReset();
  mocks.executeCommand.mockReset();
  mocks.executeCommand.mockResolvedValue(undefined);
  mocks.showErrorMessage.mockResolvedValue(undefined);
  mocks.showInformationMessage.mockResolvedValue(undefined);
});

describe("CommitMessageController", () => {
  it("explains that changes must be staged instead of only animating the icon", async () => {
    const { CommitMessageController } = await import("../src/scm/commitMessage.js");
    const controller = new CommitMessageController(() => undefined);

    await mocks.handlers.get("localLlmHarness.generateCommitMessageNoStaged")?.();

    expect(mocks.showInformationMessage).toHaveBeenCalledWith(
      "Local LLM Harness: stage the changes you want included, then generate the commit message again."
    );
    controller.dispose();
  });

  it("reports staged-diff failures instead of rejecting the command silently", async () => {
    mocks.execFileUtf8.mockImplementation(async (_command: string, args: string[]) => {
      if (args.includes("rev-parse")) return { stdout: "/workspace\n", stderr: "", exitCode: 0 };
      if (args.includes("--quiet")) return { stdout: "", stderr: "", exitCode: 0 };
      throw new Error("git diff failed");
    });
    const { CommitMessageController } = await import("../src/scm/commitMessage.js");
    const controller = new CommitMessageController(() => "/workspace");

    await mocks.handlers.get("localLlmHarness.generateCommitMessage")?.();

    expect(mocks.showErrorMessage).toHaveBeenCalledWith(
      "Local LLM Harness: could not inspect staged changes: git diff failed"
    );
    controller.dispose();
  });
});
