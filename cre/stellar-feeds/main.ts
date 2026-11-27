// Diamondz Tokenize: Stellar offerings → Chainlink CRE → CreAssetFeed / AssetOracle on Base.
//
// CRE can READ Stellar but not write to it. Each run (cron) the DON:
//   1. fetches the platform's list of Stellar offerings (addresses only; GET /api/stellar/cre-targets)
//   2. checks every StellarAssetAnchor in ONE Multicall3 read: anchor.stellarContract() must equal the listed token
//   3. reads every offering in ONE batched Stellar RPC call (simulateTransaction, envelopes built here, never supplied):
//        token.compliance() == listed compliance · compliance.is_module_registered(Created, supplyLimit)
//        supplyLimit.get_supply_limit(token) · token.total_supply() · token.paused()
//   4. writes one report: MARK supply / cap / paused, ATTEST REGISTRY = Pass only while the cap is really enforced by
//      the token (its compliance runs that module) and supply is within it.
// Cost per run is constant (2 HTTP + 1 chain read + 1 write) for up to 50 offerings, well inside CRE's per-run caps.
// Any offering whose anchor doesn't match, or whose reads fail, gets no item at all (fail closed, never a false Pass).
//
// mode "local-simulation" does every real read and consensus step, logs the batch and stops before any report or
// write. mode "production" requires a receiver and writes.
import {
  CronCapability, EVMClient, HTTPClient, LAST_FINALIZED_BLOCK_NUMBER, Runner, TxStatus,
  bytesToBase64, bytesToHex, consensusIdenticalAggregation, encodeCallMsg, getNetwork, handler, json, ok, prepareReportRequest,
  type HTTPSendRequester, type Runtime,
} from "@chainlink/cre-sdk";
import { z } from "zod";
import {
  decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseAbiParameters, stringToHex,
  zeroAddress, type Address, type Hex,
} from "viem";

// ------------------------------------------------------------------ config
const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "address");
const httpsUrl = z.string().regex(/^https:\/\/[^\s/$.?#].[^\s]*$/, "https url"); // no URL global in QuickJS
const localUrl = z.string().regex(/^http:\/\/127\.0\.0\.1:\d{2,5}\/\S*$/, "local API url");
const stellarContract = z.string().regex(/^C[A-Z2-7]{55}$/, "Stellar contract id");
const shared = {
  schedule: z.string().regex(/^(\S+\s+){5}\S+$/, "six-field CRE cron"),
  /** Public Stellar RPCs, used only when uniblock is false. */
  stellarRpc: z.object({ testnet: httpsUrl, mainnet: httpsUrl }),
  /** Read Stellar through Uniblock (secret UNIBLOCK_API_KEY_SECRET; same free-tier key as the platform). */
  uniblock: z.boolean(),
  /** EVM chain (CRE selector name) where StellarAssetAnchors are registered on AssetOracle. */
  anchorChain: z.string(),
  multicall3: addr,
};
const configSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("local-simulation"), ...shared, targetsUrl: z.union([httpsUrl, localUrl]) }).strict(),
  z.object({
    mode: z.literal("production"),
    ...shared,
    targetsUrl: httpsUrl,
    receiver: addr.refine((a) => a.toLowerCase() !== zeroAddress, "receiver must be nonzero"),
    writeChain: z.string(),
    gasLimit: z.string().regex(/^[1-9]\d*$/),
  }).strict(),
]);
type Config = z.infer<typeof configSchema>;

const target = z.object({
  network: z.enum(["testnet", "mainnet"]),
  contract: stellarContract,
  anchor: addr,
  compliance: stellarContract,
  supplyLimit: stellarContract,
  decimals: z.number().int().min(0).max(18),
});
type Target = z.infer<typeof target>;
const MAX_TARGETS = 500; // listed; each run checks a rotating window that fits CRE limits
const targetsSchema = z.object({ targets: z.array(target).max(MAX_TARGETS) });

