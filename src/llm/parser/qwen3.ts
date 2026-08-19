import { ParsedEvent, StreamingParser } from "./types.js";
import { progressSignature, writeProgressFromJsonToolBody } from "../toolProgress.js";

/**
 * Qwen 3 (Hermes-style) tokens:
 *   <think> ... </think>
 *   <tool_call> {"name": "...", "arguments": {...}} </tool_call>
 *
 * ChatML <|im_start|>/<|im_end|> are message boundaries, handled by the client
 * (not the assistant-content parser).
 */

const OPEN_THINK = "<think>";
const CLOSE_THINK = "</think>";
const OPEN_TOOL = "<tool_call>";
const CLOSE_TOOL = "</tool_call>";
const FENCE = "```";

type Mode = "final" | "think" | "tool" | "code";
type ToolCallMode = "hermes-and-function-xml" | "function-xml-only";

export class Qwen3Parser implements StreamingParser {
  private buf = "";
  private mode: Mode = "final";
  private toolBuf = "";
  private lastToolProgressSignature = "";

  constructor(private readonly toolCallMode: ToolCallMode = "hermes-and-function-xml") {}

  feed(chunk: string): ParsedEvent[] {
    this.buf += chunk;
    return this.drain(false);
  }

  end(): ParsedEvent[] {
    const out = this.drain(true);
    if (this.mode === "think") {
      // The thought streamed incrementally; only a held-back partial </think>
      // tail can remain. Surface it as thought so nothing is lost.
      if (this.buf) out.push({ kind: "thought", text: this.buf });
    } else if (this.buf.length > 0 && (this.mode === "final" || this.mode === "code")) {
      out.push({ kind: "text", text: this.buf });
    } else if (this.mode === "tool" && this.toolBuf.trim()) {
      // The stream ended inside a <tool_call>. If the body happens to be
      // complete JSON (only the closing tag was cut off), run it normally;
      // otherwise emit it blank-named so the session can feed the failure back
      // to the model instead of ending the turn with no reply at all.
      out.push(this.toolEvent(this.toolBuf, false));
    }
    this.buf = "";
    this.toolBuf = "";
    this.lastToolProgressSignature = "";
    this.mode = "final";
    out.push({ kind: "done" });
    return out;
  }

  private drain(flush: boolean): ParsedEvent[] {
    const out: ParsedEvent[] = [];
    while (this.buf.length > 0) {
      if (this.mode === "think") {
        const ci = this.buf.indexOf(CLOSE_THINK);
        if (ci === -1) {
          // Stream the thought incrementally (hold back only a possible partial
          // </think>) so the "Thinking" block fills in live instead of
          // popping in whole when the tag finally closes.
          if (flush) break;
          const keep = trailingPotentialMarker(this.buf, [CLOSE_THINK]);
          const emit = this.buf.slice(0, this.buf.length - keep);
          if (emit) out.push({ kind: "thought", text: emit });
          this.buf = this.buf.slice(this.buf.length - keep);
          break;
        }
        const emit = this.buf.slice(0, ci);
        this.buf = this.buf.slice(ci + CLOSE_THINK.length);
        if (emit) out.push({ kind: "thought", text: emit });
        this.mode = "final";
        continue;
      }
      if (this.mode === "tool") {
        const ci = this.buf.indexOf(CLOSE_TOOL);
        if (ci === -1) {
          if (flush) {
            this.toolBuf += this.buf;
            this.buf = "";
            out.push(...this.progressEvents());
            break;
          }
          const tail = trailingPotentialMarker(this.buf, [CLOSE_TOOL]);
          this.toolBuf += this.buf.slice(0, this.buf.length - tail);
          this.buf = this.buf.slice(this.buf.length - tail);
          out.push(...this.progressEvents());
          break;
        }
        this.toolBuf += this.buf.slice(0, ci);
        this.buf = this.buf.slice(ci + CLOSE_TOOL.length);
        out.push(...this.progressEvents());
        out.push(this.toolEvent(this.toolBuf, true));
        this.toolBuf = "";
        this.mode = "final";
        this.lastToolProgressSignature = "";
        continue;
      }
      if (this.mode === "code") {
        const ci = this.buf.indexOf(FENCE);
        if (ci === -1) {
          out.push(...this.flushText(flush, [FENCE]));
          break;
        }
        const upto = ci + FENCE.length;
        out.push({ kind: "text", text: this.buf.slice(0, upto) });
        this.buf = this.buf.slice(upto);
        this.mode = "final";
        continue;
      }
      // mode === "final"
      const hit = findFirstOf(this.buf, [OPEN_THINK, OPEN_TOOL, FENCE]);
      if (hit.index === -1) {
        out.push(...this.emitTail("text", flush));
        break;
      }
      const before = this.buf.slice(0, hit.index);
      if (before) out.push({ kind: "text", text: before });
      this.buf = this.buf.slice(hit.index + hit.marker.length);
      this.mode = hit.marker === OPEN_THINK ? "think" : hit.marker === OPEN_TOOL ? "tool" : "code";
      if (this.mode === "tool") {
        this.toolBuf = "";
        this.lastToolProgressSignature = "";
      } else if (this.mode === "code") {
        out.push({ kind: "text", text: FENCE });
      }
    }
    return out;
  }

