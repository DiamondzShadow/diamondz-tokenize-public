// IP registry + licensing (designs F1–F7, approved 2026-11-19). Our own registry on the offering's chain
// (contracts/src/ip): Story's L1 is being retired (DATA → Sui), so nothing here depends on it.
//
// Issuer (admin session):
//   PUT  /api/assets/:id/ip                 save the draft record: image, identifiers, holders' share, license types
//                                           (template TEXT is stored and published; its sha256 is what licensees sign)
//   POST /api/assets/:id/ip/registered      { assetId, types: { key: typeId } } → checked on chain, then stored
//   GET  /api/assets/:id/ip/requests        licensee requests (verify / offer from the console)
// Public:
//   GET  /api/ip/:id                        the IP page: record, identifiers, documents, license types, licenses,
//                                           royalties and history, read from chain (id = offering id)
//   GET  /api/ip/:id/meta                   asset NFT metadata (AssetRegistry tokenURI)
//   GET  /api/ip/:id/terms/:key             a license template, as published (text/plain; sha256 = its terms hash)
//   POST /api/ip/:id/requests               a licensee asks for a license (or verification); the issuer decides
//   GET  /api/licenses/:chainId/:licenseId  license NFT metadata + status (certificates and the QR "verify" page)
//   GET  /api/ip/config                     { kyb, verifier }: Sumsub on? the platform verifier's address
//   POST /api/ip/:id/verify-me { wallet }   after a passed Sumsub check (POST /api/kyc/start with { licensee }), the
//                                           platform verifier records it on chain, if the asset's holder allowed it
//
// Licensee verification: Sumsub business verification (companies) or ID check (individuals), per issuer. Recording it
// on chain is either the holder's own transaction (dashboard), or automatic once the holder has allowed the platform
// verifier (LicenseRegistry.setVerifier). Env: IP_VERIFIER_KEY (falls back to TREX_RELAYER_KEY).
import type { Hono } from "hono";
import { createHash } from "node:crypto";
import { z } from "zod";
import { getAddress, isAddress, parseAbiItem, type Address, type PublicClient } from "viem";
import { networkById, type Network } from "./chains";
import { publicFor, walletFor } from "./trex";
import { eventLogs } from "./logindex";
import { kycEnabled, licenseeStatus } from "./kyc";
import type { Store } from "./store";
import { privateKeyToAccount } from "viem/accounts";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const ZERO = "0x0000000000000000000000000000000000000000";

/** Classes whose assets can be licensed (design F7). */
export const LICENSABLE = ["film", "music-ip", "collectibles"] as const;

const Key = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const LicenseTypeDraft = z.object({
  key: Key,
  name: z.string().trim().min(1).max(60),
  scope: z.string().trim().max(400).default(""),
  fee: z.string().regex(/^\d{1,12}(\.\d{1,6})?$/).default("0"),
  revSharePct: z.number().min(0).max(100).default(0),
  durationDays: z.number().int().min(0).max(36_500).default(365),
  territory: z.string().trim().min(1).max(80).default("Worldwide"),
  byRequest: z.boolean().default(false),
  active: z.boolean().default(true),
  /** The counsel template, verbatim. Public once registered. */
  termsName: z.string().trim().min(1).max(80),
  termsText: z.string().min(50, "paste the full template text").max(200_000),
});
export const IpDraft = z.object({
  imageUrl: z.union([z.literal(""), z.string().url().startsWith("https://").max(500)]).default(""),
  summary: z.string().max(1000).default(""),
  identifiers: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,31}$/), z.string().trim().min(1).max(128)).refine((o) => Object.keys(o).length <= 16, "at most 16 identifiers").default({}),
  holdersPct: z.number().min(0).max(100).default(0),
  licenseTypes: z.array(LicenseTypeDraft).max(12).default([]),
});

