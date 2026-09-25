import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { HarnessSettings } from "../src/config/settings.js";
import { authorizeCommand } from "../src/features/commands/safeList/policy.js";
import { DEFAULT_SAFE_PATTERNS } from "../src/features/commands/safeList/defaults.js";
import { prepareCommand, parseCommand } from "../src/features/commands/safeList/commandSyntax.js";
import { checkedPatterns, matchesSafeList } from "../src/features/commands/safeList/regex.js";
import { CommandRuntime } from "../src/features/commands/shared/runtime.js";
import { startProcess } from "../src/features/commands/shared/process.js";

let root: string;
const settings = (patterns: unknown = DEFAULT_SAFE_PATTERNS) => ({ safeCommandPatterns: patterns } as HarnessSettings);
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "llh-safe-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("safe command syntax and policy", () => {
  it("uses identical lossless candidates for native and legacy commands", () => {
    const legacy = prepareCommand("run_command", { command: "grep 'a b' 'file name.txt'" });
    const native = prepareCommand("run_process", { program: "grep", args: ["a b", "file name.txt"] });
    expect(legacy).toEqual(native);
    expect(parseCommand(native.display)).toEqual(["grep", "a b", "file name.txt"]);
    expect(prepareCommand("run_process", { program: "echo", args: ["it's", "", "$(literal)"] }).display)
      .toBe("echo 'it'\"'\"'s' '' '$(literal)'");
  });

  it.each(["git status; rm a", "git status && rm a", "echo $(id)", "echo `id`", "echo x > a", "grep a *", "A=b git status", "git status\nrm a"])("rejects shell syntax: %s", command => {
    expect(() => prepareCommand("run_command", { command })).toThrow();
  });

  it("does not turn punctuation inside quoted arguments into operators", () => {
    expect(parseCommand("grep 'x;y|z' a.txt")).toEqual(["grep", "x;y|z", "a.txt"]);
  });

  it("requires a whole-command match and fails closed on empty/invalid lists", async () => {
    expect(await matchesSafeList(checkedPatterns(["git status"]), "git status extra")).toBe(false);
    expect(await matchesSafeList(checkedPatterns([]), "git status")).toBe(false);
    expect(() => checkedPatterns(["["])).toThrow("Invalid");
    expect(() => checkedPatterns(null)).toThrow();
    await expect(authorizeCommand("run_command", { command: "mkdir foo" }, root, settings([]))).rejects.toThrow("does not match");
    await expect(authorizeCommand("run_command", { command: "rm a -rf b" }, root, settings())).rejects.toThrow("does not match");
  });

  it("terminates pathological regex matching instead of blocking the host", async () => {
    await expect(matchesSafeList(["(a+)+"], "a".repeat(100) + "!")).rejects.toThrow("timed out");
  });

  it("permits creation and deletion inside the workspace", async () => {
    for (const command of ["mkdir 'a folder'", "rmdir 'a folder'"]) {
      const prepared = await authorizeCommand("run_command", { command }, root, settings());
      const result = await startProcess(prepared.executable, prepared.args, root, undefined, undefined, prepared.env).result;
      expect(result.exitCode).toBe(0);
    }
    await fs.writeFile(path.join(root, "a.txt"), "fixture");
    const prepared = await authorizeCommand("run_process", { program: "rm", args: ["a.txt"] }, root, settings());
    expect((await startProcess(prepared.executable, prepared.args, root).result).exitCode).toBe(0);
    await expect(fs.stat(path.join(root, "a.txt"))).rejects.toThrow();
  });

  it.each(["/", "..", ".", ".git", "../outside"])("denies deleting protected/outside target %s despite a matching regex", async target => {
    await expect(authorizeCommand("run_process", { program: "rm", args: ["-rf", target] }, root, settings(["rm .*"]))).rejects.toThrow();
  });

  it("rejects symlink escapes and recursive deletion containing Git metadata", async () => {
    await fs.symlink(os.tmpdir(), path.join(root, "outside"));
    await expect(authorizeCommand("run_command", { command: "rm outside" }, root, settings())).rejects.toThrow("outside the workspace");
    await fs.mkdir(path.join(root, "nested/.git"), { recursive: true });
    await expect(authorizeCommand("run_process", { program: "rm", args: ["-r", "nested"] }, root, settings(["rm .*"]))).rejects.toThrow("Git metadata");
  });

  it.each(["git branch new-branch", "git branch -- new-branch", "git diff --output=../file", "git -c alias.x=!id x", "git push", "sudo rm a", "sudo.exe rm a", "RUNAS.COM rm a"])("retains built-in restrictions even with a broad user pattern: %s", async command => {
    await expect(authorizeCommand("run_command", { command }, root, settings([".*"]))).rejects.toThrow();
  });

  it("hardens accepted Git calls against helpers, parent discovery and fetching", async () => {
    await fs.mkdir(path.join(root, ".git"));
    const prepared = await authorizeCommand("run_command", { command: "git diff --cached" }, root, settings());
    expect(prepared.args).toContain(`--git-dir=${path.join(root, ".git")}`);
    expect(prepared.args).toContain("--no-ext-diff");
    expect(prepared.args).toContain("--no-textconv");
    expect(prepared.args).toContain("protocol.allow=never");
    expect(prepared.env.GIT_NO_LAZY_FETCH).toBe("1");
    expect(prepared.env.GIT_ALLOW_PROTOCOL).toBe("");
  });

  it("checks metadata directories too when validating recursive search containment", async () => {
    await fs.mkdir(path.join(root, ".git"));
    await fs.symlink(os.tmpdir(), path.join(root, ".git", "outside"));
    await expect(authorizeCommand("run_command", { command: "grep -r needle ." }, root, settings())).rejects.toThrow("outside the workspace");
  });

  it("treats every matching command identically for approval", () => {
    const runtime = new CommandRuntime({ workspaceRoot: root, emit() {}, async appendResult() {} }, {
      async prepare() {}, async launch() { throw new Error("unused"); }, autoapprove: value => value.autoapproveSafeCommands === true
    });
    expect(runtime.needsApproval(settings())).toBe(true);
    expect(runtime.needsApproval({ ...settings(), autoapproveSafeCommands: true })).toBe(false);
    expect(runtime.category("run_command")).toBe("command");
    expect(runtime.category("run_process")).toBe("command");
  });
});
