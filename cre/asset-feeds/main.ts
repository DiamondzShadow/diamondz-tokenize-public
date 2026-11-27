// Diamondz Tokenize: per-asset-class proof-of-asset feeds on Chainlink CRE.
//
// Every run (cron), for each listed asset, the DON gathers market / registry / on-chain data for its asset class,
// agrees on it (EVM reads are DON reads; HTTP observations use median consensus), and builds a batch of items:
//   MARK   = a live market value for the listing (stored on CreAssetFeed, readable by anyone)
//   ATTEST = a proof-of-asset check signed into AssetOracle (only where the source is authoritative for that asset)
// The batch is one CRE report delivered through Chainlink's KeystoneForwarder to CreAssetFeed.
//
// mode "local-simulation" runs every real fetch and consensus step, then logs the batch and stops before any
// report, EVM client write or forwarder delivery. mode "production" requires a receiver and writes.
import {
  CronCapability, EVMClient, HTTPClient, LAST_FINALIZED_BLOCK_NUMBER, Runner, TxStatus,
  bytesToBase64, bytesToHex, consensusMedianAggregation, encodeCallMsg, getNetwork, handler, json, text,
  ok, prepareReportRequest, type HTTPSendRequester, type NodeRuntime, type Runtime,
} from "@chainlink/cre-sdk";
import { z } from "zod";
import {
  decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseAbiParameters, stringToHex,
  zeroAddress, type Address, type Hex,
} from "viem";

// ------------------------------------------------------------------ config
const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "address");
const decimal = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,18})?$/, "positive decimal string");
const httpsUrl = z.string().regex(/^https:\/\/[^\s/$.?#].[^\s]*$/, "https url"); // no URL global in QuickJS
const feedRef = z.object({
  chain: z.string(),
  address: addr,
  /** Chainlink feed heartbeat; a round older than heartbeat x 1.5 is rejected. */
  heartbeatSec: z.number().int().positive(),
  /** L2 sequencer uptime feed on the same chain (Base, Arbitrum). */
  sequencer: addr.optional(),
});
const asset = z.discriminatedUnion("category", [
  z.object({ category: z.literal("real-estate"), label: z.string(), token: addr, appraisedValueUsd: decimal, appraisalIndex: decimal, fredSeries: z.string().regex(/^[A-Z0-9]{2,30}$/) }),
  z.object({ category: z.literal("energy"), label: z.string(), token: addr, bblPerDay: decimal, royaltyBps: z.number().int().min(0).max(10_000) }),
  z.object({ category: z.literal("private-equity"), label: z.string(), token: addr, comps: z.array(z.string().regex(/^[A-Z.]{1,10}$/)).max(5) }),
  z.object({ category: z.literal("private-credit"), label: z.string(), token: addr, spreadBps: z.number().int().min(0).max(5_000) }),
  z.object({ category: z.literal("funds"), label: z.string(), token: addr, navFeed: feedRef.optional() }),
  z.object({ category: z.literal("music-ip"), label: z.string(), token: addr, royaltyVault: addr, royaltyToken: addr }),
  z.object({ category: z.literal("collectibles"), label: z.string(), token: addr, metal: z.enum(["XAU", "XAG"]).optional(), ounces: decimal.optional() }),
  z.object({ category: z.literal("carbon"), label: z.string(), token: addr, creditChain: z.string(), creditToken: addr, holder: addr, expectedTonnes: decimal }),
]);
const shared = {
  schedule: z.string().regex(/^(\S+\s+){5}\S+$/, "six-field CRE cron"),
  feeds: z.object({ WTI: feedRef, XAU: feedRef, XAG: feedRef, SPY: feedRef, PCE: feedRef }),
  sofrUrl: httpsUrl,
  storyRpc: httpsUrl,
  keyed: z.object({ fred: z.boolean(), massive: z.boolean() }),
  assets: z.array(asset).max(40),
};
const configSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("local-simulation"), ...shared }).strict(),
  z.object({
    mode: z.literal("production"),
    ...shared,
    receiver: addr.refine((a) => a.toLowerCase() !== zeroAddress, "receiver must be nonzero"),
    writeChain: z.string(),
    gasLimit: z.string().regex(/^[1-9]\d*$/),
  }).strict(),
]);
type Config = z.infer<typeof configSchema>;
type Asset = z.infer<typeof asset>;
type FeedRef = z.infer<typeof feedRef>;

