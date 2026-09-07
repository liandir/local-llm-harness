import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

const mocks = vi.hoisted(() => ({
  folders: [{ uri: { fsPath: "/workspace/a" } }, { uri: { fsPath: "/workspace/b" } }],
  changed: undefined as (() => void) | undefined,
  closeCurrent: vi.fn(),
  pushSettings: vi.fn(),
  pushChats: vi.fn(),
  refreshOpenTabs: vi.fn(),
  storageRoots: [] as string[]
}));
vi.mock("vscode", () => ({
  workspace: {
    get workspaceFolders() { return mocks.folders; },
    onDidChangeWorkspaceFolders: (handler: () => void) => { mocks.changed = handler; return { dispose() {} }; }
  },
  window: { registerWebviewViewProvider: vi.fn() },
  commands: { registerCommand: vi.fn() }
}));
vi.mock("../src/config/settings.js", () => ({ migrateLegacySafeCommands: vi.fn() }));
vi.mock("../src/scm/commitMessage.js", () => ({ CommitMessageController: class {} }));
vi.mock("../src/chat/storage.js", () => ({
  ChatStorage: class { constructor(root: string) { mocks.storageRoots.push(root); } }
}));
vi.mock("../src/ui/chatView/provider.js", () => ({
  ChatViewProvider: class {
    closeCurrent = mocks.closeCurrent;
    pushSettings = mocks.pushSettings;
  }
}));
vi.mock("../src/ui/sideView/provider.js", () => ({
  SideViewProvider: class {
    pushChats = mocks.pushChats;
    refreshOpenTabs = mocks.refreshOpenTabs;
  }
}));
import { activate } from "../src/extension.js";

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.storageRoots = [];
  mocks.folders = [{ uri: { fsPath: "/workspace/a" } }, { uri: { fsPath: "/workspace/b" } }];
  await activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);
});

describe("workspace folder lifecycle", () => {
  it("closes the old chat and refreshes views when the active root is replaced", () => {
    mocks.folders.shift();
    mocks.changed!();
    expect(mocks.storageRoots).toEqual(["/workspace/a", "/workspace/b"]);
    expect(mocks.closeCurrent).toHaveBeenCalledOnce();
    expect(mocks.pushSettings).toHaveBeenCalledOnce();
    expect(mocks.pushChats).toHaveBeenCalledOnce();
    expect(mocks.refreshOpenTabs).toHaveBeenCalledOnce();
  });

  it("closes the chat when all folders are removed", () => {
    mocks.folders = [];
    mocks.changed!();
    expect(mocks.storageRoots).toEqual(["/workspace/a"]);
    expect(mocks.closeCurrent).toHaveBeenCalledOnce();
    expect(mocks.pushSettings).toHaveBeenCalledOnce();
    expect(mocks.pushChats).toHaveBeenCalledOnce();
  });

  it("preserves the active session when unrelated folders change", () => {
    mocks.folders.pop();
    mocks.changed!();
    expect(mocks.storageRoots).toEqual(["/workspace/a"]);
    expect(mocks.closeCurrent).not.toHaveBeenCalled();
    expect(mocks.pushSettings).not.toHaveBeenCalled();
  });
});