// ------------------------------------------------------------------ ABIs (subset)
const assetsAbi = [
  { type: "function", name: "assetOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] },
  {
    type: "function", name: "asset", stateMutability: "view", inputs: [{ type: "uint256" }],
    outputs: [{ type: "tuple", components: [
      { name: "offering", type: "address" }, { name: "assetClass", type: "bytes32" }, { name: "docsManifest", type: "bytes32" },
      { name: "payee", type: "address" }, { name: "holdersBps", type: "uint16" }, { name: "registeredAt", type: "uint64" }, { name: "uri", type: "string" },
    ] }],
  },
  { type: "function", name: "identifiers", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "string[]" }, { type: "string[]" }] },
] as const;
const typeTuple = { type: "tuple", components: [
  { name: "assetId", type: "uint256" }, { name: "termsHash", type: "bytes32" }, { name: "feeToken", type: "address" }, { name: "fee", type: "uint256" },
  { name: "revShareBps", type: "uint16" }, { name: "durationDays", type: "uint32" }, { name: "byRequest", type: "bool" }, { name: "active", type: "bool" },
  { name: "name", type: "string" }, { name: "territory", type: "string" }, { name: "termsURI", type: "string" },
] } as const;
const licenseTuple = { type: "tuple", components: [
  { name: "assetId", type: "uint256" }, { name: "typeId", type: "uint256" }, { name: "licensee", type: "address" }, { name: "termsHash", type: "bytes32" },
  { name: "feeToken", type: "address" }, { name: "feePaid", type: "uint256" }, { name: "revShareBps", type: "uint16" }, { name: "start", type: "uint64" },
  { name: "end", type: "uint64" }, { name: "revoked", type: "bool" }, { name: "revenueReported", type: "uint256" }, { name: "work", type: "string" },
  { name: "territory", type: "string" },
] } as const;
const licensesAbi = [
  { type: "function", name: "licenseType", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [typeTuple] },
  { type: "function", name: "license", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [licenseTuple] },
  { type: "function", name: "status", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint8" }] },
  { type: "function", name: "assets", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "verifier", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "verifiedUntil", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "uint64" }] },
  { type: "function", name: "verifyLicensee", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "address" }, { type: "uint64" }], outputs: [] },
] as const;

