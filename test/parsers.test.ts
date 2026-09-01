import { describe, it, expect } from "vitest";
import { Gemma4Parser } from "../src/llm/parser/gemma4.js";
import { Qwen3Parser } from "../src/llm/parser/qwen3.js";
import { MuseGlimmerParser } from "../src/llm/parser/museGlimmer.js";
import { GptOssParser } from "../src/llm/parser/gptOss.js";
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

function toolProgress(events: ParsedEvent[]): Extract<ParsedEvent, { kind: "toolCallProgress" }>[] {
  return events.filter((e): e is Extract<ParsedEvent, { kind: "toolCallProgress" }> => e.kind === "toolCallProgress");
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

  it("parses native Gemma line edit tool calls", () => {
    const p = new Gemma4Parser();
    const events = drain(p, [
      `<|tool_call>call:insert_text{path:<|"|>src/app.ts<|"|>,line:1,expectedLine:<|"|>const old = true;<|"|>,text:<|"|>/** Header */\n<|"|>}<tool_call|>`,
      `<|tool_call>call:replace_range{path:<|"|>src/app.ts<|"|>,startLine:2,endLine:3,expectedContent:<|"|>old two\nold three<|"|>,content:<|"|>updated\n<|"|>}<tool_call|>`
    ]);
    const calls = toolCalls(events);
    expect(calls.map(c => c.name)).toEqual(["insert_text", "replace_range"]);
    expect(JSON.parse(calls[0].argsJson)).toMatchObject({ path: "src/app.ts", line: 1, text: "/** Header */\n" });
    expect(JSON.parse(calls[0].argsJson)).toMatchObject({ expectedLine: "const old = true;" });
    expect(JSON.parse(calls[1].argsJson)).toMatchObject({
      path: "src/app.ts",
      startLine: 2,
      endLine: 3,
      expectedContent: "old two\nold three",
      content: "updated\n"
    });
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

  it("emits native Gemma progress for line-edit tools before the final call", () => {
    const p = new Gemma4Parser();
    const insert = p.feed(`<|tool_call>call:insert_text{path:<|"|>src/app.ts<|"|>,line:1,text:<|"|>one\n`);
    expect(toolProgress(insert).at(-1)).toMatchObject({
      name: "insert_text",
      path: "src/app.ts",
      line: 1,
      content: "one\n",
      contentLines: 2
    });
    const insertFinal = p.feed(`<|"|>}<tool_call|>`);
    expect([...insert, ...insertFinal].findIndex(e => e.kind === "toolCallProgress"))
      .toBeLessThan([...insert, ...insertFinal].findIndex(e => e.kind === "toolCall"));

    const replace = p.feed(`<|tool_call>call:replace_range{path:<|"|>src/app.ts<|"|>,startLine:2,endLine:3,content:<|"|>updated\n`);
    expect(toolProgress(replace).at(-1)).toMatchObject({
      name: "replace_range",
      path: "src/app.ts",
      content: "updated\n",
      startLine: 2,
      endLine: 3
    });
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

  it("parses a JSON-bodied update_todos XML fallback", () => {
    const p = new Gemma4Parser();
    const todos = [
      { content: "Inspect files", status: "in_progress" },
      { content: "Implement change", status: "pending" }
    ];
    const events = drain(p, [
      `<update_`,
      `todos>${JSON.stringify({ todos })}</update_todos>`
    ]);
    const calls = toolCalls(events);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("update_todos");
    expect(JSON.parse(calls[0].argsJson)).toEqual({ todos });
    expect(textOf(events)).toBe("");
  });

  it("recognizes ask_user_question in the XML fallback", () => {
    const p = new Gemma4Parser();
    const events = drain(p, [
      `<ask_user_question>{"question":"Choose?","suggestions":["A","B"]}</ask_user_question>`
    ]);
    const call = toolCalls(events)[0];
    expect(call.name).toBe("ask_user_question");
    expect(JSON.parse(call.argsJson)).toEqual({ question: "Choose?", suggestions: ["A", "B"] });
  });

  it("parses XML fallback line edit tools", () => {
    const p = new Gemma4Parser();
    const events = drain(p, [
      "<insert_text><path>src/app.ts</path><line>1</line><text>/** Header */\n</text></insert_text>",
      "<replace_range><path>src/app.ts</path><startLine>2</startLine><endLine>3</endLine><content>updated\n</content></replace_range>"
    ]);
    const calls = toolCalls(events);
    expect(calls.map(c => c.name)).toEqual(["insert_text", "replace_range"]);
    expect(JSON.parse(calls[0].argsJson).text).toBe("/** Header */\n");
    expect(JSON.parse(calls[1].argsJson).content).toBe("updated\n");
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

  it("preserves whitespace and source-like tags in XML edit preconditions", () => {
    const p = new Gemma4Parser();
    const events = drain(p, [
      "<replace_range><path>src/app.ts</path><startLine>2</startLine><endLine>2</endLine>",
      "<expectedContent>  <div>old</div></expectedContent><content>  <div>new</div>\n</content></replace_range>"
    ]);
    const call = events.find(e => e.kind === "toolCall");
    expect(call?.kind).toBe("toolCall");
    if (call?.kind !== "toolCall") return;
    expect(JSON.parse(call.argsJson)).toMatchObject({
      expectedContent: "  <div>old</div>",
      content: "  <div>new</div>\n"
    });
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

  it("emits XML fallback progress for insert_text via its <text> tag", () => {
    const p = new Gemma4Parser();
    const first = p.feed("<insert_text><path>src/app.ts</path><line>1</line><text>one\n");
    expect(toolProgress(first).at(-1)).toMatchObject({
      name: "insert_text",
      path: "src/app.ts",
      content: "one\n",
      contentLines: 2
    });
    const final = p.feed("two\n</text></insert_text>");
    const events = [...first, ...final];
    expect(events.findIndex(e => e.kind === "toolCallProgress")).toBeLessThan(events.findIndex(e => e.kind === "toolCall"));
    expect(JSON.parse(toolCalls(final)[0].argsJson).text).toBe("one\ntwo\n");
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

  it("accepts a named <tool_call> fallback with a JSON argument body", () => {
    const p = new Gemma4Parser();
    const events = drain(p, [
      `before <tool_call name="list_dir">{"path":"."}</tool_call> after`
    ]);
    const calls = toolCalls(events);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("list_dir");
    expect(JSON.parse(calls[0].argsJson)).toEqual({ path: "." });
    expect(textOf(events)).toBe("before  after");
  });

  it("parses a chunked named fallback for line-edit tools", () => {
    const p = new Gemma4Parser();
    const events = drain(p, [
      `<tool_call na`,
      `me='replace_range'>{"path":"src/app.ts","startLine":2,`,
      `"endLine":3,"content":"updated\\n"}</tool_call>`
    ]);
    const calls = toolCalls(events);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("replace_range");
    expect(JSON.parse(calls[0].argsJson)).toEqual({
      path: "src/app.ts",
      startLine: 2,
      endLine: 3,
      content: "updated\n"
    });
    expect(textOf(events)).toBe("");
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

  it("surfaces an unclosed native Gemma tool call at stream end instead of dropping it", () => {
    const p = new Gemma4Parser();
    const events = drain(p, [`<|tool_call>call:write_file{path:<|"|>a.txt<|"|>,content:<|"|>partial conten`]);
    const calls = toolCalls(events);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("");
    expect(calls[0].argsJson).toContain("call:write_file");
  });

  it("executes an unclosed native Gemma call whose body is complete", () => {
    const p = new Gemma4Parser();
    const events = drain(p, [`<|tool_call>call:read_file{path:<|"|>src/app.ts<|"|>}`]);
    const calls = toolCalls(events);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("read_file");
    expect(JSON.parse(calls[0].argsJson).path).toBe("src/app.ts");
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

  it("parses Qwen3-Coder function and parameter tool calls", () => {
    const p = new Qwen3Parser();
    const events = drain(p, [
      "<tool_call><function=replace_range>",
      "<parameter=path>src/app.ts</parameter>",
      "<parameter=startLine>2</parameter><parameter=endLine>3</parameter>",
      "<parameter=content>updated\nlines\n</parameter>",
      "</function></tool_call>"
    ]);
    const call = toolCalls(events)[0];
    expect(call.name).toBe("replace_range");
    expect(JSON.parse(call.argsJson)).toEqual({
      path: "src/app.ts",
      startLine: 2,
      endLine: 3,
      content: "updated\nlines"
    });
  });

  it("preserves whitespace in single-line Qwen source-text parameters", () => {
    const p = new Qwen3Parser();
    const events = drain(p, [
      "<tool_call><function=insert_text>",
      "<parameter=path> src/Game.tsx </parameter>",
      "<parameter=line>189</parameter>",
      "<parameter=expectedLine>  // Keyboard event handlers</parameter>",
      "<parameter=text>    installHandlers();  </parameter>",
      "</function></tool_call>"
    ]);

    const args = JSON.parse(toolCalls(events)[0].argsJson);
    expect(args.path).toBe("src/Game.tsx");
    expect(args.line).toBe(189);
    expect(args.expectedLine).toBe("  // Keyboard event handlers");
    expect(args.text).toBe("    installHandlers();  ");
  });

  it("recovers only function XML when used at the native-text boundary", () => {
    const p = new Qwen3Parser("function-xml-only");
    const events = drain(p, [
      'Example: <tool_call>{"name":"read_file","arguments":{"path":"secret"}}</tool_call>\n',
      "```\n<tool_call><function=read_file><parameter=path>also-secret</parameter></function></tool_call>\n```\n",
      "<tool_call><function=list_dir><parameter=path>src</parameter></function></tool_call>"
    ]);
    expect(toolCalls(events)).toHaveLength(1);
    expect(toolCalls(events)[0].name).toBe("list_dir");
    expect(JSON.parse(toolCalls(events)[0].argsJson)).toEqual({ path: "src" });
    expect(textOf(events)).toContain('Example: <tool_call>{"name":"read_file"');
    expect(textOf(events)).toContain("also-secret");
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

  it("surfaces the replace_range bounds in streaming progress", () => {
    const p = new Qwen3Parser();
    const progress = toolProgress(
      p.feed(`<tool_call>{"name":"replace_range","arguments":{"path":"src/app.ts","startLine":2,"endLine":5,"content":"new\\n`)
    );
    expect(progress.at(-1)).toMatchObject({
      name: "replace_range",
      path: "src/app.ts",
      startLine: 2,
      endLine: 5
    });
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

  it("recovers a simple Python-style single-quoted tool call", () => {
    const p = new Qwen3Parser();
    const events = drain(p, [`<tool_call>{'name': 'list_dir', 'arguments': {'path': '.'}}</tool_call>`]);
    const calls = toolCalls(events);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("list_dir");
    expect(JSON.parse(calls[0].argsJson)).toEqual({ path: "." });
  });

  it("recovers literal newlines inside a JSON source payload", () => {
    const p = new Qwen3Parser();
    const events = drain(p, [
      `<tool_call>{"name":"replace_range","arguments":{"path":"src/app.ts","startLine":1,"endLine":1,"expectedContent":"old","content":"first\nsecond\n"}}</tool_call>`
    ]);
    const call = toolCalls(events)[0];
    expect(call.name).toBe("replace_range");
    expect(JSON.parse(call.argsJson).content).toBe("first\nsecond\n");
  });

  it("surfaces an irreparable call with a specific parser error", () => {
    const p = new Qwen3Parser();
    const events = drain(p, [`<tool_call>{"name":"list_dir","arguments":{"path":???}}</tool_call>`]);
    const call = events.find((event): event is Extract<ParsedEvent, { kind: "toolCall" }> => event.kind === "toolCall");
    expect(call?.name).toBe("");
    expect(call?.argsJson).toContain("???");
    expect(call?.parseError).toMatch(/JSON|position|unexpected|property/i);
  });

  it("surfaces an unclosed <tool_call> at stream end instead of dropping it", () => {
    const p = new Qwen3Parser();
    const events = drain(p, [`<tool_call>{"name":"read_file","arguments":{"path":"src/ma`]);
    const calls = toolCalls(events);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("");
    expect(calls[0].argsJson).toContain(`"read_file"`);
  });

  it("executes an unclosed <tool_call> whose body is complete JSON", () => {
    const p = new Qwen3Parser();
    const events = drain(p, [`<tool_call>{"name":"list_dir","arguments":{"path":"."}}`]);
    const calls = toolCalls(events);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("list_dir");
    expect(JSON.parse(calls[0].argsJson).path).toBe(".");
  });

  it("streams an unclosed <think> as thought (content is never dropped)", () => {
    const p = new Qwen3Parser();
    const events = drain(p, ["<think>no close and the final answer"]);
    expect(thoughtOf(events)).toContain("the final answer");
    expect(textOf(events)).toBe("");
  });
});

describe("GptOssParser", () => {
  it("separates Harmony reasoning, commentary, tool calls, and final text", () => {
    const events = drain(new GptOssParser(), [
      "<|chan",
      "nel|>analysis<|message|>I should inspect the file.<|end|>",
      "<|start|>assistant<|channel|>commentary<|message|>I’ll inspect it now.<|end|>",
      "<|start|>assistant<|channel|>commentary to=functions.read_file <|constrain|>json<|message|>",
      '{"path":"src/app.ts"}<|call|>',
      "<|start|>assistant<|channel|>final<|message|>Done.<|return|>"
    ]);

    expect(thoughtOf(events)).toBe("I should inspect the file.");
    expect(textOf(events)).toBe("I’ll inspect it now.Done.");
    expect(toolCalls(events)).toEqual([{
      kind: "toolCall",
      name: "read_file",
      argsJson: '{"path":"src/app.ts"}'
    }]);
  });

  it("passes ordinary prose and tool-looking examples through without executing them", () => {
    const text = "Example: to=functions.read_file with {\"path\":\"secret\"}.";
    const events = drain(new GptOssParser(), [text]);
    expect(textOf(events)).toBe(text);
    expect(toolCalls(events)).toHaveLength(0);
  });

  it("streams write progress from Harmony JSON before completing the call", () => {
    const parser = new GptOssParser();
    const first = parser.feed(
      "<|channel|>commentary to=functions.write_file<|constrain|>json<|message|>" +
      '{"path":"src/app.ts","content":"one\\n'
    );
    expect(toolProgress(first).at(-1)).toMatchObject({
      name: "write_file",
      path: "src/app.ts",
      content: "one\n"
    });
    const final = parser.feed('two\\n"}<|call|>');
    expect(JSON.parse(toolCalls(final)[0].argsJson).content).toBe("one\ntwo\n");
  });

  it("surfaces a truncated Harmony call as malformed instead of dropping it", () => {
    const events = drain(new GptOssParser(), [
      '<|channel|>commentary to=functions.read_file<|constrain|>json<|message|>{"path":"src/ma'
    ]);
    const call = events.find(event => event.kind === "toolCall");
    expect(call).toMatchObject({ kind: "toolCall", name: "" });
    if (call?.kind === "toolCall") expect(call.parseError).toContain("Incomplete GPT-OSS Harmony tool call");
  });
});

describe("MuseGlimmerParser", () => {
  it("separates recipient reasoning and answer channels across chunks", () => {
    const events = drain(new MuseGlimmerParser(), [
      "to=se", "lf<|message|>inspect first<|eo", "m|><|start|>assistant to=user<|message|>done<|eot|>"
    ]);
    expect(thoughtOf(events)).toBe("inspect first");
    expect(textOf(events)).toBe("done");
  });

  it("parses repeated ATEM calls and typed parameters", () => {
    const events = drain(new MuseGlimmerParser(), [
      `<|start|>assistant to=read_file<|message|><atem:function_calls>\n`,
      `<atem:invoke name="read_file"><atem:parameter name="path"> src/a.ts </atem:parameter>`,
      `<atem:parameter name="startLine">2</atem:parameter></atem:invoke>`,
      `<atem:invoke name="glob"><atem:parameter name="pattern">src/**/*.ts</atem:parameter>`,
      `<atem:parameter name="options">{"hidden":true}</atem:parameter></atem:invoke>`,
      `</atem:function_calls><|eot|>`
    ]);
    const calls = toolCalls(events);
    expect(calls.map(call => call.name)).toEqual(["read_file", "glob"]);
    expect(JSON.parse(calls[0].argsJson)).toEqual({ path: "src/a.ts", startLine: 2 });
    expect(JSON.parse(calls[1].argsJson)).toEqual({ pattern: "src/**/*.ts", options: { hidden: true } });
  });

  it("preserves multiline source parameters and emits write progress", () => {
    const parser = new MuseGlimmerParser();
    const first = parser.feed(
      `to=write_file<|message|><atem:function_calls><atem:invoke name="write_file">` +
      `<atem:parameter name="path">src/a.ts</atem:parameter>` +
      `<atem:parameter name="content">  const x = 1;\n`
    );
    expect(toolProgress(first).at(-1)).toMatchObject({
      name: "write_file",
      path: "src/a.ts",
      content: "  const x = 1;\n"
    });
    const events = [...first, ...parser.feed(`</atem:parameter></atem:invoke></atem:function_calls><|eot|>`), ...parser.end()];
    expect(JSON.parse(toolCalls(events)[0].argsJson).content).toBe("  const x = 1;\n");
  });

  it("does not execute ATEM syntax inside a code fence", () => {
    const raw = `\`\`\`xml\n<atem:function_calls><atem:invoke name="read_file"><atem:parameter name="path">secret</atem:parameter></atem:invoke></atem:function_calls>\n\`\`\``;
    const events = drain(new MuseGlimmerParser(), [raw]);
    expect(toolCalls(events)).toHaveLength(0);
    expect(textOf(events)).toContain("<atem:invoke");
  });

  it("surfaces an incomplete ATEM invocation as malformed", () => {
    const events = drain(new MuseGlimmerParser(), [
      `<atem:function_calls><atem:invoke name="read_file"><atem:parameter name="path">src/a.ts`
    ]);
    const call = toolCalls(events)[0];
    expect(call.name).toBe("");
    expect(call.argsJson).toContain("src/a.ts");
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
