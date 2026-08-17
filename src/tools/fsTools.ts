import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
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
  /** Revision of the complete file, even when only a range was returned. */
  revision: string;
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
  const revision = textRevision(full);
  const totalLines = countLogicalLines(full);
  if (!ranged) {
    return { content: full, startLine: totalLines === 0 ? 0 : 1, endLine: totalLines, totalLines, revision };
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
  return { content, startLine: start, endLine: end, totalLines, revision };
}

export async function createFile(
  ctx: FsToolContext,
  args: { path: string; content: string }
): Promise<{ bytesWritten: number }> {
  const abs = await assertInsideWorkspace(ctx.workspaceRoot, args.path);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, args.content, { encoding: "utf-8", flag: "wx" });
  return { bytesWritten: Buffer.byteLength(args.content, "utf-8") };
}

export interface ExactTextEdit {
  oldText: string;
  newText: string;
}

export async function editFile(
  ctx: FsToolContext,
  args: { path: string; baseRevision: string; edits: ExactTextEdit[] }
): Promise<TextEditResult> {
  const { abs, previous, next } = await prepareEditFile(ctx, args);
  await fs.writeFile(abs, next, "utf-8");
  return { bytesWritten: Buffer.byteLength(next, "utf-8"), previous, next };
}

export async function previewEditFile(
  ctx: FsToolContext,
  args: { path: string; baseRevision: string; edits: ExactTextEdit[] }
): Promise<{ previous: string; next: string }> {
  const { previous, next } = await prepareEditFile(ctx, args);
  return { previous, next };
}

async function prepareEditFile(
  ctx: FsToolContext,
  args: { path: string; baseRevision: string; edits: ExactTextEdit[] }
): Promise<{ abs: string; previous: string; next: string }> {
  const abs = await assertInsideWorkspace(ctx.workspaceRoot, args.path);
  const previous = await readEditableTextFile(abs);
  const actualRevision = textRevision(previous);
  if (args.baseRevision !== actualRevision) {
    throw new Error(
      `edit_file revision mismatch for ${args.path}: expected ${args.baseRevision}, current revision is ${actualRevision}. ` +
      `Nothing was written; re-read the file and retry.`
    );
  }
  if (!Array.isArray(args.edits) || args.edits.length === 0) {
    throw new Error("edit_file requires at least one text edit.");
  }
  let next = previous;
  for (let index = 0; index < args.edits.length; index++) {
    const edit = args.edits[index];
    if (!edit || typeof edit.oldText !== "string" || edit.oldText.length === 0 || typeof edit.newText !== "string") {
      throw new Error(`edit_file edits[${index}] requires non-empty oldText and string newText.`);
    }
    const first = next.indexOf(edit.oldText);
    if (first === -1) throw new Error(`edit_file edits[${index}].oldText was not found. Nothing was written.`);
    if (next.indexOf(edit.oldText, first + edit.oldText.length) !== -1) {
      throw new Error(`edit_file edits[${index}].oldText is ambiguous because it occurs more than once. Nothing was written.`);
    }
    next = next.slice(0, first) + edit.newText + next.slice(first + edit.oldText.length);
  }
  return { abs, previous, next };
}

function textRevision(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
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
  /** Exact current text of `line`, without its line break; use <EOF> when appending. */
  expectedLine: string;
  text: string;
}

export interface ReplaceRangeArgs {
  path: string;
  startLine: number;
  endLine: number;
  /** Exact current text of the target lines, joined with \n and without display prefixes. */
  expectedContent: string;
  content: string;
}

