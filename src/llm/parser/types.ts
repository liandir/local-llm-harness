export type ParsedEvent =
  | { kind: "text"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "toolCallProgress"; name: string; path?: string; content?: string; contentBytes: number; contentLines: number; id?: string }
  | { kind: "toolCall"; name: string; argsJson: string; id?: string }
  | { kind: "summary"; text: string }
  | { kind: "done" };

export interface StreamingParser {
  /** Feed a chunk of raw model output. Yields zero or more events. */
  feed(chunk: string): ParsedEvent[];
  /** Signal end of stream. Yields any trailing events (including `done`). */
  end(): ParsedEvent[];
}