// ------------------------------------------------------------------ helpers
const ITEM_MARK = 1;
const ITEM_ATTEST = 2;
const RESULT = { Pass: 1, Fail: 2 } as const;
const metricId = (name: string): Hex => keccak256(stringToHex(name));
const kindId = (name: string): Hex => keccak256(stringToHex(name));
const pow10 = (n: number) => 10n ** BigInt(n);

/** Strict positive decimal string -> integer scaled to `dp` decimals (rejects excess precision, never rounds). */
function scaleDecimal(value: string, dp: number): bigint {
  const m = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
  if (!m) throw new Error(`not a positive decimal: ${value}`);
  const [, whole, frac = ""] = m;
  if (frac.length > dp) throw new Error(`${value} has more than ${dp} decimals`);
  return BigInt(whole) * pow10(dp) + BigInt(frac.padEnd(dp, "0") || "0");
}

const roundAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
]);
const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

type FeedValue = { answer: bigint; decimals: number; updatedAt: bigint; roundId: bigint; ref: FeedRef };

const clients = new Map<string, EVMClient>();
function evm(chain: string): EVMClient {
  if (!clients.has(chain)) {
    const net = getNetwork({ chainFamily: "evm", chainSelectorName: chain });
    if (!net) throw new Error(`unknown chain selector name ${chain}`);
    clients.set(chain, new EVMClient(net.chainSelector.selector));
  }
  return clients.get(chain)!;
}

const call = (runtime: Runtime<Config>, chain: string, to: string, data: Hex) =>
  evm(chain).callContract(runtime, {
    call: encodeCallMsg({ from: zeroAddress, to: to.toLowerCase() as Address, data }),
    blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
  });

/** Reads a set of Chainlink feeds (all calls initiated before any is resolved), with freshness + sequencer checks. */
function readFeeds(runtime: Runtime<Config>, refs: Record<string, FeedRef>): Record<string, FeedValue> {
  const nowSec = BigInt(Math.floor(runtime.now().getTime() / 1000));
  const pending = Object.entries(refs).map(([name, ref]) => ({
    name, ref,
    round: call(runtime, ref.chain, ref.address, encodeFunctionData({ abi: roundAbi, functionName: "latestRoundData" })),
    dec: call(runtime, ref.chain, ref.address, encodeFunctionData({ abi: roundAbi, functionName: "decimals" })),
    seq: ref.sequencer ? call(runtime, ref.chain, ref.sequencer, encodeFunctionData({ abi: roundAbi, functionName: "latestRoundData" })) : null,
  }));
  const out: Record<string, FeedValue> = {};
  for (const p of pending) {
    const [roundId, answer, , updatedAt] = decodeFunctionResult({ abi: roundAbi, functionName: "latestRoundData", data: bytesToHex(p.round.result().data) });
    const decimals = Number(decodeFunctionResult({ abi: roundAbi, functionName: "decimals", data: bytesToHex(p.dec.result().data) }));
    if (p.seq) {
      const [, seqAnswer, seqStartedAt] = decodeFunctionResult({ abi: roundAbi, functionName: "latestRoundData", data: bytesToHex(p.seq.result().data) });
      if (seqAnswer !== 0n) throw new Error(`${p.name}: L2 sequencer on ${p.ref.chain} is down`);
      if (nowSec - seqStartedAt < 3600n) throw new Error(`${p.name}: L2 sequencer recovered under 1h ago; waiting out the grace period`);
    }
    if (roundId === 0n || updatedAt === 0n) throw new Error(`${p.name}: incomplete round`);
    if (updatedAt > nowSec + 60n) throw new Error(`${p.name}: round from the future`);
    if (nowSec - updatedAt > (BigInt(p.ref.heartbeatSec) * 3n) / 2n) throw new Error(`${p.name}: stale (updated ${nowSec - updatedAt}s ago)`);
    if (answer <= 0n) throw new Error(`${p.name}: non-positive answer`);
    out[p.name] = { answer, decimals, updatedAt, roundId, ref: p.ref };
  }
  return out;
}

