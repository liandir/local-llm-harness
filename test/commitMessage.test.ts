import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, () => unknown>(),
  execFileUtf8: vi.fn(),
  showErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  executeCommand: vi.fn(),
  getExtension: vi.fn(),
  clipboardWriteText: vi.fn(),
  complete: vi.fn(),
  readSettings: vi.fn()
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
  extensions: { getExtension: mocks.getExtension },
  env: { clipboard: { writeText: mocks.clipboardWriteText } }
}));

vi.mock("../src/util/exec.js", () => ({ execFileUtf8: mocks.execFileUtf8 }));
vi.mock("../src/llm/client.js", () => ({ complete: mocks.complete }));
vi.mock("../src/config/settings.js", () => ({ readSettings: mocks.readSettings }));

beforeEach(() => {
  mocks.handlers.clear();
  mocks.execFileUtf8.mockReset();
  mocks.showErrorMessage.mockReset();
  mocks.showInformationMessage.mockReset();
  mocks.executeCommand.mockReset();
  mocks.getExtension.mockReset();
  mocks.clipboardWriteText.mockReset();
  mocks.complete.mockReset();
  mocks.readSettings.mockReset();
  mocks.executeCommand.mockResolvedValue(undefined);
  mocks.showErrorMessage.mockResolvedValue(undefined);
  mocks.showInformationMessage.mockResolvedValue(undefined);
  mocks.clipboardWriteText.mockResolvedValue(undefined);
  mocks.readSettings.mockReturnValue({
    endpoint: "http://127.0.0.1:8080/v1",
    modelFamily: "gemma4",
    topK: 40,
    topP: 0.95
  });
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

  it("opens SCM before writing a normalized Qwen commit message into the Git input", async () => {
    mocks.execFileUtf8.mockImplementation(async (_command: string, args: string[]) => {
      if (args.includes("rev-parse")) return { stdout: "/workspace\n", stderr: "", exitCode: 0 };
      if (args.includes("--quiet")) return { stdout: "", stderr: "", exitCode: 1 };
      if (args.includes("--cached")) return { stdout: "diff --git a/a.ts b/a.ts\n", stderr: "", exitCode: 0 };
      throw new Error(`unexpected git arguments: ${args.join(" ")}`);
    });
    mocks.readSettings.mockReturnValue({
      endpoint: "http://127.0.0.1:8080/v1",
      modelFamily: "qwen3",
      topK: 20,
      topP: 0.9
    });
    mocks.complete.mockResolvedValue("<think>drafting</think>\n```text\nFix restart behavior\n```");

    const events: string[] = [];
    let inputValue = "";
    const inputBox = {
      get value(): string { return inputValue; },
      set value(value: string) { events.push("write"); inputValue = value; }
    };
    mocks.executeCommand.mockImplementation(async (command: string) => {
      if (command === "workbench.view.scm") events.push("open");
    });
    mocks.getExtension.mockReturnValue({
      activate: async () => ({
        getAPI: () => ({ repositories: [{ rootUri: { fsPath: "/workspace" }, inputBox }] })
      })
    });

    const { CommitMessageController } = await import("../src/scm/commitMessage.js");
    const controller = new CommitMessageController(() => "/workspace");
    await mocks.handlers.get("localLlmHarness.generateCommitMessage")?.();

    expect(inputValue).toBe("Fix restart behavior");
    expect(events).toEqual(["open", "write"]);
    expect(mocks.complete).toHaveBeenCalledWith(
      "http://127.0.0.1:8080/v1",
      expect.objectContaining({
        max_tokens: 512,
        top_k: 20,
        top_p: 0.9,
        messages: expect.arrayContaining([
          expect.objectContaining({ content: expect.stringContaining("/no_think") })
        ])
      }),
      expect.any(AbortSignal)
    );
    controller.dispose();
  });
});
