// Proof of asset: what independent verifiers have signed on chain (AssetOracle) plus live on-chain checks of the
// offering itself, refreshed in the background so listings show near-real-time status.
//
//   GET  /api/proof/:assetId              status for one asset (public when listed, admins always)
//   GET  /api/proof/verifiers/:chainId    verifiers the platform has approved on that network
//   POST /api/proof/evidence              verifier uploads an evidence file (signed by an approved verifier wallet)
//   GET  /api/proof/evidence/:sha256      fetch an evidence file
import type { Hono, Context } from "hono";
import { createPublicClient, getAddress, http, isAddress, parseAbiItem, verifyMessage, type Address, type PublicClient } from "viem";
import { createHash } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import { assetOracleFor, creFeedFor, knownOracles, networkById, oracleForSale, type Network, rpcUrl } from "./chains";
import { eventLogs } from "./logindex";
import { registerJob } from "./jobs";
import { CHECK_KINDS, CLASS_CHECKS, CLASS_FEEDS, metricHash, kindHash, kindByHash, classHash, type CheckKindId } from "../../web/src/lib/verification";
import { ITEM_ID, type AssetClassId } from "../../web/src/lib/catalog";

const EVIDENCE_DIR = process.env.EVIDENCE_DIR ?? `${import.meta.dir}/../data/evidence`;
const MAX_EVIDENCE_BYTES = 20 * 1024 * 1024;
const EVIDENCE_TYPES: Record<string, string> = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "application/json": "json", "text/plain": "txt" };
const REFRESH_MS = 2 * 60_000;
const SIG_MAX_AGE_S = 10 * 60;

export const oracleAbi = [
  { type: "function", name: "isVerified", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "registration", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bytes32" }, { type: "bytes32[]" }] },
  {
    type: "function", name: "latest", stateMutability: "view", inputs: [{ type: "address" }, { type: "bytes32" }],
    outputs: [{
      type: "tuple", components: [
        { name: "verifier", type: "address" }, { name: "result", type: "uint8" }, { name: "attestedAt", type: "uint64" },
        { name: "validUntil", type: "uint64" }, { name: "value", type: "int256" }, { name: "evidenceHash", type: "bytes32" },
        { name: "evidenceURI", type: "string" },
      ],
    }],
  },
  { type: "function", name: "verifiers", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }, { type: "string" }] },
  { type: "function", name: "canAttest", stateMutability: "view", inputs: [{ type: "address" }, { type: "bytes32" }], outputs: [{ type: "bool" }] },
] as const;
const verifierSetEvent = parseAbiItem("event VerifierSet(address indexed verifier, bool active, string name)");
const verifierKindEvent = parseAbiItem("event VerifierKindSet(address indexed verifier, bytes32 indexed kind, bool allowed)");
const attestedEvent = parseAbiItem(
  "event Attested(address indexed token, bytes32 indexed kind, address indexed verifier, uint8 result, uint64 validUntil, int256 value, bytes32 evidenceHash, string evidenceURI)",
);
const liveAbi = [
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "sold", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "cap", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "raised", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "isOpen", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "treasury", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "oracle", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "retired", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
] as const;

export type CheckStatus = "current" | "expiring" | "expired" | "failed" | "missing" | "verifier-removed";

export interface ProofCheck {
  kind: CheckKindId;
  name: string;
  confirms: string;
  status: CheckStatus;
  verifier?: { address: Address; name: string };
  attestedAt?: string;
  validUntil?: string;
  value?: string;
  valueUnit?: string;
  evidenceURI?: string;
  evidenceHash?: string;
  tx?: string;
}

export interface LiveCheck {
  id: string;
  label: string;
  ok: boolean | null; // null = informational
  detail: string;
}

export interface FeedValue {
  metric: string;
  label: string;
  unit: string;
  value: string; // integer string
  decimals: number;
  observedAt: string;
  source: "chainlink-cre";
}

