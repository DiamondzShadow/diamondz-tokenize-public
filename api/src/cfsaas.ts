// Cloudflare for SaaS (custom hostnames) for white-label domains.
//
// A customer points `invest.theirfirm.com` (CNAME) at CF_SAAS_TARGET (default sites.tokenize.diamondz.one) and adds
// Cloudflare's ownership TXT record. Cloudflare issues and renews the certificate (HTTP validation through the CNAME)
// and sends traffic to the zone's fallback origin, which is our server.
//
// Env: CF_API_TOKEN (Zone › SSL and Certificates: Edit, Zone › DNS: Edit on the zone), CF_ZONE_ID (diamondz.one),
//      CF_SAAS_TARGET (optional), CF_API (optional, tests point it at a stand-in).

export class CfError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const api = () => (process.env.CF_API ?? "https://api.cloudflare.com/client/v4").replace(/\/+$/, "");
const zone = () => process.env.CF_ZONE_ID ?? "";
export const cfConfigured = () => !!(process.env.CF_API_TOKEN && zone());
export const saasTarget = () => (process.env.CF_SAAS_TARGET ?? "sites.tokenize.diamondz.one").toLowerCase();

async function cf<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  if (!cfConfigured()) throw new CfError(503, "Custom domains aren't connected on this server yet");
  const res = await fetch(`${api()}${path}`, {
    method,
    headers: { authorization: `Bearer ${process.env.CF_API_TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const j = (await res.json().catch(() => null)) as any;
  if (!res.ok || j?.success === false) {
    const msg = j?.errors?.map((e: any) => e?.message).filter(Boolean).join("; ") || `HTTP ${res.status}`;
    throw new CfError(res.status >= 500 ? 502 : res.status === 409 ? 409 : 400, `Cloudflare: ${msg}`);
  }
  return j?.result as T;
}

export interface CustomHostname {
  id: string; hostname: string; status: string;
  ssl?: { status?: string; validation_errors?: { message: string }[] };
  ownership_verification?: { type: string; name: string; value: string };
  verification_errors?: string[];
}

export const createHostname = (hostname: string) =>
  cf<CustomHostname>("POST", `/zones/${zone()}/custom_hostnames`, { hostname, ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } } });
export const getHostname = (id: string) => cf<CustomHostname>("GET", `/zones/${zone()}/custom_hostnames/${encodeURIComponent(id)}`);
export const deleteHostname = (id: string) => cf("DELETE", `/zones/${zone()}/custom_hostnames/${encodeURIComponent(id)}`);

/** One-time platform setup: the CNAME target exists (proxied, same origin as the main site) and is the fallback origin. */
export async function ensureFallbackOrigin(originOf: string) {
  const target = saasTarget();
  const recs = await cf<any[]>("GET", `/zones/${zone()}/dns_records?name=${encodeURIComponent(target)}`);
  if (!recs.length) {
    const src = (await cf<any[]>("GET", `/zones/${zone()}/dns_records?name=${encodeURIComponent(originOf)}`)).find((r) => r.type === "A" || r.type === "AAAA");
    if (!src) throw new CfError(400, `Cloudflare: no A record for ${originOf} to copy`);
    await cf("POST", `/zones/${zone()}/dns_records`, { type: src.type, name: target, content: src.content, proxied: true, ttl: 1, comment: "White-label custom domains (Cloudflare for SaaS fallback origin)" });
  }
  await cf("PUT", `/zones/${zone()}/custom_hostnames/fallback_origin`, { origin: target });
  return cf<{ origin: string; status: string }>("GET", `/zones/${zone()}/custom_hostnames/fallback_origin`);
}
export const fallbackOrigin = () => cf<{ origin: string; status: string }>("GET", `/zones/${zone()}/custom_hostnames/fallback_origin`).catch(() => null);
