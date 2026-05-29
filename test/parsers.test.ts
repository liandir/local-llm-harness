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

  it("parses XML-style read and command tool calls", () => {
    const p = new Gemma4Parser();
    const events = drain(p, [
      "<read_file><path>src/app.ts</path></read_file>",
      "<run_command><command>npm test</command></run_command>"
    ]);
    const calls = events.filter((e): e is { kind: "toolCall"; name: string; argsJson: string } => e.kind === "toolCall");
    expect(calls.map(c => c.name)).toEqual(["read_file", "run_command"]);
    expect(JSON.parse(calls[0].argsJson).path).toBe("src/app.ts");
    expect(JSON.parse(calls[1].argsJson).command).toBe("npm test");
  });

  it("parses XML-style write_file with raw multiline content", () => {
    const p = new Gemma4Parser();
    const events = drain(p, [
      "<write_file><path>src/app.ts</path><content>const html = \"<div>ok</div>\";\n",
      "console.log(html);\n</content></write_file>"
    ]);
    const tc = events.find(e => e.kind === "toolCall") as { kind: "toolCall"; name: string; argsJson: string };
    const args = JSON.parse(tc.argsJson);
    expect(tc.name).toBe("write_file");
    expect(args.path).toBe("src/app.ts");
    expect(args.content).toContain("console.log(html);");
  });

  it("accepts think tags from Gemma-compatible local templates", () => {
    const p = new Gemma4Parser();
    const events = drain(p, ["<think>hidden reasoning</think>visible answer"]);
    expect(events.find(e => e.kind === "thought" && e.text.includes("hidden reasoning"))).toBeTruthy();
    expect(events.find(e => e.kind === "text" && e.text.includes("visible answer"))).toBeTruthy();
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