const markAbi = [{
  type: "function", name: "latestMark", stateMutability: "view", inputs: [{ type: "address" }, { type: "bytes32" }],
  outputs: [{ type: "tuple", components: [{ name: "value", type: "int256" }, { name: "decimals", type: "uint8" }, { name: "observedAt", type: "uint64" }, { name: "sourceHash", type: "bytes32" }] }],
}] as const;

export interface Proof {
  assetId: string;
  chainId: number;
  oracle: Address | null;
  /** Sale is wired to the oracle: verification gates purchases. */
  gated: boolean;
  registered: boolean;
  verified: boolean;
  checks: ProofCheck[];
  live: LiveCheck[];
  /** Live market feeds for this listing from the Chainlink CRE workflow (empty until the feed is live). */
  feeds: FeedValue[];
  checkedAt: string;
  error?: string;
}

const clients = new Map<number, PublicClient>();
function clientFor(net: Network): PublicClient {
  if (!clients.has(net.id)) {
    const rpc = rpcUrl(net);
    clients.set(net.id, createPublicClient({ transport: http(rpc, { timeout: 20_000, retryCount: 2 }) }) as PublicClient);
  }
  return clients.get(net.id)!;
}

const iso = (s: bigint | number) => new Date(Number(s) * 1000).toISOString();
const eq = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const ZERO = "0x0000000000000000000000000000000000000000";

/** The tx of the latest Attested event for (token, kind), from the shared log index. Best effort. */
async function attestTx(client: PublicClient, chainId: number, oracle: Address, fromBlock: number, token: Address, kind: `0x${string}`) {
  try {
    const logs = await eventLogs(client, chainId, oracle, fromBlock, attestedEvent as any, { token, kind });
    return logs.at(-1)?.transactionHash;
  } catch {
    return undefined;
  }
}

