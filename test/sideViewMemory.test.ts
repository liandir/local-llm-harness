import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type { WorkspaceMemory } from "../src/chat/workspaceMemory.js";
import type { SideToExt } from "../src/ui/messaging.js";

vi.mock("vscode", () => ({ Uri: { joinPath: (...parts: string[]) => parts.join("/") } }));
vi.mock("../src/config/settings.js", () => ({
  onSettingsChange: () => ({ dispose() {} })
}));
import { SideViewProvider } from "../src/ui/sideView/provider.js";

let provider: SideViewProvider;
let receive: (message: SideToExt) => Promise<void>;
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
  list.mockResolvedValue(memories);
  provider = new SideViewProvider(
    { extensionUri: "/extension" } as unknown as vscode.ExtensionContext,
    () => undefined, vi.fn(), vi.fn(), () => [],
    { list, edit, setEnabled, regenerate, summarizeExisting, reset } as unknown as WorkspaceMemory
  );
  provider.resolveWebviewView({
    webview: {
      asWebviewUri: (uri: string) => uri,
      postMessage,
      onDidReceiveMessage: (handler: typeof receive) => { receive = handler; return { dispose() {} }; }
    },
    onDidDispose: vi.fn()
  } as unknown as vscode.WebviewView);
});

describe("Recent Chats memory management", () => {
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
