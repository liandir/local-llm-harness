import { describe, expect, it } from "vitest";
import pkg from "../package.json";
import {
  checkSafeCommand,
  DEFAULT_LS_COMMAND_PATTERN,
  DEFAULT_MKDIR_COMMAND_PATTERN,
  migrateLegacyDefaultSafeCommands,
  type SafeCommandEntry
} from "../src/tools/safeCommands.js";

const defaults = pkg.contributes.configuration.properties["localLlmHarness.safeCommands"]
  .default as SafeCommandEntry[];

describe("default safe commands", () => {
  it("allows basic workspace inspection commands", () => {
    expect(checkSafeCommand("pwd", defaults).ok).toBe(true);
    expect(checkSafeCommand("ls", defaults).ok).toBe(true);
    expect(checkSafeCommand("ls -la src/chat", defaults).ok).toBe(true);
    expect(checkSafeCommand("ls src/hooks/", defaults).ok).toBe(true);
    expect(checkSafeCommand("ls coala-utils/tests/", defaults).ok).toBe(true);
    expect(checkSafeCommand("ls -F", defaults).ok).toBe(true);
    expect(checkSafeCommand("ls -F coala-utils/tests/", defaults).ok).toBe(true);
    expect(checkSafeCommand("ls -laF src/chat/", defaults).ok).toBe(true);
    expect(checkSafeCommand("cat src/chat/storage.ts", defaults).ok).toBe(true);
    expect(checkSafeCommand("grep TODO src/chat/storage.ts", defaults).ok).toBe(true);
    expect(checkSafeCommand("grep -n safeCommands package.json", defaults).ok).toBe(true);
    expect(checkSafeCommand("grep -R TODO src", defaults).ok).toBe(true);
    expect(checkSafeCommand("grep -r \"safeCommands\" src", defaults).ok).toBe(true);
    expect(checkSafeCommand("grep -rl \"safeCommands\" src", defaults).ok).toBe(true);
    expect(checkSafeCommand("grep -r 'safe command' .", defaults).ok).toBe(true);
    expect(checkSafeCommand("find . -maxdepth 2 -type f", defaults).ok).toBe(true);
    expect(checkSafeCommand('find . -maxdepth 2 -name "*backup*" -o -name "*.bak" -o -name "*.bak2"', defaults).ok).toBe(true);
    expect(checkSafeCommand("git status", defaults).ok).toBe(true);
    expect(checkSafeCommand("git diff", defaults).ok).toBe(true);
  });

  it("keeps the packaged ls pattern synchronized and migrates only old defaults", () => {
    expect(defaults[1].match).toBe(DEFAULT_LS_COMMAND_PATTERN);
    const old = "ls(?: -(?:l|a|la|al))?(?: (?:\\.|(?:\\.[A-Za-z0-9][A-Za-z0-9._-]*|[A-Za-z0-9][A-Za-z0-9._-]*)(?:/(?:\\.[A-Za-z0-9][A-Za-z0-9._-]*|[A-Za-z0-9][A-Za-z0-9._-]*))*))?";
    expect(migrateLegacyDefaultSafeCommands([{ match: old, description: "old default" }])?.[0].match)
      .toBe(DEFAULT_LS_COMMAND_PATTERN);
    expect(migrateLegacyDefaultSafeCommands([{ match: "ls custom", description: "mine" }]))
      .toBeUndefined();
  });

  it("allows simple relative mkdir commands", () => {
    expect(checkSafeCommand("mkdir tmp", defaults).ok).toBe(true);
    expect(checkSafeCommand("mkdir -p tmp/nested", defaults).ok).toBe(true);
    expect(checkSafeCommand("mkdir one two three/nested", defaults).ok).toBe(true);
    expect(checkSafeCommand("mkdir -p one two three/nested", defaults).ok).toBe(true);
    expect(checkSafeCommand(`mkdir ${Array.from({ length: 16 }, (_, i) => `dir${i}`).join(" ")}`, defaults).ok).toBe(true);
    expect(checkSafeCommand(`mkdir ${Array.from({ length: 17 }, (_, i) => `dir${i}`).join(" ")}`, defaults).ok).toBe(false);
  });

  it("keeps the packaged mkdir pattern synchronized and migrates its old default", () => {
    const packaged = defaults.find(entry => entry.description?.startsWith("Create up to sixteen directories"));
    expect(packaged?.match).toBe(DEFAULT_MKDIR_COMMAND_PATTERN);
    const old = "mkdir(?: -p)? (?:\\.[A-Za-z0-9][A-Za-z0-9._-]*|[A-Za-z0-9][A-Za-z0-9._-]*)(?:/(?:\\.[A-Za-z0-9][A-Za-z0-9._-]*|[A-Za-z0-9][A-Za-z0-9._-]*))*";
    expect(migrateLegacyDefaultSafeCommands([{ match: old, description: "old default" }])?.[0].match)
      .toBe(DEFAULT_MKDIR_COMMAND_PATTERN);
  });

  it("allows standard read-only git inspection commands", () => {
    const commands = [
      "git status --short --branch",
      "git diff --cached --stat",
      "git diff HEAD~1 -- src/app.ts",
      "git log -10 --oneline --graph --all",
      "git show --stat HEAD",
      "git shortlog -10",
      "git reflog -10",
      "git branch --list",
      "git tag --list v*",
      "git show-ref --heads --tags",
      "git for-each-ref refs/heads",
      "git remote -v",
      "git rev-parse --show-toplevel",
      "git rev-list --max-count=5 HEAD",
      "git describe --tags HEAD",
      "git ls-files -- src",
      "git ls-tree -r HEAD",
      "git cat-file -p HEAD",
      "git blame -w src/app.ts",
      "git grep -n TODO -- src",
      "git stash list",
      "git stash show -p stash@{0}",
      "git worktree list",
      "git submodule status",
      "git merge-base --is-ancestor main HEAD"
    ];
    for (const command of commands) expect(checkSafeCommand(command, defaults).ok, command).toBe(true);
  });

  it("still rejects mutating git commands and write-capable inspection flags", () => {
    const commands = [
      "git add .",
      "git commit -m test",
      "git reset --hard",
      "git checkout main",
      "git switch main",
      "git branch -D old",
      "git tag -d v1",
      "git remote remove origin",
      "git stash pop",
      "git worktree remove tmp",
      "git submodule update",
      "git diff --output=changes.patch",
      "git diff --ext-diff",
      "git log --output=history.txt"
    ];
    for (const command of commands) expect(checkSafeCommand(command, defaults).ok, command).toBe(false);
  });

  it("allows simple relative mv commands", () => {
    expect(checkSafeCommand("mv tmp/a.txt tmp/b.txt", defaults).ok).toBe(true);
    expect(checkSafeCommand("mv src/old src/new", defaults).ok).toBe(true);
  });

  it("allows simple relative cp commands", () => {
    expect(checkSafeCommand("cp tmp/a.txt tmp/b.txt", defaults).ok).toBe(true);
    expect(checkSafeCommand("cp src/source src/copy", defaults).ok).toBe(true);
  });

  it("allows plain removal of simple non-hidden relative workspace paths", () => {
    expect(checkSafeCommand("rm src/hooks/useGameLoop.ts.backup.bak src/hooks/useGameLoop.ts.bak2", defaults).ok).toBe(true);
    expect(checkSafeCommand("rm tmp/generated.txt", defaults).ok).toBe(true);
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
    expect(checkSafeCommand("ls -R src", defaults).ok).toBe(false);
    expect(checkSafeCommand("mkdir tmp && cat package.json", defaults).ok).toBe(false);
    expect(checkSafeCommand("mkdir tmp ../outside", defaults).ok).toBe(false);
    expect(checkSafeCommand("mkdir tmp /tmp/outside", defaults).ok).toBe(false);
    expect(checkSafeCommand("mv ../a b", defaults).ok).toBe(false);
    expect(checkSafeCommand("mv src/a /tmp/b", defaults).ok).toBe(false);
    expect(checkSafeCommand("mv src/a src/b; cat package.json", defaults).ok).toBe(false);
    expect(checkSafeCommand("cp ../a b", defaults).ok).toBe(false);
    expect(checkSafeCommand("cp src/a /tmp/b", defaults).ok).toBe(false);
    expect(checkSafeCommand("cp src/a src/b; cat package.json", defaults).ok).toBe(false);
    expect(checkSafeCommand("rm -rf src", defaults).ok).toBe(false);
    expect(checkSafeCommand("rm .git/config", defaults).ok).toBe(false);
    expect(checkSafeCommand("rm ../package.json", defaults).ok).toBe(false);
    expect(checkSafeCommand("rm /tmp/file", defaults).ok).toBe(false);
    expect(checkSafeCommand("rm src/a; cat package.json", defaults).ok).toBe(false);
    expect(checkSafeCommand("find / -maxdepth 2 -type f", defaults).ok).toBe(false);
    expect(checkSafeCommand("find . -maxdepth 2 -name *backup*", defaults).ok).toBe(false);
    expect(checkSafeCommand('find . -maxdepth 2 -name "*.bak" -exec rm {} \\;', defaults).ok).toBe(false);
  });
});