// ---- HTTP observations (each node fetches; DON takes the median)
const sofrSchema = z.object({ refRates: z.array(z.object({ type: z.literal("SOFR"), percentRate: z.number(), effectiveDate: z.string() })).min(1) });
/** SOFR in hundredths of a basis point (3.93% -> 39300). */
const fetchSofr = (sender: HTTPSendRequester, url: string): number => {
  const r = sender.sendRequest({ url, method: "GET" }).result();
  if (!ok(r)) throw new Error(`SOFR HTTP ${r.statusCode}`);
  const pct = sofrSchema.parse(json(r)).refRates[0].percentRate;
  if (!(pct > 0 && pct < 25)) throw new Error(`SOFR out of range: ${pct}`);
  return Math.round(pct * 10_000);
};

/** ERC-20 balance via JSON-RPC eth_call on a chain CRE can't read natively (Story). Returns base units. */
const fetchRpcBalance = (sender: HTTPSendRequester, rpc: string, token: string, holder: string): bigint => {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [holder.toLowerCase() as Address] });
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: token.toLowerCase(), data }, "finalized"] });
  const r = sender.sendRequest({
    url: rpc, method: "POST", headers: { "Content-Type": "application/json" },
    body: bytesToBase64(new TextEncoder().encode(body)), cacheSettings: { store: false },
  }).result();
  if (!ok(r)) throw new Error(`RPC HTTP ${r.statusCode}`);
  const res = z.object({ result: z.string().regex(/^0x[0-9a-fA-F]*$/) }).parse(json(r)).result;
  return res === "0x" ? 0n : BigInt(res);
};

const fredSchema = z.object({ observations: z.array(z.object({ value: z.string(), date: z.string() })).min(1) });
/** Latest FRED observation, scaled x1e4. Node mode: the API key is passed in, never read here. */
const fetchFred = (node: NodeRuntime<Config>, series: string, key: string): number => {
  const r = new HTTPClient().sendRequest(node, {
    url: `https://api.stlouisfed.org/fred/series/observations?series_id=${series}&api_key=${key}&file_type=json&sort_order=desc&limit=1`,
    method: "GET",
  }).result();
  if (!ok(r)) throw new Error(`FRED HTTP ${r.statusCode}`);
  const v = fredSchema.parse(json(r)).observations[0].value;
  return Math.round(Number(scaleDecimal(v, 4)));
};

/** Latest FRED observation from the public keyless CSV (fredgraph.csv), scaled x1e4. Used when keyed.fred is false. */
const fetchFredCsv = (node: NodeRuntime<Config>, series: string): number => {
  const r = new HTTPClient().sendRequest(node, { url: `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${series}`, method: "GET" }).result();
  if (!ok(r)) throw new Error(`FRED CSV HTTP ${r.statusCode}`);
  const rows = text(r).split(/\r?\n/).slice(1).map((l) => l.split(",")[1]?.trim() ?? "");
  const v = rows.reverse().find((x) => /^-?\d+(\.\d+)?$/.test(x));
  if (!v) throw new Error(`FRED CSV ${series}: no value`);
  return Math.round(Number(scaleDecimal(v, 4)));
};

const massiveSchema = z.object({ results: z.array(z.object({ c: z.number() })).min(1) });
/** Previous close in cents from Massive (formerly polygon.io). */
const fetchMassive = (node: NodeRuntime<Config>, ticker: string, key: string): number => {
  const r = new HTTPClient().sendRequest(node, {
    url: `https://api.massive.com/v2/aggs/ticker/${ticker}/prev?adjusted=true&apiKey=${key}`,
    method: "GET",
  }).result();
  if (!ok(r)) throw new Error(`Massive HTTP ${r.statusCode}`);
  return Math.round(massiveSchema.parse(json(r)).results[0].c * 100);
};

