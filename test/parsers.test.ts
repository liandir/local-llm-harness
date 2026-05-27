import { describe, it, expect } from "vitest";
import { Gemma4Parser } from "../src/llm/parser/gemma4.js";
import { Qwen3Parser } from "../src/llm/parser/qwen3.js";
import { ParsedEvent } from "../src/llm/parser/types.js";

function drain(parser: { feed(c: string): ParsedEvent[]; end(): ParsedEvent[] }, chunks: string[]): ParsedEvent[] {
  const out: ParsedEvent[] = [];
  for (const c of chunks) out.push(...parser.feed(c));
  out.push(...parser.end());
  return out;
}

describe("Gemma4Parser", () => {
  it("emits thought then text then toolCall", () => {
    const p = new Gemma4Parser();
    const events = drain(p, [
      "<|channel>thoughtthinking out loud<|channel>finalhello user",
      "<|tool_call>call:read_file{\"path\":\"a.ts\"}<tool_call|>",
      " trailing"
    ]);
    const kinds = events.map(e => e.kind);
    expect(kinds).toContain("thought");
    expect(kinds).toContain("text");
    expect(kinds).toContain("toolCall");
    const tc = events.find(e => e.kind === "toolCall") as { kind: "toolCall"; name: string; argsJson: string };
    expect(tc.name).toBe("read_file");
    expect(JSON.parse(tc.argsJson).path).toBe("a.ts");
    expect(events[events.length - 1].kind).toBe("done");
  });

  it("handles marker split across chunk boundaries", () => {
    const p = new Gemma4Parser();
    const events = drain(p, ["hello <|", "tool_call>call:list_dir{\"path\":\".\"}<tool_", "call|>"]);
    const tc = events.find(e => e.kind === "toolCall") as { kind: "toolCall"; name: string };
    expect(tc?.name).toBe("list_dir");
  });
});

describe("Qwen3Parser", () => {
  it("parses <think> and <tool_call> blocks", () => {
    const p = new Qwen3Parser();
    const events = drain(p, [
      "<think>planning</think>",
      "hello <tool_call>{\"name\":\"read_file\",\"arguments\":{\"path\":\"a.ts\"}}</tool_call>"
    ]);
    expect(events.find(e => e.kind === "thought")).toBeTruthy();
    const tc = events.find(e => e.kind === "toolCall") as { kind: "toolCall"; name: string; argsJson: string };
    expect(tc.name).toBe("read_file");
    expect(JSON.parse(tc.argsJson).path).toBe("a.ts");
  });
});
