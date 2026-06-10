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
    expect(checkSafeCommand("grep TODO src/chat/storage.ts", defaults).ok).toBe(true);
    expect(checkSafeCommand("grep -n safeCommands package.json", defaults).ok).toBe(true);
    expect(checkSafeCommand("grep -R TODO src", defaults).ok).toBe(true);
    expect(checkSafeCommand("grep -r \"safeCommands\" src", defaults).ok).toBe(true);
    expect(checkSafeCommand("grep -rl \"safeCommands\" src", defaults).ok).toBe(true);
    expect(checkSafeCommand("grep -r 'safe command' .", defaults).ok).toBe(true);
    expect(checkSafeCommand("find . -maxdepth 2 -type f", defaults).ok).toBe(true);
    expect(checkSafeCommand("git status", defaults).ok).toBe(true);
    expect(checkSafeCommand("git diff", defaults).ok).toBe(true);
  });

  it("allows simple relative mkdir commands", () => {
    expect(checkSafeCommand("mkdir tmp", defaults).ok).toBe(true);
    expect(checkSafeCommand("mkdir -p tmp/nested", defaults).ok).toBe(true);
  });

  it("allows simple relative mv commands", () => {
    expect(checkSafeCommand("mv tmp/a.txt tmp/b.txt", defaults).ok).toBe(true);
    expect(checkSafeCommand("mv src/old src/new", defaults).ok).toBe(true);
  });

  it("allows simple relative cp commands", () => {
    expect(checkSafeCommand("cp tmp/a.txt tmp/b.txt", defaults).ok).toBe(true);
    expect(checkSafeCommand("cp src/source src/copy", defaults).ok).toBe(true);
  });

  it("rejects absolute paths, traversal, and shell operators", () => {
    expect(checkSafeCommand("cat /etc/passwd", defaults).ok).toBe(false);
    expect(checkSafeCommand("cat ../package.json", defaults).ok).toBe(false);
    expect(checkSafeCommand("grep TODO ../package.json", defaults).ok).toBe(false);
    expect(checkSafeCommand("grep -rl TODO ../src", defaults).ok).toBe(false);
    expect(checkSafeCommand("grep \"TODO; cat package.json\" package.json", defaults).ok).toBe(false);
    expect(checkSafeCommand("grep \"$(cat package.json)\" src", defaults).ok).toBe(false);
    expect(checkSafeCommand("grep TODO package.json; cat package.json", defaults).ok).toBe(false);
    expect(checkSafeCommand("ls src; cat package.json", defaults).ok).toBe(false);
    expect(checkSafeCommand("mkdir tmp && cat package.json", defaults).ok).toBe(false);
    expect(checkSafeCommand("mv ../a b", defaults).ok).toBe(false);
    expect(checkSafeCommand("mv src/a /tmp/b", defaults).ok).toBe(false);
    expect(checkSafeCommand("mv src/a src/b; cat package.json", defaults).ok).toBe(false);
    expect(checkSafeCommand("cp ../a b", defaults).ok).toBe(false);
    expect(checkSafeCommand("cp src/a /tmp/b", defaults).ok).toBe(false);
    expect(checkSafeCommand("cp src/a src/b; cat package.json", defaults).ok).toBe(false);
    expect(checkSafeCommand("find / -maxdepth 2 -type f", defaults).ok).toBe(false);
  });
});
