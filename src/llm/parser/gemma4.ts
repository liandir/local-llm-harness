import { ParsedEvent, StreamingParser } from "./types.js";
import {
  progressSignature,
  writeProgressFromGemmaToolBody,
  writeProgressFromJsonToolBody,
  writeProgressFromXmlToolBody
} from "../toolProgress.js";

/**
 * Parser for Gemma 4 assistant content.
 *
 * Native Gemma 4 tool calls use a custom, non-JSON serialization:
 *   <|tool_call>call:read_file{path:<|"|>src/app.ts<|"|>}<tool_call|>
 *
 * We also keep the XML and Hermes fallbacks because local templates can drift,
 * but the native format is the canonical path for `gemma4`.
 */

const OPEN_THINK = "<think>";
const CLOSE_THINK = "</think>";
const OPEN_CHANNEL = "<|channel>";
const CLOSE_CHANNEL = "<channel|>";
const FENCE = "```";
const GEMMA_TOOL_OPEN = "<|tool_call>";
const GEMMA_TOOL_CLOSE = "<tool_call|>";
const HERMES_TOOL_OPEN = "<tool_call>";
const HERMES_TOOL_CLOSE = "</tool_call>";
const TOOL_RESPONSE_OPEN = "<|tool_response>";
const TOOL_RESPONSE_CLOSE = "<tool_response|>";
const STRING_DELIM = `<|"|>`;
const TOOL_NAMES = ["read_file", "write_file", "list_dir", "glob", "run_command"] as const;
const XML_TOOL_OPENS = TOOL_NAMES.map(name => `<${name}>`);

type Mode = "text" | "think" | "channel" | "tool" | "toolResponse" | "code";
type ToolKind = "gemma" | "hermes" | "xml";

