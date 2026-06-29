import { safeFetch } from "../network/safeFetch.js";
import { progressSignature, writeProgressFromJsonToolBody } from "./toolProgress.js";

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
}

export interface ChatCompletionRequest {
  messages: LlmMessage[];
  temperature?: number;
  top_k?: number;
  top_p?: number;
  max_tokens?: number;
}

export type LlmStreamChunk =
  | { kind: "text"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "toolCallProgress"; name: string; path?: string; content?: string; contentBytes: number; contentLines: number; startLine?: number; endLine?: number; id?: string }
  | { kind: "toolCall"; name: string; argsJson: string; id?: string };

interface ToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface StreamChoice {
  delta?: {
    content?: unknown;
    reasoning_content?: unknown;
    reasoning?: unknown;
    thought?: unknown;
    tool_calls?: ToolCallDelta[];
  };
  text?: unknown;
  reasoning_content?: unknown;
  finish_reason?: unknown;
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
      // llama.cpp accepts its native sampling params alongside the OpenAI
      // fields; undefined values are dropped so the server defaults apply.
      top_k: req.top_k,
      top_p: req.top_p,
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
  const toolAcc = new Map<number, { name: string; args: string; id?: string; lastProgressSignature?: string }>();
  const collectToolCalls = (delta: { tool_calls?: ToolCallDelta[] }): LlmStreamChunk[] => {
    const out: LlmStreamChunk[] = [];
    const calls = delta?.tool_calls;
    if (!Array.isArray(calls)) return out;
    for (const c of calls) {
      const idx = typeof c.index === "number" ? c.index : 0;
      const cur = toolAcc.get(idx) ?? { name: "", args: "" };
      if (c.id) cur.id = c.id;
      if (c.function?.name) cur.name = c.function.name;
      if (typeof c.function?.arguments === "string") cur.args += c.function.arguments;
      toolAcc.set(idx, cur);
      const progress = writeProgressFromJsonToolBody(cur.args, cur.name);
      if (!progress) continue;
      const signature = progressSignature(progress);
      if (signature === cur.lastProgressSignature) continue;
      cur.lastProgressSignature = signature;
      out.push({ kind: "toolCallProgress", ...progress, id: cur.id ?? String(idx) });
    }
    return out;
  };
  const flushToolCalls = (): LlmStreamChunk[] => {
    const out: LlmStreamChunk[] = [];
    for (const [idx, v] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
      if (v.name) out.push({ kind: "toolCall", name: v.name, argsJson: v.args.trim() || "{}", id: v.id ?? String(idx) });
    }
    toolAcc.clear();
    return out;
  };

  let finished = false;
  let sawText = false;
  let sawTool = false;
  let lastFinishReason: string | undefined;
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
        let obj: { choices?: StreamChoice[] };
        try {
          obj = JSON.parse(payload) as { choices?: StreamChoice[] };
        } catch {
          continue;
        }
        const choice = obj.choices?.[0];
        const delta = choice?.delta ?? {};
        for (const tc of collectToolCalls(delta)) yield tc;
        const thought = delta.reasoning_content
          ?? delta.reasoning
          ?? delta.thought
          ?? choice?.reasoning_content
          ?? "";
        const text = delta.content
          ?? choice?.text
          ?? "";
        if (thought) yield { kind: "thought", text: String(thought) };
        if (text) { sawText = true; yield { kind: "text", text: String(text) }; }

        const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined;
        if (finishReason) lastFinishReason = finishReason;
        if (finishReason === "tool_calls") {
          for (const tc of flushToolCalls()) { sawTool = true; yield tc; }
          finished = true;
          break;
        }
        if (finishReason === "length") {
          throw new Error(
            "LLM generation stopped early because llama.cpp reported finish_reason=\"length\". " +
            "The model reached its output or context limit; compact context before retrying, " +
            "or restart the server with a larger --ctx-size if its window is smaller than the configured context size."
          );
        }
      }
    }
    // Emit any structured tool calls collected from delta.tool_calls.
    for (const tc of flushToolCalls()) { sawTool = true; yield tc; }
    // A stream that produced neither visible text nor a tool call is the
    // "model stopped without a reply" case — log finish_reason to help diagnose
    // stop-token / template issues (the session surfaces a user-facing notice).
    if (!sawText && !sawTool) {
      console.warn(`[llm] stream produced no text or tool call; finish_reason=${lastFinishReason ?? "none"}`);
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
  for await (const chunk of streamChat(endpoint, req, signal)) {
    if (chunk.kind === "text") out += chunk.text;
  }
  return out;
}

const serverCtxCache = new Map<string, { value: number | undefined; at: number }>();
const SERVER_CTX_TTL_MS = 60_000;

/**
 * The server's actual per-slot context window, from llama.cpp's GET /props
 * (`default_generation_settings.n_ctx`). The configured contextSize setting is
 * only an upper bound the user believes in; if the server was started with a
 * smaller --ctx-size, generation hits finish_reason="length" long before the
 * configured limit. Returns undefined when the endpoint does not expose it.
 */
export async function fetchServerContextSize(endpoint: string): Promise<number | undefined> {
  const cached = serverCtxCache.get(endpoint);
  if (cached && Date.now() - cached.at < SERVER_CTX_TTL_MS) return cached.value;
  let value: number | undefined;
  try {
    const res = await safeFetch(endpoint, new URL("/props", endpoint).toString(), {});
    if (res.ok) {
      const obj = (await res.json()) as { default_generation_settings?: { n_ctx?: unknown } };
      const n = obj.default_generation_settings?.n_ctx;
      if (typeof n === "number" && Number.isFinite(n) && n > 0) value = Math.floor(n);
    }
  } catch {
    // Endpoint offline or not llama.cpp; fall back to the configured size.
  }
  serverCtxCache.set(endpoint, { value, at: Date.now() });
  return value;
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