export async function computeProof(asset: any): Promise<Proof> {
  const net = networkById(asset.chainId);
  const now = Date.now();
  const base: Proof = {
    assetId: asset.id, chainId: asset.chainId, oracle: null, gated: false, registered: false, verified: false,
    checks: [], live: [], feeds: [], checkedAt: new Date(now).toISOString(),
  };
  if (!net) return { ...base, error: "unsupported network" };
  const dep = asset.deployment;
  const required = CLASS_CHECKS[asset.assetClass as AssetClassId] ?? [];
  const client = clientFor(net);
  const read = <T,>(address: Address, abi: any, functionName: string, args: any[] = []) =>
    client.readContract({ address, abi, functionName, args }) as Promise<T>;

  // ---- live on-chain checks of the offering itself (no third party needed)
  const live: LiveCheck[] = [];
  let saleOracle: string = ZERO;
  if (dep && asset.standard === "erc4626") {
    // Fund vault: no fixed-price sale; report deposits against the offering size, liquidity and whether it's open.
    try {
      const vault = dep.token as Address;
      const vAbi = [
        ...["totalAssets", "depositCap", "capRemaining"].map((name) => ({ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] })),
        ...["paused", "assetVerified"].map((name) => ({ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] })),
        { type: "function", name: "oracle", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
      ];
      const [total, cap, paused, verifiedNow, liquid] = await Promise.all([
        read<bigint>(vault, vAbi, "totalAssets"), read<bigint>(vault, vAbi, "depositCap"), read<boolean>(vault, vAbi, "paused"),
        read<boolean>(vault, vAbi, "assetVerified"), read<bigint>(dep.payToken as Address, liveAbi, "balanceOf", [vault]),
      ]);
      saleOracle = await read<string>(vault, vAbi, "oracle").catch(() => ZERO);
      const d = net.stable?.decimals ?? 6;
      const usd = (v: bigint) => `${(Number(v / 10n ** BigInt(Math.max(0, d - 2))) / 100).toLocaleString()} ${net.stable?.symbol ?? "tUSD"}`;
      live.push(
        { id: "within-cap", label: "Within the offering size", ok: cap === 0n || total <= cap, detail: cap === 0n ? `${usd(total)} in the fund` : `${usd(total)} of ${usd(cap)}` },
        { id: "liquid", label: "Cash held in the vault", ok: null, detail: `${usd(liquid)} available for redemptions; the rest is invested off chain` },
        { id: "sale-state", label: "Deposits", ok: null, detail: paused ? "paused by the issuer" : !verifiedNow ? "closed until proof of asset is current" : "open" },
      );
    } catch (e: any) {
      console.error("[proof] vault checks", asset.id, e?.shortMessage ?? e);
      live.push({ id: "live-unavailable", label: "Live on-chain checks", ok: null, detail: "couldn't read the fund vault right now" });
    }
  } else if (dep) {
    try {
    const token = dep.token as Address, sale = dep.sale as Address;
    const [supply, sold, cap, raised, open, paused, treasury] = await Promise.all([
      read<bigint>(token, liveAbi, "totalSupply"), read<bigint>(sale, liveAbi, "sold"), read<bigint>(sale, liveAbi, "cap"),
      read<bigint>(sale, liveAbi, "raised"), read<boolean>(sale, liveAbi, "isOpen"), read<boolean>(sale, liveAbi, "paused"),
      read<Address>(sale, liveAbi, "treasury"),
    ]);
    saleOracle = await read<string>(sale, liveAbi, "oracle").catch(() => ZERO); // sales deployed before oracles have no getter
    const payDecimals = net.stable?.decimals ?? 6;
    // ERC-1155 fractions and ERC-721 NFTs are whole units (0 decimals); holders may retire (burn) carbon credits on purpose.
    const multi = asset.standard === "erc1155";
    const td = multi || asset.standard === "erc721" ? 0 : 18; // whole fractions / whole NFTs
    const retired = multi ? await read<bigint>(token, liveAbi, "retired", [ITEM_ID]).catch(() => 0n) : 0n;
    const fmt = (v: bigint, d: number) => (d === 0 ? Number(v) : Number(v / 10n ** BigInt(Math.max(0, d - 2))) / 100);
    const treasuryBal = await read<bigint>(dep.payToken as Address, liveAbi, "balanceOf", [treasury]).catch(() => null);
    const accounted = supply + retired;
    live.push(
      {
        id: "supply-matches-sales", label: "Tokens in circulation match tokens sold", ok: accounted === sold,
        detail: accounted === sold
          ? `${fmt(supply, td).toLocaleString()} issued, all through the sale${retired ? `; ${fmt(retired, td).toLocaleString()} more retired by holders` : ""}`
          : `${fmt(supply, td).toLocaleString()} in circulation${retired ? ` + ${fmt(retired, td).toLocaleString()} retired` : ""} but ${fmt(sold, td).toLocaleString()} sold: ${accounted > sold ? "tokens were minted outside the sale" : "tokens were burned"}`,
      },
      { id: "within-cap", label: "Within the offering cap", ok: accounted <= cap, detail: `${fmt(sold, td).toLocaleString()} of ${fmt(cap, td).toLocaleString()} sold` },
      { id: "raised", label: "Raised", ok: null, detail: `${fmt(raised, payDecimals).toLocaleString()} ${net.stable?.symbol ?? "tUSD"}` },
      {
        id: "treasury", label: "Treasury balance", ok: null,
        detail: treasuryBal === null ? "unavailable" : `${fmt(treasuryBal, payDecimals).toLocaleString()} ${net.stable?.symbol ?? "tUSD"} held by ${treasury}`,
      },
      { id: "sale-state", label: "Sale", ok: null, detail: paused ? "paused by the issuer" : open ? "open" : "closed" },
    );
      } catch (e: any) {
      // One unreadable contract must not hide the rest of the proof.
      console.error("[proof] live checks", asset.id, e?.shortMessage ?? e);
      live.push({ id: "live-unavailable", label: "Live on-chain checks", ok: null, detail: "couldn't read the sale contracts right now" });
    }
  }

  // ---- live market feeds written by the Chainlink CRE workflow
  const creFeed = creFeedFor(net);
  if (dep && creFeed) {
    const wanted = CLASS_FEEDS[asset.assetClass as AssetClassId] ?? [];
    const marks = await Promise.all(wanted.map((f) =>
      read<any>(creFeed as Address, markAbi, "latestMark", [dep.token, metricHash(f.metric)]).catch(() => null)));
    wanted.forEach((f, i) => {
      const m = marks[i];
      if (m && m.observedAt > 0n) base.feeds.push({ metric: f.metric, label: f.label, unit: f.unit, value: m.value.toString(), decimals: Number(m.decimals), observedAt: iso(m.observedAt), source: "chainlink-cre" });
    });
  }

  // ---- signed attestations
  // The oracle this offering's sale is gated by (old offerings stay on the oracle they were deployed with).
  const oracleCfg = oracleForSale(net, saleOracle);
  const oracle = oracleCfg?.address ?? null;
  if (!oracle) return { ...base, live, checks: required.map((k) => ({ kind: k, name: CHECK_KINDS[k].name, confirms: CHECK_KINDS[k].confirms, status: "missing" as const })), error: `Proof of asset isn't live on ${net.name} yet` };
  const gated = eq(saleOracle, oracle);
  if (!dep) return { ...base, oracle, live, checks: required.map((k) => ({ kind: k, name: CHECK_KINDS[k].name, confirms: CHECK_KINDS[k].confirms, status: "missing" as const })) };

  const token = dep.token as Address;
  // Judge expiry by chain time, exactly as the contract does when it gates purchases.
  const chainNow = Number((await client.getBlock()).timestamp) * 1000;
  const [cls, kindHashes] = await read<[string, string[]]>(oracle, oracleAbi, "registration", [token]);
  const registered = cls !== `0x${"0".repeat(64)}`;
  const kinds: CheckKindId[] = registered ? (kindHashes.map(kindByHash).filter(Boolean) as CheckKindId[]) : required;
  const verified = registered ? await read<boolean>(oracle, oracleAbi, "isVerified", [token]) : false;

  const checks = await Promise.all(kinds.map(async (k): Promise<ProofCheck> => {
    const meta = CHECK_KINDS[k];
    const out: ProofCheck = { kind: k, name: meta.name, confirms: meta.confirms, status: "missing", valueUnit: meta.valueUnit };
    if (!registered) return out;
    const a = await read<any>(oracle, oracleAbi, "latest", [token, kindHash(k)]);
    if (Number(a.result) === 0) return out;
    const [[active, name], allowed] = await Promise.all([
      read<[boolean, string]>(oracle, oracleAbi, "verifiers", [a.verifier]),
      read<boolean>(oracle, oracleAbi, "canAttest", [a.verifier, kindHash(k)]),
    ]);
    const until = Number(a.validUntil) * 1000;
    out.verifier = { address: getAddress(a.verifier), name };
    out.attestedAt = iso(a.attestedAt);
    out.validUntil = iso(a.validUntil);
    out.value = a.value !== 0n ? a.value.toString() : undefined;
    out.evidenceURI = a.evidenceURI;
    out.evidenceHash = a.evidenceHash;
    out.tx = await attestTx(client, net!.id, oracle, oracleCfg!.fromBlock, token, kindHash(k));
    if (!active || !allowed) out.status = "verifier-removed";
    else if (Number(a.result) === 2) out.status = until >= chainNow ? "failed" : "expired";
    else if (until < chainNow) out.status = "expired";
    else out.status = until - chainNow < 14 * 86_400_000 ? "expiring" : "current";
    return out;
  }));
  if (registered && !eq(cls, classHash(asset.assetClass))) live.push({ id: "class", label: "Registered asset class", ok: false, detail: "the token is registered under a different asset class than this listing" });
  return { ...base, oracle, gated, registered, verified, checks, live };
}