export class Gemma4Parser implements StreamingParser {
  private buf = "";
  private mode: Mode = "text";
  private channelBuf = "";
  private toolBuf = "";
  private toolName = "";
  private toolClose = "";
  private toolKind: ToolKind = "gemma";
  private lastToolProgressSignature = "";

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
    } else if (this.mode === "channel") {
      const text = this.channelBuf + this.buf;
      if (text) out.push({ kind: "text", text });
      this.channelBuf = "";
    } else if (this.buf.length > 0 && (this.mode === "text" || this.mode === "code")) {
      out.push({ kind: "text", text: this.buf });
    }
    // Incomplete tool/tool-response blocks are dropped; their payloads are not safe.
    this.buf = "";
    this.toolBuf = "";
    this.toolName = "";
    this.toolClose = "";
    this.mode = "text";
    this.lastToolProgressSignature = "";
    out.push({ kind: "done" });
    return out;
  }

  private drain(flush: boolean): ParsedEvent[] {
    const out: ParsedEvent[] = [];
    while (this.buf.length > 0) {
      if (this.mode === "tool") {
        const idx = this.buf.indexOf(this.toolClose);
        if (idx === -1) {
          if (flush) {
            this.toolBuf += this.buf;
            this.buf = "";
            out.push(...this.progressEvents());
            break;
          }
          const keep = trailingPotentialMarker(this.buf, [this.toolClose]);
          this.toolBuf += this.buf.slice(0, this.buf.length - keep);
          this.buf = this.buf.slice(this.buf.length - keep);
          out.push(...this.progressEvents());
          break;
        }
        this.toolBuf += this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + this.toolClose.length);
        out.push(...this.progressEvents());
        const parsed = this.parseActiveToolCall();
        out.push({ kind: "toolCall", name: parsed.name, argsJson: parsed.argsJson });
        this.toolBuf = "";
        this.toolName = "";
        this.toolClose = "";
        this.mode = "text";
        this.lastToolProgressSignature = "";
        continue;
      }

      if (this.mode === "toolResponse") {
        const idx = this.buf.indexOf(TOOL_RESPONSE_CLOSE);
        if (idx === -1) {
          if (flush) {
            this.buf = "";
            this.mode = "text";
            break;
          }
          const keep = trailingPotentialMarker(this.buf, [TOOL_RESPONSE_CLOSE]);
          this.buf = this.buf.slice(this.buf.length - keep);
          break;
        }
        this.buf = this.buf.slice(idx + TOOL_RESPONSE_CLOSE.length);
        this.mode = "text";
        continue;
      }

      if (this.mode === "think") {
        const idx = this.buf.indexOf(CLOSE_THINK);
        if (idx === -1) {
          // Stream the thought incrementally (hold back only a possible partial
          // </think>) so the "Thinking…" block fills in live instead of popping
          // in whole when the tag finally closes.
          if (flush) break;
          const keep = trailingPotentialMarker(this.buf, [CLOSE_THINK]);
          const emit = this.buf.slice(0, this.buf.length - keep);
          if (emit) out.push({ kind: "thought", text: emit });
          this.buf = this.buf.slice(this.buf.length - keep);
          break;
        }
        const emit = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + CLOSE_THINK.length);
        if (emit) out.push({ kind: "thought", text: emit });
        this.mode = "text";
        continue;
      }

      if (this.mode === "channel") {
        const idx = this.buf.indexOf(CLOSE_CHANNEL);
        if (idx === -1) {
          if (flush) break;
          const keep = trailingPotentialMarker(this.buf, [CLOSE_CHANNEL]);
          this.channelBuf += this.buf.slice(0, this.buf.length - keep);
          this.buf = this.buf.slice(this.buf.length - keep);
          break;
        }
        this.channelBuf += this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + CLOSE_CHANNEL.length);
        out.push(...eventsFromChannel(this.channelBuf));
        this.channelBuf = "";
        this.mode = "text";
        continue;
      }

      if (this.mode === "code") {
        const idx = this.buf.indexOf(FENCE);
        if (idx === -1) {
          out.push(...this.flushText(flush, [FENCE]));
          break;
        }
        const upto = idx + FENCE.length;
        out.push({ kind: "text", text: this.buf.slice(0, upto) });
        this.buf = this.buf.slice(upto);
        this.mode = "text";
        continue;
      }

      const markers = [
        OPEN_THINK,
        OPEN_CHANNEL,
        FENCE,
        GEMMA_TOOL_OPEN,
        HERMES_TOOL_OPEN,
        TOOL_RESPONSE_OPEN,
        TOOL_RESPONSE_CLOSE,
        ...XML_TOOL_OPENS
      ];
      const hit = findFirstOf(this.buf, markers);
      if (hit.index === -1) {
        out.push(...this.flushText(flush, markers));
        break;
      }

      const before = this.buf.slice(0, hit.index);
      if (before) out.push({ kind: "text", text: before });
      this.buf = this.buf.slice(hit.index + hit.marker.length);

      if (hit.marker === OPEN_THINK) {
        this.mode = "think";
      } else if (hit.marker === OPEN_CHANNEL) {
        this.mode = "channel";
        this.channelBuf = "";
      } else if (hit.marker === FENCE) {
        out.push({ kind: "text", text: FENCE });
        this.mode = "code";
      } else if (hit.marker === GEMMA_TOOL_OPEN) {
        this.startTool("gemma", "", GEMMA_TOOL_CLOSE);
      } else if (hit.marker === HERMES_TOOL_OPEN) {
        this.startTool("hermes", "", HERMES_TOOL_CLOSE);
      } else if (hit.marker === TOOL_RESPONSE_OPEN) {
        this.mode = "toolResponse";
      } else if (hit.marker === TOOL_RESPONSE_CLOSE) {
        // Stray close marker: consume it without leaking special tokens.
        this.mode = "text";
      } else {
        const name = hit.marker.slice(1, -1);
        this.startTool("xml", name, `</${name}>`);
      }
    }
    return out;
  }

  private flushText(flush: boolean, markers: string[]): ParsedEvent[] {
    if (flush) {
      const out: ParsedEvent[] = this.buf ? [{ kind: "text", text: this.buf }] : [];
      this.buf = "";
      return out;
    }
    const keep = trailingPotentialMarker(this.buf, markers);
    const emit = this.buf.slice(0, this.buf.length - keep);
    const out: ParsedEvent[] = emit ? [{ kind: "text", text: emit }] : [];
    this.buf = this.buf.slice(this.buf.length - keep);
    return out;
  }

  private startTool(kind: ToolKind, name: string, close: string): void {
    this.mode = "tool";
    this.toolKind = kind;
    this.toolName = name;
    this.toolClose = close;
    this.toolBuf = "";
    this.lastToolProgressSignature = "";
  }

  private parseActiveToolCall(): { name: string; argsJson: string } {
    if (this.toolKind === "gemma") return parseGemmaToolCall(this.toolBuf);
    if (this.toolKind === "hermes") return parseJsonToolCall(this.toolBuf);
    return parseXmlToolCall(this.toolName, this.toolBuf);
  }

  private progressEvents(): ParsedEvent[] {
    const progress = this.toolKind === "gemma"
      ? writeProgressFromGemmaToolBody(this.toolBuf)
      : this.toolKind === "hermes"
        ? writeProgressFromJsonToolBody(this.toolBuf)
        : writeProgressFromXmlToolBody(this.toolName, this.toolBuf);
    if (!progress) return [];
    const signature = progressSignature(progress);
    if (signature === this.lastToolProgressSignature) return [];
    this.lastToolProgressSignature = signature;
    return [{ kind: "toolCallProgress", ...progress }];
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
    if (i !== -1 && (best.index === -1 || i < best.index || (i === best.index && m.length > best.marker.length))) {
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

function eventsFromChannel(body: string): ParsedEvent[] {
  const trimmed = body.trimStart();
  const label = /^(thought|analysis|final)\b[:\s]*/i.exec(trimmed);
  if (!label) return body ? [{ kind: "thought", text: body }] : [];
  const text = trimmed.slice(label[0].length);
  if (!text) return [];
  return label[1].toLowerCase() === "final"
    ? [{ kind: "text", text }]
    : [{ kind: "thought", text }];
}

/** Body shape: `call:name{key:<|"|>value<|"|>,count:2}`. */
export function parseGemmaToolCall(body: string): { name: string; argsJson: string } {
  const m = body.trim().match(/^call:([A-Za-z_][\w]*)\s*\{([\s\S]*)\}\s*$/);
  if (!m) return { name: "", argsJson: "{}" };
  try {
    return { name: m[1], argsJson: JSON.stringify(parseGemmaArgs(m[2])) };
  } catch {
    return { name: m[1], argsJson: "{}" };
  }
}

/** Body shape: `{"name":..,"arguments":{..}}` (Hermes / Qwen style). */
export function parseJsonToolCall(body: string): { name: string; argsJson: string } {
  try {
    const obj = JSON.parse(body.trim());
    const name = typeof obj.name === "string" ? obj.name : "";
    const args = obj.arguments ?? obj.args ?? {};
    return { name, argsJson: JSON.stringify(args) };
  } catch {
    return { name: "", argsJson: "{}" };
  }
}

export function parseXmlToolCall(name: string, body: string): { name: string; argsJson: string } {
  const args: Record<string, string> = {};
  const paramRe = /<([A-Za-z_][\w]*)>/g;
  let match: RegExpExecArray | null;
  while ((match = paramRe.exec(body)) !== null) {
    const paramName = match[1];
    const close = `</${paramName}>`;
    const valueStart = match.index + match[0].length;
    const valueEnd = paramName === "content"
      ? body.lastIndexOf(close)
      : body.indexOf(close, valueStart);
    if (valueEnd === -1 || valueEnd < valueStart) continue;
    const raw = body.slice(valueStart, valueEnd);
    args[paramName] = paramName === "content" ? raw : raw.trim();
    paramRe.lastIndex = valueEnd + close.length;
  }
  return { name, argsJson: JSON.stringify(args) };
}

function parseGemmaArgs(input: string): Record<string, unknown> {
  return new GemmaArgParser(input).parseArgs();
}

class GemmaArgParser {
  private i = 0;

  constructor(private readonly input: string) {}

  parseArgs(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    while (this.i < this.input.length) {
      this.skipWsAndCommas();
      if (this.i >= this.input.length) break;
      const key = this.parseKey();
      this.skipWs();
      if (this.peek() !== ":") break;
      this.i++;
      out[key] = this.parseValue();
      this.skipWs();
      if (this.peek() === ",") this.i++;
    }
    return out;
  }

  private parseObject(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    this.i++;
    while (this.i < this.input.length) {
      this.skipWsAndCommas();
      if (this.peek() === "}") {
        this.i++;
        break;
      }
      const key = this.parseKey();
      this.skipWs();
      if (this.peek() !== ":") break;
      this.i++;
      out[key] = this.parseValue();
      this.skipWs();
      if (this.peek() === ",") this.i++;
    }
    return out;
  }

  private parseArray(): unknown[] {
    const out: unknown[] = [];
    this.i++;
    while (this.i < this.input.length) {
      this.skipWsAndCommas();
      if (this.peek() === "]") {
        this.i++;
        break;
      }
      out.push(this.parseValue());
      this.skipWs();
      if (this.peek() === ",") this.i++;
    }
    return out;
  }

  private parseValue(): unknown {
    this.skipWs();
    if (this.startsWith(STRING_DELIM)) return this.parseGemmaString();
    const c = this.peek();
    if (c === "{") return this.parseObject();
    if (c === "[") return this.parseArray();
    return this.parseBareValue();
  }

  private parseKey(): string {
    this.skipWs();
    if (this.startsWith(STRING_DELIM)) return this.parseGemmaString();
    const start = this.i;
    while (this.i < this.input.length && this.peek() !== ":") this.i++;
    return this.input.slice(start, this.i).trim();
  }

  private parseGemmaString(): string {
    this.i += STRING_DELIM.length;
    const end = this.input.indexOf(STRING_DELIM, this.i);
    if (end === -1) {
      const value = this.input.slice(this.i);
      this.i = this.input.length;
      return value;
    }
    const value = this.input.slice(this.i, end);
    this.i = end + STRING_DELIM.length;
    return value;
  }

  private parseBareValue(): unknown {
    const start = this.i;
    while (this.i < this.input.length && !",]}".includes(this.peek())) this.i++;
    const raw = this.input.slice(start, this.i).trim();
    if (/^true$/i.test(raw)) return true;
    if (/^false$/i.test(raw)) return false;
    if (/^null$/i.test(raw)) return null;
    if (/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) return Number(raw);
    return raw;
  }

  private skipWsAndCommas(): void {
    while (this.i < this.input.length && (/\s/.test(this.peek()) || this.peek() === ",")) this.i++;
  }

  private skipWs(): void {
    while (this.i < this.input.length && /\s/.test(this.peek())) this.i++;
  }

  private startsWith(s: string): boolean {
    return this.input.startsWith(s, this.i);
  }

  private peek(): string {
    return this.input[this.i] ?? "";
  }
}
