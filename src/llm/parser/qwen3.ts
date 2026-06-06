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

type Mode = "final" | "think" | "tool";

export class Qwen3Parser implements StreamingParser {
  private buf = "";
  private mode: Mode = "final";
  private toolBuf = "";
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
    } else if (this.buf.length > 0 && this.mode === "final") {
      out.push({ kind: "text", text: this.buf });
    }
    // An unclosed <tool_call> is incomplete and is dropped.
    this.buf = "";
    this.toolBuf = "";
    this.lastToolProgressSignature = "";
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
          // </think>) so the "Thinking…" block fills in live instead of
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
        const parsed = parseQwenToolCall(this.toolBuf);
        out.push({ kind: "toolCall", name: parsed.name, argsJson: parsed.argsJson });
        this.toolBuf = "";
        this.mode = "final";
        this.lastToolProgressSignature = "";
        continue;
      }
      // mode === "final"
      const hit = findFirstOf(this.buf, [OPEN_THINK, OPEN_TOOL]);
      if (hit.index === -1) {
        out.push(...this.emitTail("text", flush));
        break;
      }
      const before = this.buf.slice(0, hit.index);
      if (before) out.push({ kind: "text", text: before });
      this.buf = this.buf.slice(hit.index + hit.marker.length);
      this.mode = hit.marker === OPEN_THINK ? "think" : "tool";
      if (this.mode === "tool") {
        this.toolBuf = "";
        this.lastToolProgressSignature = "";
      }
    }
    return out;
  }

  private emitTail(kind: "text" | "thought", flush: boolean): ParsedEvent[] {
    const markers = [OPEN_THINK, OPEN_TOOL, CLOSE_THINK, CLOSE_TOOL];
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

export function parseQwenToolCall(body: string): { name: string; argsJson: string } {
  const trimmed = body.trim();
  try {
    const obj = JSON.parse(trimmed);
    const name = typeof obj.name === "string" ? obj.name : "";
    const args = obj.arguments ?? obj.args ?? {};
    return { name, argsJson: JSON.stringify(args) };
  } catch {
    return { name: "", argsJson: "{}" };
  }
}
