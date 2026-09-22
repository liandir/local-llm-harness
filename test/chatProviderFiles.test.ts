import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";
import type { ChatToExt } from "../src/ui/messaging.js";

const mocks = vi.hoisted(() => ({
  open: vi.fn(), openText: vi.fn(), showText: vi.fn(), error: vi.fn(), reveal: vi.fn(),
  editor: { document: { uri: { fsPath: "" } } }
}));
vi.mock("vscode", () => ({
  commands: { executeCommand: mocks.open },
  workspace: { openTextDocument: mocks.openText },
  window: {
    showTextDocument: mocks.showText, showErrorMessage: mocks.error,
    activeTextEditor: { ...mocks.editor, revealRange: mocks.reveal }
  },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  Range: class {
    start: { line: number; character: number };
    end: { line: number; character: number };
    constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
      this.start = { line: startLine, character: startCharacter };
      this.end = { line: endLine, character: endCharacter };
    }
  },
  TextEditorRevealType: { AtTop: 1 }
}));
vi.mock("../src/config/settings.js", () => ({ readSettings: () => ({ reasoningEfforts: {} }) }));
vi.mock("../src/chat/session.js", () => ({ ChatSession: class {} }));
import { ChatViewProvider } from "../src/ui/chatView/provider.js";

let workspace: string;
beforeEach(async () => {
  vi.clearAllMocks();
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "llh-file-links-"));
});
afterEach(async () => { await fs.rm(workspace, { recursive: true, force: true }); });

function send(message: ChatToExt) {
  const provider = new ChatViewProvider(
    {} as vscode.ExtensionContext, () => undefined, () => workspace,
    vi.fn(), vi.fn(), vi.fn(), vi.fn()
  );
  return (provider as unknown as { onMessage(message: ChatToExt): Promise<void> }).onMessage(message);
}

describe("workspace file links", () => {
  it.each(["image.png", "image.JPG", "image.webp", "README.md"])("uses the registered editor for %s", async name => {
    await fs.writeFile(path.join(workspace, name), "fixture");
    await send({ type: "openFile", path: name });
    expect(mocks.open).toHaveBeenCalledWith("vscode.open", { fsPath: path.join(workspace, name) }, { preview: false });
    expect(mocks.openText).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("still opens text files at the requested line", async () => {
    const absolute = path.join(workspace, "source.ts");
    await fs.writeFile(absolute, "line one\nline two\n");
    mocks.editor.document.uri.fsPath = absolute;
    mocks.openText.mockResolvedValue(mocks.editor.document);
    await send({ type: "openFile", path: "source.ts", line: 2 });
    const selection = { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } };
    expect(mocks.openText).toHaveBeenCalledWith({ fsPath: absolute });
    expect(mocks.showText).toHaveBeenCalledWith(mocks.editor.document, { preview: false, selection });
    expect(mocks.reveal).toHaveBeenCalledWith(selection, 1);
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("rejects image links and symlinks outside the workspace before opening an editor", async () => {
    await fs.symlink(os.tmpdir(), path.join(workspace, "outside"));
    for (const filePath of ["../image.png", "outside/image.png"]) {
      await send({ type: "openFile", path: filePath });
    }
    expect(mocks.error).toHaveBeenCalledTimes(2);
    expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining("outside the workspace"));
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.openText).not.toHaveBeenCalled();
  });
});
