import { progressSignature, writeProgressFromJsonToolBody } from "../toolProgress.js";
import type { ParsedEvent, StreamingParser } from "./types.js";

const START_ASSISTANT = "<|start|>assistant";
const CHANNEL = "<|channel|>";
const MESSAGE = "<|message|>";
const END = "<|end|>";
const CALL = "<|call|>";
const RETURN = "<|return|>";

type Mode = "outside" | "header" | "message";
type HarmonyChannel = "analysis" | "commentary" | "final";

/**
 * Recover GPT-OSS Harmony messages when a server returns the model's raw
 * template output through `content` instead of structured API fields.
 * Ordinary text is passed through unchanged; only a Harmony message addressed
 * to `functions.NAME` on the commentary channel becomes a tool call.
 */
export class GptOssParser implements StreamingParser {
  private buf = "";
  private mode: Mode = "outside";
  private header = "";
  private channel: HarmonyChannel = "final";
  private toolName: string | undefined;
  private toolBuf = "";
  private lastToolProgressSignature = "";

  feed(chunk: string): ParsedEvent[] {
    this.buf += chunk;
    return this.drain(false);
  }

  end(): ParsedEvent[] {
    const out = this.drain(true);
    this.reset();
    out.push({ kind: "done" });
    return out;
  }

  private drain(flush: boolean): ParsedEvent[] {
    const out: ParsedEvent[] = [];
    while (this.buf.length > 0 || (flush && this.mode !== "outside")) {
      if (this.mode === "outside") {
        const hit = findFirstOf(this.buf, [START_ASSISTANT, CHANNEL]);
        if (hit.index === -1) {
          out.push(...this.flushOutsideText(flush));
          break;
        }
        const before = this.buf.slice(0, hit.index);
        if (before) out.push({ kind: "text", text: before });
        this.buf = this.buf.slice(hit.index + hit.marker.length);
        this.header = hit.marker;
        this.mode = "header";
        continue;
      }

      if (this.mode === "header") {
        const messageIndex = this.buf.indexOf(MESSAGE);
        if (messageIndex === -1) {
          if (flush) {
            out.push({ kind: "text", text: this.header + this.buf });
            this.buf = "";
            this.mode = "outside";
          }
          break;
        }
        this.header += this.buf.slice(0, messageIndex);
        this.buf = this.buf.slice(messageIndex + MESSAGE.length);
        const channel = /<\|channel\|>(analysis|commentary|final)\b/.exec(this.header)?.[1] as HarmonyChannel | undefined;
        if (!channel) {
          out.push({ kind: "text", text: this.header + MESSAGE });
          this.header = "";
          this.mode = "outside";
          continue;
        }
        this.channel = channel;
        const recipient = /\bto=functions\.([A-Za-z_][A-Za-z0-9_]*)\b/.exec(this.header)?.[1];
        this.toolName = channel === "commentary" ? recipient : undefined;
        this.toolBuf = "";
        this.lastToolProgressSignature = "";
        this.header = "";
        this.mode = "message";
        continue;
      }

      const hit = findFirstOf(this.buf, [END, CALL, RETURN, START_ASSISTANT]);
      if (hit.index === -1) {
        if (this.toolName !== undefined) {
          const keep = flush ? 0 : trailingPotentialMarker(this.buf, [END, CALL, RETURN, START_ASSISTANT]);
          this.toolBuf += this.buf.slice(0, this.buf.length - keep);
          this.buf = this.buf.slice(this.buf.length - keep);
          out.push(...this.progressEvents());
          if (flush) {
            out.push(this.toolEvent(false));
            this.finishMessage();
          }
        } else {
          const keep = flush ? 0 : trailingPotentialMarker(this.buf, [END, CALL, RETURN, START_ASSISTANT]);
          const text = this.buf.slice(0, this.buf.length - keep);
          this.buf = this.buf.slice(this.buf.length - keep);
          if (text) out.push(this.contentEvent(text));
          if (flush) this.finishMessage();
        }
        break;
      }

      const content = this.buf.slice(0, hit.index);
      if (this.toolName !== undefined) {
        this.toolBuf += content;
        out.push(...this.progressEvents());
        out.push(this.toolEvent(true));
      } else if (content) {
        out.push(this.contentEvent(content));
      }
      this.buf = hit.marker === START_ASSISTANT
        ? this.buf.slice(hit.index)
        : this.buf.slice(hit.index + hit.marker.length);
      this.finishMessage();
    }
    return out;
  }

  private flushOutsideText(flush: boolean): ParsedEvent[] {
    const keep = flush ? 0 : trailingPotentialMarker(this.buf, [START_ASSISTANT, CHANNEL]);
    const text = this.buf.slice(0, this.buf.length - keep);
    this.buf = this.buf.slice(this.buf.length - keep);
    return text ? [{ kind: "text", text }] : [];
  }

  private contentEvent(text: string): ParsedEvent {
    return this.channel === "analysis" ? { kind: "thought", text } : { kind: "text", text };
  }

  private progressEvents(): ParsedEvent[] {
    const progress = writeProgressFromJsonToolBody(this.toolBuf, this.toolName);
    if (!progress) return [];
    const signature = progressSignature(progress);
    if (signature === this.lastToolProgressSignature) return [];
    this.lastToolProgressSignature = signature;
    return [{ kind: "toolCallProgress", ...progress }];
  }

  private toolEvent(closed: boolean): ParsedEvent {
    const raw = this.toolBuf.trim();
    try {
      const args: unknown = JSON.parse(raw || "{}");
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        throw new Error("Harmony tool arguments must be a JSON object.");
      }
      return { kind: "toolCall", name: this.toolName ?? "", argsJson: JSON.stringify(args) };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        kind: "toolCall",
        name: "",
        argsJson: raw || "{}",
        parseError: closed ? `Malformed GPT-OSS Harmony tool call: ${detail}` : "Incomplete GPT-OSS Harmony tool call."
      };
    }
  }

  private finishMessage(): void {
    this.mode = "outside";
    this.header = "";
    this.channel = "final";
    this.toolName = undefined;
    this.toolBuf = "";
    this.lastToolProgressSignature = "";
  }

  private reset(): void {
    this.buf = "";
    this.finishMessage();
  }
}

interface MarkerHit {
  index: number;
  marker: string;
}

function findFirstOf(value: string, markers: string[]): MarkerHit {
  let best: MarkerHit = { index: -1, marker: "" };
  for (const marker of markers) {
    const index = value.indexOf(marker);
    if (index !== -1 && (best.index === -1 || index < best.index)) best = { index, marker };
  }
  return best;
}

function trailingPotentialMarker(value: string, markers: string[]): number {
  const longest = Math.max(...markers.map(marker => marker.length));
  const tailMax = Math.min(longest - 1, value.length);
  for (let length = tailMax; length > 0; length--) {
    const tail = value.slice(value.length - length);
    if (markers.some(marker => marker.startsWith(tail))) return length;
  }
  return 0;
}
