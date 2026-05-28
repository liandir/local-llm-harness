import { describe, expect, it } from "vitest";
import pkg from "../package.json";
import { checkSafeCommand, type SafeCommandEntry } from "../src/tools/safeCommands.js";

const defaults = pkg.contributes.configuration.properties["localLlmHarness.safeCommands"]
  .default as SafeCommandEntry[];

describe("default safe commands", () => {
  it("allows basic workspace inspection commands", () => {
    expect(checkSafeCommand("pwd", defaults).ok).toBe(true);
    expect(checkSafeCommand("ls", defaults).ok).toBe(true);
    expect(checkSafeCommand("ls -la src/chat", defaults).ok).toBe(true);
    expect(checkSafeCommand("cat src/chat/storage.ts", defaults).ok).toBe(true);
    expect(checkSafeCommand("find . -maxdepth 2 -type f", defaults).ok).toBe(true);
    expect(checkSafeCommand("git status", defaults).ok).toBe(true);
    expect(checkSafeCommand("git diff", defaults).ok).toBe(true);
  });

  it("allows simple relative mkdir commands", () => {
    expect(checkSafeCommand("mkdir tmp", defaults).ok).toBe(true);
    expect(checkSafeCommand("mkdir -p tmp/nested", defaults).ok).toBe(true);
  });

  it("rejects absolute paths, traversal, and shell operators", () => {
    expect(checkSafeCommand("cat /etc/passwd", defaults).ok).toBe(false);
    expect(checkSafeCommand("cat ../package.json", defaults).ok).toBe(false);
    expect(checkSafeCommand("ls src; cat package.json", defaults).ok).toBe(false);
    expect(checkSafeCommand("mkdir tmp && cat package.json", defaults).ok).toBe(false);
    expect(checkSafeCommand("find / -maxdepth 2 -type f", defaults).ok).toBe(false);
  });
});