  private emitTail(kind: "text" | "thought", flush: boolean): ParsedEvent[] {
    const markers = [OPEN_THINK, OPEN_TOOL, CLOSE_THINK, CLOSE_TOOL, FENCE];
    return this.flushText(flush, markers, kind);
  }

  private flushText(flush: boolean, markers: string[], kind: "text" | "thought" = "text"): ParsedEvent[] {
    const tail = trailingPotentialMarker(this.buf, markers);
    if (!flush && tail > 0) {
      const emit = this.buf.slice(0, this.buf.length - tail);
      const out: ParsedEvent[] = emit ? [{ kind, text: emit } as ParsedEvent] : [];
      this.buf = this.buf.slice(this.buf.length - tail);
      return out;
    }
    const out: ParsedEvent[] = this.buf ? [{ kind, text: this.buf } as ParsedEvent] : [];
    this.buf = "";
    return out;
  }

  private progressEvents(): ParsedEvent[] {
    const progress = writeProgressFromJsonToolBody(this.toolBuf);
    if (!progress) return [];
    const signature = progressSignature(progress);
    if (signature === this.lastToolProgressSignature) return [];
    this.lastToolProgressSignature = signature;
    return [{ kind: "toolCallProgress", ...progress }];
  }

  private toolEvent(body: string, closed: boolean): ParsedEvent {
    const functionXml = parseQwenFunctionToolCall(body);
    if (functionXml.recognized) {
      return {
        kind: "toolCall",
        name: functionXml.name,
        argsJson: functionXml.argsJson,
        parseError: functionXml.parseError
      };
    }
    if (this.toolCallMode === "function-xml-only") {
      return { kind: "text", text: `<tool_call>${body}${closed ? CLOSE_TOOL : ""}` };
    }
    const parsed = parseQwenToolCall(body);
    return { kind: "toolCall", name: parsed.name, argsJson: parsed.argsJson, parseError: parsed.parseError };
  }
}

interface OpenHit {
  index: number;
  marker: string;
}

function findFirstOf(s: string, markers: string[]): OpenHit {
  let best: OpenHit = { index: -1, marker: "" };
  for (const m of markers) {
    const i = s.indexOf(m);
    if (i !== -1 && (best.index === -1 || i < best.index)) {
      best = { index: i, marker: m };
    }
  }
  return best;
}

function trailingPotentialMarker(s: string, markers: string[]): number {
  const longest = Math.max(...markers.map(m => m.length));
  const tailMax = Math.min(longest - 1, s.length);
  for (let len = tailMax; len > 0; len--) {
    const tail = s.slice(s.length - len);
    if (markers.some(m => m.startsWith(tail))) return len;
  }
  return 0;
}

export function parseQwenToolCall(body: string): { name: string; argsJson: string; parseError?: string } {
  const functionXml = parseQwenFunctionToolCall(body);
  if (functionXml.recognized) {
    return { name: functionXml.name, argsJson: functionXml.argsJson, parseError: functionXml.parseError };
  }
  const trimmed = unwrapJsonFence(body.trim());
  const candidates = [trimmed, escapeLiteralJsonControls(trimmed), singleQuotedJsonToDoubleQuoted(trimmed)]
    .filter((candidate, index, all) => candidate && all.indexOf(candidate) === index);
  let parseError = "Invalid JSON.";
  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate);
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
        parseError = "Tool-call JSON must be an object.";
        continue;
      }
      const record = obj as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name : "";
      const args = record.arguments ?? record.args ?? {};
      return { name, argsJson: JSON.stringify(args) };
    } catch (error) {
      parseError = error instanceof SyntaxError ? error.message : String(error);
    }
  }
  return { name: "", argsJson: trimmed || "{}", parseError };
}

type FunctionToolCallParse =
  | { recognized: false }
  | { recognized: true; name: string; argsJson: string; parseError?: string };

