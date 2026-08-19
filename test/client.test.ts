import { afterEach, describe, expect, it, vi } from "vitest";
import {
  complete,
  fetchServerMetadata,
  MalformedNativeToolCallError,
  NativeToolsUnsupportedError,
  streamChat,
  type LlmStreamChunk
} from "../src/llm/client.js";
import { asOpenAiTools, toolsForMode } from "../src/tools/toolDefinitions.js";

function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line + "\n"));
      controller.close();
    }
  }), { status: 200 });
}

describe("OpenAI-compatible client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends standard chat-completions messages, including assistant history", async () => {
    const fetchMock = vi.fn(async () => sseResponse(["data: [DONE]"]));
    vi.stubGlobal("fetch", fetchMock);

    const messages = [
      { role: "system" as const, content: "system" },
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi" },
      { role: "user" as const, content: "next question" }
    ];

    for await (const chunk of streamChat("http://127.0.0.1:8080", { messages }, new AbortController().signal)) {
      void chunk;
      // drain
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { messages: typeof messages };
    expect(body.messages).toEqual(messages);
  });

  it("forwards a per-request llama.cpp reasoning budget", async () => {
    const fetchMock = vi.fn(async () => sseResponse(["data: [DONE]"]));
    vi.stubGlobal("fetch", fetchMock);

    for await (const chunk of streamChat("http://127.0.0.1:8080", {
      messages: [{ role: "user", content: "name this chat" }],
      thinking_budget_tokens: 128
    }, new AbortController().signal)) {
      void chunk;
    }

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { thinking_budget_tokens?: number };
    expect(body.thinking_budget_tokens).toBe(128);
  });

  it("reports when llama.cpp has accepted a streaming request", async () => {
    const accepted = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(["data: [DONE]"])));

    for await (const chunk of streamChat("http://127.0.0.1:8080", {
      messages: [{ role: "user", content: "hello" }],
      onResponseAccepted: accepted
    }, new AbortController().signal)) {
      void chunk;
    }

    expect(accepted).toHaveBeenCalledTimes(1);
  });

  it("reads the model alias and context length from llama.cpp props", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      model_alias: "gemma-4-31b-it",
      model_path: "/models/fallback.gguf",
      default_generation_settings: { n_ctx: 65536 }
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchServerMetadata("http://127.0.0.1:8080/v1", true)).resolves.toEqual({
      modelAlias: "gemma-4-31b-it",
      contextSize: 65536
    });
    const [requestedUrl] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(requestedUrl).toBe("http://127.0.0.1:8080/props");
  });

  it("uses the model filename when an older props response has no alias", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      model_path: "/models/qwen3-coder.gguf",
      default_generation_settings: { n_ctx: 32768 }
    }), { status: 200 })));

    await expect(fetchServerMetadata("http://127.0.0.1:8080", true)).resolves.toEqual({
      modelAlias: "qwen3-coder.gguf",
      contextSize: 32768
    });
  });

  it("rejects endpoint metadata without a usable context length", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      model_alias: "model",
      default_generation_settings: {}
    }), { status: 200 })));

    await expect(fetchServerMetadata("http://127.0.0.1:8080", true)).rejects.toThrow("valid context length");
  });

  it("streams reasoning_content separately from visible text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "answer" } }] })}`,
      "data: [DONE]"
    ])));

    const chunks = [];
    for await (const chunk of streamChat(
      "http://127.0.0.1:8080",
      { messages: [{ role: "user", content: "hello" }] },
      new AbortController().signal
    )) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { kind: "thought", text: "thinking" },
      { kind: "text", text: "answer" }
    ]);
  });

  it("reports the server finish reason for a thought-only completion", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
      "data: [DONE]"
    ])));

    const chunks = [];
    for await (const chunk of streamChat(
      "http://127.0.0.1:8080",
      { messages: [{ role: "user", content: "hello" }] },
      new AbortController().signal
    )) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { kind: "thought", text: "thinking" },
      { kind: "finish", reason: "stop" }
    ]);
  });

  it("can retain visible output from an intentionally capped auxiliary completion", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Review fixes plan implementation" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}`,
      "data: [DONE]"
    ])));

    await expect(complete(
      "http://127.0.0.1:8080",
      { messages: [{ role: "user", content: "name this chat" }], max_tokens: 32 },
      new AbortController().signal,
      { acceptPartialOnLength: true }
    )).resolves.toBe("Review fixes plan implementation");
  });

  it("returns only the visible answer from a reasoning completion", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "I should summarize this request." } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Are all fixes implemented?" } }] })}`,
      "data: [DONE]"
    ])));

    await expect(complete(
      "http://127.0.0.1:8080",
      { messages: [{ role: "user", content: "summarize this" }], max_tokens: 512 },
      new AbortController().signal
    )).resolves.toBe("Are all fixes implemented?");
  });

  it("emits structured tool_calls when the server finishes a tool-call turn", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_read", function: { name: "read_file" } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"path\":" } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"a.ts\"}" } }] }, finish_reason: "tool_calls" }] })}`,
      "data: [DONE]"
    ])));

    const chunks = [];
    for await (const chunk of streamChat(
      "http://127.0.0.1:8080",
      { messages: [{ role: "user", content: "read a file" }] },
      new AbortController().signal
    )) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { kind: "toolCall", name: "read_file", argsJson: "{\"path\":\"a.ts\"}", id: "call_read" }
    ]);
  });

  it("throws when the server reports a length-limited generation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}`,
      "data: [DONE]"
    ])));

    const chunks: LlmStreamChunk[] = [];
    await expect((async () => {
      for await (const chunk of streamChat(
        "http://127.0.0.1:8080",
        { messages: [{ role: "user", content: "hello" }] },
        new AbortController().signal
      )) {
        chunks.push(chunk);
      }
    })()).rejects.toThrow("finish_reason=\"length\"");

    expect(chunks).toEqual([
      { kind: "text", text: "partial" }
    ]);
  });

  it("emits structured write progress before the final tool call", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_write", function: { name: "write_file" } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"path\":\"src/app.ts\"," } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"content\":\"one\\n" } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "two\\n\"}" } }] }, finish_reason: "tool_calls" }] })}`,
      "data: [DONE]"
    ])));

    const chunks = [];
    for await (const chunk of streamChat(
      "http://127.0.0.1:8080",
      { messages: [{ role: "user", content: "edit a file" }] },
      new AbortController().signal
    )) {
      chunks.push(chunk);
    }

    const progress = chunks.filter(c => c.kind === "toolCallProgress");
    expect(progress.at(-1)).toMatchObject({
      kind: "toolCallProgress",
      name: "write_file",
      path: "src/app.ts",
      content: "one\ntwo\n",
      contentBytes: 8,
      contentLines: 3,
      id: "call_write"
    });
    expect(chunks.findIndex(c => c.kind === "toolCallProgress")).toBeLessThan(chunks.findIndex(c => c.kind === "toolCall"));
    expect(chunks.at(-1)).toEqual({
      kind: "toolCall",
      name: "write_file",
      argsJson: "{\"path\":\"src/app.ts\",\"content\":\"one\\ntwo\\n\"}",
      id: "call_write"
    });
  });

  it("shows a native edit_file as soon as its streamed function name is known", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_edit", function: { name: "edit_file" } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"path\":\"src/app.ts\",\"baseRevision\":\"sha256:abc\",\"edits\":[{\"oldText\":\"old\",\"newText\":\"new" } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: " text\"}]}" } }] }, finish_reason: "tool_calls" }] })}`,
      "data: [DONE]"
    ])));

    const chunks = [];
    for await (const chunk of streamChat(
      "http://127.0.0.1:8080",
      { messages: [{ role: "user", content: "edit a file" }] },
      new AbortController().signal
    )) {
      chunks.push(chunk);
    }

    expect(chunks[0]).toMatchObject({
      kind: "toolCallProgress",
      name: "edit_file",
      contentBytes: 0,
      contentLines: 0,
      id: "call_edit"
    });
    expect(chunks.filter(c => c.kind === "toolCallProgress").at(-1)).toMatchObject({
      name: "edit_file",
      path: "src/app.ts",
      content: "new text",
      contentLines: 1
    });
    expect(chunks.findIndex(c => c.kind === "toolCallProgress"))
      .toBeLessThan(chunks.findIndex(c => c.kind === "toolCall"));
  });

  it("sends canonical tools and disables parallel calls by default", async () => {
    const fetchMock = vi.fn(async () => sseResponse(["data: [DONE]"]));
    vi.stubGlobal("fetch", fetchMock);
    const tools = asOpenAiTools(toolsForMode(true));

    for await (const chunk of streamChat(
      "http://127.0.0.1:8080",
      { messages: [{ role: "user", content: "inspect" }], tools },
      new AbortController().signal
    )) { void chunk; }

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.tools).toEqual(tools);
    expect(body.tool_choice).toBe("auto");
    expect(body.parallel_tool_calls).toBe(false);
    expect(tools.map(tool => tool.function.name)).toEqual(["read_file", "list_dir", "glob", "ask_user_question"]);
  });

  it("offers argv-based execution to native models instead of the legacy shell-string tool", () => {
    const names = toolsForMode(false, "native").map(tool => tool.name);
    expect(names).toContain("run_process");
    expect(names).not.toContain("run_command");
    expect(names).toContain("create_file");
    expect(names).toContain("edit_file");
    expect(names).not.toContain("write_file");
    expect(names).toContain("insert_text");
    expect(names).toContain("replace_range");
    const process = toolsForMode(false, "native").find(tool => tool.name === "run_process")!;
    expect(process.parameters.properties.args.items).toEqual({ type: "string" });
  });

  it("reports an explicit server rejection so auto mode can use the legacy adapter", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "tools param requires --jinja flag",
      { status: 400 }
    )));
    const tools = asOpenAiTools(toolsForMode(false));

    await expect((async () => {
      for await (const chunk of streamChat(
        "http://127.0.0.1:8080",
        { messages: [{ role: "user", content: "inspect" }], tools },
        new AbortController().signal
      )) { void chunk; }
    })()).rejects.toBeInstanceOf(NativeToolsUnsupportedError);
  });

  it("classifies a server-side native argument parse failure for bounded recovery", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 500, message: "Failed to parse tool call arguments as JSON: json.exception.parse_error.101 unexpected end of input" } }),
      { status: 500 }
    )));
    const tools = asOpenAiTools(toolsForMode(false));

    await expect((async () => {
      for await (const chunk of streamChat(
        "http://127.0.0.1:8080",
        { messages: [{ role: "user", content: "inspect" }], tools },
        new AbortController().signal
      )) { void chunk; }
    })()).rejects.toBeInstanceOf(MalformedNativeToolCallError);
  });
});
