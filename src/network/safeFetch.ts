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
  const v = await validateEndpoint(endpoint.toString());
  if (!v.ok) {
    throw new NetworkPolicyError(`Endpoint policy violation: ${v.error}`);
  }
  // Node 18+ has a global fetch. Endpoint validation rejects DNS hostnames,
  // so the actual connection cannot be redirected by DNS rebinding.
  // This is the only file allowed to call fetch (the ESLint config enforces it).
  // eslint-disable-next-line no-restricted-globals
  return fetch(target.toString(), {
    method: init.method ?? "GET",
    headers: init.headers,
    body: init.body,
    signal: init.signal
  });
}