export interface TextEditResult {
  bytesWritten: number;
  previous: string;
  next: string;
  /** A line break was auto-added before appended text because the file did not end with one. */
  addedLeadingBreak?: boolean;
  /** A line break was auto-added after the edit text so the following line stays separate. */
  addedTrailingBreak?: boolean;
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
  const actualLine = args.line === lineCount + 1 ? "<EOF>" : lineText(previous, args.line);
  if (args.expectedLine !== actualLine) {
    const whitespaceHint = leadingWhitespaceMismatchHint(args.expectedLine, actualLine);
    throw new Error(
      `insert_text precondition failed at ${args.path}:${args.line}: expected the current line to be ` +
      `${JSON.stringify(args.expectedLine)}, but it is ${JSON.stringify(actualLine)}. Nothing was written. ` +
      whitespaceHint +
      `Re-read the file and retry with the current line number and exact expectedLine.`
    );
  }
  // Line-addressed inserts always mean whole lines, so repair the two ways an
  // insert can silently merge with a neighbor:
  //  - appending to a file whose last line has no line break glues onto it;
  //  - text without a trailing break glues the following line onto itself.
  let text = args.text;
  let addedLeadingBreak = false;
  let addedTrailingBreak = false;
  if (text.length > 0) {
    if (
      args.line === lineCount + 1 &&
      previous.length > 0 &&
      !endsWithLineBreak(previous) &&
      !startsWithLineBreak(text)
    ) {
      text = "\n" + text;
      addedLeadingBreak = true;
    }
    if (args.line <= lineCount && !endsWithLineBreak(text)) {
      text = text + "\n";
      addedTrailingBreak = true;
    }
  }
  const offset = offsetBeforeLine(previous, args.line);
  const next = previous.slice(0, offset) + text + previous.slice(offset);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, next, "utf-8");
  return { bytesWritten: Buffer.byteLength(text, "utf-8"), previous, next, addedLeadingBreak, addedTrailingBreak };
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
  const actualContent = rangeText(previous, args.startLine, args.endLine);
  if (normalizeLineBreaks(args.expectedContent) !== normalizeLineBreaks(actualContent)) {
    const mismatchHint = rangeContentMismatchHint(args.expectedContent, actualContent);
    throw new Error(
      `replace_range precondition failed at ${args.path}:${args.startLine}-${args.endLine}: ` +
      `expectedContent does not match the current file. Nothing was written. ` +
      `${mismatchHint}Current target text is ${quotedPreview(actualContent)}. Re-read the file and retry with matching ` +
      `startLine, endLine, and expectedContent.`
    );
  }
  // replace_range consumes endLine's line break, so replacement content that
  // does not end with a break would glue the following line onto its last line
  // — virtually never intended (joining lines is done by spanning them in the
  // range). Add the missing break when more lines follow.
  let content = args.content;
  let addedTrailingBreak = false;
  if (content.length > 0 && args.endLine < lineCount && !endsWithLineBreak(content)) {
    content = content + "\n";
    addedTrailingBreak = true;
  }
  const start = offsetBeforeLine(previous, args.startLine);
  const end = offsetAfterLine(previous, args.endLine);
  const next = previous.slice(0, start) + content + previous.slice(end);
  await fs.writeFile(abs, next, "utf-8");
  return { bytesWritten: Buffer.byteLength(content, "utf-8"), previous, next, addedTrailingBreak };
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

/** Text of one logical line without its terminating CR/LF sequence. */
function lineText(text: string, line: number): string {
  return text
    .slice(offsetBeforeLine(text, line), offsetAfterLine(text, line))
    .replace(/(?:\r\n|\r|\n)$/, "");
}

/** Current target text in the same portable form requested from the model. */
function rangeText(text: string, startLine: number, endLine: number): string {
  const lines: string[] = [];
  for (let line = startLine; line <= endLine; line++) lines.push(lineText(text, line));
  return lines.join("\n");
}

function normalizeLineBreaks(text: string): string {
  return text.replace(/\r\n|\r/g, "\n");
}

/** Give small models an explicit correction when they copied code but dropped indentation. */
function leadingWhitespaceMismatchHint(expected: string, actual: string): string {
  if (expected.trimStart() !== actual.trimStart()) return "";
  const expectedWhitespace = expected.slice(0, expected.length - expected.trimStart().length);
  const actualWhitespace = actual.slice(0, actual.length - actual.trimStart().length);
  if (expectedWhitespace === actualWhitespace) return "";
  return `The non-whitespace text matches, but expectedLine starts with ${describeWhitespace(expectedWhitespace)} ` +
    `while the current line starts with ${describeWhitespace(actualWhitespace)}. ` +
    `Preserve every space or tab after read_file's displayed number-tab prefix. `;
}

