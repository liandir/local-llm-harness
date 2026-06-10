import { isIP } from "node:net";

export class EndpointPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EndpointPolicyError";
  }
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
  resolved?: string[];
}

export async function validateEndpoint(rawUrl: string): Promise<ValidationResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, error: "Not a valid URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: `Protocol ${url.protocol} not allowed (use http or https).` };
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");

  if (hostname.toLowerCase() === "localhost") {
    return { ok: true, resolved: [hostname] };
  }

  if (!isIP(hostname)) {
    return {
      ok: false,
      error: "Only localhost or private IP literals are allowed.",
      resolved: [hostname]
    };
  }

  if (!isPrivateAddress(hostname)) {
    return {
      ok: false,
      error: `Endpoint uses public address ${hostname}. Only localhost or private IP literals are allowed.`,
      resolved: [hostname]
    };
  }
  return { ok: true, resolved: [hostname] };
}

export function isPrivateAddress(addr: string): boolean {
  const v = isIP(addr);
  if (v === 4) return isPrivateIPv4(addr);
  if (v === 6) return isPrivateIPv6(addr);
  return false;
}

function isPrivateIPv4(addr: string): boolean {
  const parts = addr.split(".").map(n => parseInt(n, 10));
  if (parts.length !== 4 || parts.some(p => Number.isNaN(p))) return false;
  const [a, b] = parts;
  // 127.0.0.0/8
  if (a === 127) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 link-local
  if (a === 169 && b === 254) return true;
  // 100.64.0.0/10 CGNAT (used by Tailscale)
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateIPv6(addr: string): boolean {
  const lower = addr.toLowerCase();
  if (lower === "::1") return true;
  if (lower === "::") return false;
  // fe80::/10 link-local
  if (/^fe[89ab][0-9a-f]?:/.test(lower)) return true;
  // fc00::/7 unique-local
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
  // IPv4-mapped IPv6 ::ffff:a.b.c.d
  const mapped = lower.match(/^::ffff:([\d.]+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}
