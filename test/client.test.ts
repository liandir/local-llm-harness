import { afterEach, describe, expect, it, vi } from "vitest";
import { streamChat } from "../src/llm/client.js";

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

    for await (const _ of streamChat("http://127.0.0.1:8080", { messages }, new AbortController().signal)) {
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
});