function rangeLeadingWhitespaceMismatchHint(expected: string, actual: string): string {
  const expectedLines = normalizeLineBreaks(expected).split("\n");
  const actualLines = normalizeLineBreaks(actual).split("\n");
  if (
    expectedLines.length !== actualLines.length ||
    !expectedLines.every((line, index) => line.trimStart() === actualLines[index].trimStart()) ||
    expectedLines.every((line, index) => line === actualLines[index])
  ) {
    return "";
  }
  return `The non-whitespace text matches, but leading indentation differs. ` +
    `Preserve every space or tab after each read_file number-tab prefix. `;
}

/**
 * Explain the exact-text mismatch in terms a small model can act on. Merely
 * echoing the target is not enough for invisible differences: a model that
 * accidentally supplied a final LF, literal "\\n", or read_file's display
 * prefixes will otherwise keep retrying the same invalid precondition.
 */
function rangeContentMismatchHint(expected: string, actual: string): string {
  const normalizedExpected = normalizeLineBreaks(expected);
  const normalizedActual = normalizeLineBreaks(actual);

  if (normalizedExpected === normalizedActual + "\n") {
    return `Mismatch detail: expectedContent has one extra trailing newline; omit the final line break. `;
  }
  if (normalizedActual === normalizedExpected + "\n") {
    return `Mismatch detail: expectedContent is missing the range's final empty line. `;
  }

  const withoutNumberPrefixes = normalizedExpected
    .split("\n")
    .map(line => line.replace(/^\d+\t/, ""))
    .join("\n");
  if (withoutNumberPrefixes === normalizedActual) {
    return `Mismatch detail: expectedContent includes read_file's display-only line-number and tab prefixes; remove them. `;
  }

  const decodedLineBreaks = normalizedExpected.replace(/\\r\\n|\\n|\\r/g, "\n");
  if (decodedLineBreaks === normalizedActual) {
    return `Mismatch detail: expectedContent contains literal backslash-n line separators instead of newline characters. `;
  }

  const whitespaceHint = rangeLeadingWhitespaceMismatchHint(normalizedExpected, normalizedActual);
  if (whitespaceHint) return `Mismatch detail: ${whitespaceHint}`;

  const expectedLines = normalizedExpected.split("\n").length;
  const actualLines = normalizedActual.split("\n").length;
  const lineCountHint = expectedLines === actualLines
    ? ""
    : ` expectedContent has ${expectedLines} line${expectedLines === 1 ? "" : "s"}; the target has ${actualLines}.`;
  const difference = firstTextDifference(normalizedExpected, normalizedActual);
  return `Mismatch detail:${lineCountHint} First difference is at line ${difference.line}, column ${difference.column}: ` +
    `expectedContent has ${describeCharacter(difference.expected)}, but the target has ${describeCharacter(difference.actual)}. `;
}

function firstTextDifference(expected: string, actual: string): {
  line: number;
  column: number;
  expected: string | undefined;
  actual: string | undefined;
} {
  const limit = Math.min(expected.length, actual.length);
  let index = 0;
  while (index < limit && expected[index] === actual[index]) index++;
  const before = actual.slice(0, index);
  const lastBreak = before.lastIndexOf("\n");
  return {
    line: before.split("\n").length,
    column: index - lastBreak,
    expected: expected[index],
    actual: actual[index]
  };
}

function describeCharacter(char: string | undefined): string {
  if (char === undefined) return "end-of-text";
  if (char === "\n") return "a newline";
  if (char === "\t") return "a tab";
  if (char === " ") return "a space";
  return JSON.stringify(char);
}

