import { Gemma4Parser } from "./gemma4.js";
import { Qwen3Parser } from "./qwen3.js";
import { MuseGlimmerParser } from "./museGlimmer.js";
import { GptOssParser } from "./gptOss.js";
import { StreamingParser } from "./types.js";
import type { CompatibilityFamily } from "../toolCallingProfile.js";

export function makeParser(family: CompatibilityFamily): StreamingParser {
  switch (family) {
    case "gemma4": return new Gemma4Parser();
    case "qwen3": return new Qwen3Parser();
    case "muse-glimmer": return new MuseGlimmerParser();
    case "gpt-oss": return new GptOssParser();
  }
}

/**
 * Qwen3-Coder may leak its template-native function XML through `content`
 * instead of the API's structured `tool_calls` channel. This parser recovers
 * only that dialect; Hermes JSON examples remain ordinary visible text.
 */
export function makeNativeTextRecoveryParser(family: CompatibilityFamily): StreamingParser {
  switch (family) {
    case "gemma4": return new Gemma4Parser(true);
    case "qwen3": return new Qwen3Parser("function-xml-only");
    case "muse-glimmer": return new MuseGlimmerParser();
    case "gpt-oss": return new GptOssParser();
  }
}

export type { ParsedEvent } from "./types.js";
