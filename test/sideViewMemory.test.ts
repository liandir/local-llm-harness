import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type { WorkspaceMemory } from "../src/chat/workspaceMemory.js";
import type { ChatStorage } from "../src/chat/storage.js";
import type { SideToExt } from "../src/ui/messaging.js";

vi.mock("vscode", () => ({ Uri: { joinPath: (...parts: string[]) => parts.join("/") }, commands: { executeCommand: vi.fn() } }));
vi.mock("../src/config/settings.js", () => ({
  onSettingsChange: () => ({ dispose() {} }),
  readSettings: () => ({ endpoint: "invalid", memoryEnabled: true })
}));
import { SideViewProvider } from "../src/ui/sideView/provider.js";

let provider: SideViewProvider;
let receive: (message: SideToExt) => Promise<void>;
let storage: ChatStorage | undefined;
const postMessage = vi.fn();
const list = vi.fn();
const edit = vi.fn();
const setEnabled = vi.fn();
const regenerate = vi.fn();
const summarizeExisting = vi.fn();
const reset = vi.fn();
const memories = [{ sourceId: "source", title: "Parser", text: "Parser decision", status: "ready" }];

beforeEach(() => {
  vi.clearAllMocks();
  storage = undefined;
  list.mockResolvedValue(memories);
  provider = new SideViewProvider(
    { extensionUri: "/extension", extension: { packageJSON: { version: "1.7.0" } } } as unknown as vscode.ExtensionContext,
    () => storage, vi.fn(), vi.fn(), () => [],
    { list, edit, setEnabled, regenerate, summarizeExisting, reset } as unknown as WorkspaceMemory
  );
  provider.resolveWebviewView({
    webview: {
      asWebviewUri: (uri: string) => uri,
      postMessage,
      onDidReceiveMessage: (handler: typeof receive) => { receive = handler; return { dispose() {} }; }
    },
    onDidDispose: vi.fn(), show: vi.fn()
  } as unknown as vscode.WebviewView);
});

describe("Recent Chats memory management", () => {
  it("opens the source memory editor after its chats and summaries are loaded", async () => {
    storage = { load: vi.fn().mockResolvedValue({ id: "source" }), list: vi.fn().mockResolvedValue([{ id: "source", title: "Parser", updatedAt: 1 }]) } as unknown as ChatStorage;
    await receive({ type: "ready" });
    postMessage.mockClear();
    await provider.revealMemory("source");
    expect(postMessage.mock.calls.map(([message]) => message.type)).toEqual(["chats", "memories", "revealMemory"]);
    expect(postMessage).toHaveBeenLastCalledWith({ type: "revealMemory", id: "source" });
  });

  it("defers source navigation until the webview is ready and rejects unavailable sources", async () => {
    storage = { load: vi.fn().mockResolvedValue({ id: "source" }), list: vi.fn().mockResolvedValue([]) } as unknown as ChatStorage;
    await provider.revealMemory("source");
    expect(postMessage).not.toHaveBeenCalledWith({ type: "revealMemory", id: "source" });
    await receive({ type: "ready" });
    expect(postMessage).toHaveBeenLastCalledWith({ type: "revealMemory", id: "source" });
    vi.mocked(storage.load).mockResolvedValue(undefined);
    postMessage.mockClear();
    await provider.revealMemory("foreign-source");
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("drops pending source navigation if the workspace changes before the webview loads", async () => {
    storage = { load: vi.fn().mockResolvedValue({ id: "source" }), list: vi.fn().mockResolvedValue([]) } as unknown as ChatStorage;
    await provider.revealMemory("source");
    storage = undefined;
    await receive({ type: "ready" });
    expect(postMessage).not.toHaveBeenCalledWith({ type: "revealMemory", id: "source" });
  });

  it("loads memories when entering Chats, including after returning from Settings", async () => {
    await receive({ type: "openTab", tab: "settings" });
    expect(list).not.toHaveBeenCalled();
    await receive({ type: "openTab", tab: "chats" });
    expect(postMessage).toHaveBeenCalledWith({ type: "memories", memories });
    await receive({ type: "openTab", tab: "settings" });
    provider.focusTab("chats");
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it("routes all management actions and refreshes the chat memory controls", async () => {
    await receive({ type: "openTab", tab: "chats" });
    await receive({ type: "editMemory", id: "source", text: "Manual decision" });
    await receive({ type: "setMemoryEnabled", id: "source", enabled: false });
    await receive({ type: "regenerateMemory", id: "source" });
    await receive({ type: "summarizeExistingChats" });
    await receive({ type: "cancelMemoryGeneration" });
    expect(edit).toHaveBeenCalledWith("source", "Manual decision");
    expect(setEnabled).toHaveBeenCalledWith("source", false);
    expect(regenerate).toHaveBeenCalledWith("source");
    expect(summarizeExisting).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledTimes(6);
  });
});
