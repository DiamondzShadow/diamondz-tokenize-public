// Payouts: issuers pay income (rent, royalties, interest) to token holders through the platform Distributor.
//
// Issuer (console, signed in):
//   POST /api/assets/:id/payouts/preview   snapshot holders at a block, split pro rata, build the Merkle tree (draft)
//   POST /api/payouts/:pid/sent            after the wallet/Safe funded it: verify the on-chain payout matches the draft
//   GET  /api/assets/:id/payouts           history with claimed counts
// Investor (public):
//   GET  /api/portfolio/:address           claimable + paid payouts for a wallet
//   POST /api/payouts/:pid/claim           gas-free claim: the platform relayer submits it; funds go to the holder
// Background: payouts unclaimed after 7 days are delivered automatically by the relayer (platform pays gas,
// recouped through the flat per-payout fee).
import type { Context, Hono } from "hono";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { z } from "zod";
import {
  createPublicClient, createWalletClient, decodeEventLog, getAddress, http, isAddress, parseAbiItem, parseUnits,
  type Address, type Hex, type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { registerJob } from "./jobs";
import type { Store } from "./store";
import { networkById, type Network, rpcUrl } from "./chains";
import { eventLogs, invalidate } from "./logindex";

const AUTO_DELIVER_AFTER_MS = 7 * 86_400_000;
const AUTO_DELIVER_EVERY_MS = 60 * 60_000;
const AUTO_DELIVER_MAX_PER_RUN = 25;
const LOG_CHUNK = 5_000n;

export const distributorAbi = [
  { type: "function", name: "payoutTokens", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }, { type: "uint256" }] },
  { type: "function", name: "isClaimed", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  {
    type: "function", name: "claim", stateMutability: "nonpayable",
    inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes32[]" }], outputs: [],
  },
] as const;
const createdEvent = parseAbiItem(
  "event DistributionCreated(uint256 indexed id, address indexed token, address indexed payout, bytes32 merkleRoot, uint256 total, uint256 fee, uint64 snapshotBlock, uint64 claimDeadline, string memo)",
);
const claimedEvent = parseAbiItem("event Claimed(uint256 indexed id, uint256 index, address indexed account, uint256 amount)");
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const tokenAbi = [
  { type: "function", name: "getFrozenTokens", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/** The network's payout contract. DISTRIBUTOR_<chainId>=0xAddr:fromBlock overrides it (local forks, tests). */
export function distributorFor(net: Network | undefined): { address: Address; fromBlock: number } | undefined {
  if (!net) return undefined;
  const o = process.env[`DISTRIBUTOR_${net.id}`];
  if (o) {
    const [address, block] = o.split(":");
    return { address: address as Address, fromBlock: Number(block ?? 0) };
  }
  return net.distributor as any;
}

const clients = new Map<number, PublicClient>();
const client = (net: Network) => {
  if (!clients.has(net.id)) clients.set(net.id, createPublicClient({ transport: http(rpcUrl(net), { timeout: 20_000, retryCount: 2 }) }) as PublicClient);
  return clients.get(net.id)!;
};

// ------------------------------------------------------------------ snapshot + split

/** Block of the token's deployment, from the deployment txs recorded for the asset. */
async function tokenDeployBlock(pc: PublicClient, dep: any, asset?: any): Promise<bigint> {
  // ERC-3643: the token proxy is created inside the platform factory's transaction (no contractAddress receipt);
  // the block was recorded when the platform deployed the suite.
  if (asset?.trex?.deployBlock != null && asset.trex.token?.toLowerCase() === dep.token.toLowerCase()) return BigInt(asset.trex.deployBlock);
  for (const h of dep.txs ?? []) {
    const r = await pc.getTransactionReceipt({ hash: h }).catch(() => null);
    if (r?.contractAddress && r.contractAddress.toLowerCase() === dep.token.toLowerCase()) return r.blockNumber;
  }
  throw new Error("couldn't find the token's deployment transaction");
}

/** Holder balances at `atBlock`, rebuilt from Transfer events (exact; no archive node needed). Reads the shared
 *  incremental log index, so a second preview only fetches new blocks. */
async function balancesAt(pc: PublicClient, chainId: number, token: Address, from: bigint, atBlock: bigint) {
  const bal = new Map<string, bigint>();
  const logs = await eventLogs<{ from: Address; to: Address; value: bigint }>(pc, chainId, token, from, transferEvent as any);
  for (const l of logs) {
    if (l.blockNumber > atBlock) continue;
    const { from: f, to, value } = l.args;
    if (f !== "0x0000000000000000000000000000000000000000") bal.set(f.toLowerCase(), (bal.get(f.toLowerCase()) ?? 0n) - value);
    if (to !== "0x0000000000000000000000000000000000000000") bal.set(to.toLowerCase(), (bal.get(to.toLowerCase()) ?? 0n) + value);
  }
  return [...bal].filter(([, v]) => v > 0n).map(([a, v]) => ({ account: getAddress(a), tokens: v }));
}

/** Smallest block with timestamp >= ts (binary search). */
async function blockAtTime(pc: PublicClient, ts: bigint, lo: bigint, hi: bigint) {
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const b = await pc.getBlock({ blockNumber: mid });
    if (b.timestamp < ts) lo = mid + 1n;
    else hi = mid;
  }
  return lo;
}

/** Pro-rata split with the largest-remainder method so shares add up to `total` exactly. */
export function split(total: bigint, holders: { account: Address; tokens: bigint }[]) {
  const supply = holders.reduce((s, h) => s + h.tokens, 0n);
  if (supply === 0n) return [];
  const rows = holders.map((h) => ({ ...h, amount: (total * h.tokens) / supply, rem: (total * h.tokens) % supply }));
  let left = total - rows.reduce((s, r) => s + r.amount, 0n);
  const byRem = [...rows].sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : a.account.localeCompare(b.account)));
  for (const r of byRem) {
    if (left === 0n) break;
    r.amount += 1n;
    left -= 1n;
  }
  return rows.filter((r) => r.amount > 0n).map(({ account, tokens, amount }) => ({ account, tokens, amount }));
}

