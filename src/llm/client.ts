import { safeFetch } from "../network/safeFetch.js";

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
}

export interface ChatCompletionRequest {
  messages: LlmMessage[];
  temperature?: number;
  max_tokens?: number;
}

export type LlmStreamChunk =
  | { kind: "text"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "toolCall"; name: string; argsJson: string };

interface ToolCallDelta {
  index?: number;
  function?: { name?: string; arguments?: string };
}

/**
 * Streams text and thinking deltas from a llama.cpp /v1/chat/completions endpoint.
 * llama.cpp's OpenAI-compatible server returns SSE with lines `data: {json}`
 * where json.choices[0].delta.content is the next visible text chunk. Some
 * backends expose thinking as reasoning_content/reasoning/thought deltas; those
 * are forwarded separately so the UI can render them without showing raw tokens.
 *
 * Templates run with `--jinja` may instead return structured tool calls as
 * `delta.tool_calls` fragments. Those are accumulated by index across the stream
 * and emitted as `toolCall` chunks once complete, so they aren't silently lost.
 */
export async function* streamChat(
  endpoint: string,
  req: ChatCompletionRequest,
  signal: AbortSignal
): AsyncGenerator<LlmStreamChunk, void, void> {
  const url = new URL("/v1/chat/completions", endpoint).toString();
  const res = await safeFetch(endpoint, url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({
      model: "local",
      stream: true,
      temperature: req.temperature ?? 0.7,
      messages: req.messages,
      max_tokens: req.max_tokens
    }),
    signal
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`LLM endpoint returned ${res.status}: ${text.slice(0, 500)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  // index -> accumulated structured tool call
  const toolAcc = new Map<number, { name: string; args: string }>();
  const collectToolCalls = (delta: { tool_calls?: ToolCallDelta[] }): void => {
    const calls = delta?.tool_calls;
    if (!Array.isArray(calls)) return;
    for (const c of calls) {
      const idx = typeof c.index === "number" ? c.index : 0;
      const cur = toolAcc.get(idx) ?? { name: "", args: "" };
      if (c.function?.name) cur.name = c.function.name;
      if (typeof c.function?.arguments === "string") cur.args += c.function.arguments;
      toolAcc.set(idx, cur);
    }
  };
  const flushToolCalls = (): LlmStreamChunk[] => {
    const out: LlmStreamChunk[] = [];
    for (const [, v] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
      if (v.name) out.push({ kind: "toolCall", name: v.name, argsJson: v.args.trim() || "{}" });
    }
    toolAcc.clear();
    return out;
  };

  let finished = false;
  try {
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") { finished = true; break; }
        try {
          const obj = JSON.parse(payload);
          const choice = obj?.choices?.[0];
          const delta = choice?.delta ?? {};
          collectToolCalls(delta);
          const thought = delta.reasoning_content
            ?? delta.reasoning
            ?? delta.thought
            ?? choice?.reasoning_content
            ?? "";
          const text = delta.content
            ?? choice?.text
            ?? "";
          if (thought) yield { kind: "thought", text: String(thought) };
          if (text) yield { kind: "text", text: String(text) };
          if (choice?.finish_reason === "tool_calls") {
            for (const tc of flushToolCalls()) yield tc;
            finished = true;
            break;
          }
        } catch {
          /* ignore malformed line */
        }
      }
    }
    // Emit any structured tool calls collected from delta.tool_calls.
    for (const tc of flushToolCalls()) yield tc;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Non-streaming convenience: collect the full text. */
export async function complete(
  endpoint: string,
  req: ChatCompletionRequest,
  signal: AbortSignal
): Promise<string> {
  let out = "";
  for await (const chunk of streamChat(endpoint, req, signal)) {
    if (chunk.kind === "text") out += chunk.text;
  }
  return out;
}

/** Use llama.cpp's /tokenize for authoritative token counts. */
export async function tokenize(endpoint: string, text: string): Promise<number> {
  const url = new URL("/tokenize", endpoint).toString();
  try {
    const res = await safeFetch(endpoint, url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text })
    });
    if (!res.ok) throw new Error(`tokenize ${res.status}`);
    const obj = (await res.json()) as { tokens?: number[] };
    return obj.tokens?.length ?? Math.ceil(text.length / 4);
  } catch {
    return Math.ceil(text.length / 4);
  }
}
