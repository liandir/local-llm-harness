export interface WriteToolProgressSnapshot {
  name: "write_file";
  path?: string;
  content: string;
  contentBytes: number;
  contentLines: number;
}

const GEMMA_STRING_DELIM = `<|"|>`;
const PATH_KEYS = ["path", "file_path", "filePath", "filepath", "filename", "fileName", "file"];
const CONTENT_KEYS = ["content", "text", "contents", "body", "new_content", "newContent", "value"];

export function progressSignature(p: WriteToolProgressSnapshot): string {
  return `${p.path ?? ""}\0${p.contentBytes}\0${p.contentLines}`;
}

export function writeProgressFromGemmaToolBody(body: string): WriteToolProgressSnapshot | undefined {
  const name = /^call\s*:\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(body.trimStart())?.[1];
  if (name !== "write_file") return undefined;
  const content = extractGemmaStringField(body, CONTENT_KEYS, false) ?? "";
  return summarizeWriteProgress(extractGemmaStringField(body, PATH_KEYS, true), content);
}

export function writeProgressFromXmlToolBody(name: string, body: string): WriteToolProgressSnapshot | undefined {
  if (name !== "write_file") return undefined;
  const contentStart = /<content>/i.exec(body);
  let content = "";
  if (contentStart?.index !== undefined) {
    const start = contentStart.index + contentStart[0].length;
    const close = body.slice(start).search(/<\/content>/i);
    content = close === -1
      ? stripTrailingPotentialMarker(body.slice(start), ["</content>"])
      : body.slice(start, start + close);
  }
  return summarizeWriteProgress(extractXmlTag(body, "path"), content);
}

export function writeProgressFromJsonToolBody(body: string, knownName?: string): WriteToolProgressSnapshot | undefined {
  const name = knownName || extractJsonStringField(body, ["name"], true);
  if (name !== "write_file") return undefined;
  const content = extractJsonStringField(body, CONTENT_KEYS, false) ?? "";
  return summarizeWriteProgress(extractJsonStringField(body, PATH_KEYS, true), content);
}

function summarizeWriteProgress(path: string | undefined, content: string): WriteToolProgressSnapshot {
  return {
    name: "write_file",
    path,
    content,
    contentBytes: utf8Bytes(content),
    contentLines: content ? content.split(/\r\n|\r|\n/).length : 0
  };
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
