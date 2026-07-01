/** The three tools that mutate a file and stream a card as they're emitted. */
const WRITE_TOOL_NAMES = ["write_file", "insert_text", "replace_range"] as const;
export type WriteToolName = (typeof WRITE_TOOL_NAMES)[number];

export interface WriteToolProgressSnapshot {
  name: WriteToolName;
  path?: string;
  content: string;
  contentBytes: number;
  contentLines: number;
  /** replace_range only: the bounds being replaced, once they parse from the stream. */
  startLine?: number;
  endLine?: number;
}

const GEMMA_STRING_DELIM = `<|"|>`;
const PATH_KEYS = ["path", "file_path", "filePath", "filepath", "filename", "fileName", "file"];
const CONTENT_KEYS = ["content", "text", "contents", "body", "new_content", "newContent", "value"];
const RANGE_START_KEYS = ["startLine", "start_line", "start", "fromLine", "from_line"];
const RANGE_END_KEYS = ["endLine", "end_line", "end", "toLine", "to_line"];

interface ReplaceRange {
  startLine?: number;
  endLine?: number;
}

function isWriteToolName(name: string | undefined): name is WriteToolName {
  return !!name && (WRITE_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * The XML tag carrying the edited body differs per tool: insert_text streams its
 * payload in <text>, while write_file and replace_range use <content>. Picking by
 * name (rather than scanning for either tag) avoids mis-matching a literal
 * "<content>" that appears inside inserted source code.
 */
function xmlContentTag(name: WriteToolName): string {
  return name === "insert_text" ? "text" : "content";
}

export function progressSignature(p: WriteToolProgressSnapshot): string {
  return `${p.path ?? ""}\0${p.contentBytes}\0${p.contentLines}`;
}

export function writeProgressFromGemmaToolBody(body: string): WriteToolProgressSnapshot | undefined {
  const name = /^call\s*:\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(body.trimStart())?.[1];
  if (!isWriteToolName(name)) return undefined;
  const content = extractGemmaStringField(body, CONTENT_KEYS, false) ?? "";
  const range = name === "replace_range" ? gemmaRange(body) : undefined;
  return summarizeWriteProgress(name, extractGemmaStringField(body, PATH_KEYS, true), content, range);
}

export function writeProgressFromXmlToolBody(name: string, body: string): WriteToolProgressSnapshot | undefined {
  if (!isWriteToolName(name)) return undefined;
  const tag = xmlContentTag(name);
  const open = new RegExp(`<${tag}>`, "i").exec(body);
  let content = "";
  if (open?.index !== undefined) {
    const start = open.index + open[0].length;
    const close = body.slice(start).search(new RegExp(`</${tag}>`, "i"));
    content = close === -1
      ? stripTrailingPotentialMarker(body.slice(start), [`</${tag}>`])
      : body.slice(start, start + close);
  }
  const range = name === "replace_range" ? xmlRange(body) : undefined;
  return summarizeWriteProgress(name, extractXmlTag(body, "path"), content, range);
}

export function writeProgressFromJsonToolBody(body: string, knownName?: string): WriteToolProgressSnapshot | undefined {
  const name = knownName || extractJsonStringField(body, ["name"], true);
  if (!isWriteToolName(name)) return undefined;
  const content = extractJsonStringField(body, CONTENT_KEYS, false) ?? "";
  const range = name === "replace_range" ? jsonRange(body) : undefined;
  return summarizeWriteProgress(name, extractJsonStringField(body, PATH_KEYS, true), content, range);
}

function summarizeWriteProgress(
  name: WriteToolName,
  path: string | undefined,
  content: string,
  range?: ReplaceRange
): WriteToolProgressSnapshot {
  return {
    name,
    path,
    content,
    contentBytes: utf8Bytes(content),
    contentLines: content ? content.split(/\r\n|\r|\n/).length : 0,
    startLine: range?.startLine,
    endLine: range?.endLine
  };
}

function gemmaRange(body: string): ReplaceRange {
  return {
    startLine: firstNumber(RANGE_START_KEYS, key => extractGemmaNumberField(body, key)),
    endLine: firstNumber(RANGE_END_KEYS, key => extractGemmaNumberField(body, key))
  };
}

function xmlRange(body: string): ReplaceRange {
  const tag = (key: string): number | undefined => parseIntOrUndefined(extractXmlTag(body, key));
  return {
    startLine: firstNumber(RANGE_START_KEYS, tag),
    endLine: firstNumber(RANGE_END_KEYS, tag)
  };
}

function jsonRange(body: string): ReplaceRange {
  return {
    startLine: firstNumber(RANGE_START_KEYS, key => extractJsonNumberField(body, key)),
    endLine: firstNumber(RANGE_END_KEYS, key => extractJsonNumberField(body, key))
  };
}

function firstNumber(keys: string[], get: (key: string) => number | undefined): number | undefined {
  for (const key of keys) {
    const value = get(key);
    if (value !== undefined) return value;
  }
  return undefined;
}

function extractGemmaNumberField(body: string, key: string): number | undefined {
  const match = new RegExp(`(?:^|[,{])\\s*${escapeRegex(key)}\\s*:\\s*(-?\\d+)`).exec(body);
  return parseIntOrUndefined(match?.[1]);
}

function extractJsonNumberField(body: string, key: string): number | undefined {
  const match = new RegExp(`["']${escapeRegex(key)}["']\\s*:\\s*(-?\\d+)`).exec(body);
  return parseIntOrUndefined(match?.[1]);
}

function parseIntOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) return undefined;
  return Number(trimmed);
}