// ---------------------------------------------------------------- cache + background refresh
const cache = new Map<string, Proof>();
const inflight = new Map<string, Promise<Proof>>();

export function proofFor(asset: any, maxAgeMs = REFRESH_MS): Promise<Proof> {
  const hit = cache.get(asset.id);
  if (hit && Date.now() - Date.parse(hit.checkedAt) < maxAgeMs) return Promise.resolve(hit);
  if (inflight.has(asset.id)) return inflight.get(asset.id)!;
  const p = computeProof(asset)
    .then((r) => (cache.set(asset.id, r), r))
    .catch((e) => {
      console.error("[proof]", asset.id, e?.shortMessage ?? e);
      return hit ?? { assetId: asset.id, chainId: asset.chainId, oracle: null, gated: false, registered: false, verified: false, checks: [], live: [], feeds: [], checkedAt: new Date().toISOString(), error: "Couldn't read the network right now" };
    })
    .finally(() => inflight.delete(asset.id));
  inflight.set(asset.id, p);
  return p;
}

/** Keep every deployed asset's proof warm so listings are never more than a couple of minutes stale. */
export function startProofRefresher(allDeployed: () => Promise<any[]>) {
  registerJob("proof-refresh", async () => {
    let refreshed = 0, failed = 0;
    for (const a of await allDeployed()) await proofFor(a, REFRESH_MS - 5_000).then(() => refreshed++, () => failed++);
    return { refreshed, failed };
  }, REFRESH_MS, 5_000);
}

