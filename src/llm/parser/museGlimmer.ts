import { progressSignature, writeProgressFromAtemToolBody } from "../toolProgress.js";
import type { ParsedEvent, StreamingParser } from "./types.js";

const START_ASSISTANT = "<|start|>assistant";
const MESSAGE = "<|message|>";
const SELF = "to=self<|message|>";
const USER = "to=user<|message|>";
const EOM = "<|eom|>";
const EOT = "<|eot|>";
const FUNCTION_CALLS_OPEN = "<atem:function_calls>";
const FUNCTION_CALLS_CLOSE = "</atem:function_calls>";
const INVOKE_OPEN = "<atem:invoke";
const INVOKE_CLOSE = "</atem:invoke>";
const FENCE = "```";

type Mode = "text" | "reasoning" | "tool" | "code";

/** Recover Muse Glimmer's raw recipient/ATEM protocol when a server leaks it. */
export class MuseGlimmerParser implements StreamingParser {
  private buf = "";
  private mode: Mode = "text";
  private toolBuf = "";
  private toolClose = FUNCTION_CALLS_CLOSE;
  private lastProgressSignature = "";

  feed(chunk: string): ParsedEvent[] {
    this.buf += chunk;
    return this.drain(false);
  }

  end(): ParsedEvent[] {
    const out = this.drain(true);
    if (this.mode === "tool" && this.toolBuf.trim()) {
      const calls = parseMuseAtemCalls(this.toolBuf);
      if (calls.length > 0) out.push(...calls.map(call => ({ kind: "toolCall", ...call }) as ParsedEvent));
      else out.push({ kind: "toolCall", name: "", argsJson: this.toolBuf, parseError: "Incomplete Muse ATEM tool call." });
    } else if (this.buf) {
      out.push({ kind: this.mode === "reasoning" ? "thought" : "text", text: this.buf });
    }
    this.reset();
    out.push({ kind: "done" });
    return out;
  }

  private drain(flush: boolean): ParsedEvent[] {
    const out: ParsedEvent[] = [];
    while (this.buf) {
      if (this.mode === "tool") {
        const close = this.buf.indexOf(this.toolClose);
        if (close === -1) {
          const keep = flush ? 0 : trailingPotentialMarker(this.buf, [this.toolClose]);
          this.toolBuf += this.buf.slice(0, this.buf.length - keep);
          this.buf = this.buf.slice(this.buf.length - keep);
          out.push(...this.progressEvents());
          break;
        }
        this.toolBuf += this.buf.slice(0, close);
        if (this.toolClose === INVOKE_CLOSE) this.toolBuf += INVOKE_CLOSE;
        this.buf = this.buf.slice(close + this.toolClose.length);
        out.push(...this.progressEvents());
        const calls = parseMuseAtemCalls(this.toolBuf);
        if (calls.length > 0) out.push(...calls.map(call => ({ kind: "toolCall", ...call }) as ParsedEvent));
        else out.push({ kind: "toolCall", name: "", argsJson: this.toolBuf, parseError: "Malformed Muse ATEM tool call." });
        this.toolBuf = "";
        this.lastProgressSignature = "";
        this.mode = "text";
        continue;
      }

      if (this.mode === "code") {
        const close = this.buf.indexOf(FENCE);
        if (close === -1) {
          out.push(...this.flushVisible(flush, [FENCE]));
          break;
        }
        const end = close + FENCE.length;
        out.push({ kind: "text", text: this.buf.slice(0, end) });
        this.buf = this.buf.slice(end);
        this.mode = "text";
        continue;
      }

      const directRecipient = /^\s*to=([^<\s]+)<\|message\|>/.exec(this.buf);
      if (directRecipient) {
        this.buf = this.buf.slice(directRecipient[0].length);
        this.mode = directRecipient[1] === "self" ? "reasoning" : "text";
        continue;
      }
      if (!flush && /^\s*to=/.test(this.buf) && !this.buf.includes(MESSAGE)) break;

      const markers = [START_ASSISTANT, SELF, USER, FUNCTION_CALLS_OPEN, INVOKE_OPEN, EOM, EOT, FENCE];
      const hit = findFirst(this.buf, markers);
      if (hit.index === -1) {
        out.push(...this.flushVisible(flush, markers));
        break;
      }
      const before = this.buf.slice(0, hit.index);
      if (before) out.push({ kind: this.mode === "reasoning" ? "thought" : "text", text: before });
      this.buf = this.buf.slice(hit.index + hit.marker.length);

      if (hit.marker === START_ASSISTANT) {
        const end = this.buf.indexOf(MESSAGE);
        if (end === -1) {
          this.buf = START_ASSISTANT + this.buf;
          break;
        }
        const recipient = /^\s+to=([^<\s]+)/.exec(this.buf.slice(0, end))?.[1] ?? "user";
        this.buf = this.buf.slice(end + MESSAGE.length);
        this.mode = recipient === "self" ? "reasoning" : "text";
      } else if (hit.marker === SELF) {
        this.mode = "reasoning";
      } else if (hit.marker === USER) {
        this.mode = "text";
      } else if (hit.marker === FUNCTION_CALLS_OPEN) {
        this.startTool(FUNCTION_CALLS_CLOSE, FUNCTION_CALLS_OPEN);
      } else if (hit.marker === INVOKE_OPEN) {
        const tagEnd = this.buf.indexOf(">");
        if (tagEnd === -1) {
          this.buf = INVOKE_OPEN + this.buf;
          break;
        }
        const openTag = INVOKE_OPEN + this.buf.slice(0, tagEnd + 1);
        this.buf = this.buf.slice(tagEnd + 1);
        this.startTool(INVOKE_CLOSE, openTag);
      } else if (hit.marker === FENCE) {
        out.push({ kind: "text", text: FENCE });
        this.mode = "code";
      } else {
        // Message/turn boundary. The following recipient marker decides the next mode.
        this.mode = "text";
      }
    }
    return out;
  }

