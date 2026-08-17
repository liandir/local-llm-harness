import { safeFetch } from "../network/safeFetch.js";
import { progressSignature, writeProgressFromJsonToolBody } from "./toolProgress.js";
import type { OpenAiTool } from "../tools/toolDefinitions.js";

export interface LlmToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  reasoning_content?: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: LlmToolCall[];
}

export interface ChatCompletionRequest {
  messages: LlmMessage[];
  temperature?: number;
  top_k?: number;
  top_p?: number;
  max_tokens?: number;
  /** llama.cpp extension: cap reasoning without disabling it entirely. */
  thinking_budget_tokens?: number;
  tools?: OpenAiTool[];
  tool_choice?: "auto" | "required" | "none";
  parallel_tool_calls?: boolean;
  /** Called once llama.cpp has accepted this generation request. Not sent over the wire. */
  onResponseAccepted?: () => void;
}

export class NativeToolsUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeToolsUnsupportedError";
  }
}

export class MalformedNativeToolCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedNativeToolCallError";
  }
}

class GenerationLengthError extends Error {
  constructor() {
    super(
      "LLM generation stopped early because llama.cpp reported finish_reason=\"length\". " +
      "The model reached its output or context limit; compact context before retrying, " +
      "or restart the server with a larger --ctx-size."
    );
    this.name = "GenerationLengthError";
  }
}

export type LlmStreamChunk =
  | { kind: "text"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "finish"; reason?: string }
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
      temperature: req.temperature ?? 0.3,
      // llama.cpp accepts its native sampling params alongside the OpenAI
      // fields; undefined values are dropped so the server defaults apply.
      top_k: req.top_k,
      top_p: req.top_p,
      messages: req.messages,
      max_tokens: req.max_tokens,
      thinking_budget_tokens: req.thinking_budget_tokens,
      tools: req.tools,
      tool_choice: req.tools?.length ? (req.tool_choice ?? "auto") : undefined,
      parallel_tool_calls: req.tools?.length ? (req.parallel_tool_calls ?? false) : undefined
    }),
    signal
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    if (req.tools?.length && nativeToolsUnsupported(res.status, text)) {
      throw new NativeToolsUnsupportedError(text.slice(0, 500) || `HTTP ${res.status}`);
    }
    if (req.tools?.length && malformedNativeToolCall(res.status, text)) {
      throw new MalformedNativeToolCallError(text.slice(0, 500) || `HTTP ${res.status}`);
    }
    throw new Error(`LLM endpoint returned ${res.status}: ${text.slice(0, 500)}`);
  }
  req.onResponseAccepted?.();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const generatedCallPrefix = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
      out.push({ kind: "toolCallProgress", ...progress, id: cur.id ?? `${generatedCallPrefix}_${idx}` });
    }
    return out;
  };
  const flushToolCalls = (): LlmStreamChunk[] => {
    const out: LlmStreamChunk[] = [];
    for (const [idx, v] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
      if (v.name) out.push({ kind: "toolCall", name: v.name, argsJson: v.args.trim() || "{}", id: v.id ?? `${generatedCallPrefix}_${idx}` });
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
          throw new GenerationLengthError();
        }
      }
    }
    // Emit any structured tool calls collected from delta.tool_calls.
    for (const tc of flushToolCalls()) { sawTool = true; yield tc; }
    // A stream that produced neither visible text nor a tool call is the
    // "model stopped without a reply" case — log finish_reason to help diagnose
    // stop-token / template issues (the session surfaces a user-facing notice).
    if (!sawText && !sawTool) {
      yield { kind: "finish", reason: lastFinishReason };
      console.warn(`[llm] stream produced no text or tool call; finish_reason=${lastFinishReason ?? "none"}`);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function nativeToolsUnsupported(status: number, body: string): boolean {
  if (status < 400) return false;
  const text = body.toLowerCase();
  if (text.includes("tools param requires --jinja") || text.includes("tool_choice param requires --jinja")) {
    return true;
  }
  return status < 500 && text.includes("tool") && text.includes("template") && text.includes("support");
}

function malformedNativeToolCall(status: number, body: string): boolean {
  if (status < 400) return false;
  const text = body.toLowerCase();
  return text.includes("tool call arguments")
    && (text.includes("failed to parse") || text.includes("json.exception.parse_error"));
}

/** Non-streaming convenience: collect the full text. */
export async function complete(
  endpoint: string,
  req: ChatCompletionRequest,
  signal: AbortSignal,
  options?: { acceptPartialOnLength?: boolean }
): Promise<string> {
  let out = "";
  try {
    for await (const chunk of streamChat(endpoint, req, signal)) {
      if (chunk.kind === "text") out += chunk.text;
    }
  } catch (error) {
    // Tiny auxiliary completions intentionally use a hard output cap. Their
    // visible text remains useful even when the model omits an EOS token.
    if (!(options?.acceptPartialOnLength && error instanceof GenerationLengthError)) throw error;
  }
  return out;
}

export interface ServerMetadata {
  modelAlias: string;
  contextSize: number;
}

const serverMetadataCache = new Map<string, { value: ServerMetadata; at: number }>();
const SERVER_CTX_TTL_MS = 60_000;

/**
 * Read authoritative model metadata from llama.cpp's GET /props endpoint.
 * Endpoint saving uses `force=true`; chat turns reuse the short-lived cache.
 */
export async function fetchServerMetadata(endpoint: string, force = false): Promise<ServerMetadata> {
  const cached = serverMetadataCache.get(endpoint);
  if (!force && cached && Date.now() - cached.at < SERVER_CTX_TTL_MS) return cached.value;

  const res = await safeFetch(endpoint, new URL("/props", endpoint).toString(), {
    signal: AbortSignal.timeout(5_000)
  });
  if (!res.ok) throw new Error(`llama.cpp /props returned HTTP ${res.status}.`);
  const obj = (await res.json()) as {
    model_alias?: unknown;
    model_path?: unknown;
    default_generation_settings?: { n_ctx?: unknown; model?: unknown };
  };
  const n = obj.default_generation_settings?.n_ctx;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
    throw new Error("llama.cpp /props did not report a valid context length.");
  }
  const aliasValue = obj.model_alias ?? obj.default_generation_settings?.model;
  const modelAlias = typeof aliasValue === "string" && aliasValue.trim()
    ? aliasValue.trim()
    : modelNameFromPath(obj.model_path);
  if (!modelAlias) throw new Error("llama.cpp /props did not report a model alias or model path.");

  const value = { modelAlias, contextSize: Math.floor(n) };
  serverMetadataCache.set(endpoint, { value, at: Date.now() });
  return value;
}

export async function fetchServerContextSize(endpoint: string): Promise<number | undefined> {
  try {
    return (await fetchServerMetadata(endpoint)).contextSize;
  } catch {
    return undefined;
  }
}

function modelNameFromPath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const normalized = value.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
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
