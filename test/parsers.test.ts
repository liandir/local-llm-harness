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

function toolProgress(events: ParsedEvent[]): { name: string; path?: string; content?: string; contentBytes: number; contentLines: number }[] {
  return events.filter((e): e is { kind: "toolCallProgress"; name: string; path?: string; content?: string; contentBytes: number; contentLines: number } => e.kind === "toolCallProgress");
}

describe("Gemma4Parser", () => {
  it("parses native Gemma read and command tool calls", () => {
    const p = new Gemma4Parser();
    const events = drain(p, [
      `<|tool_call>call:read_file{path:<|"|>src/app.ts<|"|>}<tool_call|>`,
      `<|tool_call>call:run_command{command:<|"|>npm test<|"|>}<tool_call|>`
    ]);
    const calls = toolCalls(events);
    expect(calls.map(c => c.name)).toEqual(["read_file", "run_command"]);
    expect(JSON.parse(calls[0].argsJson).path).toBe("src/app.ts");
    expect(JSON.parse(calls[1].argsJson).command).toBe("npm test");
  });

  it("preserves native Gemma multiline write content exactly", () => {
    const p = new Gemma4Parser();
    const content = "  const html = \"<div>ok</div>\";\nconsole.log(html);\n";
    const events = drain(p, [
      `<|tool_call>call:write_file{path:<|"|>src/app.ts<|"|>,content:<|"|>${content}<|"|>}<tool_call|>`
    ]);
    const tc = toolCalls(events)[0];
    const args = JSON.parse(tc.argsJson);
    expect(tc.name).toBe("write_file");
    expect(args.path).toBe("src/app.ts");
    expect(args.content).toBe(content);
  });

  it("emits native Gemma write progress before the final tool call", () => {
    const p = new Gemma4Parser();
    const first = p.feed(`<|tool_call>call:write_file{path:<|"|>src/app.ts<|"|>,content:<|"|>one\n`);
    const firstProgress = toolProgress(first);
    expect(firstProgress.at(-1)).toMatchObject({
      name: "write_file",
      path: "src/app.ts",
      content: "one\n",
      contentBytes: 4,
      contentLines: 2
    });

    const second = p.feed(`two\n`);
    const secondProgress = toolProgress(second);
    expect(secondProgress.at(-1)?.contentBytes).toBeGreaterThan(firstProgress.at(-1)?.contentBytes ?? 0);
    expect(secondProgress.at(-1)?.content).toBe("one\ntwo\n");
    expect(secondProgress.at(-1)?.contentLines).toBe(3);

    const final = p.feed(`<|"|>}<tool_call|>`);
    const events = [...first, ...second, ...final];
    expect(events.findIndex(e => e.kind === "toolCallProgress")).toBeLessThan(events.findIndex(e => e.kind === "toolCall"));
    const tc = toolCalls(final)[0];
    expect(JSON.parse(tc.argsJson).content).toBe("one\ntwo\n");
  });

  it("handles native Gemma markers split across chunk boundaries", () => {
    const p = new Gemma4Parser();
    const events = drain(p, [
      "please <|tool",
      `_call>call:list_dir{path:<|"|>.<|`,
      `"|>}<tool_`,
      "call|>"
    ]);
    const calls = toolCalls(events);
    expect(calls[0]?.name).toBe("list_dir");
    expect(JSON.parse(calls[0].argsJson).path).toBe(".");
  });

  it("parses native Gemma numbers, booleans, nulls, arrays, and nested objects", () => {
    const p = new Gemma4Parser();
    const events = drain(p, [
      `<|tool_call>call:glob{pattern:<|"|>src/**/*.ts<|"|>,maxResults:12,opts:{hidden:true,nothing:null,tags:[<|"|>a<|"|>,2,false]}}<tool_call|>`
    ]);
    const args = JSON.parse(toolCalls(events)[0].argsJson);
    expect(args).toEqual({
      pattern: "src/**/*.ts",
      maxResults: 12,
      opts: { hidden: true, nothing: null, tags: ["a", 2, false] }
    });
  });

  it("ignores Gemma tool-response sentinels", () => {
    const p = new Gemma4Parser();
    const events = drain(p, [
      `before <|tool_call>call:read_file{path:<|"|>a.ts<|"|>}<tool_call|><|tool_response>`
    ]);
    expect(toolCalls(events)).toHaveLength(1);
    expect(textOf(events)).toBe("before ");
  });

  it("emits two native Gemma tool calls when the model batches them", () => {
    const p = new Gemma4Parser();
    const events = drain(p, [
      `<|tool_call>call:read_file{path:<|"|>a.ts<|"|>}<tool_call|><|tool_call>call:read_file{path:<|"|>b.ts<|"|>}<tool_call|>`
    ]);
    const calls = toolCalls(events);
    expect(calls.map(c => JSON.parse(c.argsJson).path)).toEqual(["a.ts", "b.ts"]);
  });

  it("emits thought then text then an XML fallback tool call", () => {
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

  it("handles an XML fallback tool marker split across chunk boundaries", () => {
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

  it("emits XML fallback write progress before the final tool call", () => {
    const p = new Gemma4Parser();
    const first = p.feed("<write_file><path>src/app.ts</path><content>one\n");
    expect(toolProgress(first).at(-1)).toMatchObject({
      name: "write_file",
      path: "src/app.ts",
      content: "one\n",
      contentBytes: 4,
      contentLines: 2
    });
    const final = p.feed("two\n</content></write_file>");
    const events = [...first, ...final];
    expect(events.findIndex(e => e.kind === "toolCallProgress")).toBeLessThan(events.findIndex(e => e.kind === "toolCall"));
    expect(JSON.parse(toolCalls(final)[0].argsJson).content).toBe("one\ntwo\n");
  });

  it("preserves XML fallback content whitespace", () => {
    const p = new Gemma4Parser();
    const content = "\n  keep me\n";
    const events = drain(p, [
      `<write_file><path>src/app.ts</path><content>${content}</content></write_file>`
    ]);
    const args = JSON.parse(toolCalls(events)[0].argsJson);
    expect(args.content).toBe(content);
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

  it("emits two XML fallback tool calls when the model batches them", () => {
    const p = new Gemma4Parser();
    const events = drain(p, [
      "<read_file><path>a.ts</path></read_file><read_file><path>b.ts</path></read_file>"
    ]);
    const calls = toolCalls(events);
    expect(calls.map(c => JSON.parse(c.argsJson).path)).toEqual(["a.ts", "b.ts"]);
  });

  it("streams an unclosed <think> as thought (content is never dropped)", () => {
    const p = new Gemma4Parser();
    const events = drain(p, ["<think>oops I forgot to close and here is the answer"]);
    expect(thoughtOf(events)).toContain("here is the answer");
    expect(textOf(events)).toBe("");
  });

  it("emits a closed <think> as thought, separate from the answer text", () => {
    const p = new Gemma4Parser();
    const events = drain(p, ["<think>secret", " reasoning</think>the answer"]);
    expect(thoughtOf(events)).toBe("secret reasoning");
    expect(textOf(events)).toBe("the answer");
  });

  it("streams <think> content incrementally before the closing tag", () => {
    const p = new Gemma4Parser();
    const first = p.feed("<think>step one ");
    expect(first.some(e => e.kind === "thought")).toBe(true);
    expect(thoughtOf(first)).toBe("step one ");
    const events = [...first, ...p.feed("step two</think>answer"), ...p.end()];
    expect(thoughtOf(events)).toBe("step one step two");
    expect(textOf(events)).toBe("answer");
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

  it("emits write progress before the final tool call", () => {
    const p = new Qwen3Parser();
    const first = p.feed(`<tool_call>{"name":"write_file","arguments":{"path":"src/app.ts","content":"one\\n`);
    const firstProgress = toolProgress(first);
    expect(firstProgress.at(-1)).toMatchObject({
      name: "write_file",
      path: "src/app.ts",
      content: "one\n",
      contentBytes: 4,
      contentLines: 2
    });

    const second = p.feed(`two\\n`);
    expect(toolProgress(second).at(-1)?.contentBytes).toBeGreaterThan(firstProgress.at(-1)?.contentBytes ?? 0);
    expect(toolProgress(second).at(-1)?.content).toBe("one\ntwo\n");
    const final = p.feed(`"}}</tool_call>`);
    const events = [...first, ...second, ...final];
    expect(events.findIndex(e => e.kind === "toolCallProgress")).toBeLessThan(events.findIndex(e => e.kind === "toolCall"));
    expect(JSON.parse(toolCalls(final)[0].argsJson).content).toBe("one\ntwo\n");
  });

  it("does NOT execute tool tags shown inside a ``` code fence", () => {
    const p = new Qwen3Parser();
    const events = drain(p, [
      "Example:\n```\n<tool_call>{\"name\":\"read_file\",\"arguments\":{\"path\":\"x\"}}</tool_call>\n```\nDone."
    ]);
    expect(toolCalls(events)).toHaveLength(0);
    expect(textOf(events)).toContain("<tool_call>");
  });

  it("still runs a real tool call after a fenced Qwen example", () => {
    const p = new Qwen3Parser();
    const events = drain(p, [
      "```\n<tool_call>{\"name\":\"glob\",\"arguments\":{\"pattern\":\"*.ts\"}}</tool_call>\n```\nNow:\n",
      "<tool_call>{\"name\":\"glob\",\"arguments\":{\"pattern\":\"src/*.ts\"}}</tool_call>"
    ]);
    const calls = toolCalls(events);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].argsJson).pattern).toBe("src/*.ts");
  });

  it("streams an unclosed <think> as thought (content is never dropped)", () => {
    const p = new Qwen3Parser();
    const events = drain(p, ["<think>no close and the final answer"]);
    expect(thoughtOf(events)).toContain("the final answer");
    expect(textOf(events)).toBe("");
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
