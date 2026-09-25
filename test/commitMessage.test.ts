import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  gitDiff: vi.fn(),
  showErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showQuickPick: vi.fn(),
  executeCommand: vi.fn(),
  getExtension: vi.fn(),
  clipboardWriteText: vi.fn(),
  complete: vi.fn(),
  readSettings: vi.fn()
}));

const disposable = (): { dispose(): void } => ({ dispose: vi.fn() });

vi.mock("vscode", () => ({
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  RelativePattern: class {
    constructor(_base: string, _pattern: string) {}
  },
  commands: {
    registerCommand: vi.fn((name: string, handler: (...args: unknown[]) => unknown) => {
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
    activeTextEditor: undefined,
    onDidChangeWindowState: vi.fn(disposable),
    showErrorMessage: mocks.showErrorMessage,
    showInformationMessage: mocks.showInformationMessage,
    showQuickPick: mocks.showQuickPick
  },
  extensions: { getExtension: mocks.getExtension },
  env: { clipboard: { writeText: mocks.clipboardWriteText } }
}));

vi.mock("../src/llm/client.js", () => ({ complete: mocks.complete }));
vi.mock("../src/config/settings.js", () => ({ readSettings: mocks.readSettings }));

beforeEach(() => {
  mocks.handlers.clear();
  mocks.gitDiff.mockReset();
  mocks.showErrorMessage.mockReset();
  mocks.showInformationMessage.mockReset();
  mocks.showQuickPick.mockReset();
  mocks.executeCommand.mockReset();
  mocks.getExtension.mockReset();
  mocks.gitDiff.mockResolvedValue("");
  mocks.getExtension.mockReturnValue({ activate: async () => ({ getAPI: () => ({ repositories: [{
    rootUri: { fsPath: "/workspace" }, diff: mocks.gitDiff, state: { indexChanges: [] }
  }] }) }) });
  mocks.clipboardWriteText.mockReset();
  mocks.complete.mockReset();
  mocks.readSettings.mockReset();
  mocks.executeCommand.mockResolvedValue(undefined);
  mocks.showErrorMessage.mockResolvedValue(undefined);
  mocks.showInformationMessage.mockResolvedValue(undefined);
  mocks.showQuickPick.mockResolvedValue(undefined);
  mocks.clipboardWriteText.mockResolvedValue(undefined);
  mocks.readSettings.mockReturnValue({
    endpoint: "http://127.0.0.1:8080/v1",
    model: "commit-model",
    toolCallingMode: "compat-gemma4",
    topK: 40,
    topP: 0.95,
    commitMessagePrompt: "Write a concise Git commit message."
  });
});

describe("CommitMessageController", () => {
  it("reports unavailable Git without a subprocess fallback", async () => {
    mocks.getExtension.mockReturnValue(undefined);
    const { CommitMessageController } = await import("../src/scm/commitMessage.js");
    const controller = new CommitMessageController(() => "/workspace");
    await mocks.handlers.get("localLlmHarness.generateCommitMessage")?.();
    expect(mocks.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("VS Code Git repository is unavailable"));
    expect(mocks.complete).not.toHaveBeenCalled();
    controller.dispose();
  });

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
    mocks.gitDiff.mockRejectedValue(new Error("git diff failed"));
    const { CommitMessageController } = await import("../src/scm/commitMessage.js");
    const controller = new CommitMessageController(() => "/workspace");

    await mocks.handlers.get("localLlmHarness.generateCommitMessage")?.();

    expect(mocks.showErrorMessage).toHaveBeenCalledWith(
      "Local LLM Harness: could not inspect staged changes: git diff failed"
    );
    controller.dispose();
  });

  it("rechecks Git from a stale no-staged button and writes the generated message", async () => {
    mocks.gitDiff.mockResolvedValue("diff --git a/a.ts b/a.ts\n");
    mocks.readSettings.mockReturnValue({
      endpoint: "http://127.0.0.1:8080/v1",
      toolCallingMode: "compat-qwen3",
      topK: 20,
      topP: 0.9,
      commitMessagePrompt: "Use Conventional Commits with a required scope."
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
        getAPI: () => ({ repositories: [{ rootUri: { fsPath: "/workspace" }, diff: mocks.gitDiff, inputBox }] })
      })
    });

    const { CommitMessageController } = await import("../src/scm/commitMessage.js");
    const controller = new CommitMessageController(() => "/workspace");
    await mocks.handlers.get("localLlmHarness.generateCommitMessageNoStaged")?.();

    expect(inputValue).toBe("Fix restart behavior");
    expect(events).toEqual(["open", "write"]);
    expect(mocks.complete).toHaveBeenCalledWith(
      "http://127.0.0.1:8080/v1",
      expect.objectContaining({
        top_k: 20,
        top_p: 0.9,
        messages: [expect.objectContaining({
          role: "user",
          content: expect.stringContaining("Use Conventional Commits with a required scope.")
        })]
      }),
      expect.any(AbortSignal),
      { acceptPartialOnLength: true }
    );
    expect(mocks.complete.mock.calls[0][1]).not.toHaveProperty("max_tokens");
    expect(mocks.complete.mock.calls[0][1]).not.toHaveProperty("thinking_budget_tokens");
    controller.dispose();
  });

  it("uses the nested Git repository represented by the clicked SCM action", async () => {
    const repoAInput = { value: "" };
    const repoBInput = { value: "" };
    const repositories = [
      { rootUri: { fsPath: "/workspace/repo-a" }, inputBox: repoAInput, diff: vi.fn() },
      { rootUri: { fsPath: "/workspace/repo-b" }, inputBox: repoBInput, diff: mocks.gitDiff }
    ];
    mocks.getExtension.mockReturnValue({
      activate: async () => ({ getAPI: () => ({ repositories }) })
    });
    mocks.gitDiff.mockResolvedValue("diff --git a/b.ts b/b.ts\n");
    mocks.complete.mockResolvedValue("Describe repo B changes");

    const { CommitMessageController } = await import("../src/scm/commitMessage.js");
    const controller = new CommitMessageController(() => "/workspace");
    await mocks.handlers.get("localLlmHarness.generateCommitMessage")?.({
      rootUri: { fsPath: "/workspace/repo-b" }
    });

    expect(repoAInput.value).toBe("");
    expect(repoBInput.value).toBe("Describe repo B changes");
    expect(mocks.showQuickPick).not.toHaveBeenCalled();
    expect(mocks.gitDiff).toHaveBeenCalledWith(true);
    expect(repositories[0].diff).not.toHaveBeenCalled();
    controller.dispose();
  });
});