const verifierKey = () => process.env.IP_VERIFIER_KEY || process.env.TREX_RELAYER_KEY || "";
export const verifierAddress = () => {
  const k = verifierKey();
  return k ? privateKeyToAccount((k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`).address : null;
};
const ev = {
  issued: parseAbiItem("event LicenseIssued(uint256 indexed licenseId, uint256 indexed assetId, address indexed licensee, uint256 typeId, bytes32 termsHash, uint256 fee, uint64 start, uint64 end, string work)"),
  revenue: parseAbiItem("event RevenueReported(uint256 indexed licenseId, uint256 gross, uint256 paid, string period)"),
  revoked: parseAbiItem("event LicenseRevoked(uint256 indexed licenseId, string reason)"),
  published: parseAbiItem("event LicenseTypePublished(uint256 indexed assetId, uint256 indexed typeId, string name, bytes32 termsHash, address feeToken, uint256 fee, uint16 revShareBps, uint32 durationDays, bool byRequest)"),
  docs: parseAbiItem("event DocumentsUpdated(uint256 indexed assetId, bytes32 previous, bytes32 current)"),
  registered: parseAbiItem("event AssetRegistered(uint256 indexed assetId, address indexed offering, bytes32 indexed assetClass, address to, string uri)"),
};

// ------------------------------------------------------------------ chain reads
export function ipFor(net: Network | undefined) {
  if (!net) return undefined;
  const env = process.env[`IP_${net.id}`]; // "0xAssets:0xLicenses:fromBlock" (local forks, tests)
  if (env) {
    const [assets, licenses, from] = env.split(":");
    return { assets: assets as Address, licenses: licenses as Address, fromBlock: Number(from ?? 0) };
  }
  return net.ip;
}
const clientFor = (net: Network) => publicFor(net);

/** Decoded event logs from the shared incremental index (api/src/logindex.ts), flattened to args + block + tx. */
async function logs<T>(pc: PublicClient, chainId: number, address: Address, event: any, args: any, fromBlock: number): Promise<T[]> {
  const got = await eventLogs(pc, chainId, address, fromBlock, event, args ?? {});
  return got.map((l) => ({ ...l.args, blockNumber: Number(l.blockNumber), tx: l.transactionHash }) as T);
}

const cache = new Map<string, { at: number; v: unknown }>();
async function cached<T>(key: string, ms: number, f: () => Promise<T>): Promise<T> {
  const c = cache.get(key);
  if (c && Date.now() - c.at < ms) return c.v as T;
  const v = await f();
  cache.set(key, { at: Date.now(), v });
  return v;
}

/** Everything the public IP page shows, from chain plus the issuer's published texts. */
export async function ipPage(a: any) {
  const net = networkById(a.chainId);
  const ip = ipFor(net);
  const reg = a.ip?.registered as { assetId: string; types: Record<string, string> } | undefined;
  if (!net || !ip || !reg) return null;
  return cached(`ip:${a.id}`, 30_000, async () => {
    const pc = clientFor(net);
    const id = BigInt(reg.assetId);
    const [rec, ids, owner] = await Promise.all([
      pc.readContract({ address: ip.assets, abi: assetsAbi, functionName: "asset", args: [id] }),
      pc.readContract({ address: ip.assets, abi: assetsAbi, functionName: "identifiers", args: [id] }),
      pc.readContract({ address: ip.assets, abi: assetsAbi, functionName: "ownerOf", args: [id] }),
    ]);
    const typeIds = Object.entries(reg.types);
    const types = await Promise.all(typeIds.map(async ([key, tid]) => {
      const t = await pc.readContract({ address: ip.licenses, abi: licensesAbi, functionName: "licenseType", args: [BigInt(tid)] });
      const draft = (a.ip?.licenseTypes ?? []).find((x: any) => x.key === key);
      return {
        key, typeId: tid, name: t.name, scope: draft?.scope ?? "", termsHash: t.termsHash, termsName: draft?.termsName ?? "",
        fee: t.fee.toString(), feeToken: t.feeToken, revShareBps: t.revShareBps, durationDays: t.durationDays, territory: t.territory,
        byRequest: t.byRequest, active: t.active,
      };
    }));
    const issued = await logs<any>(pc, net.id, ip.licenses, ev.issued, { assetId: id }, ip.fromBlock);
    const licenses = await Promise.all(issued.map(async (l) => {
      const [full, st] = await Promise.all([
        pc.readContract({ address: ip.licenses, abi: licensesAbi, functionName: "license", args: [l.licenseId] }),
        pc.readContract({ address: ip.licenses, abi: licensesAbi, functionName: "status", args: [l.licenseId] }),
      ]);
      return {
        licenseId: l.licenseId.toString(), typeId: l.typeId.toString(), licensee: full.licensee, work: full.work, territory: full.territory,
        feePaid: full.feePaid.toString(), revShareBps: full.revShareBps, start: Number(full.start), end: Number(full.end),
        revenueReported: full.revenueReported.toString(), status: (["none", "active", "expired", "revoked"] as const)[Number(st)], tx: l.tx,
      };
    }));
    const ids_ = licenses.map((l) => BigInt(l.licenseId));
    const revenue = ids_.length ? (await logs<any>(pc, net.id, ip.licenses, ev.revenue, { licenseId: ids_ }, ip.fromBlock)) : [];
    const revokes = ids_.length ? (await logs<any>(pc, net.id, ip.licenses, ev.revoked, { licenseId: ids_ }, ip.fromBlock)) : [];
    const published = await logs<any>(pc, net.id, ip.licenses, ev.published, { assetId: id }, ip.fromBlock);
    const docs = await logs<any>(pc, net.id, ip.assets, ev.docs, { assetId: id }, ip.fromBlock);
    const regd = await logs<any>(pc, net.id, ip.assets, ev.registered, { assetId: id }, ip.fromBlock);
    const fees = licenses.reduce((s, l) => s + BigInt(l.feePaid), 0n);
    const shares = revenue.reduce((s: bigint, r: any) => s + (r.paid as bigint), 0n);
    const history = [
      ...regd.map((e) => ({ at: e.blockNumber, tx: e.tx, text: "IP registered" })),
      ...published.map((e) => ({ at: e.blockNumber, tx: e.tx, text: `License terms published: ${e.name}` })),
      ...docs.filter((e) => e.previous !== `0x${"0".repeat(64)}`).map((e) => ({ at: e.blockNumber, tx: e.tx, text: "Documents updated" })),
      ...issued.map((e) => ({ at: e.blockNumber, tx: e.tx, text: `License #${e.licenseId} issued${e.work ? `: ${e.work}` : ""}` })),
      ...revenue.map((e: any) => ({ at: e.blockNumber, tx: e.tx, text: `Revenue reported on license #${e.licenseId} (${e.period})` })),
      ...revokes.map((e: any) => ({ at: e.blockNumber, tx: e.tx, text: `License #${e.licenseId} revoked` })),
    ].sort((x, y) => y.at - x.at);
    return {
      offering: a.id, issuer: a.tenantId, name: a.name, symbol: a.symbol, assetClass: a.assetClass, chainId: a.chainId,
      assetId: reg.assetId, registry: ip.assets, licenseRegistry: ip.licenses, owner, payee: rec.payee,
      holdersBps: rec.holdersBps, docsManifest: rec.docsManifest, registeredAt: Number(rec.registeredAt),
      identifiers: Object.fromEntries(ids[0].map((k, i) => [k, ids[1][i]])),
      imageUrl: a.ip?.imageUrl ?? a.imageUrl ?? "", summary: a.ip?.summary || a.description || "",
      documents: (a.documents ?? []).map((d: any) => ({ kind: d.kind, name: d.name, sha256: d.sha256 })),
      details: a.details ?? {}, stage: a.details?.stage ?? null,
      licenseTypes: types, licenses,
      royalties: { fees: fees.toString(), revenueShares: shares.toString(), holdersOwed: (((fees + shares) * BigInt(rec.holdersBps)) / 10_000n).toString() },
      history,
    };
  });
}

