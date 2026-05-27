import { ParsedEvent, StreamingParser } from "./types.js";

/**
 * Gemma 4 tokens:
 *   <|channel>thought   ... thinking text ...
 *   <|channel>final     ... visible text ...
 *   <|tool_call>call:NAME{ARGS}<tool_call|>
 *   <|tool_result> ... <tool_result|>      (echoed back by us, not consumed here)
 *
 * Notes:
 *  - The opening token uses `<|...>` and the closing uses `<...|>` (asymmetric).
 *  - We process content streamingly, holding back any byte that could be the
 *    start of a special token until we have enough context to decide.
 */

const OPEN_THOUGHT = "<|channel>thought";
const OPEN_FINAL = "<|channel>final";
const OPEN_TOOL = "<|tool_call>";
const CLOSE_TOOL = "<tool_call|>";

type Mode = "final" | "thought" | "tool";

export class Gemma4Parser implements StreamingParser {
  private buf = "";
  private mode: Mode = "final";
  private toolBuf = "";

  feed(chunk: string): ParsedEvent[] {
    this.buf += chunk;
    return this.drain(false);
  }

  end(): ParsedEvent[] {
    const out = this.drain(true);
    if (this.buf.length > 0) {
      if (this.mode === "thought") out.push({ kind: "thought", text: this.buf });
      else if (this.mode === "final") out.push({ kind: "text", text: this.buf });
      this.buf = "";
    }
    out.push({ kind: "done" });
    return out;
  }

  private drain(flush: boolean): ParsedEvent[] {
    const out: ParsedEvent[] = [];
    while (this.buf.length > 0) {
      if (this.mode === "tool") {
        const closeIdx = this.buf.indexOf(CLOSE_TOOL);
        if (closeIdx === -1) {
          if (flush) {
            this.toolBuf += this.buf;
            this.buf = "";
            break;
          }
          // Hold back any trailing bytes that could be a partial close marker.
          const tail = trailingPotentialMarker(this.buf, [CLOSE_TOOL]);
          this.toolBuf += this.buf.slice(0, this.buf.length - tail);
          this.buf = this.buf.slice(this.buf.length - tail);
          break;
        }
        this.toolBuf += this.buf.slice(0, closeIdx);
        this.buf = this.buf.slice(closeIdx + CLOSE_TOOL.length);
        const parsed = parseGemmaToolCall(this.toolBuf);
        out.push({ kind: "toolCall", name: parsed.name, argsJson: parsed.argsJson });
        this.toolBuf = "";
        this.mode = "final";
        continue;
      }

      const nextOpen = findFirstOf(this.buf, [OPEN_THOUGHT, OPEN_FINAL, OPEN_TOOL]);
      if (nextOpen.index === -1) {
        // No special token in view. If we might be in the middle of one, hold back.
        const tail = trailingPotentialMarker(this.buf, [OPEN_THOUGHT, OPEN_FINAL, OPEN_TOOL]);
        if (!flush && tail > 0) {
          const emit = this.buf.slice(0, this.buf.length - tail);
          if (emit) out.push(this.emit(emit));
          this.buf = this.buf.slice(this.buf.length - tail);
        } else {
          if (this.buf) out.push(this.emit(this.buf));
          this.buf = "";
        }
        break;
      }
      // Emit anything before the marker in the current mode.
      const before = this.buf.slice(0, nextOpen.index);
      if (before) out.push(this.emit(before));
      this.buf = this.buf.slice(nextOpen.index + nextOpen.marker.length);
      if (nextOpen.marker === OPEN_THOUGHT) this.mode = "thought";
      else if (nextOpen.marker === OPEN_FINAL) this.mode = "final";
      else if (nextOpen.marker === OPEN_TOOL) {
        this.mode = "tool";
        this.toolBuf = "";
      }
    }
    return out;
  }

  private emit(text: string): ParsedEvent {
    return this.mode === "thought"
      ? { kind: "thought", text }
      : { kind: "text", text };
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

/**
 * Body shape: `call:NAME{...}` where `{...}` is a JSON object.
 * We accept any whitespace and a missing `call:` prefix.
 */
export function parseGemmaToolCall(body: string): { name: string; argsJson: string } {
  const trimmed = body.trim();
  const m = trimmed.match(/^(?:call:)?\s*([A-Za-z_][\w]*)\s*(\{[\s\S]*\})\s*$/);
  if (!m) {
    return { name: "", argsJson: "{}" };
  }
  return { name: m[1], argsJson: m[2] };
}
