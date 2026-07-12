import { WorkspaceSecurityError } from "./errors.js";

/** Number of logical lines using the same CRLF/LF/CR model as legacy tools. */
export function countLogicalLines(text: string): number {
  if (text.length === 0) return 0;
  const starts = lineStartOffsets(text);
  return endsWithLineBreak(text) ? Math.max(0, starts.length - 1) : starts.length;
}

export function sliceLineRange(
  text: string,
  requestedStart: number | undefined,
  requestedEnd: number | undefined,
  displayPath: string
): { content: string; startLine: number; endLine: number; totalLines: number } {
  const totalLines = countLogicalLines(text);
  const ranged = requestedStart !== undefined || requestedEnd !== undefined;
  if (!ranged) {
    return {
      content: text,
      startLine: totalLines === 0 ? 0 : 1,
      endLine: totalLines,
      totalLines
    };
  }
  const startLine = requestedStart ?? 1;
  const requestedLastLine = requestedEnd ?? totalLines;
  if (!Number.isInteger(startLine) || startLine < 1) {
    throw new WorkspaceSecurityError(
      "INVALID_PATH",
      `read_file startLine must be an integer ≥ 1; received ${requestedStart}.`
    );
  }
  if (startLine > totalLines) {
    throw new WorkspaceSecurityError(
      "INVALID_PATH",
      `read_file range starts past the end of ${displayPath}: the file has ${totalLines} line${totalLines === 1 ? "" : "s"}, requested startLine ${startLine}.`
    );
  }
  if (!Number.isInteger(requestedLastLine) || requestedLastLine < startLine) {
    throw new WorkspaceSecurityError(
      "INVALID_PATH",
      `read_file endLine must be an integer ≥ startLine (${startLine}); received ${requestedEnd}.`
    );
  }
  const endLine = Math.min(requestedLastLine, totalLines);
  return {
    content: text.slice(offsetBeforeLine(text, startLine), offsetAfterLine(text, endLine)),
    startLine,
    endLine,
    totalLines
  };
}

export function insertWholeLines(
  previous: string,
  line: number,
  requestedText: string
): {
  next: string;
  effectiveText: string;
  addedLeadingBreak: boolean;
  addedTrailingBreak: boolean;
} {
  const lineCount = countLogicalLines(previous);
  if (!Number.isInteger(line) || line < 1 || line > lineCount + 1) {
    throw new WorkspaceSecurityError(
      "INVALID_PATH",
      `insert_text line must be between 1 and ${lineCount + 1}; received ${line}.`
    );
  }
  let effectiveText = requestedText;
  let addedLeadingBreak = false;
  let addedTrailingBreak = false;
  if (effectiveText.length > 0) {
    if (
      line === lineCount + 1 &&
      previous.length > 0 &&
      !endsWithLineBreak(previous) &&
      !startsWithLineBreak(effectiveText)
    ) {
      effectiveText = `\n${effectiveText}`;
      addedLeadingBreak = true;
    }
    if (line <= lineCount && !endsWithLineBreak(effectiveText)) {
      effectiveText += "\n";
      addedTrailingBreak = true;
    }
  }
  const offset = offsetBeforeLine(previous, line);
  return {
    next: previous.slice(0, offset) + effectiveText + previous.slice(offset),
    effectiveText,
    addedLeadingBreak,
    addedTrailingBreak
  };
}

export function replaceWholeLineRange(
  previous: string,
  startLine: number,
  endLine: number,
  requestedContent: string
): { next: string; effectiveContent: string; addedTrailingBreak: boolean } {
  const lineCount = countLogicalLines(previous);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
    throw new WorkspaceSecurityError(
      "INVALID_PATH",
      "replace_range startLine and endLine must be integers."
    );
  }
  if (startLine < 1 || endLine < startLine || endLine > lineCount) {
    throw new WorkspaceSecurityError(
      "INVALID_PATH",
      `replace_range must target lines 1-${lineCount}; received ${startLine}-${endLine}.`
    );
  }
  let effectiveContent = requestedContent;
  let addedTrailingBreak = false;
  if (effectiveContent.length > 0 && endLine < lineCount && !endsWithLineBreak(effectiveContent)) {
    effectiveContent += "\n";
    addedTrailingBreak = true;
  }
  const start = offsetBeforeLine(previous, startLine);
  const end = offsetAfterLine(previous, endLine);
  return {
    next: previous.slice(0, start) + effectiveContent + previous.slice(end),
    effectiveContent,
    addedTrailingBreak
  };
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

function startsWithLineBreak(text: string): boolean {
  return text.startsWith("\n") || text.startsWith("\r");
}
