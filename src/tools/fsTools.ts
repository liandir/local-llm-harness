import * as fs from "node:fs/promises";
import * as path from "node:path";
import { assertInsideWorkspace } from "./workspaceGuard.js";

const MAX_READ_BYTES = 1024 * 1024; // 1 MiB cap on returned content
const MAX_RANGE_SOURCE_BYTES = 8 * 1024 * 1024; // files we are willing to load to slice a range from
const DEFAULT_GLOB_MAX_RESULTS = 200;
const MAX_GLOB_RESULTS = 1000;

export interface FsToolContext {
  workspaceRoot: string;
}

export interface ReadFileArgs {
  path: string;
  /** Optional 1-based first line to read (inclusive). */
  startLine?: number;
  /** Optional 1-based last line to read (inclusive); clamped to the file end. */
  endLine?: number;
}

export interface ReadFileResult {
  /** The requested slice, exactly as stored on disk. */
  content: string;
  /** Real 1-based line number of the first line in `content`. */
  startLine: number;
  /** Real 1-based line number of the last line in `content` (0 for an empty file). */
  endLine: number;
  totalLines: number;
}

/**
 * Read a whole file or a 1-based inclusive line range. Lines are addressed
 * with the same line model as insert_text / replace_range, so the numbers
 * reported here are exactly the numbers those tools expect back.
 */