// ---------------------------------------------------------------- verifier directory
export async function verifiersOn(chainId: number) {
  const net = networkById(chainId);
  const o = assetOracleFor(net);
  if (!net || !o) return [];
  const client = clientFor(net);
  const sets = (await eventLogs<any>(client, net.id, o.address, o.fromBlock, verifierSetEvent as any)).map((l) => ({ args: l.args }));
  const kinds = (await eventLogs<any>(client, net.id, o.address, o.fromBlock, verifierKindEvent as any)).map((l) => ({ args: l.args }));
  const by = new Map<string, { address: Address; name: string; active: boolean; kinds: Set<CheckKindId> }>();
  for (const l of sets) by.set(l.args.verifier!.toLowerCase(), { address: getAddress(l.args.verifier!), name: l.args.name!, active: l.args.active!, kinds: by.get(l.args.verifier!.toLowerCase())?.kinds ?? new Set() });
  for (const l of kinds) {
    const v = by.get(l.args.verifier!.toLowerCase());
    const k = kindByHash(l.args.kind!);
    if (!v || !k) continue;
    if (l.args.allowed) v.kinds.add(k);
    else v.kinds.delete(k);
  }
  return [...by.values()].filter((v) => v.active).map((v) => ({ ...v, kinds: [...v.kinds] }));
}

// ---------------------------------------------------------------- evidence files
export const evidenceMessage = (sha256: string, chainId: number, ts: number) =>
  `Diamondz Tokenize evidence upload\nsha256: ${sha256}\nnetwork: ${chainId}\ntime: ${ts}`;

