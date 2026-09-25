import { additionalPolicy } from "../build/networkPolicy.js";
import { validateEndpoint } from "./endpointValidator.js";

export class NetworkPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkPolicyError";
  }
}

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  additional?: boolean;
  maxResponseBytes?: number;
}

/**
 * The ONLY outbound HTTP primitive in this extension.
 *
 * Enforces two invariants:
 *  1. The requested URL's origin matches the configured endpoint's origin.
 *  2. The endpoint validates as localhost or a private IP literal.
 *
 * If either fails, the request is refused with a NetworkPolicyError —
 * the surrounding code is responsible for surfacing this to the user.
 */
export async function safeFetch(
  configuredEndpoint: string,
  requestUrl: string,
  init: SafeFetchOptions = {}
): Promise<Response> {
  let endpoint: URL;
  let target: URL;
  try {
    endpoint = new URL(configuredEndpoint);
    target = new URL(requestUrl, configuredEndpoint);
  } catch (e) {
    throw new NetworkPolicyError(`Malformed URL: ${(e as Error).message}`);
  }
  if (endpoint.origin !== target.origin) {
    throw new NetworkPolicyError(
      `Refusing to fetch ${target.origin}; only the configured endpoint origin ${endpoint.origin} is allowed.`
    );
  }
  if (init.additional) {
    if (!additionalPolicy) throw new NetworkPolicyError("Additional network requests are unavailable in this edition.");
    try { await additionalPolicy(endpoint, target); }
    catch (error) { throw new NetworkPolicyError((error as Error).message); }
  } else {
    const v = await validateEndpoint(endpoint.toString());
    if (!v.ok) throw new NetworkPolicyError(`Endpoint policy violation: ${v.error}`);
  }
  // Node 18+ has a global fetch. Endpoint validation rejects DNS hostnames,
  // so the actual connection cannot be redirected by DNS rebinding.
  // This is the only file allowed to call fetch (the ESLint config enforces it).
  // eslint-disable-next-line no-restricted-globals
  // redirect: "error" — a compromised endpoint must not be able to 307/308 the
  // request body to another origin; the origin check above only covers the
  // initial request.
  const response = await fetch(target.toString(), {
    method: init.method ?? "GET",
    headers: init.headers,
    body: init.body,
    signal: init.signal,
    redirect: "error"
  });
  if (!init.maxResponseBytes || !response.body) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      size += next.value.byteLength;
      if (size > init.maxResponseBytes) throw new NetworkPolicyError("Response exceeds the size limit.");
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers: response.headers });
}