  private flushVisible(flush: boolean, markers: string[]): ParsedEvent[] {
    const keep = flush ? 0 : trailingPotentialMarker(this.buf, markers);
    const text = this.buf.slice(0, this.buf.length - keep);
    this.buf = this.buf.slice(this.buf.length - keep);
    return text ? [{ kind: this.mode === "reasoning" ? "thought" : "text", text }] : [];
  }

  private startTool(close: string, prefix: string): void {
    this.mode = "tool";
    this.toolClose = close;
    this.toolBuf = prefix;
    this.lastProgressSignature = "";
  }

  private progressEvents(): ParsedEvent[] {
    const progress = writeProgressFromAtemToolBody(this.toolBuf);
    if (!progress) return [];
    const signature = progressSignature(progress);
    if (signature === this.lastProgressSignature) return [];
    this.lastProgressSignature = signature;
    return [{ kind: "toolCallProgress", ...progress }];
  }

  private reset(): void {
    this.buf = "";
    this.mode = "text";
    this.toolBuf = "";
    this.toolClose = FUNCTION_CALLS_CLOSE;
    this.lastProgressSignature = "";
  }
}

export function parseMuseAtemCalls(body: string): Array<{ name: string; argsJson: string; parseError?: string }> {
  const calls: Array<{ name: string; argsJson: string; parseError?: string }> = [];
  const invoke = /<atem:invoke\b[^>]*\bname=["']([^"']+)["'][^>]*>([\s\S]*?)<\/atem:invoke>/gi;
  const matches = [...body.matchAll(invoke)];
  const residue = body
    .replace(/<\/?atem:function_calls>/gi, "")
    .replace(invoke, "")
    .trim();
  if (residue) {
    return [{ name: "", argsJson: body, parseError: "Unexpected text outside a Muse ATEM invocation." }];
  }
  for (const match of matches) {
    const args: Record<string, unknown> = {};
    const parameters = match[2];
    const parameter = /<atem:parameter\b[^>]*\bname=["']([^"']+)["'][^>]*>([\s\S]*?)<\/atem:parameter>/gi;
    let duplicate: string | undefined;
    for (const param of parameters.matchAll(parameter)) {
      if (param[1] in args) duplicate = param[1];
      args[param[1]] = parseAtemValue(param[1], param[2]);
    }
    const residue = parameters.replace(parameter, "").trim();
    const parseError = duplicate
      ? `Duplicate ATEM parameter "${duplicate}".`
      : residue
        ? "Unexpected text outside an ATEM parameter."
        : undefined;
    calls.push(parseError
      ? { name: "", argsJson: match[0], parseError }
      : { name: match[1], argsJson: JSON.stringify(args) });
  }
  return calls;
}

const SOURCE_TEXT_PARAMETERS = new Set([
  "content", "text", "expectedContent", "expected_content", "expectedLine", "expected_line",
  "oldText", "old_text", "newText", "new_text"
]);

function parseAtemValue(name: string, value: string): unknown {
  if (SOURCE_TEXT_PARAMETERS.has(name)) return value;
  const trimmed = value.trim();
  if (/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(trimmed)
    || trimmed.startsWith("[") || trimmed.startsWith("{") || trimmed.startsWith('"')) {
    try { return JSON.parse(trimmed); } catch { /* preserve non-JSON strings */ }
  }
  return value.includes("\n") ? value : trimmed;
}

function findFirst(value: string, markers: string[]): { index: number; marker: string } {
  let found = { index: -1, marker: "" };
  for (const marker of markers) {
    const index = value.indexOf(marker);
    if (index !== -1 && (found.index === -1 || index < found.index)) found = { index, marker };
  }
  return found;
}

function trailingPotentialMarker(value: string, markers: string[]): number {
  const max = Math.min(value.length, Math.max(...markers.map(marker => marker.length)) - 1);
  for (let length = max; length > 0; length--) {
    const tail = value.slice(-length);
    if (markers.some(marker => marker.startsWith(tail))) return length;
  }
  return 0;
}
