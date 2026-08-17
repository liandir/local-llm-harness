import { Gemma4Parser } from "./gemma4.js";
import { Qwen3Parser } from "./qwen3.js";
import { StreamingParser } from "./types.js";

export type ModelFamily = "gemma4" | "qwen3";

export function makeParser(family: ModelFamily): StreamingParser {
  switch (family) {
    case "gemma4": return new Gemma4Parser();
    case "qwen3": return new Qwen3Parser();
  }
}

/**
 * Qwen3-Coder may leak its template-native function XML through `content`
 * instead of the API's structured `tool_calls` channel. This parser recovers
 * only that dialect; Hermes JSON examples remain ordinary visible text.
 */
export function makeNativeTextRecoveryParser(): StreamingParser {
  return new Qwen3Parser("function-xml-only");
}

export type { ParsedEvent } from "./types.js";
