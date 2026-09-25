import * as fs from "node:fs/promises";
import * as path from "node:path";
import { constants } from "node:fs";
import { assertInsideWorkspace } from "../../../tools/workspaceGuard.js";
import { processEnvironment } from "../shared/process.js";
import { checkedPatterns, matchesSafeList } from "./regex.js";
import { prepareCommand } from "./commandSyntax.js";
import type { HarnessSettings } from "../../../config/settings.js";

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function executable(program: string, root: string): Promise<string> {
  const rootReal = await fs.realpath(root);
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(entry)) continue;
    for (const suffix of process.platform === "win32" ? [".exe", ".com", ""] : [""]) {
      try {
        const candidate = await fs.realpath(path.join(entry, program + suffix));
        if (inside(rootReal, candidate) || !(await fs.stat(candidate)).isFile()) continue;
        if (process.platform === "win32" && !/\.(exe|com)$/i.test(candidate)) continue;
        await fs.access(candidate, constants.X_OK);
        return candidate;
      } catch { /* try the next trusted PATH entry */ }
    }
  }
  throw new Error(`Executable ${program} was not found outside the workspace in an absolute PATH entry.`);
}

async function checkedPath(root: string, value: string, mutation = false): Promise<string> {
  if (!value || value === "-" || /[\0\r\n]/.test(value)) throw new Error("Use an explicit workspace path.");
  const absolute = await assertInsideWorkspace(root, value);
  if (mutation) {
    const relative = path.relative(await fs.realpath(root), absolute);
    if (!relative || relative.split(path.sep).some(part => part.toLowerCase() === ".git")) {
      throw new Error("The workspace root and Git metadata are protected.");
    }
  }
  return absolute;
}

async function checkTree(root: string, absolute: string, budget: { remaining: number }): Promise<void> {
  if (--budget.remaining < 0) throw new Error("Directory traversal exceeds the Safe list limit.");
  const resolved = await assertInsideWorkspace(root, absolute);
  const stat = await fs.lstat(absolute);
  if (stat.isSymbolicLink()) throw new Error("Recursive commands cannot traverse symbolic links.");
  if (!stat.isDirectory() && !stat.isFile()) throw new Error("Special filesystem entries are unavailable in Safe list.");
  if (stat.isDirectory()) for (const entry of await fs.readdir(resolved)) {
    if (entry.toLowerCase() === ".git") throw new Error("Recursive operations cannot include Git metadata.");
    await checkTree(root, path.join(resolved, entry), budget);
  }
}

function operands(args: string[], permitted: RegExp): string[] {
  const paths: string[] = [];
  let literal = false;
  for (const arg of args) {
    if (!literal && arg === "--") { literal = true; continue; }
    if (!literal && arg.startsWith("-")) {
      if (!permitted.test(arg)) throw new Error(`Unsupported option ${arg} for this built-in safe command.`);
    } else paths.push(arg);
  }
  return paths;
}