// ------------------------------------------------------------------ relayer (gas-free claims + auto-delivery)
function relayer(net: Network) {
  const k = process.env.PAYOUT_RELAYER_KEY;
  if (!k) return null;
  const acct = privateKeyToAccount((k.startsWith("0x") ? k : `0x${k}`) as Hex);
  const rpc = rpcUrl(net);
  const chain = { id: net.id, name: net.name, nativeCurrency: net.native, rpcUrls: { default: { http: [rpc] } } } as const;
  return createWalletClient({ account: acct, chain, transport: http(rpc) });
}

type PayoutData = {
  chainId: number; token: Address; tokenDecimals?: number; payout: Address; payoutSymbol: string; payoutDecimals: number;
  amount: string; memo: string; snapshotBlock: string; snapshotTime: string; claimDeadline: string;
  root: Hex; tree: any; holders: { account: Address; tokens: string; amount: string }[];
  frozen: { account: Address; tokens: string; frozenTokens: string; amount: string; held: boolean }[];
  fee: string; distributionId?: string; tx?: Hex; sentAt?: string; sentBlock?: string; distributor: Address;
};

async function relayClaim(net: Network, d: PayoutData, account: Address) {
  const tree = StandardMerkleTree.load(d.tree);
  let found: { index: number; amount: bigint; leafIndex: number } | null = null;
  for (const [i, v] of tree.entries()) if ((v[1] as string).toLowerCase() === account.toLowerCase()) found = { index: Number(v[0]), amount: BigInt(v[2]), leafIndex: i };
  if (!found) throw Object.assign(new Error("This wallet has nothing to claim in this payout"), { status: 404 });
  const pc = client(net);
  const id = BigInt(d.distributionId!);
  if (await pc.readContract({ address: d.distributor, abi: distributorAbi, functionName: "isClaimed", args: [id, BigInt(found.index)] }))
    throw Object.assign(new Error("Already claimed"), { status: 409 });
  if (Date.parse(d.claimDeadline) < Date.now()) throw Object.assign(new Error("The claim window for this payout has closed"), { status: 410 });
  const wc = relayer(net);
  if (!wc) throw Object.assign(new Error("Gas-free claiming isn't switched on yet"), { status: 503 });
  const args = [id, BigInt(found.index), getAddress(account), found.amount, tree.getProof(found.leafIndex) as Hex[]] as const;
  await pc.simulateContract({ address: d.distributor, abi: distributorAbi, functionName: "claim", args, account: wc.account });
  const hash = await wc.writeContract({ address: d.distributor, abi: distributorAbi, functionName: "claim", args, chain: wc.chain });
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`claim reverted: ${hash}`);
  invalidate(net.id, d.distributor); // the next history read includes this claim
  return { tx: hash, amount: found.amount.toString() };
}

