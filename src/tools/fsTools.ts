import { GuardedWorkspace } from "../security/workspace/index.js";

/**
 * Compatibility facade for the historical file-tool API.
 *
 * Filesystem authority now lives exclusively in `security/workspace`. New
 * orchestration code should depend on `WorkspacePort`; these wrappers remain
 * for existing imports and tests while the session is modularized.
 */
export interface FsToolContext {
  workspaceRoot: string;
  workspace?: GuardedWorkspace;
  signal?: AbortSignal;
}

export interface ReadFileArgs {
  path: string;
  /** Optional 1-based first line to read (inclusive). */
  startLine?: number;
  /** Optional 1-based last line to read (inclusive); clamped to the file end. */
  endLine?: number;
}

export interface ReadFileResult {
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
}

export async function readFile(ctx: FsToolContext, args: ReadFileArgs): Promise<ReadFileResult> {
  return withWorkspace(ctx, (workspace, signal) => workspace.readFile(args, signal));
}

export async function writeFile(
  ctx: FsToolContext,
  args: { path: string; content: string }
): Promise<{ bytesWritten: number }> {
  return withWorkspace(ctx, (workspace, signal) => workspace.writeFile(args.path, args.content, signal));
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
  addedLeadingBreak?: boolean;
  addedTrailingBreak?: boolean;
}

export async function insertText(ctx: FsToolContext, args: InsertTextArgs): Promise<TextEditResult> {
  const result = await withWorkspace(ctx, (workspace, signal) =>
    workspace.insertText(args.path, args.line, args.text, signal)
  );
  return {
    bytesWritten: result.bytesWritten,
    previous: result.previous ?? "",
    next: result.next,
    addedLeadingBreak: result.addedLeadingBreak,
    addedTrailingBreak: result.addedTrailingBreak
  };
}

export async function replaceRange(ctx: FsToolContext, args: ReplaceRangeArgs): Promise<TextEditResult> {
  const result = await withWorkspace(ctx, (workspace, signal) =>
    workspace.replaceRange(args.path, args.startLine, args.endLine, args.content, signal)
  );
  return {
    bytesWritten: result.bytesWritten,
    previous: result.previous ?? "",
    next: result.next,
    addedLeadingBreak: result.addedLeadingBreak,
    addedTrailingBreak: result.addedTrailingBreak
  };
}

export interface DirEntry {
  name: string;
  type: "file" | "dir" | "other";
}

export async function listDir(ctx: FsToolContext, args: { path: string }): Promise<DirEntry[]> {
  const entries = await withWorkspace(ctx, (workspace, signal) =>
    workspace.listDirectory(args.path, signal)
  );
  return entries.map(entry => ({
    name: entry.name,
    type: entry.type === "directory" ? "dir" : entry.type
  }));
}

export async function glob(
  ctx: FsToolContext,
  args: { pattern: string; maxResults?: number }
): Promise<string[]> {
  const results = await withWorkspace(ctx, (workspace, signal) =>
    workspace.glob(args.pattern, args.maxResults, signal)
  );
  return [...results];
}

async function withWorkspace<T>(
  ctx: FsToolContext,
  operation: (workspace: GuardedWorkspace, signal: AbortSignal) => Promise<T>
): Promise<T> {
  const signal = ctx.signal ?? new AbortController().signal;
  const workspace = ctx.workspace ?? await GuardedWorkspace.create(ctx.workspaceRoot, signal);
  return operation(workspace, signal);
}

export function countLogicalLines(text: string): number {
  if (text.length === 0) return 0;
  const starts = lineStartOffsets(text);
  return endsWithLineBreak(text) ? Math.max(0, starts.length - 1) : starts.length;
}

const SNIPPET_CONTEXT_LINES = 3;
const SNIPPET_MAX_LINES = 40;
const SNIPPET_HEAD_LINES = 25;
const SNIPPET_TAIL_LINES = 10;

/** Return a bounded, numbered view of an edited region plus nearby context. */
export function editRegionSnippet(next: string, regionStart: number, regionLineCount: number): string {
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

/**
 * Detect the common small-model error of pasting read_file's display-only
 * number/tab prefixes back into an edit.
 */
export function looksLikeNumberedReadOutput(content: string, expectedFirstLine?: number): boolean {
  const lines = content.split(/\r\n|\r|\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length < 2) return false;
  let previous: number | undefined;
  let first: number | undefined;
  let sawPadding = false;
  for (const line of lines) {
    const match = /^( *)(\d{1,7})\t/.exec(line);
    if (!match) return false;
    if (match[1].length > 0) sawPadding = true;
    const number = parseInt(match[2], 10);
    if (first === undefined) first = number;
    if (previous !== undefined && number !== previous + 1) return false;
    previous = number;
  }
  return sawPadding || (expectedFirstLine !== undefined && first === expectedFirstLine);
}

/** Prefix every logical line with its real 1-based number and a tab. */
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

function sliceLines(text: string, startLine: number, endLine: number): string {
  return text.slice(offsetBeforeLine(text, startLine), offsetAfterLine(text, endLine));
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
  const newline = /\r\n|\n|\r/g;
  let match: RegExpExecArray | null;
  while ((match = newline.exec(text))) starts.push(match.index + match[0].length);
  return starts;
}

function endsWithLineBreak(text: string): boolean {
  return text.endsWith("\n") || text.endsWith("\r");
}
