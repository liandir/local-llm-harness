import { describe, expect, it } from "vitest";
import { resolveWorkspaceFileLink } from "../src/ui/chatView/webview/workspaceLinks.js";

describe("resolveWorkspaceFileLink", () => {
  it("resolves relative workspace links and exposes the full path as the tooltip", () => {
    expect(resolveWorkspaceFileLink("src/app.ts:12", "C:\\repo")).toEqual({
      path: "src\\app.ts",
      tooltip: "C:\\repo\\src\\app.ts",
      line: 12
    });
  });

  it("accepts absolute paths only when they are inside the workspace", () => {
    expect(resolveWorkspaceFileLink("C:\\repo\\README.md", "C:\\repo")).toEqual({
      path: "C:\\repo\\README.md",
      tooltip: "C:\\repo\\README.md",
      line: undefined
    });
    expect(resolveWorkspaceFileLink("C:\\other\\secret.txt", "C:\\repo")).toBeUndefined();
  });

  it("supports encoded file URIs and hash line references", () => {
    expect(resolveWorkspaceFileLink("file:///C:/repo/My%20File.ts#L7", "C:\\repo")).toEqual({
      path: "C:\\repo\\My File.ts",
      tooltip: "C:\\repo\\My File.ts",
      line: 7
    });
  });

  it("does not turn external URLs or escaping paths into workspace links", () => {
    expect(resolveWorkspaceFileLink("https://example.com/file.ts", "C:\\repo")).toBeUndefined();
    expect(resolveWorkspaceFileLink("../outside.txt", "C:\\repo")).toBeUndefined();
  });

  it("preserves UNC workspace paths", () => {
    expect(resolveWorkspaceFileLink("//server/share/repo/src/app.ts", "\\\\server\\share\\repo")).toEqual({
      path: "\\\\server\\share\\repo\\src\\app.ts",
      tooltip: "\\\\server\\share\\repo\\src\\app.ts",
      line: undefined
    });
  });
});