export async function readFile(ctx: FsToolContext, args: ReadFileArgs): Promise<ReadFileResult> {
  const abs = await assertInsideWorkspace(ctx.workspaceRoot, args.path);
  const stat = await fs.stat(abs);
  if (!stat.isFile()) throw new Error(`Not a file: ${args.path}`);
  const ranged = args.startLine !== undefined || args.endLine !== undefined;
  if (!ranged && stat.size > MAX_READ_BYTES) {
    throw new Error(
      `File too large (${stat.size} bytes; max ${MAX_READ_BYTES}). Pass startLine/endLine to read a smaller range.`
    );
  }
  if (ranged && stat.size > MAX_RANGE_SOURCE_BYTES) {
    throw new Error(`File too large to read (${stat.size} bytes; max ${MAX_RANGE_SOURCE_BYTES} even for range reads).`);
  }
  const full = await fs.readFile(abs, "utf-8");
  const totalLines = countLogicalLines(full);
  if (!ranged) {
    return { content: full, startLine: totalLines === 0 ? 0 : 1, endLine: totalLines, totalLines };
  }

  const start = args.startLine ?? 1;
  const requestedEnd = args.endLine ?? totalLines;
  if (!Number.isInteger(start) || start < 1) {
    throw new Error(`read_file startLine must be an integer ≥ 1; received ${args.startLine}.`);
  }
  // Check past-EOF before the end ≥ start rule: with endLine omitted the end
  // defaults to totalLines, and a start past EOF would otherwise surface as a
  // baffling "endLine ≥ startLine; received undefined" error.
  if (start > totalLines) {
    throw new Error(
      `read_file range starts past the end of ${args.path}: the file has ${totalLines} line${totalLines === 1 ? "" : "s"}, requested startLine ${start}.`
    );
  }
  if (!Number.isInteger(requestedEnd) || requestedEnd < start) {
    throw new Error(`read_file endLine must be an integer ≥ startLine (${start}); received ${args.endLine}.`);
  }
  const end = Math.min(requestedEnd, totalLines);
  const content = full.slice(offsetBeforeLine(full, start), offsetAfterLine(full, end));
  if (Buffer.byteLength(content, "utf-8") > MAX_READ_BYTES) {
    throw new Error(
      `Requested range ${start}-${end} is too large (max ${MAX_READ_BYTES} bytes of content). Read a smaller range.`
    );
  }
  return { content, startLine: start, endLine: end, totalLines };
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

export interface InsertTextArgs {
  path: string;
  line: number;
  text: string;
}

export interface ReplaceRangeArgs {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface TextEditResult {
  bytesWritten: number;
  previous: string;
  next: string;
}

export async function insertText(
  ctx: FsToolContext,
  args: InsertTextArgs
): Promise<TextEditResult> {
  const abs = await assertInsideWorkspace(ctx.workspaceRoot, args.path);
  const previous = await readEditableTextFile(abs);
  const lineCount = countLogicalLines(previous);
  if (!Number.isInteger(args.line) || args.line < 1 || args.line > lineCount + 1) {
    throw new Error(`insert_text line must be between 1 and ${lineCount + 1}; received ${args.line}.`);
  }
  const offset = offsetBeforeLine(previous, args.line);
  const next = previous.slice(0, offset) + args.text + previous.slice(offset);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, next, "utf-8");
  return { bytesWritten: Buffer.byteLength(args.text, "utf-8"), previous, next };
}

export async function replaceRange(
  ctx: FsToolContext,
  args: ReplaceRangeArgs
): Promise<TextEditResult> {
  const abs = await assertInsideWorkspace(ctx.workspaceRoot, args.path);
  const previous = await readEditableTextFile(abs);
  const lineCount = countLogicalLines(previous);
  if (!Number.isInteger(args.startLine) || !Number.isInteger(args.endLine)) {
    throw new Error(`replace_range startLine and endLine must be integers.`);
  }
  if (args.startLine < 1 || args.endLine < args.startLine || args.endLine > lineCount) {
    throw new Error(`replace_range must target lines 1-${lineCount}; received ${args.startLine}-${args.endLine}.`);
  }
  const start = offsetBeforeLine(previous, args.startLine);
  const end = offsetAfterLine(previous, args.endLine);
  const next = previous.slice(0, start) + args.content + previous.slice(end);
  await fs.writeFile(abs, next, "utf-8");
  return { bytesWritten: Buffer.byteLength(args.content, "utf-8"), previous, next };
}

async function readEditableTextFile(abs: string): Promise<string> {
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) throw new Error(`Not a file: ${abs}`);
    return fs.readFile(abs, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

export function countLogicalLines(text: string): number {
  if (text.length === 0) return 0;
  const starts = lineStartOffsets(text);
  return endsWithLineBreak(text) ? Math.max(0, starts.length - 1) : starts.length;
}

function offsetBeforeLine(text: string, line: number): number {
  const lineCount = countLogicalLines(text);
  if (line === lineCount + 1) return text.length;
  return lineStartOffsets(text)[line - 1] ?? text.length;
}

function offsetAfterLine(text: string, line: number): number {
  const lineCount = countLogicalLines(text);
  if (line >= lineCount) return text.length;
  return lineStartOffsets(text)[line] ?? text.length;
}

function lineStartOffsets(text: string): number[] {
  const starts = [0];
  const re = /\r\n|\n|\r/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    starts.push(match.index + match[0].length);
  }
  return starts;
}

function endsWithLineBreak(text: string): boolean {
  return text.endsWith("\n") || text.endsWith("\r");
}

/**
 * Prefix every line with its 1-based number and a tab, e.g. `12\tconst x = 1;`.
 *
 * The line-addressed edit tools (insert_text, replace_range) require the model
 * to name lines by number, but raw file content carries no numbers — leaving
 * the model to count by eye, which it gets wrong on anything but tiny files and
 * lands edits on the wrong line. This formats read_file output so the model
 * reads the exact number it must pass back.
 *
 * For a range read, pass `firstLineNumber` so the numbers shown are the lines'
 * REAL positions in the file — numbering a slice from 1 would make the model
 * edit the wrong lines.
 *
 * Numbering is derived from the same line model as the edit tools
 * (countLogicalLines / lineStartOffsets), so a number shown here is always the
 * number those tools expect. The trailing line break of each line is stripped;
 * the number/tab prefix is presentational and is not part of the file.
 */
export function formatFileForModel(content: string, firstLineNumber = 1): string {
  const count = countLogicalLines(content);
  if (count === 0) return "";
  const starts = lineStartOffsets(content);
  const width = String(firstLineNumber + count - 1).length;
  const lines: string[] = [];
  for (let line = 1; line <= count; line++) {
    const begin = starts[line - 1];
    const end = line < starts.length ? starts[line] : content.length;
    const text = content.slice(begin, end).replace(/(\r\n|\r|\n)$/, "");
    lines.push(`${String(firstLineNumber + line - 1).padStart(width, " ")}\t${text}`);
  }
  return lines.join("\n");
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
  const max = normalizeGlobMaxResults(args.maxResults);
  const results: string[] = [];
  const re = globToRegex(args.pattern);
  await walk(ctx.workspaceRoot, ctx.workspaceRoot, re, results, max);
  return results;
}

function normalizeGlobMaxResults(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_GLOB_MAX_RESULTS;
  }
  return Math.min(MAX_GLOB_RESULTS, Math.max(1, Math.floor(value)));
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
