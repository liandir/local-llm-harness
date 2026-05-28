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

/**
 * Streams raw text deltas from a llama.cpp /v1/chat/completions endpoint.
 * llama.cpp's OpenAI-compatible server returns SSE with lines `data: {json}`
 * where json.choices[0].delta.content is the next text chunk. We pass that
 * text through unchanged to the active model-family parser.
 */
export async function* streamChat(
  endpoint: string,
  req: ChatCompletionRequest,
  signal: AbortSignal
): AsyncGenerator<string, void, void> {
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
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          const obj = JSON.parse(payload);
          const delta = obj?.choices?.[0]?.delta?.content
            ?? obj?.choices?.[0]?.text
            ?? "";
          if (delta) yield delta as string;
        } catch {
          /* ignore malformed line */
        }
      }
    }
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
  for await (const chunk of streamChat(endpoint, req, signal)) out += chunk;
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