// ------------------------------------------------------------------ handler
type Mark = { token: Address; metric: string; value: bigint; decimals: number; source: string };
type Attest = { token: Address; kind: string; result: 1 | 2; validDays: number; value: bigint; evidenceURI: string; source: string };

const onCron = (runtime: Runtime<Config>): string => {
  const cfg = runtime.config;
  const now = runtime.now();
  const nowSec = BigInt(Math.floor(now.getTime() / 1000));
  const assets = cfg.assets;
  const has = (c: Asset["category"]) => assets.some((a) => a.category === c);

  // 1. Initiate every independent read/fetch first, then resolve.
  const feedRefs: Record<string, FeedRef> = {};
  if (has("energy")) feedRefs.WTI = cfg.feeds.WTI;
  if (has("private-equity")) feedRefs.SPY = cfg.feeds.SPY;
  if (has("real-estate") || has("private-credit")) feedRefs.PCE = cfg.feeds.PCE;
  for (const a of assets) {
    if (a.category === "collectibles" && a.metal) feedRefs[a.metal] = cfg.feeds[a.metal];
    if (a.category === "funds" && a.navFeed) feedRefs[`NAV:${a.token}`] = a.navFeed;
  }
  const http = new HTTPClient();
  const sofrP = has("private-credit") ? http.sendRequest(runtime, fetchSofr, consensusMedianAggregation<number>())(cfg.sofrUrl) : null;
  const storyP = assets.map((a) =>
    a.category === "music-ip" ? http.sendRequest(runtime, fetchRpcBalance, consensusMedianAggregation<bigint>())(cfg.storyRpc, a.royaltyToken, a.royaltyVault) : null);
  const carbonP = assets.map((a) =>
    a.category === "carbon" ? call(runtime, a.creditChain, a.creditToken, encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [a.holder.toLowerCase() as Address] })) : null);

  // Keyed sources (FRED, Massive): one batched secrets call, resolved in DON mode, passed into node mode.
  const wantFred = cfg.keyed.fred && has("real-estate");
  const wantFredCsv = !cfg.keyed.fred && has("real-estate");
  const wantMassive = cfg.keyed.massive && (has("real-estate") || assets.some((a) => a.category === "private-equity" && a.comps.length));
  const secretIds = [...(wantFred ? [{ id: "FRED_API_KEY_SECRET" }] : []), ...(wantMassive ? [{ id: "MASSIVE_API_KEY_SECRET" }] : [])];
  const secrets = secretIds.length ? runtime.getSecrets(secretIds).result() : {};
  type Pending = { result: () => number };
  const fredP = new Map<string, Pending>();
  const massiveP = new Map<string, Pending>();
  for (const a of assets) {
    if (wantFred && a.category === "real-estate" && !fredP.has(a.fredSeries))
      fredP.set(a.fredSeries, runtime.runInNodeMode(fetchFred, consensusMedianAggregation<number>())(a.fredSeries, secrets["FRED_API_KEY_SECRET"].value));
    if (wantFredCsv && a.category === "real-estate" && !fredP.has(a.fredSeries))
      fredP.set(a.fredSeries, runtime.runInNodeMode(fetchFredCsv, consensusMedianAggregation<number>())(a.fredSeries));
    const tickers = a.category === "real-estate" ? ["VNQ"] : a.category === "private-equity" ? a.comps : [];
    if (wantMassive) for (const t of tickers) if (!massiveP.has(t))
      massiveP.set(t, runtime.runInNodeMode(fetchMassive, consensusMedianAggregation<number>())(t, secrets["MASSIVE_API_KEY_SECRET"].value));
  }

  const feeds = readFeeds(runtime, feedRefs);
  const sofr = sofrP ? BigInt(sofrP.result()) : null;
  const fred = new Map([...fredP].map(([k, p]) => [k, BigInt(p.result())]));
  const massive = new Map([...massiveP].map(([k, p]) => [k, BigInt(p.result())]));

  // 2. Deterministic per-asset computation.
  const marks: Mark[] = [];
  const attests: Attest[] = [];
  const feedSrc = (f: FeedValue) => `chainlink:${f.ref.chain}:${f.ref.address}:round:${f.roundId}`;
  assets.forEach((a, i) => {
    const token = a.token.toLowerCase() as Address;
    switch (a.category) {
      case "real-estate": {
        const pce = feeds.PCE;
        marks.push({ token, metric: "US_PCE_PRICE_INDEX", value: pce.answer, decimals: pce.decimals, source: feedSrc(pce) });
        const hpi = fred.get(a.fredSeries);
        if (hpi !== undefined) {
          // Appraised value carried forward by the house price index since the appraisal.
          const base = scaleDecimal(a.appraisedValueUsd, 2);
          const baseIdx = scaleDecimal(a.appraisalIndex, 4);
          marks.push({ token, metric: "HPI_ADJUSTED_VALUE_USD", value: (base * hpi) / baseIdx, decimals: 2, source: `fred:${a.fredSeries}:${hpi}` });
        }
        const vnq = massive.get("VNQ");
        if (vnq !== undefined) marks.push({ token, metric: "REIT_INDEX_VNQ_USD", value: vnq, decimals: 2, source: `massive:VNQ:${vnq}` });
        break;
      }
      case "energy": {
        const wti = feeds.WTI;
        marks.push({ token, metric: "WTI_USD", value: wti.answer, decimals: wti.decimals, source: feedSrc(wti) });
        // Estimated monthly royalty revenue: bbl/day x 30 x WTI x royalty share.
        const bbl = scaleDecimal(a.bblPerDay, 2);
        const est = (bbl * 30n * wti.answer * BigInt(a.royaltyBps)) / (100n * 10_000n);
        marks.push({ token, metric: "EST_MONTHLY_ROYALTY_USD", value: est, decimals: wti.decimals, source: `${feedSrc(wti)}:bbl/d=${a.bblPerDay}:bps=${a.royaltyBps}` });
        break;
      }
      case "private-equity": {
        const spy = feeds.SPY;
        marks.push({ token, metric: "PUBLIC_MARKET_SPY_USD", value: spy.answer, decimals: spy.decimals, source: feedSrc(spy) });
        for (const t of a.comps) {
          const v = massive.get(t);
          if (v !== undefined) marks.push({ token, metric: `COMP_${t}_USD`, value: v, decimals: 2, source: `massive:${t}:${v}` });
        }
        break;
      }
      case "private-credit": {
        marks.push({ token, metric: "SOFR_BPS", value: sofr!, decimals: 2, source: `nyfed:sofr:${sofr}` });
        marks.push({ token, metric: "FLOATING_RATE_BPS", value: sofr! + BigInt(a.spreadBps) * 100n, decimals: 2, source: `nyfed:sofr:${sofr}+${a.spreadBps}bps` });
        break;
      }
      case "funds": {
        const nav = a.navFeed ? feeds[`NAV:${a.token}`] : undefined;
        if (nav) {
          marks.push({ token, metric: "NAV_PER_SHARE", value: nav.answer, decimals: nav.decimals, source: feedSrc(nav) });
          // NAVLink data comes from the fund administrator, so it can sign the NAV check.
          attests.push({ token, kind: "NAV", result: RESULT.Pass, validDays: 2, value: nav.answer, evidenceURI: `chainlink-feed:${nav.ref.chain}:${nav.ref.address}:${nav.roundId}`, source: feedSrc(nav) });
        }
        break;
      }
      case "music-ip": {
        const bal = storyP[i]!.result();
        marks.push({ token, metric: "STORY_ROYALTY_VAULT_BALANCE", value: bal, decimals: 18, source: `story:${a.royaltyToken}:${a.royaltyVault}:${bal}` });
        break;
      }
      case "collectibles": {
        if (a.metal && a.ounces) {
          const f = feeds[a.metal];
          marks.push({ token, metric: `${a.metal}_USD`, value: f.answer, decimals: f.decimals, source: feedSrc(f) });
          marks.push({ token, metric: "METAL_HOLDING_VALUE_USD", value: (scaleDecimal(a.ounces, 4) * f.answer) / 10_000n, decimals: f.decimals, source: `${feedSrc(f)}:oz=${a.ounces}` });
        }
        break;
      }
      case "carbon": {
        const held = decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: bytesToHex(carbonP[i]!.result().data) });
        const need = scaleDecimal(a.expectedTonnes, 18);
        marks.push({ token, metric: "CARBON_CREDITS_HELD", value: held, decimals: 18, source: `${a.creditChain}:${a.creditToken}:${a.holder}:${held}` });
        // On-chain credit balance is authoritative for this holder: pass if it still covers the tokenized tonnes.
        attests.push({ token, kind: "REGISTRY", result: held >= need ? RESULT.Pass : RESULT.Fail, validDays: 30, value: held / pow10(18), evidenceURI: `evm:${a.creditChain}:${a.creditToken}:balanceOf:${a.holder}`, source: `held=${held} need=${need}` });
        break;
      }
    }
  });

  // 3. Encode the batch exactly as CreAssetFeed decodes it.
  const items = [
    ...marks.map((m) => ({
      itemType: ITEM_MARK,
      body: encodeAbiParameters(parseAbiParameters("address, bytes32, int256, uint8, uint64, bytes32"),
        [m.token, metricId(m.metric), m.value, m.decimals, nowSec, keccak256(stringToHex(m.source))]),
    })),
    ...attests.map((t) => ({
      itemType: ITEM_ATTEST,
      body: encodeAbiParameters(
        parseAbiParameters("(address token, bytes32 kind, uint8 result, uint64 validUntil, int256 value, bytes32 evidenceHash, string evidenceURI)"),
        [{ token: t.token, kind: kindId(t.kind), result: t.result, validUntil: nowSec + BigInt(t.validDays * 86_400), value: t.value, evidenceHash: keccak256(stringToHex(t.source)), evidenceURI: t.evidenceURI }]),
    })),
  ];
  const summary = {
    marks: marks.map((m) => ({ token: m.token, metric: m.metric, value: m.value.toString(), decimals: m.decimals })),
    attestations: attests.map((t) => ({ token: t.token, kind: t.kind, result: t.result === 1 ? "PASS" : "FAIL", value: t.value.toString(), evidence: t.evidenceURI })),
  };

  if (cfg.mode === "local-simulation") {
    runtime.log(`local-simulation: ${marks.length} marks, ${attests.length} attestations (not written)`);
    return JSON.stringify({ mode: "local-simulation", observedAt: nowSec.toString(), wouldWrite: items.length, ...summary });
  }

  if (!items.length) return JSON.stringify({ mode: "production", items: 0, ...summary }); // nothing listed yet: no empty report

  // 4. Production: one signed report, delivered through the KeystoneForwarder to CreAssetFeed.
  const encoded = encodeAbiParameters(parseAbiParameters("(uint8 itemType, bytes body)[]"), [items]);
  const report = runtime.report(prepareReportRequest(encoded)).result();
  const res = evm(cfg.writeChain).writeReport(runtime, { receiver: cfg.receiver, report, gasConfig: { gasLimit: cfg.gasLimit } }).result();
  if (res.txStatus !== TxStatus.SUCCESS) throw new Error(res.errorMessage ?? `write status ${res.txStatus}`);
  if (!res.txHash) throw new Error("write succeeded without a transaction hash");
  return JSON.stringify({ mode: "production", tx: bytesToHex(res.txHash), items: items.length, ...summary });
};

const initWorkflow = (config: Config) => [handler(new CronCapability().trigger({ schedule: config.schedule }), onCron)];

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}
