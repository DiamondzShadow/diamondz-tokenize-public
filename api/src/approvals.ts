// Investors approved without an identity check (2026-11-20). For ERC-7943 / 721 / 1155 / 4626 offerings the issuer's
// own wallet approves investors directly on chain (InvestorRegistry.setInvestor), so the server can't stop an
// approval that skipped the identity check. Instead, every approved wallet is compared with the issuer's identity
// checks and the result is shown openly: to the issuer (each wallet) and to investors on the listing (counts only).
// ERC-3643 is enforced at approval time on real networks (trex identityGate); Stellar offerings aren't covered yet.
//
//   GET /api/assets/:id/approvals     issuer: every approved wallet + whether it passed an identity check
//   GET /api/market/:id/approvals     public: counts only (no wallets)
import type { Context, Hono } from "hono";
import { getAddress, parseAbiItem, type Address, type PublicClient } from "viem";
import type { Store } from "./store";
import { eventLogs } from "./logindex";

const UPDATED = parseAbiItem("event InvestorUpdated(address indexed wallet, bool verified, bool accredited, uint16 country, uint64 expiresAt)");
const REMOVED = parseAbiItem("event InvestorRemoved(address indexed wallet)");
const COVERED = new Set(["erc7943", "erc721", "erc1155", "erc4626"]);
const fromBlocks = new Map<string, bigint>();
const cache = new Map<string, { at: number; v: Audit }>();
const TTL = 5 * 60_000;

export interface ApprovedWallet { wallet: Address; checked: boolean; identity: string; accredited: boolean; country: number; approvedAt: string | null; system: boolean }
export interface Audit { covered: boolean; total: number; checked: number; manual: number; wallets: ApprovedWallet[]; testnet: boolean; note?: string }

export interface ApprovalDeps {
  store: Store;
  requireAdmin: any;
  adminAsset: (c: Context<any>, id: string) => Promise<any | null>;
  listedAsset: (c: Context<any>, id: string) => Promise<any | null>;
  client: (chainId: number) => { pc: PublicClient; testnet: boolean } | null;
  /** Every deployed offering (a registry can be shared by several of an issuer's offerings on one chain). */
  allDeployed: () => Promise<any[]>;
}

export function mountApprovals(app: Hono<any>, deps: ApprovalDeps) {
  async function audit(a: any): Promise<Audit> {
    const empty = (note: string): Audit => ({ covered: false, total: 0, checked: 0, manual: 0, wallets: [], testnet: false, note });
    if (!COVERED.has(a.standard)) return empty(a.standard === "erc3643" ? "ERC-3643: approvals on real networks require a passed identity check" : "Not covered for this token type yet");
    const d = a.deployment;
    const cl = d?.registry ? deps.client(a.chainId) : null;
    if (!d?.registry || !cl) return empty("Not deployed");
    const key = `${a.chainId}:${d.registry.toLowerCase()}`;
    const hit = cache.get(`${key}:${a.tenantId}`);
    if (hit && Date.now() - hit.at < TTL) return hit.v;
    let from = fromBlocks.get(key);
    if (from === undefined) {
      // Earliest deployment among the offerings sharing this registry, so no earlier approval is missed.
      const sharing = (await deps.allDeployed()).filter((x: any) => x.chainId === a.chainId && String(x.deployment?.registry ?? "").toLowerCase() === d.registry.toLowerCase());
      let min: bigint | null = null;
      for (const x of sharing.length ? sharing : [a]) {
        const tx = (x.deployment?.txs ?? [])[0];
        const r = tx ? await cl.pc.getTransactionReceipt({ hash: tx }).catch(() => null) : null;
        if (r?.blockNumber !== undefined && (min === null || r.blockNumber < min)) min = r.blockNumber;
      }
      from = min ?? 0n;
      fromBlocks.set(key, from);
    }
    const [ups, rms] = await Promise.all([eventLogs<any>(cl.pc, a.chainId, d.registry, from, UPDATED as any), eventLogs<any>(cl.pc, a.chainId, d.registry, from, REMOVED as any)]);
    const last = new Map<string, { verified: boolean; accredited: boolean; country: number; block: bigint }>();
    for (const l of ups) last.set(String(l.args.wallet).toLowerCase(), { verified: !!l.args.verified, accredited: !!l.args.accredited, country: Number(l.args.country), block: l.blockNumber });
    for (const l of rms) { const w = String(l.args.wallet).toLowerCase(); const p = last.get(w); if (p && l.blockNumber >= p.block) last.delete(w); }
    const system = new Set([d.sale, d.token, d.payToken, d.rules].filter(Boolean).map((x: string) => x.toLowerCase()));
    const wallets: ApprovedWallet[] = [];
    for (const [w, s] of last) {
      if (!s.verified) continue;
      const k = await deps.store.kycByWallet(a.tenantId, w).catch(() => null);
      wallets.push({ wallet: getAddress(w), checked: k?.status === "approved", identity: k?.status ?? "none", accredited: s.accredited, country: s.country, approvedAt: null, system: system.has(w) });
    }
    const people = wallets.filter((x) => !x.system);
    const v: Audit = { covered: true, total: people.length, checked: people.filter((x) => x.checked).length, manual: people.filter((x) => !x.checked).length, wallets: wallets.sort((x, y) => Number(x.checked) - Number(y.checked)), testnet: cl.testnet };
    cache.set(`${key}:${a.tenantId}`, { at: Date.now(), v });
    return v;
  }

  app.get("/assets/:id/approvals", deps.requireAdmin, async (c) => {
    const a = await deps.adminAsset(c, c.req.param("id") ?? "");
    if (!a) return c.json({ error: "Not found" }, 404);
    try {
      const x = await Promise.race([audit(a), new Promise<null>((r) => setTimeout(() => r(null), 8000))]);
      return x ? c.json(x) : c.json({ covered: false, total: 0, checked: 0, manual: 0, testnet: false, wallets: [], note: "Still reading the investor registry. Refresh in a minute." });
    } catch (e: any) { return c.json({ error: e?.shortMessage ?? "Couldn't read the investor registry" }, 502); }
  });

  app.get("/market/:id/approvals", async (c) => {
    const a = await deps.listedAsset(c, c.req.param("id") ?? "");
    if (!a) return c.json({ error: "Not found" }, 404);
    try {
      // Never hold a visitor longer than 8 s (the server drops requests idle for 10 s): a first history scan after a
      // restart keeps running in the background and the next visit gets the result.
      const x = await Promise.race([audit(a), new Promise<null>((r) => setTimeout(() => r(null), 8000))]);
      if (!x) return c.json({ covered: false, total: 0, checked: 0, manual: 0, testnet: false, note: "Still checking" });
      c.header("Cache-Control", "public, max-age=300");
      return c.json({ covered: x.covered, total: x.total, checked: x.checked, manual: x.manual, testnet: x.testnet, note: x.note ?? null });
    } catch { return c.json({ covered: false, total: 0, checked: 0, manual: 0, testnet: false, note: "Unavailable right now" }); }
  });

  // Warm the scans at start-up so the first investor to open a listing doesn't wait for a long history read.
  setTimeout(async () => {
    for (const a of await deps.allDeployed().catch(() => [])) if (COVERED.has(a.standard)) await audit(a).catch(() => null);
  }, 15_000);

  /** Drop cached results for a tenant (call after a new identity check result, so flags clear quickly). */
  return { forget: () => cache.clear() };
}