// ------------------------------------------------------------------ bytes, strkeys, XDR
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** base64 -> bytes (no atob/Buffer in QuickJS). */
function b64Bytes(s: string): Uint8Array {
  const out: number[] = [];
  let buf = 0, bits = 0;
  for (const ch of s.replace(/=+$/, "")) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error("bad base64");
    buf = ((buf << 6) | v) & 0xffffff; bits += 6;
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff); }
  }
  return new Uint8Array(out);
}
const rd32 = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const rd64 = (b: Uint8Array, o: number) => (BigInt(rd32(b, o)) << 32n) | BigInt(rd32(b, o + 4));
const SCV_BOOL = 0, SCV_I128 = 10, SCV_SYMBOL = 15, SCV_VEC = 16, SCV_ADDRESS = 18;
/** ScVal bool / i128 → bigint (bool → 0/1); anything else is rejected. */
function scvNum(x: string): bigint {
  const b = b64Bytes(x);
  const t = rd32(b, 0);
  if (t === SCV_BOOL && b.length === 8) return rd32(b, 4) ? 1n : 0n;
  if (t === SCV_I128 && b.length === 20) return (BigInt.asIntN(64, rd64(b, 4)) << 64n) + rd64(b, 12);
  throw new Error(`unexpected ScVal type ${t} (${b.length} bytes)`);
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** "C…" contract strkey → 32-byte contract id (version byte must be contract). */
function contractId(strkey: string): Uint8Array {
  const out: number[] = [];
  let buf = 0, bits = 0;
  for (const ch of strkey) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error(`bad strkey ${strkey}`);
    buf = (buf << 5) | v; bits += 5;
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff); buf &= (1 << bits) - 1; }
  }
  if (out.length !== 35 || out[0] !== 2 << 3) throw new Error(`not a contract strkey ${strkey}`);
  return new Uint8Array(out.slice(1, 33));
}
class Xdr {
  b: number[] = [];
  u32(n: number) { this.b.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff); return this; }
  raw(a: Uint8Array) { for (const x of a) this.b.push(x); return this; }
  str(s: string) { const e = new TextEncoder().encode(s); this.u32(e.length).raw(e); while (this.b.length % 4) this.b.push(0); return this; }
  bytes() { return new Uint8Array(this.b); }
}
const scContract = (id: Uint8Array) => new Xdr().u32(SCV_ADDRESS).u32(1).raw(id).bytes();
/** Unit enum variant (e.g. ComplianceHook::Created) as Soroban encodes it: vec[symbol]. */
const scUnitEnum = (name: string) => new Xdr().u32(SCV_VEC).u32(1).u32(1).u32(SCV_SYMBOL).str(name).bytes();
/** Unsigned TransactionEnvelope with one InvokeContract op, for simulateTransaction only (zero source, seq 0). */
function invokeEnvelope(contract: string, fn: string, args: Uint8Array[]): string {
  const x = new Xdr()
    .u32(2) // ENVELOPE_TYPE_TX
    .u32(0).raw(new Uint8Array(32)) // source: KEY_TYPE_ED25519, zero key (simulation never checks it)
    .u32(100) // fee
    .u32(0).u32(0) // seqNum
    .u32(0) // PRECOND_NONE
    .u32(0) // MEMO_NONE
    .u32(1) // one operation
    .u32(0) // no op source
    .u32(24) // INVOKE_HOST_FUNCTION
    .u32(0) // HOST_FUNCTION_TYPE_INVOKE_CONTRACT
    .u32(1).raw(contractId(contract)) // ScAddress contract
    .str(fn)
    .u32(args.length);
  for (const a of args) x.raw(a);
  x.u32(0).u32(0).u32(0); // auth, tx ext, signatures
  return bytesToBase64(x.bytes());
}

// ------------------------------------------------------------------ reads
/** The platform's list of Stellar offerings, as canonical JSON (identical across nodes). */
const fetchTargets = (sender: HTTPSendRequester, url: string): string => {
  const r = sender.sendRequest({ url, method: "GET", cacheSettings: { store: false } }).result();
  if (!ok(r)) throw new Error(`targets HTTP ${r.statusCode}`);
  const t = targetsSchema.parse(json(r)).targets;
  return JSON.stringify([...t].sort((a, b) => (a.contract < b.contract ? -1 : a.contract > b.contract ? 1 : 0)));
};

const CALLS = ["compliance", "registered", "cap", "supply", "paused"] as const;
const READS_PER_TARGET = CALLS.length;
/** Public Stellar RPC rejects JSON-RPC batches over 10 calls ("batch exceeds the limit of 10 calls"). */
const BATCH_READS = 10;
/** CRE per-run HTTPAction.CallLimit is 15; one call is the target list. */
const MAX_BATCHES = 14;
type Reads = Record<(typeof CALLS)[number], string | null>;
// A read that the contract rejects comes back with result.error (and no results): that read is null, not a crash.
const batchItem = z.object({
  id: z.number().int(),
  result: z.object({ results: z.array(z.object({ xdr: z.string() })).optional(), error: z.string().optional() }).optional(),
});
/** One batched simulateTransaction call for every read of every offering on one network. Per-read failures become null
 *  (that offering is then skipped), so one bad offering never sinks the others. Canonical JSON for identical consensus. */
