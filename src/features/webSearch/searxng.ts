import { safeFetch } from "../../network/safeFetch.js";
import { additionalPolicy } from "./networkPolicy.js";

export interface SearchRequest { query: string; count: number }
export interface SearchResult { title: string; url: string; snippet: string; published?: string }
export function searchRequest(args: Record<string, unknown>): SearchRequest {
  if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 500) throw new Error("Search query must contain 1–500 characters.");
  const count = args.count ?? 5;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 10) throw new Error("Search count must be 1–10.");
  return { query: args.query.trim(), count };
}
export async function searchUrl(endpoint: string): Promise<URL> {
  if (!endpoint.trim()) throw new Error("Configure the SearXNG endpoint in Settings first.");
  const base = new URL(endpoint);
  const url = new URL(base.href);
  url.pathname = base.pathname.replace(/\/$/, "") + "/search";
  await additionalPolicy(base, url);
  return url;
}
function plain(value: unknown, limit: number): string {
  // eslint-disable-next-line no-control-regex
  return typeof value === "string" ? value.replace(/<[^>]*>/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, limit) : "";
}
export async function searchSearxng(endpoint: string, request: SearchRequest, signal?: AbortSignal): Promise<SearchResult[]> {
  const url = await searchUrl(endpoint);
  url.searchParams.set("q", request.query);
  url.searchParams.set("format", "json");
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 15000);
  try {
    const response = await safeFetch(endpoint, url.href, {
      headers: { Accept: "application/json" }, signal: controller.signal,
      additional: true, maxResponseBytes: 1024 * 1024
    });
    if (!response.ok) throw new Error(`Search service returned HTTP ${response.status}; check the endpoint and JSON-format configuration.`);
    const body: unknown = await response.json();
    const rows = body && typeof body === "object" && "results" in body ? body.results : undefined;
    if (!Array.isArray(rows)) throw new Error("Search service did not return a results array.");
    const results: SearchResult[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (!row || typeof row !== "object" || typeof row.url !== "string") continue;
      let target: URL;
      try { target = new URL(row.url); } catch { continue; }
      if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || seen.has(target.href)) continue;
      seen.add(target.href);
      results.push({ title: plain(row.title, 240), url: target.href, snippet: plain(row.content, 1600), published: plain(row.publishedDate, 100) || undefined });
      if (results.length === request.count) break;
    }
    return results;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(signal?.aborted ? "Search cancelled." : "Search timed out.");
    // Do not echo request URLs or provider bodies into the transcript.
    if (error instanceof SyntaxError) throw new Error("Search service returned invalid JSON; enable its JSON search format.");
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}
