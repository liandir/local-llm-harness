import * as fs from "node:fs/promises";
import * as path from "node:path";
import { assertInsideWorkspace } from "./workspaceGuard.js";

const MAX_READ_BYTES = 1024 * 1024; // 1 MiB

export interface FsToolContext {
  workspaceRoot: string;
}

export async function readFile(ctx: FsToolContext, args: { path: string }): Promise<string> {
  const abs = await assertInsideWorkspace(ctx.workspaceRoot, args.path);
  const stat = await fs.stat(abs);
  if (!stat.isFile()) throw new Error(`Not a file: ${args.path}`);
  if (stat.size > MAX_READ_BYTES) {
    throw new Error(`File too large (${stat.size} bytes; max ${MAX_READ_BYTES}).`);
  }
  return fs.readFile(abs, "utf-8");
}

export async function writeFile(
  ctx: FsToolContext,
  args: { path: string; content: string }
): Promise<{ bytesWritten: number }> {
  const abs = await assertInsideWorkspace(ctx.workspaceRoot, args.path);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, args.content, "utf-8");
  return { bytesWritten: Buffer.byteLength(args.content, "utf-8") };
}

export interface DirEntry {
  name: string;
  type: "file" | "dir" | "other";
}

export async function listDir(
  ctx: FsToolContext,
  args: { path: string }
): Promise<DirEntry[]> {
  const abs = await assertInsideWorkspace(ctx.workspaceRoot, args.path);
  const entries = await fs.readdir(abs, { withFileTypes: true });
  return entries.map(e => ({
    name: e.name,
    type: e.isDirectory() ? "dir" : e.isFile() ? "file" : "other"
  }));
}

export async function glob(
  ctx: FsToolContext,
  args: { pattern: string; maxResults?: number }
): Promise<string[]> {
  const max = args.maxResults ?? 200;
  const results: string[] = [];
  const re = globToRegex(args.pattern);
  await walk(ctx.workspaceRoot, ctx.workspaceRoot, re, results, max);
  return results;
}

async function walk(
  root: string,
  dir: string,
  re: RegExp,
  out: string[],
  max: number
): Promise<void> {
  if (out.length >= max) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= max) return;
    if (e.name === ".git" || e.name === "node_modules") continue;
    const abs = path.join(dir, e.name);
    const rel = path.relative(root, abs);
    if (e.isDirectory()) {
      await walk(root, abs, re, out, max);
    } else if (e.isFile() && re.test(rel)) {
      out.push(rel);
    }
  }
}

function globToRegex(pattern: string): RegExp {
  // Minimal glob: ** = any path, * = anything but /, ? = single char.
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i += 2;
        if (pattern[i] === "/") i++;
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (".+^$()|{}[]\\".includes(c)) {
      re += "\\" + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp("^" + re + "$");
}
