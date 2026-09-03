import { describe, expect, it } from "vitest";
import { workspaceFileIconGlyph } from "../src/ui/chatView/webview/fileTypeIcons.js";

function glyphCode(filePath: string): number | undefined {
  return workspaceFileIconGlyph(filePath).codePointAt(0);
}

describe("workspaceFileIconGlyph", () => {
  it("uses VS Code Seti glyphs inferred from common file suffixes", () => {
    expect(glyphCode("src/ui/main.ts")).toBe(0xe099);
    expect(glyphCode("src/ui/component.tsx")).toBe(0xe07d);
    expect(glyphCode("assets/logo.png")).toBe(0xe04c);
  });

  it("uses the longest matching suffix and ignores case", () => {
    expect(glyphCode("main.SPEC.TS")).toBe(0xe099);
    expect(glyphCode("styles.CSS.MAP")).toBe(0xe01d);
  });

  it("preserves VS Code's special filename associations", () => {
    expect(glyphCode("docs/README.md")).toBe(0xe04d);
    expect(glyphCode("Dockerfile")).toBe(0xe025);
    expect(glyphCode("config/tsconfig.json")).toBe(0xe097);
  });

  it("falls back to the Seti generic file glyph", () => {
    expect(glyphCode("src/unrecognised.zzz-no-icon")).toBe(0xe023);
  });
});
