import { afterEach, describe, expect, it, vi } from "vitest";
import { streamChat, type LlmStreamChunk } from "../src/llm/client.js";

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

  it("emits structured tool_calls when the server finishes a tool-call turn", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "read_file" } }] } }] })}`,
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
      { kind: "toolCall", name: "read_file", argsJson: "{\"path\":\"a.ts\"}", id: "0" }
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
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "write_file" } }] } }] })}`,
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
      contentBytes: 8,
      contentLines: 3,
      id: "0"
    });
    expect(chunks.findIndex(c => c.kind === "toolCallProgress")).toBeLessThan(chunks.findIndex(c => c.kind === "toolCall"));
    expect(chunks.at(-1)).toEqual({
      kind: "toolCall",
      name: "write_file",
      argsJson: "{\"path\":\"src/app.ts\",\"content\":\"one\\ntwo\\n\"}",
      id: "0"
    });
  });
});