// ------------------------------------------------------------------ routes
type Deps = {
  store: Store;
  requireAdmin: any;
  adminAsset: (c: any, id: string) => Promise<any | null>;
  saveAsset: (c: any, asset: any) => Promise<void>;
  /** Any deployed asset this site shows (any issuer), by offering id. */
  publicAsset: (c: any, id: string) => Promise<any | null>;
  /** Saves an asset found through publicAsset (licensee requests). */
  savePublicAsset: (asset: any) => Promise<void>;
  tooMany: (key: string, max: number, windowMs: number) => boolean;
  ipKey: (c: any) => string;
};

export function mountIp(app: Hono<any>, deps: Deps) {
  app.put("/assets/:id/ip", deps.requireAdmin, async (c) => {
    const a = await deps.adminAsset(c, c.req.param("id"));
    if (!a) return c.json({ error: "Not found" }, 404);
    if (a.status !== "deployed") return c.json({ error: "Deploy the offering first" }, 409);
    const parsed = IpDraft.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    const d = parsed.data;
    if (d.licenseTypes.length && !(LICENSABLE as readonly string[]).includes(a.assetClass)) return c.json({ error: "Licensing is for film, music and collectibles" }, 400);
    if (new Set(d.licenseTypes.map((t) => t.key)).size !== d.licenseTypes.length) return c.json({ error: "license type keys must be unique" }, 400);
    const reg = a.ip?.registered;
    // Once registered, published types are fixed on chain: their text can't change (publish a new type instead).
    for (const t of d.licenseTypes) {
      const before = (a.ip?.licenseTypes ?? []).find((x: any) => x.key === t.key);
      if (reg?.types?.[t.key] && before && before.termsText !== t.termsText) return c.json({ error: `"${t.name}" is published: add a new license type for new terms` }, 409);
    }
    const licenseTypes = d.licenseTypes.map((t) => ({ ...t, termsHash: `0x${sha(t.termsText)}` }));
    await deps.saveAsset(c, { ...a, ip: { ...(a.ip ?? {}), ...d, licenseTypes } });
    return c.json({ ok: true, licenseTypes: licenseTypes.map(({ termsText: _t, ...x }) => x) });
  });

  app.post("/assets/:id/ip/registered", deps.requireAdmin, async (c) => {
    const a = await deps.adminAsset(c, c.req.param("id"));
    if (!a?.deployment) return c.json({ error: "Not found" }, 404);
    const body = z.object({ assetId: z.string().regex(/^\d{1,30}$/), types: z.record(Key, z.string().regex(/^\d{1,30}$/)).default({}) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "assetId and types required" }, 400);
    const net = networkById(a.chainId);
    const ip = ipFor(net);
    if (!net || !ip) return c.json({ error: "The IP registry isn't on this network yet" }, 409);
    const pc = clientFor(net);
    const errs: string[] = [];
    try {
      const id = BigInt(body.data.assetId);
      const of = await pc.readContract({ address: ip.assets, abi: assetsAbi, functionName: "assetOf", args: [a.deployment.token] });
      if (of !== id) errs.push("that asset isn't registered for this offering's token");
      const rec = await pc.readContract({ address: ip.assets, abi: assetsAbi, functionName: "asset", args: [id] });
      const want = Math.round(Number(a.ip?.holdersPct ?? 0) * 100);
      if (Number(rec.holdersBps) !== want) errs.push("token holders' share doesn't match the draft");
      for (const [key, tid] of Object.entries(body.data.types)) {
        const draft = (a.ip?.licenseTypes ?? []).find((x: any) => x.key === key);
        if (!draft) { errs.push(`unknown license type ${key}`); continue; }
        const t = await pc.readContract({ address: ip.licenses, abi: licensesAbi, functionName: "licenseType", args: [BigInt(tid)] });
        if (t.assetId !== id) errs.push(`license type ${key} belongs to another asset`);
        if (t.termsHash.toLowerCase() !== draft.termsHash.toLowerCase()) errs.push(`license type ${key}: terms fingerprint doesn't match the published text`);
        if (t.byRequest !== draft.byRequest || Number(t.revShareBps) !== Math.round(draft.revSharePct * 100) || Number(t.durationDays) !== draft.durationDays) errs.push(`license type ${key}: settings don't match the draft`);
      }
    } catch (e: any) {
      return c.json({ error: `Couldn't read the registry: ${e?.shortMessage ?? e?.message}` }, 422);
    }
    if (errs.length) return c.json({ error: `Registration check failed: ${errs.join("; ")}` }, 422);
    const registered = { assetId: body.data.assetId, types: { ...(a.ip?.registered?.types ?? {}), ...body.data.types }, at: new Date().toISOString() };
    await deps.saveAsset(c, { ...a, ip: { ...(a.ip ?? {}), registered } });
    cache.delete(`ip:${a.id}`);
    return c.json({ ok: true, registered });
  });

  app.get("/assets/:id/ip/requests", deps.requireAdmin, async (c) => {
    const a = await deps.adminAsset(c, c.req.param("id"));
    if (!a) return c.json({ error: "Not found" }, 404);
    // Each request carries the licensee's Sumsub check status (never the documents).
    const out = await Promise.all((a.ip?.requests ?? []).map(async (r: any) => ({ ...r, check: (await licenseeStatus(deps.store, a.tenantId, r.wallet))?.status ?? null })));
    return c.json(out);
  });

  app.get("/ip/config", (c) => c.json({ kyb: kycEnabled(), verifier: verifierAddress() }));

  app.post("/ip/:id/verify-me", async (c) => {
    if (deps.tooMany(`ipver:${deps.ipKey(c)}`, 10, 10 * 60_000)) return c.json({ error: "Too many requests" }, 429);
    const a = await deps.publicAsset(c, c.req.param("id"));
    if (!a?.ip?.registered) return c.json({ error: "Not found" }, 404);
    const body = z.object({ wallet: z.string().refine(isAddress) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "wallet required" }, 400);
    const wallet = getAddress(body.data.wallet);
    const row = await licenseeStatus(deps.store, a.tenantId, wallet);
    if (row?.status !== "approved") return c.json({ approved: false, status: row?.status ?? "none" });
    const net = networkById(a.chainId);
    const ip = ipFor(net);
    const key = verifierKey();
    const me = verifierAddress();
    if (!net || !ip || !key || !me) return c.json({ approved: true, onChain: false, reason: "The rights holder records your verification on chain." });
    const pc = clientFor(net);
    const id = BigInt(a.ip.registered.assetId);
    try {
      const until = Number(await pc.readContract({ address: ip.licenses, abi: licensesAbi, functionName: "verifiedUntil", args: [id, wallet] }));
      if (until > Date.now() / 1000 + 7 * 86_400) return c.json({ approved: true, onChain: true, until });
      const allowed = await pc.readContract({ address: ip.licenses, abi: licensesAbi, functionName: "verifier", args: [id, me] });
      if (!allowed) return c.json({ approved: true, onChain: false, reason: "Your check passed. The rights holder records it on chain from their dashboard." });
      const wc = walletFor(net, key);
      const next = BigInt(Math.floor(Date.now() / 1000) + 365 * 86_400);
      const { request } = await pc.simulateContract({ address: ip.licenses, abi: licensesAbi, functionName: "verifyLicensee", args: [id, wallet, next], account: wc.account! });
      const hash = await wc.writeContract(request as any);
      const r = await pc.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error(`verify failed ${hash}`);
      return c.json({ approved: true, onChain: true, until: Number(next), tx: hash });
    } catch (e: any) {
      console.error("[ip] verify-me", a.id, e?.shortMessage ?? e?.message);
      return c.json({ error: "Couldn't record your verification on chain, try again shortly" }, 422);
    }
  });

  // ---- public
  app.get("/ip/:id", async (c) => {
    const a = await deps.publicAsset(c, c.req.param("id"));
    if (!a?.ip?.registered) return c.json({ error: "Not found" }, 404);
    try {
      const p = await ipPage(a);
      return p ? c.json(p) : c.json({ error: "Not found" }, 404);
    } catch (e: any) {
      console.error("[ip] page", a.id, e?.shortMessage ?? e?.message);
      return c.json({ error: "Couldn't read the registry from the network. Try again in a moment." }, 422);
    }
  });

  app.get("/ip/:id/meta", async (c) => {
    const a = await deps.publicAsset(c, c.req.param("id"));
    if (!a) return c.json({ error: "Not found" }, 404);
    c.header("Cache-Control", "public, max-age=300");
    return c.json({
      name: a.name, description: a.ip?.summary || a.description || "",
      ...(a.ip?.imageUrl || a.imageUrl ? { image: a.ip?.imageUrl || a.imageUrl } : {}),
      external_url: `https://${c.req.header("host") ?? "tokenize.diamondz.one"}/ip/${a.id}`,
      attributes: [{ trait_type: "Asset class", value: a.assetClass }, ...Object.entries(a.ip?.identifiers ?? {}).map(([k, v]) => ({ trait_type: k, value: v }))],
    });
  });

  app.get("/ip/:id/terms/:key", async (c) => {
    const a = await deps.publicAsset(c, c.req.param("id"));
    const t = (a?.ip?.licenseTypes ?? []).find((x: any) => x.key === c.req.param("key"));
    if (!t) return c.text("Not found", 404);
    c.header("Content-Type", "text/plain; charset=utf-8");
    c.header("X-Terms-Sha256", t.termsHash);
    return c.body(t.termsText);
  });

  app.post("/ip/:id/requests", async (c) => {
    if (deps.tooMany(`ipreq:${deps.ipKey(c)}`, 10, 60 * 60_000)) return c.json({ error: "Too many requests, try again later" }, 429);
    const a = await deps.publicAsset(c, c.req.param("id"));
    if (!a?.ip?.registered) return c.json({ error: "Not found" }, 404);
    const body = z.object({
      wallet: z.string().refine(isAddress, "full 0x wallet address"),
      company: z.string().trim().min(2).max(120),
      kind: z.enum(["company", "individual"]).default("company"),
      jurisdiction: z.string().trim().min(2).max(80),
      email: z.string().trim().toLowerCase().email().max(200),
      typeKey: Key.optional(),
      work: z.string().trim().max(200).default(""),
      message: z.string().trim().max(2000).default(""),
    }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    const req = { id: `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, ...body.data, wallet: getAddress(body.data.wallet), at: new Date().toISOString(), status: "open" };
    const requests = [req, ...(a.ip.requests ?? [])].slice(0, 200);
    await deps.savePublicAsset({ ...a, ip: { ...a.ip, requests } });
    return c.json({ ok: true, id: req.id }, 201);
  });

  app.get("/licenses/:chainId/:licenseId", async (c) => {
    const net = networkById(Number(c.req.param("chainId")));
    const ip = ipFor(net);
    const lid = c.req.param("licenseId").replace(/\.json$/, "");
    if (!net || !ip || !/^\d{1,30}$/.test(lid)) return c.json({ error: "Not found" }, 404);
    const pc = clientFor(net);
    try {
      const l = await pc.readContract({ address: ip.licenses, abi: licensesAbi, functionName: "license", args: [BigInt(lid)] });
      if (l.licensee === ZERO) return c.json({ error: "Not found" }, 404);
      const [st, t, rec] = await Promise.all([
        pc.readContract({ address: ip.licenses, abi: licensesAbi, functionName: "status", args: [BigInt(lid)] }),
        pc.readContract({ address: ip.licenses, abi: licensesAbi, functionName: "licenseType", args: [l.typeId] }),
        pc.readContract({ address: ip.assets, abi: assetsAbi, functionName: "asset", args: [l.assetId] }),
      ]);
      const status = (["none", "active", "expired", "revoked"] as const)[Number(st)];
      c.header("Cache-Control", "public, max-age=60");
      return c.json({
        name: `License #${lid}: ${t.name}`,
        description: `${t.name} license${l.work ? ` for "${l.work}"` : ""}. Status: ${status}.`,
        licenseId: lid, chainId: net.id, status, assetId: l.assetId.toString(), offering: rec.offering, licensee: l.licensee,
        typeName: t.name, termsHash: l.termsHash, termsURI: t.termsURI, feeToken: l.feeToken, feePaid: l.feePaid.toString(),
        revShareBps: l.revShareBps, start: Number(l.start), end: Number(l.end), work: l.work, territory: l.territory,
        revenueReported: l.revenueReported.toString(), registry: ip.licenses,
        attributes: [{ trait_type: "Status", value: status }, { trait_type: "License", value: t.name }, { trait_type: "Territory", value: l.territory }],
      });
    } catch (e: any) {
      return c.json({ error: `Couldn't read the license: ${e?.shortMessage ?? e?.message}` }, 422);
    }
  });
}
