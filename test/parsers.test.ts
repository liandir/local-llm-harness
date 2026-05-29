import { describe, it, expect } from "vitest";
import { Gemma4Parser } from "../src/llm/parser/gemma4.js";
import { Qwen3Parser } from "../src/llm/parser/qwen3.js";
import { ParsedEvent } from "../src/llm/parser/types.js";
import { coalesceSameRole } from "../src/llm/prompt.js";

function drain(parser: { feed(c: string): ParsedEvent[]; end(): ParsedEvent[] }, chunks: string[]): ParsedEvent[] {
  const out: ParsedEvent[] = [];
  for (const c of chunks) out.push(...parser.feed(c));
  out.push(...parser.end());
  return out;
}

function textOf(events: ParsedEvent[]): string {
  return events.filter(e => e.kind === "text").map(e => (e as { text: string }).text).join("");
}

function thoughtOf(events: ParsedEvent[]): string {
  return events.filter(e => e.kind === "thought").map(e => (e as { text: string }).text).join("");
}

function toolCalls(events: ParsedEvent[]): { name: string; argsJson: string }[] {
  return events.filter((e): e is { kind: "toolCall"; name: string; argsJson: string } => e.kind === "toolCall");
}

describe("Gemma4Parser", () => {
  it("emits thought then text then an XML tool call", () => {
    const p = new Gemma4Parser();
    const events = drain(p, [
      "<think>thinking out loud</think>hello user",
      "<read_file><path>a.ts</path></read_file>",
      " trailing"
    ]);
    expect(thoughtOf(events)).toContain("thinking out loud");
    expect(textOf(events)).toContain("hello user");
    expect(textOf(events)).toContain(" trailing");
    const calls = toolCalls(events);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("read_file");
    expect(JSON.parse(calls[0].argsJson).path).toBe("a.ts");
    expect(events[events.length - 1].kind).toBe("done");
  });

  it("handles an XML tool marker split across chunk boundaries", () => {
    const p = new Gemma4Parser();
    const events = drain(p, ["please <list", "_dir><path>.</path></list", "_dir>"]);
    const calls = toolCalls(events);
    expect(calls[0]?.name).toBe("list_dir");
    expect(JSON.parse(calls[0].argsJson).path).toBe(".");
  });

  it("parses XML-style write_file with raw multiline content", () => {
    const p = new Gemma4Parser();
    const events = drain(p, [
      "<write_file><path>src/app.ts</path><content>const html = \"<div>ok</div>\";\n",
      "console.log(html);\n</content></write_file>"
    ]);
    const tc = toolCalls(events)[0];
    const args = JSON.parse(tc.argsJson);
    expect(tc.name).toBe("write_file");
    expect(args.path).toBe("src/app.ts");
    expect(args.content).toContain("console.log(html);");
    expect(args.content).toContain("<div>ok</div>");
  });

  it("accepts the JSON <tool_call> fallback (format drift)", () => {
    const p = new Gemma4Parser();
    const events = drain(p, ['<tool_call>{"name":"glob","arguments":{"pattern":"src/**/*.ts"}}</tool_call>']);
    const tc = toolCalls(events)[0];
    expect(tc.name).toBe("glob");
    expect(JSON.parse(tc.argsJson).pattern).toBe("src/**/*.ts");
  });

  it("does NOT execute tool tags shown inside a ``` code fence", () => {
    const p = new Gemma4Parser();
    const events = drain(p, [
      "Here is how to read a file:\n```\n<read_file><path>x</path></read_file>\n```\nThat's the format.",
    ]);
    expect(toolCalls(events)).toHaveLength(0);
    expect(textOf(events)).toContain("<read_file><path>x</path></read_file>");
  });

  it("still runs a real (unfenced) call that follows a fenced example", () => {
    const p = new Gemma4Parser();
    const events = drain(p, [
      "```\n<glob><pattern>*.ts</pattern></glob>\n```\nNow doing it:\n",
      "<glob><pattern>src/*.ts</pattern></glob>"
    ]);
    const calls = toolCalls(events);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].argsJson).pattern).toBe("src/*.ts");
  });

  it("emits two tool calls when the model batches them", () => {
    const p = new Gemma4Parser();
    const events = drain(p, [
      "<read_file><path>a.ts</path></read_file><read_file><path>b.ts</path></read_file>"
    ]);
    const calls = toolCalls(events);
    expect(calls.map(c => JSON.parse(c.argsJson).path)).toEqual(["a.ts", "b.ts"]);
  });

  it("surfaces an unclosed <think> as visible text (answer is never hidden)", () => {
    const p = new Gemma4Parser();
    const events = drain(p, ["<think>oops I forgot to close and here is the answer"]);
    expect(textOf(events)).toContain("here is the answer");
  });

  it("buffers a closed <think> into one thought event", () => {
    const p = new Gemma4Parser();
    const events = drain(p, ["<think>secret", " reasoning</think>the answer"]);
    expect(thoughtOf(events)).toBe("secret reasoning");
    expect(textOf(events)).toBe("the answer");
  });
});

describe("Qwen3Parser", () => {
  it("parses <think> and <tool_call> blocks", () => {
    const p = new Qwen3Parser();
    const events = drain(p, [
      "<think>planning</think>",
      "hello <tool_call>{\"name\":\"read_file\",\"arguments\":{\"path\":\"a.ts\"}}</tool_call>"
    ]);
    expect(thoughtOf(events)).toContain("planning");
    const tc = toolCalls(events)[0];
    expect(tc.name).toBe("read_file");
    expect(JSON.parse(tc.argsJson).path).toBe("a.ts");
  });

  it("surfaces an unclosed <think> as visible text", () => {
    const p = new Qwen3Parser();
    const events = drain(p, ["<think>no close and the final answer"]);
    expect(textOf(events)).toContain("the final answer");
  });
});

describe("coalesceSameRole", () => {
  it("merges a tool-result user turn into the preceding user turn", () => {
    const merged = coalesceSameRole([
      { role: "system", content: "sys" },
      { role: "user", content: "do the thing" },
      { role: "user", content: "[read_file result]\nfile contents" }
    ]);
    expect(merged.map(m => m.role)).toEqual(["system", "user"]);
    expect(merged[1].content).toContain("do the thing");
    expect(merged[1].content).toContain("file contents");
  });

  it("leaves an already-alternating transcript unchanged", () => {
    const input = [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: "q" },
      { role: "assistant" as const, content: "a" },
      { role: "user" as const, content: "[glob result]\n[]" }
    ];
    const merged = coalesceSameRole(input);
    expect(merged.map(m => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });
});