function extractGemmaStringField(body: string, keys: string[], requireClosed: boolean): string | undefined {
  for (const key of keys) {
    const re = new RegExp(`(?:^|[,{])\\s*${escapeRegex(key)}\\s*:\\s*${escapeRegex(GEMMA_STRING_DELIM)}`);
    const match = re.exec(body);
    if (!match || match.index === undefined) continue;
    const start = match.index + match[0].length;
    const end = body.indexOf(GEMMA_STRING_DELIM, start);
    if (end !== -1) return body.slice(start, end);
    if (!requireClosed) return stripTrailingPotentialMarker(body.slice(start), [GEMMA_STRING_DELIM]);
  }
  return undefined;
}

function extractXmlTag(body: string, tag: string): string | undefined {
  const match = new RegExp(`<${escapeRegex(tag)}>([\\s\\S]*?)</${escapeRegex(tag)}>`, "i").exec(body);
  return match?.[1];
}

function extractJsonStringField(body: string, keys: string[], requireClosed: boolean): string | undefined {
  const keyPattern = keys.map(escapeRegex).join("|");
  const re = new RegExp(`["'](${keyPattern})["']\\s*:\\s*["']`, "g");
  const match = re.exec(body);
  if (!match || match.index === undefined) return undefined;
  const quote = body[match.index + match[0].length - 1];
  const start = match.index + match[0].length;
  let escaped = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\") {
      escaped = true;
      continue;
    }
    if (c === quote) return unescapeJsonishString(body.slice(start, i));
  }
  if (requireClosed) return undefined;
  let partial = body.slice(start);
  if (escaped) partial = partial.slice(0, -1);
  return unescapeJsonishString(partial);
}

function unescapeJsonishString(value: string): string {
  try {
    return JSON.parse(`"${value.replace(/\r?\n/g, "\\n")}"`);
  } catch {
    return value
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, "\"")
      .replace(/\\\\/g, "\\");
  }
}

function stripTrailingPotentialMarker(s: string, markers: string[]): string {
  const longest = Math.max(...markers.map(m => m.length));
  const tailMax = Math.min(longest - 1, s.length);
  for (let len = tailMax; len > 0; len--) {
    const tail = s.slice(s.length - len);
    if (markers.some(m => m.startsWith(tail))) return s.slice(0, s.length - len);
  }
  return s;
}

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
