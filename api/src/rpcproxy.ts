// Read-only JSON-RPC proxy for the browser: POST /api/rpc/:chainId → the server's RPC for that network (Uniblock,
// see chains.ts rpcUrl). Keeps the Uniblock key off the browser and lets every visitor read chains the public RPCs
// refuse (Arbitrum publicnode rejects eth_getLogs). Guarded for the entry Uniblock tier (40M CU a month, 1,000 CU/s):
//   - read methods only (wallets send transactions through their own provider, never through here);
//   - eth_getLogs must name an address and stay within 50,000 blocks;
//   - identical requests within a few seconds share one upstream call;
//   - per-visitor limit (RPC_PROXY_PER_MIN, default 240 requests a minute), batches of at most 20.
import type { Hono } from "hono";
import { networkById, rpcUrl } from "./chains";

const READ = new Set([
  "eth_chainId", "eth_blockNumber", "eth_call", "eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_getLogs",
  "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getBlockByNumber", "eth_getBlockByHash",
  "eth_estimateGas", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory", "eth_getTransactionCount", "net_version",
]);
const MAX_LOG_RANGE = 50_000n;
const CACHE_MS: Record<string, number> = { eth_chainId: 3_600_000, net_version: 3_600_000, eth_blockNumber: 2_000, eth_getCode: 60_000 };
const DEFAULT_CACHE_MS = 4_000;
const PER_MIN = Number(process.env.RPC_PROXY_PER_MIN ?? 240);

type Req = { jsonrpc: "2.0"; id: unknown; method: string; params?: unknown[] };
const cache = new Map<string, { at: number; ms: number; body: Promise<any> }>();

function refuse(id: unknown, message: string) {
  return { jsonrpc: "2.0", id, error: { code: -32601, message } };
}

function checkLogs(params: unknown[] | undefined): string | null {
  const f = (params?.[0] ?? {}) as { address?: unknown; fromBlock?: string; toBlock?: string; blockHash?: string };
  if (!f.address) return "eth_getLogs needs an address";
  if (f.blockHash) return null;
  const n = (v?: string) => (v && /^0x[0-9a-f]+$/i.test(v) ? BigInt(v) : null);
  const from = n(f.fromBlock), to = n(f.toBlock);
  if (from === null || to === null) return "eth_getLogs needs numeric fromBlock and toBlock";
  if (to - from + 1n > MAX_LOG_RANGE) return `eth_getLogs range is limited to ${MAX_LOG_RANGE} blocks`;
  return null;
}

async function upstream(url: string, r: Req) {
  const key = `${url}|${r.method}|${JSON.stringify(r.params ?? [])}`;
  const ms = CACHE_MS[r.method] ?? DEFAULT_CACHE_MS;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ms) return hit.body;
  const body = fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: r.method, params: r.params ?? [] }),
    signal: AbortSignal.timeout(20_000),
  }).then((x) => x.json());
  cache.set(key, { at: Date.now(), ms, body });
  body.catch(() => cache.delete(key));
  if (cache.size > 5_000) for (const [k, v] of cache) if (Date.now() - v.at > v.ms) cache.delete(k);
  return body;
}

export function mountRpcProxy(app: Hono<any>, deps: { tooMany: (key: string, max: number, windowMs: number) => boolean; ipKey: (c: any) => string }) {
  app.post("/rpc/:chainId", async (c) => {
    const net = networkById(Number(c.req.param("chainId")));
    if (!net) return c.json({ error: "Unknown network" }, 404);
    const body = await c.req.json().catch(() => null);
    const reqs: Req[] = Array.isArray(body) ? body : body ? [body] : [];
    if (!reqs.length || reqs.length > 20) return c.json(refuse(null, "Send 1 to 20 requests"), 400);
    if (deps.tooMany(`rpc:${deps.ipKey(c)}`, PER_MIN, 60_000)) return c.json(refuse(null, "Too many requests"), 429);
    const url = rpcUrl(net);
    const out = await Promise.all(reqs.map(async (r) => {
      if (!r || typeof r.method !== "string" || !READ.has(r.method)) return refuse(r?.id, `Method not allowed: ${r?.method}`);
      if (r.method === "eth_getLogs") { const why = checkLogs(r.params); if (why) return refuse(r.id, why); }
      try {
        const res = await upstream(url, r);
        return { jsonrpc: "2.0", id: r.id, ...(res.error ? { error: res.error } : { result: res.result }) };
      } catch {
        return { jsonrpc: "2.0", id: r.id, error: { code: -32603, message: "Upstream RPC unavailable" } };
      }
    }));
    return c.json(Array.isArray(body) ? out : out[0]);
  });
}
