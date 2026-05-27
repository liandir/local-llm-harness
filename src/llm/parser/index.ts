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

export type { ParsedEvent } from "./types.js";