const fetchStellarBatch = (sender: HTTPSendRequester, rpc: string, envelopes: string[]): string => {
  if (!envelopes.length) return "[]";
  const body = JSON.stringify(envelopes.map((tx, id) => ({ jsonrpc: "2.0", id, method: "simulateTransaction", params: { transaction: tx } })));
  const r = sender.sendRequest({
    url: rpc, method: "POST", headers: { "Content-Type": "application/json" },
    body: bytesToBase64(new TextEncoder().encode(body)), cacheSettings: { store: false },
  }).result();
  if (!ok(r)) throw new Error(`Stellar RPC HTTP ${r.statusCode}`);
  const arr = z.array(batchItem).parse(json(r));
  const byId = new Map(arr.map((x) => [x.id, x.result?.error ? null : x.result?.results?.[0]?.xdr ?? null]));
  return JSON.stringify(envelopes.map((_, i) => byId.get(i) ?? null));
};

const anchorAbi = parseAbi(["function stellarContract() view returns (string)"]);
const multicallAbi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);
const evm = (chain: string) => {
  const net = getNetwork({ chainFamily: "evm", chainSelectorName: chain });
  if (!net) throw new Error(`unknown chain selector name ${chain}`);
  return new EVMClient(net.chainSelector.selector);
};

// ------------------------------------------------------------------ handler
const ITEM_MARK = 1, ITEM_ATTEST = 2;
const PASS = 1, FAIL = 2;
const id32 = (name: string): Hex => keccak256(stringToHex(name));