function describeWhitespace(value: string): string {
  if (value === "") return "no leading whitespace";
  const spaces = [...value].filter(char => char === " ").length;
  const tabs = [...value].filter(char => char === "\t").length;
  const parts: string[] = [];
  if (spaces > 0) parts.push(`${spaces} space${spaces === 1 ? "" : "s"}`);
  if (tabs > 0) parts.push(`${tabs} tab${tabs === 1 ? "" : "s"}`);
  const other = value.length - spaces - tabs;
  if (other > 0) parts.push(`${other} other whitespace character${other === 1 ? "" : "s"}`);
  return parts.join(" and ");
}

function quotedPreview(text: string): string {
  const limit = 1200;
  return JSON.stringify(text.length <= limit ? text : text.slice(0, limit) + "… [truncated]");
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

function startsWithLineBreak(text: string): boolean {
  return text.startsWith("\n") || text.startsWith("\r");
}

const SNIPPET_CONTEXT_LINES = 3;
const SNIPPET_MAX_LINES = 40;
const SNIPPET_HEAD_LINES = 25;
const SNIPPET_TAIL_LINES = 10;

/**
 * Numbered snippet of the region an edit just changed (plus context lines),
 * for the model-facing tool result. Without this the model never sees the
 * effect of its edit: a mistargeted range goes unnoticed, and line numbers
 * shifted by the edit are only knowable by re-reading. `regionStart` is the
 * 1-based first line of the new content; `regionLineCount` is how many lines
 * it now spans (0 for a pure deletion — the snippet then shows the seam).
 * Very large regions are middle-elided so the result can't blow the context.
 */
export function editRegionSnippet(
  next: string,
  regionStart: number,
  regionLineCount: number
): string {
  const totalLines = countLogicalLines(next);
  if (totalLines === 0) return "(the file is now empty)";
  const regionEnd = regionStart + Math.max(0, regionLineCount - 1);
  const start = Math.max(1, Math.min(regionStart, totalLines) - SNIPPET_CONTEXT_LINES);
  const end = Math.min(totalLines, Math.max(regionStart, regionEnd) + SNIPPET_CONTEXT_LINES);
  if (end - start + 1 <= SNIPPET_MAX_LINES) {
    return formatFileForModel(sliceLines(next, start, end), start);
  }
  const headEnd = start + SNIPPET_HEAD_LINES - 1;
  const tailStart = end - SNIPPET_TAIL_LINES + 1;
  return [
    formatFileForModel(sliceLines(next, start, headEnd), start),
    `[... lines ${headEnd + 1}-${tailStart - 1} of the edited region not shown ...]`,
    formatFileForModel(sliceLines(next, tailStart, end), tailStart)
  ].join("\n");
}

function sliceLines(text: string, startLine: number, endLine: number): string {
  return text.slice(offsetBeforeLine(text, startLine), offsetAfterLine(text, endLine));
}

/**
 * True when edit content looks like read_file output pasted back verbatim,
 * line-number/tab prefixes included — a classic small-model mistake that
 * writes the display prefixes into the file. Deliberately conservative so
 * real data with a leading numeric column (TSV) is not misflagged: every
 * line must carry a `NN<tab>` prefix, the numbers must increase by exactly 1,
 * and there must be a second signal — space-padded numbers (read_file
 * right-aligns them; data files don't) or a first number equal to the line
 * the edit targets.
 */
export function looksLikeNumberedReadOutput(content: string, expectedFirstLine?: number): boolean {
  const lines = content.split(/\r\n|\r|\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length < 2) return false;
  let previous: number | undefined;
  let first: number | undefined;
  let sawPadding = false;
  for (const line of lines) {
    const m = /^( *)(\d{1,7})\t/.exec(line);
    if (!m) return false;
    if (m[1].length > 0) sawPadding = true;
    const n = parseInt(m[2], 10);
    if (first === undefined) first = n;
    if (previous !== undefined && n !== previous + 1) return false;
    previous = n;
  }
  return sawPadding || (expectedFirstLine !== undefined && first === expectedFirstLine);
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
