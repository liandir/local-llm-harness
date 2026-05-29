import { ParsedEvent, StreamingParser } from "./types.js";

/**
 * Parser for the Gemma chat-template family.
 *
 * Real Gemma models (1/2/3) have no special tokens for thinking or tool calls.
 * Their sequence/turn tokens — <bos>, <eos>, <start_of_turn>, <end_of_turn> —
 * are added and stripped by the llama.cpp server's chat template, so they never
 * reach us. This parser only ever sees the assistant's *content* and recognizes
 * the plain-text conventions we ask the model to use in the system prompt:
 *
 *   <think> ... </think>                              optional reasoning
 *   <read_file><path>...</path></read_file>           tool call (one XML block)
 *   <write_file><path>..</path><content>..</content></write_file>
 *   <tool_call>{"name":..,"arguments":{..}}</tool_call>   JSON fallback
 *
 * Robustness rules:
 *  - Markers inside ``` fenced code blocks are treated as literal text, so the
 *    model can *show* a tool-call example without it being executed.
 *  - <think> content is buffered and only emitted once </think> is seen; if the
 *    block is never closed, it is flushed as visible text so a forgotten
 *    </think> can never hide the answer.
 *  - The JSON <tool_call> form is accepted in addition to XML so a model that
 *    drifts to Hermes/Qwen syntax still produces a real tool call rather than
 *    silently leaking it into the visible text.
 */

const OPEN_THINK = "<think>";
const CLOSE_THINK = "</think>";
const FENCE = "```";
const HERMES_OPEN = "<tool_call>";
const HERMES_CLOSE = "</tool_call>";
const TOOL_NAMES = ["read_file", "write_file", "list_dir", "glob", "run_command"] as const;
const XML_TOOL_OPENS = TOOL_NAMES.map(name => `<${name}>`);

type Mode = "text" | "think" | "tool" | "code";

export class Gemma4Parser implements StreamingParser {
  private buf = "";
  private mode: Mode = "text";
  private thoughtBuf = "";
  private toolBuf = "";
  private toolName = "";   // XML tool name; "" means the JSON <tool_call> form
  private toolClose = "";  // closing marker for the active tool block

  feed(chunk: string): ParsedEvent[] {
    this.buf += chunk;
    return this.drain(false);
  }

  end(): ParsedEvent[] {
    const out = this.drain(true);
    // Whatever survives draining at end-of-stream is incomplete.
    if (this.mode === "think") {
      // Unclosed <think>: surface buffered reasoning + remainder as visible text
      // so a forgotten </think> can never hide the answer.
      const text = this.thoughtBuf + this.buf;
      if (text) out.push({ kind: "text", text });
      this.thoughtBuf = "";
    } else if (this.buf.length > 0 && (this.mode === "text" || this.mode === "code")) {
      out.push({ kind: "text", text: this.buf });
    }
    // An unclosed tool block is dropped — its args are partial and unsafe to run.
    this.buf = "";
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
            break;
          }
          const keep = trailingPotentialMarker(this.buf, [this.toolClose]);
          this.toolBuf += this.buf.slice(0, this.buf.length - keep);
          this.buf = this.buf.slice(this.buf.length - keep);
          break;
        }
        this.toolBuf += this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + this.toolClose.length);
        const parsed = this.toolName
          ? parseXmlToolCall(this.toolName, this.toolBuf)
          : parseJsonToolCall(this.toolBuf);
        out.push({ kind: "toolCall", name: parsed.name, argsJson: parsed.argsJson });
        this.toolBuf = "";
        this.toolName = "";
        this.toolClose = "";
        this.mode = "text";
        continue;
      }

      if (this.mode === "think") {
        const idx = this.buf.indexOf(CLOSE_THINK);
        if (idx === -1) {
          if (flush) break; // residual is surfaced as text in end()
          const keep = trailingPotentialMarker(this.buf, [CLOSE_THINK]);
          this.thoughtBuf += this.buf.slice(0, this.buf.length - keep);
          this.buf = this.buf.slice(this.buf.length - keep);
          break;
        }
        this.thoughtBuf += this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + CLOSE_THINK.length);
        if (this.thoughtBuf) out.push({ kind: "thought", text: this.thoughtBuf });
        this.thoughtBuf = "";
        this.mode = "text";
        continue;
      }

      if (this.mode === "code") {
        // Inside a ``` fence nothing is a marker except the closing fence.
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

      // mode === "text"
      const markers = [OPEN_THINK, FENCE, HERMES_OPEN, ...XML_TOOL_OPENS];
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
        this.thoughtBuf = "";
      } else if (hit.marker === FENCE) {
        out.push({ kind: "text", text: FENCE });
        this.mode = "code";
      } else if (hit.marker === HERMES_OPEN) {
        this.mode = "tool";
        this.toolBuf = "";
        this.toolName = "";
        this.toolClose = HERMES_CLOSE;
      } else {
        // XML tool open such as <read_file>
        this.mode = "tool";
        this.toolBuf = "";
        this.toolName = hit.marker.slice(1, -1);
        this.toolClose = `</${this.toolName}>`;
      }
    }
    return out;
  }

  /** Emit the buffer as text, holding back a trailing partial marker mid-stream. */
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

/**
 * If the buffer ends in a prefix of any marker, return the length of that prefix
 * so we hold it back until more data arrives.
 */
function trailingPotentialMarker(s: string, markers: string[]): number {
  const longest = Math.max(...markers.map(m => m.length));
  const tailMax = Math.min(longest - 1, s.length);
  for (let len = tailMax; len > 0; len--) {
    const tail = s.slice(s.length - len);
    if (markers.some(m => m.startsWith(tail))) return len;
  }
  return 0;
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
    // `content` spans to the *last* close tag so embedded markup survives;
    // other params take the nearest close.
    const valueEnd = paramName === "content"
      ? body.lastIndexOf(close)
      : body.indexOf(close, valueStart);
    if (valueEnd === -1 || valueEnd < valueStart) continue;
    args[paramName] = body.slice(valueStart, valueEnd).trim();
    paramRe.lastIndex = valueEnd + close.length;
  }
  return { name, argsJson: JSON.stringify(args) };
}