const onCron = (runtime: Runtime<Config>): string => {
  const cfg = runtime.config;
  const nowSec = BigInt(Math.floor(runtime.now().getTime() / 1000));
  const http = new HTTPClient();
  const ubKey = cfg.uniblock ? runtime.getSecrets([{ id: "UNIBLOCK_API_KEY_SECRET" }]).result()["UNIBLOCK_API_KEY_SECRET"]!.value : "";
  const rpcFor = (n: Target["network"]) => ubKey
    ? `https://api.uniblock.dev/uni/v1/json-rpc?chainId=${n === "mainnet" ? "stellar-soroban" : "stellar-soroban-testnet"}&apiKey=${ubKey}`
    : cfg.stellarRpc[n];

  // 1. targets. Budget: Stellar RPC batches hold 10 reads (5 per offering), and a run gets 15 HTTP calls (1 for the
  // list), so 14 batches = 28 offerings per run. With more, a window rotates every run so each is still covered.
  const listed: Target[] = JSON.parse(http.sendRequest(runtime, fetchTargets, consensusIdenticalAggregation<string>())(cfg.targetsUrl).result());
  const PER_RUN = Math.floor((MAX_BATCHES * BATCH_READS) / READS_PER_TARGET);
  const start = listed.length > PER_RUN ? Number((nowSec / 1800n) * BigInt(PER_RUN) % BigInt(listed.length)) : 0;
  const targets = listed.length > PER_RUN ? [...listed, ...listed].slice(start, start + PER_RUN) : listed;
  if (!targets.length) {
    runtime.log("no Stellar offerings listed");
    return JSON.stringify({ mode: cfg.mode, targets: 0, wouldWrite: 0 });
  }

  // 2 + 3. one anchor read and one Stellar batch per network, all initiated before any is resolved
  const created = scUnitEnum("Created");
  const calls = targets.map((t) => {
    const tok = scContract(contractId(t.contract));
    return [
      invokeEnvelope(t.contract, "compliance", []),
      invokeEnvelope(t.compliance, "is_module_registered", [created, scContract(contractId(t.supplyLimit))]),
      invokeEnvelope(t.supplyLimit, "get_supply_limit", [tok]),
      invokeEnvelope(t.contract, "total_supply", []),
      invokeEnvelope(t.contract, "paused", []),
    ];
  });
  const anchorP = evm(cfg.anchorChain).callContract(runtime, {
    call: encodeCallMsg({
      from: zeroAddress, to: cfg.multicall3.toLowerCase() as Address,
      data: encodeFunctionData({
        abi: multicallAbi, functionName: "aggregate3",
        args: [targets.map((t) => ({ target: t.anchor as Address, allowFailure: true, callData: encodeFunctionData({ abi: anchorAbi, functionName: "stellarContract" }) }))],
      }),
    }),
    blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
  });
  // Batches of whole offerings (2 per batch), same network per batch, at most MAX_BATCHES in total.
  const per = Math.floor(BATCH_READS / READS_PER_TARGET);
  const batches: { idx: number[]; p: { result: () => string } }[] = [];
  for (const n of [...new Set(targets.map((t) => t.network))]) {
    const idx = targets.map((t, i) => (t.network === n ? i : -1)).filter((i) => i >= 0);
    for (let k = 0; k < idx.length && batches.length < MAX_BATCHES; k += per) {
      const chunk = idx.slice(k, k + per);
      batches.push({ idx: chunk, p: http.sendRequest(runtime, fetchStellarBatch, consensusIdenticalAggregation<string>())(rpcFor(n), chunk.flatMap((i) => calls[i]!)) });
    }
  }

  const anchorRes = decodeFunctionResult({ abi: multicallAbi, functionName: "aggregate3", data: bytesToHex(anchorP.result().data) });
  const reads = new Map<number, Reads>();
  for (const { idx, p } of batches) {
    const flat: (string | null)[] = JSON.parse(p.result());
    idx.forEach((ti, k) => {
      const r = {} as Reads;
      CALLS.forEach((c, j) => { r[c] = flat[k * CALLS.length + j] ?? null; });
      reads.set(ti, r);
    });
  }

  // 4. items
  type Mark = { token: Address; metric: string; value: bigint; decimals: number; source: string };
  type Attest = { token: Address; result: number; value: bigint; evidenceURI: string; source: string };
  const marks: Mark[] = [];
  const attests: Attest[] = [];
  const skipped: string[] = [];
  targets.forEach((t, i) => {
    const src = `stellar:${t.network}:${t.contract}`;
    try {
      const a = anchorRes[i];
      if (!a?.success) throw new Error(`anchor ${t.anchor} unreadable`);
      const recorded = decodeFunctionResult({ abi: anchorAbi, functionName: "stellarContract", data: a.returnData });
      if (recorded !== t.contract) throw new Error(`anchor ${t.anchor} records ${recorded}`);
      const r = reads.get(i)!;
      for (const c of CALLS) if (!r[c]) throw new Error(`${c} read failed`);
      const complianceOk = r.compliance === bytesToBase64(scContract(contractId(t.compliance)));
      const registered = scvNum(r.registered!) === 1n;
      const cap = scvNum(r.cap!), supply = scvNum(r.supply!), paused = scvNum(r.paused!);
      const token = t.anchor.toLowerCase() as Address;
      marks.push({ token, metric: "STELLAR_TOTAL_SUPPLY", value: supply, decimals: t.decimals, source: `${src}:total_supply:${supply}` });
      marks.push({ token, metric: "STELLAR_SUPPLY_CAP", value: cap, decimals: t.decimals, source: `${src}:get_supply_limit:${t.supplyLimit}:${cap}` });
      marks.push({ token, metric: "STELLAR_PAUSED", value: paused, decimals: 0, source: `${src}:paused:${paused}` });
      const pass = complianceOk && registered && cap > 0n && supply <= cap;
      attests.push({
        token, result: pass ? PASS : FAIL, value: supply, evidenceURI: `${src}:total_supply`,
        source: `supply=${supply} cap=${cap} compliance=${complianceOk ? t.compliance : "MISMATCH"} capModule=${registered ? "hooked" : "NOT-HOOKED"}`,
      });
    } catch (e) {
      skipped.push(t.contract);
      runtime.log(`skip ${t.contract}: ${(e as Error).message}`);
    }
  });

  // Encode exactly as CreAssetFeed decodes it (same item format as the asset-feeds workflow).
  const items = [
    ...marks.map((m) => ({
      itemType: ITEM_MARK,
      body: encodeAbiParameters(parseAbiParameters("address, bytes32, int256, uint8, uint64, bytes32"),
        [m.token, id32(m.metric), m.value, m.decimals, nowSec, keccak256(stringToHex(m.source))]),
    })),
    ...attests.map((t) => ({
      itemType: ITEM_ATTEST,
      body: encodeAbiParameters(
        parseAbiParameters("(address token, bytes32 kind, uint8 result, uint64 validUntil, int256 value, bytes32 evidenceHash, string evidenceURI)"),
        [{ token: t.token, kind: id32("REGISTRY"), result: t.result, validUntil: nowSec + 86_400n, value: t.value, evidenceHash: keccak256(stringToHex(t.source)), evidenceURI: t.evidenceURI }]),
    })),
  ];
  const summary = {
    targets: targets.length, skipped,
    marks: marks.map((m) => ({ token: m.token, metric: m.metric, value: m.value.toString() })),
    attestations: attests.map((t) => ({ token: t.token, result: t.result === PASS ? "PASS" : "FAIL", value: t.value.toString(), why: t.source })),
  };

  if (cfg.mode === "local-simulation") {
    runtime.log(`local-simulation: ${marks.length} marks, ${attests.length} attestations, ${skipped.length} skipped (not written)`);
    return JSON.stringify({ mode: "local-simulation", observedAt: nowSec.toString(), wouldWrite: items.length, ...summary });
  }
  if (!items.length) return JSON.stringify({ mode: "production", items: 0, ...summary });

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