export function mountProof(app: Hono<any>, deps: { findAsset: (c: Context, id: string) => Promise<any | null>; allDeployed: () => Promise<any[]> }) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });

  app.get("/proof/verifiers/:chainId", async (c) => {
    try {
      return c.json(await verifiersOn(Number(c.req.param("chainId"))));
    } catch (e) {
      console.error("[proof] verifiers", e);
      return c.json({ error: "Couldn't read the network right now" }, 422);
    }
  });

  app.get("/proof/evidence/:sha", async (c) => {
    const sha = c.req.param("sha").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha)) return c.json({ error: "Not found" }, 404);
    for (const ext of Object.values(EVIDENCE_TYPES)) {
      const f = Bun.file(`${EVIDENCE_DIR}/${sha}.${ext}`);
      if (await f.exists()) {
        return new Response(f, {
          headers: {
            "content-type": f.type,
            "cache-control": "public, max-age=31536000, immutable",
            "x-content-type-options": "nosniff",
            "content-security-policy": "sandbox",
          },
        });
      }
    }
    return c.json({ error: "Not found" }, 404);
  });

  // Upload: multipart form with `file`, `chainId`, `verifier`, `ts`, `signature` (personal_sign of evidenceMessage).
  // Only wallets the platform approved as verifiers on that network's AssetOracle can upload.
  app.post("/proof/evidence", async (c) => {
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > MAX_EVIDENCE_BYTES + 64 * 1024) return c.json({ error: "File too large (max 20 MB)" }, 413);
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!form || !(file instanceof File)) return c.json({ error: "Attach a file" }, 400);
    if (file.size > MAX_EVIDENCE_BYTES) return c.json({ error: "File too large (max 20 MB)" }, 413);
    const ext = EVIDENCE_TYPES[(file.type.split(";")[0] ?? "").trim().toLowerCase()];
    if (!ext) return c.json({ error: "Upload a PDF, PNG, JPEG, JSON or text file" }, 415);
    const chainId = Number(form.get("chainId"));
    const verifier = String(form.get("verifier") ?? "");
    const ts = Number(form.get("ts"));
    const signature = String(form.get("signature") ?? "") as `0x${string}`;
    const net = networkById(chainId);
    const oracles = knownOracles(net);
    if (!net || !oracles.length) return c.json({ error: "Proof of asset isn't live on that network" }, 400);
    if (!isAddress(verifier)) return c.json({ error: "Bad verifier address" }, 400);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > SIG_MAX_AGE_S) return c.json({ error: "Signature expired, sign again" }, 400);

    const bytes = new Uint8Array(await file.arrayBuffer());
    // The claimed type must match the file's signature (the server also serves it sandboxed + nosniff).
    const magic: Record<string, number[]> = { pdf: [0x25, 0x50, 0x44, 0x46], png: [0x89, 0x50, 0x4e, 0x47], jpg: [0xff, 0xd8, 0xff] };
    if (magic[ext] && !magic[ext].every((b, i) => bytes[i] === b)) return c.json({ error: `That file isn't a real ${ext.toUpperCase()}` }, 415);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const client = clientFor(net);
    const message = evidenceMessage(sha, chainId, ts);
    // publicClient.verifyMessage also accepts ERC-1271 contract wallets (e.g. a verifier's Safe).
    const sigOk = await client.verifyMessage({ address: verifier as Address, message, signature }).catch(() => false)
      || (await verifyMessage({ address: verifier as Address, message, signature }).catch(() => false));
    if (!sigOk) return c.json({ error: "Signature doesn't match the verifier wallet" }, 401);
    // Approved on any platform oracle of this network (current or legacy).
    let active = false;
    for (const o of oracles) {
      if (active) break;
      // An oracle that can't be read (e.g. a legacy one on a fork) simply doesn't approve anyone.
      [active] = await client.readContract({ address: o.address, abi: oracleAbi, functionName: "verifiers", args: [verifier as Address] }).catch(() => [false] as const);
    }
    if (!active) return c.json({ error: "This wallet isn't an approved verifier on " + net.name }, 403);

    const path = `${EVIDENCE_DIR}/${sha}.${ext}`;
    if (!existsSync(path)) await Bun.write(path, bytes);
    const host = c.req.header("host");
    return c.json({ sha256: `0x${sha}`, uri: `https://${host}/api/proof/evidence/${sha}`, bytes: file.size });
  });

  app.get("/proof/:assetId", async (c) => {
    const asset = await deps.findAsset(c, c.req.param("assetId"));
    if (!asset) return c.json({ error: "Not found" }, 404);
    return c.json(await proofFor(asset));
  });

  startProofRefresher(deps.allDeployed);
}