/** Parse Qwen3-Coder's native `<function=...><parameter=...>` tool dialect. */
function parseQwenFunctionToolCall(body: string): FunctionToolCallParse {
  const trimmed = body.trim();
  if (!trimmed.startsWith("<function=")) return { recognized: false };
  const outer = /^<function=([A-Za-z_][A-Za-z0-9_]*)>([\s\S]*)<\/function>$/.exec(trimmed);
  if (!outer) {
    return {
      recognized: true,
      name: "",
      argsJson: trimmed || "{}",
      parseError: "Malformed Qwen function block: expected <function=NAME>...</function>."
    };
  }

  const [, name, parameterBody] = outer;
  const args: Record<string, unknown> = {};
  const openParameter = /<parameter=([A-Za-z_][A-Za-z0-9_]*)>/g;
  let cursor = 0;
  while (cursor < parameterBody.length) {
    openParameter.lastIndex = cursor;
    const match = openParameter.exec(parameterBody);
    if (!match) {
      if (parameterBody.slice(cursor).trim() === "") break;
      return malformedFunctionArgs(trimmed, "Unexpected text outside a <parameter=NAME> block.");
    }
    if (parameterBody.slice(cursor, match.index).trim() !== "") {
      return malformedFunctionArgs(trimmed, "Unexpected text before a <parameter=NAME> block.");
    }
    const parameterName = match[1];
    if (parameterName in args) {
      return malformedFunctionArgs(trimmed, `Duplicate parameter "${parameterName}".`);
    }
    const close = parameterBody.indexOf("</parameter>", openParameter.lastIndex);
    if (close === -1) {
      return malformedFunctionArgs(trimmed, `Parameter "${parameterName}" is missing </parameter>.`);
    }
    const rawValue = stripParameterFramingNewline(parameterBody.slice(openParameter.lastIndex, close));
    args[parameterName] = parseFunctionParameterValue(parameterName, rawValue);
    cursor = close + "</parameter>".length;
  }
  return { recognized: true, name, argsJson: JSON.stringify(args) };
}

function malformedFunctionArgs(raw: string, parseError: string): FunctionToolCallParse {
  return { recognized: true, name: "", argsJson: raw, parseError };
}

function stripParameterFramingNewline(value: string): string {
  return value.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

const SOURCE_TEXT_PARAMETERS = new Set([
  "content",
  "text",
  "expectedContent",
  "expected_content",
  "expectedLine",
  "expected_line",
  "oldText",
  "old_text",
  "newText",
  "new_text"
]);

function parseFunctionParameterValue(name: string, value: string): unknown {
  // These values are file text, where leading and trailing whitespace is data.
  // In particular, trimming a one-line expectedLine removes its indentation and
  // guarantees that the safety precondition will fail even when the model copied
  // the numbered read correctly. Only framing newlines have already been removed.
  if (SOURCE_TEXT_PARAMETERS.has(name)) return value;
  const trimmed = value.trim();
  if (
    trimmed.startsWith("[")
    || trimmed.startsWith("{")
    || trimmed.startsWith('"')
    || /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(trimmed)
  ) {
    try { return JSON.parse(trimmed); } catch { /* retain the model's exact string */ }
  }
  return value.includes("\n") ? value : trimmed;
}

function unwrapJsonFence(value: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(value);
  return match ? match[1].trim() : value;
}

/** Escape only forbidden literal control characters that occur inside JSON strings. */
function escapeLiteralJsonControls(value: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && inString) {
      result += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      result += char;
      continue;
    }
    if (inString && char === "\n") result += "\\n";
    else if (inString && char === "\r") result += "\\r";
    else if (inString && char === "\t") result += "\\t";
    else result += char;
  }
  return result;
}

/**
 * Conservative Python-style quote recovery. It only runs when the call uses
 * no double quotes at all, avoiding ambiguous rewrites of source payloads that
 * legitimately contain both quote styles.
 */
function singleQuotedJsonToDoubleQuoted(value: string): string {
  if (!value.includes("'") || value.includes('"')) return value;
  let result = "";
  let inString = false;
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      if (char === "'") result += "'";
      else result += `\\${char}`;
      escaped = false;
      continue;
    }
    if (char === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (char === "'") {
      inString = !inString;
      result += '"';
      continue;
    }
    if (inString && char === '"') result += '\\"';
    else if (inString && char === "\n") result += "\\n";
    else if (inString && char === "\r") result += "\\r";
    else if (inString && char === "\t") result += "\\t";
    else result += char;
  }
  return inString ? value : result;
}