async function constrainBuiltin(program: string, args: string[], root: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const name = program.replace(/\.exe$/i, "").toLowerCase();
  const optionsEnd = args.indexOf("--");
  const optionArgs = optionsEnd < 0 ? args : args.slice(0, optionsEnd);
  if (["rm", "rmdir", "mkdir"].includes(name)) {
    const values = operands(args, name === "rm" ? /^-[rRfiv]+$|^--(?:recursive|force|verbose)$/ : name === "mkdir" ? /^-p$|^--parents$/ : /^-v$|^--verbose$/);
    if (!values.length) throw new Error("At least one workspace path is required.");
    const recursive = name === "rm" && optionArgs.some(arg => arg === "--recursive" || /^-[rRfiv]*[rR]/.test(arg));
    for (const value of values) {
      const absolute = await checkedPath(root, value, true);
      if (recursive) await checkTree(root, absolute, { remaining: 10000 });
    }
  } else if (name === "grep" || name === "rg") {
    const values = operands(args, /^-[nivlcEFHhr]+$|^--(?:line-number|ignore-case|files|hidden)$/);
    const filesOnly = name === "rg" && optionArgs.includes("--files");
    if (!filesOnly && !values.length) throw new Error("A search pattern is required.");
    const paths = filesOnly ? values : values.slice(1);
    const recursive = name === "rg" || optionArgs.some(arg => /^-[nivlcEFHhr]*r/.test(arg));
    if (!paths.length && !recursive) throw new Error("Specify a workspace file path.");
    for (const value of paths.length ? paths : ["."]) {
      const absolute = await checkedPath(root, value);
      if (recursive) await checkSearchTree(root, absolute, { remaining: 10000 });
      else if (!(await fs.stat(absolute)).isFile()) throw new Error("Search input must be a regular file.");
    }
  } else if (name === "git") {
    const [subcommand, ...rest] = args;
    const options: Record<string, RegExp> = {
      status: /^--short$|^--porcelain(?:=v1)?$|^-sb$/,
      diff: /^--(?:cached|staged|stat|name-only|name-status|no-color)$/,
      log: /^--oneline$|^-\d+$/,
      show: /^--stat$|^--no-color$/,
      "ls-files": /^--(?:cached|modified|deleted)$/,
      branch: /^-[ar]$|^--list$/
    };
    if (!options[subcommand]) throw new Error("Only the built-in read-only Git subcommands are available.");
    let pathspec = false;
    for (const arg of rest) {
      if (arg === "--") { pathspec = true; continue; }
      if (pathspec) {
        if (subcommand === "branch") throw new Error("Only branch listing without branch-name operands is available.");
        await checkedPath(root, arg); continue;
      }
      if (arg.startsWith("-")) {
        if (!options[subcommand].test(arg)) throw new Error(`Unsupported Git option: ${arg}`);
      } else if (subcommand === "show" && /^[A-Za-z0-9_./~^:-]+$/.test(arg)) {
        const colon = arg.indexOf(":");
        if (colon >= 0) await checkedPath(root, arg.slice(colon + 1));
      } else throw new Error("Use -- before explicit Git workspace paths; branch creation and arbitrary revision options are unavailable.");
    }
    // An explicit local repository prevents parent discovery and configured worktree escape.
    const gitDirectory = await checkedPath(root, ".git");
    if (!(await fs.stat(gitDirectory)).isDirectory()) throw new Error("Safe Git requires a .git directory inside the workspace; linked worktrees are not supported.");
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1", GIT_PAGER: "cat" });
    return ["--no-pager", `--git-dir=${gitDirectory}`, `--work-tree=${root}`,
      "-c", "protocol.allow=never", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
      "-c", "core.pager=cat", "-c", "diff.external=", subcommand,
      ...(["diff", "log", "show"].includes(subcommand) ? ["--no-ext-diff", "--no-textconv"] : []), ...rest];
  }
  return args;
}

async function checkSearchTree(root: string, target: string, budget: { remaining: number }): Promise<void> {
  if (--budget.remaining < 0) throw new Error("Search traversal exceeds the Safe list limit; specify a narrower path.");
  const absolute = await assertInsideWorkspace(root, target);
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink()) throw new Error("Recursive searches cannot traverse symbolic links.");
  if (stat.isDirectory()) {
    for (const entry of await fs.readdir(absolute)) {
      await checkSearchTree(root, path.join(absolute, entry), budget);
    }
  } else if (!stat.isFile()) throw new Error("Search input must be regular files.");
}

export async function authorizeCommand(name: string, input: Record<string, unknown>, root: string, settings: HarnessSettings) {
  const prepared = prepareCommand(name, input);
  if (!await matchesSafeList(checkedPatterns(settings.safeCommandPatterns), prepared.display)) {
    throw new Error(`Command does not match the configured safe list: ${prepared.display}. Use a matching command; only the user can edit the safe list.`);
  }
  const env = processEnvironment();
  // Prevent implicit startup/configuration hooks from changing an approved invocation.
  for (const key of Object.keys(env)) {
    if (/^(?:LD_|DYLD_)/.test(key) || ["RIPGREP_CONFIG_PATH", "GREP_OPTIONS", "BASH_ENV", "ENV", "NODE_OPTIONS", "PYTHONSTARTUP"].includes(key)) delete env[key];
  }
  const args = await constrainBuiltin(prepared.program, prepared.args, root, env);
  return { ...prepared, args, executable: await executable(prepared.program, root), env };
}
