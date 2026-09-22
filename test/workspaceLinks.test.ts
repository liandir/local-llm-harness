import { describe, expect, it } from "vitest";
import MarkdownIt from "markdown-it";
import {
  enableWorkspaceFileLinks,
  resolveWorkspaceFileLink,
  workspaceFileLabel,
  workspaceFileName
} from "../src/ui/chatView/webview/workspaceLinks.js";

describe("Markdown workspace file links", () => {
  it("parses file URI links instead of leaving valid Markdown as literal text", () => {
    const md = new MarkdownIt({ html: false });
    const href = "file:///home/poseidon/Desktop/test/AGENTS.md";
    const markdown = `The README doesn't reference [AGENTS.md](${href}) which exists in the workspace.`;
    expect(md.render(markdown)).not.toContain("<a ");
    enableWorkspaceFileLinks(md, () => "/home/poseidon/Desktop/test");
    expect(md.render(markdown)).toContain(`<a href="${href}">AGENTS.md</a>`);
  });

  it("uses the current workspace and preserves ordinary link validation", () => {
    const md = new MarkdownIt({ html: false });
    let workspaceRoot: string | undefined;
    enableWorkspaceFileLinks(md, () => workspaceRoot);
    const href = "file:///C:/repo/My%20File.ts#L7";
    expect(md.validateLink(href)).toBe(false);
    workspaceRoot = "C:\\repo";
    expect(md.render(`[File](${href})`)).toContain('<a href="file:///C:/repo/My%20File.ts#L7">');
    workspaceRoot = "C:\\other";
    expect(md.validateLink(href)).toBe(false);
    expect(md.render("[Web](https://example.com)")).toContain('<a href="https://example.com">Web</a>');
  });

  it.each([
    "file:///outside/secret.txt",
    "file:///workspace/../outside/secret.txt",
    "javascript:alert%281%29",
    "vbscript:msgbox%281%29",
    "data:text/html;base64,PHNjcmlwdD4="
  ])("does not enable disallowed links: %s", href => {
    const md = new MarkdownIt({ html: false });
    enableWorkspaceFileLinks(md, () => "/workspace");
    expect(md.render(`[Link](${href})`)).not.toContain("<a ");
  });
});

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

describe("workspaceFileName", () => {
  it("extracts the basename from Windows and POSIX workspace paths", () => {
    expect(workspaceFileName("src\\ui\\main.ts")).toBe("main.ts");
    expect(workspaceFileName("src/ui/main.ts")).toBe("main.ts");
    expect(workspaceFileName("README.md")).toBe("README.md");
  });

  it("builds compact Markdown labels with an optional line number", () => {
    expect(workspaceFileLabel({ path: "src/ui/main.ts", line: 42 })).toBe("main.ts:42");
    expect(workspaceFileLabel({ path: "src/ui/main.ts" })).toBe("main.ts");
  });
});