async function claimedLogs(net: Network, d: PayoutData) {
  const pc = client(net);
  // Always index the distributor from its own first block (one shared stream per contract); filter by payout id.
  const from = BigInt(distributorFor(net)?.fromBlock ?? d.sentBlock ?? 0);
  const logs = await eventLogs<{ account: Address; amount: bigint }>(pc, net.id, d.distributor, from, claimedEvent as any, { id: BigInt(d.distributionId!) });
  return logs.map((l) => ({ account: getAddress(l.args.account), amount: l.args.amount, tx: l.transactionHash }));
}

// ------------------------------------------------------------------ routes
const Preview = z.object({
  amount: z.string().regex(/^\d{1,12}(\.\d{1,6})?$/, "amount like 15000.00"),
  memo: z.string().trim().min(1).max(80),
  snapshot: z.discriminatedUnion("mode", [z.object({ mode: z.literal("now") }), z.object({ mode: z.literal("date"), at: z.string().datetime() })]),
  claimMonths: z.number().int().min(1).max(36).default(12),
  holdFrozen: z.boolean().default(true),
});

export function mountPayouts(app: Hono<any>, deps: {
  store: Store;
  requireAdmin: (c: Context<any>, next: () => Promise<void>) => Promise<Response | void>;
  adminAsset: (c: Context<any>, id: string) => Promise<any | null>;
  tenantId: (c: Context<any>) => string;
  /** Issuers whose offerings this website shows (platform site: itself + every self-serve workspace). */
  siteTenantIds: (c: Context<any>) => Promise<string[]>;
  siteHas: (c: Context<any>, tenantId: string) => boolean;
}) {
  const { store } = deps;
  const row = (id: string) => store.getPayout(id);
  const save = (id: string, status: string, data: PayoutData) => store.setPayout(id, status, JSON.stringify(data), new Date().toISOString());
  const fail = (c: Context, e: any) => {
    const status = e?.status ?? 500;
    if (status === 500) console.error("[payouts]", e?.shortMessage ?? e);
    return c.json({ error: status === 500 ? (e?.shortMessage ?? "Couldn't complete that on the network. Try again.") : e.message }, status);
  };

  app.post("/assets/:id/payouts/preview", deps.requireAdmin, async (c) => {
    const asset = await deps.adminAsset(c, c.req.param("id") ?? "");
    if (!asset || asset.status !== "deployed") return c.json({ error: "Deploy the offering first" }, 404);
    // Holder snapshots read ERC-20 Transfer logs; ERC-1155 (TransferSingle/Batch) and ERC-721 aren't supported yet.
    // ERC-721 Transfer logs share the ERC-20 topic but index the token id, so they'd be misread as amounts.
    if (asset.standard === "erc1155" || asset.standard === "erc721")
      return c.json({ error: `Payouts to ${asset.standard === "erc721" ? "ERC-721" : "ERC-1155"} holders aren't available yet` }, 400);
    const net = networkById(asset.chainId)!;
    const dist = distributorFor(net);
    if (!dist) return c.json({ error: `Payouts aren't live on ${net.name} yet` }, 409);
    const p = Preview.safeParse(await c.req.json().catch(() => null));
    if (!p.success) return c.json({ error: p.error.issues.map((i) => i.message).join("; ") }, 400);
    try {
      const pc = client(net);
      const dep = asset.deployment;
      const payout = getAddress(dep.payToken);
      const [decimals, symbol, [enabled, fee]] = await Promise.all([
        pc.readContract({ address: payout, abi: [{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }] as const, functionName: "decimals" }),
        pc.readContract({ address: payout, abi: [{ type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }] as const, functionName: "symbol" }),
        pc.readContract({ address: dist.address, abi: distributorAbi, functionName: "payoutTokens", args: [payout] }),
      ]);
      if (!enabled) return c.json({ error: `${symbol} isn't enabled for payouts on ${net.name}` }, 409);
      const tokenDecimals = await pc.readContract({ address: getAddress(dep.token), abi: [{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }] as const, functionName: "decimals" });
      const deployBlock = await tokenDeployBlock(pc, dep, asset);
      // "Now" = a few blocks behind the tip (L2 reorgs are shallow). Not "finalized": on rollups that lags
      // 15+ minutes and would leave out recent buyers.
      const latest = await pc.getBlockNumber({ cacheTime: 0 });
      const head = latest > deployBlock + 3n ? latest - 3n : latest;
      let snapBlock = head;
      if (p.data.snapshot.mode === "date") {
        const ts = BigInt(Math.floor(Date.parse(p.data.snapshot.at) / 1000));
        snapBlock = await blockAtTime(pc, ts, deployBlock, head);
      }
      const snapTime = (await pc.getBlock({ blockNumber: snapBlock })).timestamp;
      const holders = await balancesAt(pc, net.id, getAddress(dep.token), deployBlock, snapBlock);
      if (!holders.length) return c.json({ error: "Nobody held this token at the snapshot" }, 409);
      const frozenAmt = await Promise.all(holders.map((h) => pc.readContract({ address: getAddress(dep.token), abi: tokenAbi, functionName: "getFrozenTokens", args: [h.account] }).catch(() => 0n)));
      const total = parseUnits(p.data.amount, decimals);
      const shares = split(total, holders);
      const frozenOf = (a: Address) => frozenAmt[holders.findIndex((h) => h.account === a)] ?? 0n;
      const frozen = shares.filter((s) => frozenOf(s.account) > 0n);
      const held = new Set(p.data.holdFrozen ? frozen.map((f) => f.account) : []);
      const paid = shares.filter((s) => !held.has(s.account));
      const leaves = paid.map((s, i) => [i, s.account, s.amount.toString()]);
      const tree = StandardMerkleTree.of(leaves, ["uint256", "address", "uint256"]);
      const paidTotal = paid.reduce((s, r) => s + r.amount, 0n);
      const deadline = new Date(Number(snapTime) * 1000);
      deadline.setMonth(deadline.getMonth() + p.data.claimMonths);
      const data: PayoutData = {
        chainId: net.id, token: getAddress(dep.token), tokenDecimals: Number(tokenDecimals), payout, payoutSymbol: symbol, payoutDecimals: Number(decimals),
        amount: paidTotal.toString(), memo: p.data.memo, snapshotBlock: snapBlock.toString(), snapshotTime: new Date(Number(snapTime) * 1000).toISOString(),
        claimDeadline: deadline.toISOString(), root: tree.root as Hex, tree: tree.dump(),
        holders: paid.map((s) => ({ account: s.account, tokens: s.tokens.toString(), amount: s.amount.toString() })),
        frozen: frozen.map((f) => ({ account: f.account, tokens: f.tokens.toString(), frozenTokens: frozenOf(f.account).toString(), amount: f.amount.toString(), held: held.has(f.account) })),
        fee: (fee as bigint).toString(), distributor: dist.address,
      };
      const id = `pay_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const now = new Date().toISOString();
      await store.insertPayout({ id, tenant_id: deps.tenantId(c), asset_id: asset.id, status: "draft", data: JSON.stringify(data), created_at: now, updated_at: now });
      const { tree: _t, ...pub } = data;
      return c.json({ id, status: "draft", ...pub, call: {
        distributor: dist.address,
        args: [data.token, data.payout, data.root, data.amount, data.snapshotBlock, String(Math.floor(deadline.getTime() / 1000)), data.memo, data.fee],
      } });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post("/payouts/:pid/sent", deps.requireAdmin, async (c) => {
    const r = await row(c.req.param("pid") ?? "");
    if (!r || r.tenant_id !== deps.tenantId(c)) return c.json({ error: "Not found" }, 404);
    if (r.status !== "draft") return c.json({ error: "Already recorded" }, 409);
    const tx = (await c.req.json().catch(() => ({})))?.tx as string;
    if (!/^0x[0-9a-fA-F]{64}$/.test(tx ?? "")) return c.json({ error: "Transaction hash required" }, 400);
    const d = JSON.parse(r.data) as PayoutData;
    const net = networkById(d.chainId)!;
    try {
      const rc = await client(net).getTransactionReceipt({ hash: tx as Hex });
      if (rc.status !== "success") return c.json({ error: "That transaction failed" }, 422);
      const ev = rc.logs.filter((l) => l.address.toLowerCase() === d.distributor.toLowerCase())
        .map((l) => { try { return decodeEventLog({ abi: [createdEvent], data: l.data, topics: l.topics }); } catch { return null; } })
        .find(Boolean);
      if (!ev) return c.json({ error: "No payout found in that transaction" }, 422);
      const a = ev.args as any;
      const mismatch = [
        a.token.toLowerCase() !== d.token.toLowerCase() && "token",
        a.payout.toLowerCase() !== d.payout.toLowerCase() && "payout currency",
        a.merkleRoot !== d.root && "holder list (Merkle root)",
        a.total.toString() !== d.amount && "amount",
        a.snapshotBlock.toString() !== d.snapshotBlock && "snapshot block",
      ].filter(Boolean);
      if (mismatch.length) return c.json({ error: `The on-chain payout doesn't match this preview: ${mismatch.join(", ")}` }, 422);
      const next: PayoutData = { ...d, distributionId: a.id.toString(), tx: tx as Hex, sentAt: new Date().toISOString(), sentBlock: rc.blockNumber.toString(), fee: a.fee.toString() };
      await save(r.id, "sent", next);
      return c.json({ ok: true, distributionId: next.distributionId });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.get("/assets/:id/payouts", deps.requireAdmin, async (c) => {
    const asset = await deps.adminAsset(c, c.req.param("id") ?? "");
    if (!asset) return c.json({ error: "Not found" }, 404);
    const rows = await store.payoutsSentByAsset(asset.id);
    const out = await Promise.all(rows.map(async (r) => {
      const d = JSON.parse(r.data) as PayoutData;
      const net = networkById(d.chainId)!;
      const claims = await claimedLogs(net, d).catch((e) => { console.error("[payouts] claimed logs", e?.shortMessage ?? e); return null; });
      return {
        id: r.id, memo: d.memo, amount: d.amount, decimals: d.payoutDecimals, symbol: d.payoutSymbol, fee: d.fee,
        snapshotTime: d.snapshotTime, snapshotBlock: d.snapshotBlock, sentAt: d.sentAt, tx: d.tx, claimDeadline: d.claimDeadline,
        holders: d.holders.length, claimedCount: claims?.length ?? null, claimedAmount: claims ? claims.reduce((s, x) => s + x.amount, 0n).toString() : null,
        frozenHeld: d.frozen.filter((f) => f.held).length,
      };
    }));
    const dist = distributorFor(networkById(asset.chainId));
    return c.json({ distributor: dist?.address ?? null, payouts: out });
  });

  app.get("/portfolio/:address", async (c) => {
    const addr = c.req.param("address");
    if (!isAddress(addr)) return c.json({ error: "Bad address" }, 400);
    const assetData = new Map<string, string>();
    const rows: any[] = [];
    for (const tenantId of await deps.siteTenantIds(c)) {
      for (const p of await store.payoutsSentByTenant(tenantId)) {
        if (!assetData.has(p.asset_id)) assetData.set(p.asset_id, (await store.getAsset(p.asset_id, p.tenant_id))?.data ?? "null");
        const asset = assetData.get(p.asset_id)!;
        if (asset !== "null") rows.push({ ...p, asset });
      }
    }
    const claimable: any[] = [], paid: any[] = [];
    for (const r of rows) {
      const d = JSON.parse(r.data) as PayoutData;
      const mine = d.holders.find((h) => h.account.toLowerCase() === addr.toLowerCase());
      if (!mine) continue;
      const asset = JSON.parse(r.asset);
      const net = networkById(d.chainId)!;
      const claims = await claimedLogs(net, d).catch((e) => { console.error("[payouts] claimed logs", e?.shortMessage ?? e); return []; });
      const got = claims.find((x) => x.account.toLowerCase() === addr.toLowerCase());
      const item = { payoutId: r.id, assetId: r.asset_id, assetName: asset.name, symbol: asset.symbol, memo: d.memo, chainId: d.chainId,
        amount: mine.amount, decimals: d.payoutDecimals, payoutSymbol: d.payoutSymbol, tokens: mine.tokens, tokenDecimals: d.tokenDecimals ?? 18, snapshotTime: d.snapshotTime, claimDeadline: d.claimDeadline };
      if (got) paid.push({ ...item, tx: got.tx });
      else if (Date.parse(d.claimDeadline) > Date.now()) claimable.push(item);
    }
    return c.json({ claimable, paid });
  });

  // Gas-free claim. Public: it can only ever pay the holder their own share.
  const recent = new Map<string, number>();
  app.post("/payouts/:pid/claim", async (c) => {
    const r = await row(c.req.param("pid") ?? "");
    if (!r || r.status !== "sent" || !deps.siteHas(c, r.tenant_id)) return c.json({ error: "Not found" }, 404);
    const account = (await c.req.json().catch(() => ({})))?.account as string;
    if (!isAddress(account ?? "")) return c.json({ error: "Wallet address required" }, 400);
    const key = `${r.id}:${account.toLowerCase()}`;
    if (Date.now() - (recent.get(key) ?? 0) < 30_000) return c.json({ error: "Claim already in progress" }, 429);
    recent.set(key, Date.now());
    const d = JSON.parse(r.data) as PayoutData;
    try {
      return c.json(await relayClaim(networkById(d.chainId)!, d, getAddress(account)));
    } catch (e) {
      recent.delete(key);
      return fail(c, e);
    }
  });

  // Auto-delivery: after 7 days, the relayer claims for holders who haven't.
  const autoDeliver = async () => {
    if (!process.env.PAYOUT_RELAYER_KEY) return { skipped: "no relayer key" };
    let budget = AUTO_DELIVER_MAX_PER_RUN, delivered = 0, failedClaims = 0;
    for (const r of await store.payoutsSent()) {
      const d = JSON.parse(r.data) as PayoutData;
      if (!d.sentAt || Date.now() - Date.parse(d.sentAt) < AUTO_DELIVER_AFTER_MS || Date.parse(d.claimDeadline) < Date.now()) continue;
      const net = networkById(d.chainId)!;
      const claimed = new Set((await claimedLogs(net, d).catch(() => [])).map((x) => x.account.toLowerCase()));
      for (const h of d.holders) {
        if (budget <= 0) return { delivered, failed: failedClaims, budgetExhausted: true };
        if (claimed.has(h.account.toLowerCase())) continue;
        budget--;
        await relayClaim(net, d, h.account).then(
          (x) => { delivered++; console.log(`[payouts] auto-delivered ${r.id} to ${h.account} ${x.tx}`); },
          (e) => { failedClaims++; console.error(`[payouts] auto-deliver ${r.id} ${h.account}:`, e?.shortMessage ?? e?.message); },
        );
      }
    }
    return { delivered, failed: failedClaims };
  };
  registerJob("payout-autodeliver", autoDeliver, AUTO_DELIVER_EVERY_MS, 60_000);
}
