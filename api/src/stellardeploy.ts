// Stellar (Soroban) edition: deploy and operate an offering (designs X1–X5, approved 2026-11-19).
//
// The platform's Stellar relayer (STELLAR_RELAYER_SECRET, testnet) pays every fee and holds the contracts' "manager"
// role; the issuer's own Stellar wallet (Freighter) is set as ADMIN on every contract, so the issuer can always revoke
// the platform. Identity claims (KYC/AML, accredited) are signed by the platform claim key (STELLAR_CLAIM_SECRET,
// Ed25519, OZ claim-issuer message format) and held in per-investor identity contracts the relayer keeps as custodian.
//
// Deployment is a resumable job: each step records its result on the asset (data.stellar.steps), so a retry after a
// failure continues where it stopped and never creates anything twice. The last step gives the offering an EVM
// address (StellarAssetAnchor on Base Sepolia) registered on AssetOracle, so Chainlink CRE can attest it.
//
//   POST /assets/:id/stellar/deploy         { issuer }              start or resume the deploy (admin)
//   POST /assets/:id/stellar/verify         { account, country }    verify an investor on chain (admin)
//   POST /assets/:id/stellar/issue          { account, amount }     mint to a verified investor (admin)
//   POST /assets/:id/stellar/freeze         { account, freeze }     (admin)
//   POST /assets/:id/stellar/pause          { paused }              (admin)
//   POST /stellar/assets/:id/requests       { account, country }    investor asks to be verified (public)
import type { Context, Hono } from "hono";
import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import {
  Address, Asset as ClassicAsset, Keypair, Operation, StrKey, TransactionBuilder, nativeToScVal, rpc, scValToNative, xdr, BASE_FEE,
} from "@stellar/stellar-sdk";
import { createPublicClient, createWalletClient, getAddress, hashMessage, http, isAddress, keccak256, recoverMessageAddress, recoverPublicKey, toHex, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { stellarById, networkById, stellarCodeReady, type StellarNetwork, type StellarWasm } from "../../web/src/lib/chains";
import { CLASS_CHECKS } from "../../web/src/lib/verification";
import { claimSignerMessage } from "../../web/src/lib/claims";
import { readContract } from "./stellar";
import { rpcUrl, stellarRpcUrl } from "./chains";
import anchorArtifact from "./contracts/stellar-anchor.json";

type Deps = {
  requireAdmin: (c: Context, next: () => Promise<void>) => Promise<Response | void>;
  adminAsset: (c: Context, id: string) => Promise<any | null>;
  /** Fresh read for background jobs (no request context). */
  loadAsset: (id: string, tenantId: string) => Promise<any | null>;
  publicAsset: (c: Context, id: string) => Promise<any | null>;
  /** Saves by a.id + a.tenantId (works outside a request). */
  saveAsset: (a: any) => Promise<void>;
  tooMany: (key: string, max: number, windowMs: number) => boolean;
  ipKey: (c: Context) => string;
  /** Every asset on the platform (background jobs). */
  allAssets: () => Promise<any[]>;
  /** The signed-in workspace's mainnet gates (same as EVM mainnet offerings). */
  mainnetRules: (c: Context) => { testnetOnly: boolean; offeringFeeUsd: number; counselReady: boolean };
  /** Company verified + lawyer signed + Diamondz approved; empty = cleared (2026-11-20). */
  legalReasons?: (asset: any) => Promise<string[]>;
};

const TOPIC_KYC = 1;
const TOPIC_AML = 2;
const TOPIC_ACCREDITED = 3;
const ED25519_SCHEME = 101;
const LEDGERS_PER_DAY = 17_280;
const DECIMALS = 7;
const UNIT = 10n ** BigInt(DECIMALS);

// ------------------------------------------------------------------ keys
/** Testnet keys are STELLAR_RELAYER_SECRET / STELLAR_CLAIM_SECRET; other networks add _<NETWORK> (e.g. _MAINNET). */
/** Mainnet rules (operator-signed actions, platform handover, multisig + fee gates). Always on mainnet; on testnet only
 *  for the e2e that proves them before real XLM is spent (STELLAR_MAINNET_RULES_ON_TESTNET=1). */
const strict = (n: StellarNetwork) => !n.testnet || process.env.STELLAR_MAINNET_RULES_ON_TESTNET === "1";
const keyVar = (base: string, n: StellarNetwork) => (n.testnet ? base : `${base}_${n.key.toUpperCase()}`);
function relayer(n: StellarNetwork): Keypair {
  const s = process.env[keyVar("STELLAR_RELAYER_SECRET", n)];
  if (!s) throw new Error(`Stellar relayer isn't configured for ${n.name}`);
  return Keypair.fromSecret(s);
}
function claimKey(n: StellarNetwork): Keypair {
  const h = process.env[keyVar("STELLAR_CLAIM_SECRET", n)];
  if (!h || !/^[0-9a-f]{64}$/i.test(h)) throw new Error(`Stellar claim key isn't configured for ${n.name}`);
  return Keypair.fromRawEd25519Seed(Buffer.from(h, "hex"));
}
/** Mainnet rules never use the platform claim key: investor claims are signed by the issuer's own EVM wallet. */
export const stellarConfigured = (n: StellarNetwork) => !!process.env[keyVar("STELLAR_RELAYER_SECRET", n)] && (strict(n) || !!process.env[keyVar("STELLAR_CLAIM_SECRET", n)]);

// ------------------------------------------------------------------ ScVal helpers
const addr = (a: string) => new Address(a).toScVal();
const u32 = (n: number) => nativeToScVal(n, { type: "u32" });
const u64 = (n: bigint) => nativeToScVal(n, { type: "u64" });
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
const str = (s: string) => nativeToScVal(s, { type: "string" });
const bytes = (b: Buffer) => xdr.ScVal.scvBytes(b);
const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const vec = (v: xdr.ScVal[]) => xdr.ScVal.scvVec(v);
/** Unit enum variant (e.g. ComplianceHook::Created) as Soroban encodes it: vec[symbol]. */
const unitEnum = (name: string) => vec([sym(name)]);
/** CountryData { country: CountryRelation::Individual(IndividualCountryRelation::Residence(code)), metadata: None } */
const countryProfile = (code: number) =>
  xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: sym("country"), val: vec([sym("Individual"), vec([sym("Residence"), u32(code)])]) }),
    new xdr.ScMapEntry({ key: sym("metadata"), val: xdr.ScVal.scvVoid() }),
  ]);

// ------------------------------------------------------------------ transactions
const servers = new Map<number, rpc.Server>();
const server = (n: StellarNetwork) => servers.get(n.id) ?? servers.set(n.id, new rpc.Server(stellarRpcUrl(n.key, n.rpc))).get(n.id)!;

/** One relayer transaction at a time per network (sequence numbers). */
const queues = new Map<number, Promise<unknown>>();
function serial<T>(id: number, job: () => Promise<T>): Promise<T> {
  const prev = queues.get(id) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(job);
  queues.set(id, next);
  return next;
}

async function submit(n: StellarNetwork, op: xdr.Operation): Promise<{ hash: string; ret: unknown }> {
  return serial(n.id, async () => {
    const kp = relayer(n);
    const s = server(n);
    const acct = await s.getAccount(kp.publicKey());
    const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: n.passphrase }).addOperation(op).setTimeout(120).build();
    const prepared = await s.prepareTransaction(tx); // simulate + footprint + resource fee; throws with the contract error
    prepared.sign(kp);
    const sent = await s.sendTransaction(prepared);
    if (sent.status === "ERROR") throw new Error(`Stellar rejected the transaction ${sent.hash}`);
    for (let i = 0; i < 60; i++) {
      const r = await s.getTransaction(sent.hash);
      if (r.status === rpc.Api.GetTransactionStatus.SUCCESS) return { hash: sent.hash, ret: r.returnValue ? scValToNative(r.returnValue) : null };
      if (r.status === rpc.Api.GetTransactionStatus.FAILED) throw new Error(`Stellar transaction failed: ${sent.hash}`);
      await new Promise((res) => setTimeout(res, 1_500));
    }
    throw new Error(`Stellar transaction not confirmed in time: ${sent.hash}`);
  });
}
const call = (n: StellarNetwork, contract: string, fn: string, ...args: xdr.ScVal[]) =>
  submit(n, Operation.invokeContractFunction({ contract, function: fn, args }));
async function deploy(n: StellarNetwork, wasm: StellarWasm, args: xdr.ScVal[]): Promise<string> {
  const r = await submit(n, Operation.createCustomContract({
    address: new Address(relayer(n).publicKey()), wasmHash: Buffer.from(n.wasm[wasm], "hex"), constructorArgs: args, salt: randomBytes(32),
  }));
  const id = String(r.ret);
  if (!StrKey.isValidContract(id)) throw new Error(`deploy of ${wasm} returned no contract id`);
  return id;
}

// ------------------------------------------------------------------ claims (OZ claim-issuer format)
/** Claim data: created (u64 BE) || valid until (u64 BE), the OZ expiration encoding. */
function newClaimData(validDays = 365): Buffer {
  const created = BigInt(Math.floor(Date.now() / 1000));
  const data = Buffer.alloc(16);
  data.writeBigUInt64BE(created, 0);
  data.writeBigUInt64BE(created + BigInt(validDays) * 86_400n, 8);
  return data;
}
/** The canonical claim message: 0x01 || sha256(passphrase) || issuerXdr || identityXdr || topic u32 || nonce u32 || data.
 *  Nonce 0: a fresh identity contract per investor. */
function claimMessage(n: StellarNetwork, claimIssuer: string, identity: string, topic: number, data: Buffer): Buffer {
  const be32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
  return Buffer.concat([
    Buffer.from([1]), createHash("sha256").update(n.passphrase).digest(),
    new Address(claimIssuer).toScVal().toXDR(), new Address(identity).toScVal().toXDR(), be32(topic), be32(0), data,
  ]);
}
/** Testnet: sig = pubkey(32) || ed25519(message), signed by the platform claim key (scheme 101). */
export function signClaim(n: StellarNetwork, claimIssuer: string, identity: string, topic: number, validDays = 365) {
  const kp = claimKey(n);
  const data = newClaimData(validDays);
  const msg = claimMessage(n, claimIssuer, identity, topic, data);
  return { data, signature: Buffer.concat([kp.rawPublicKey(), kp.sign(msg)]), publicKey: kp.rawPublicKey() };
}
/** Mainnet (scheme 1): what the issuer's EVM wallet signs with personal_sign: the raw 32-byte keccak256(message). */
export const ETH_PERSONAL_SIGN_SCHEME = 1;
export const claimDigest = (n: StellarNetwork, claimIssuer: string, identity: string, topic: number, data: Buffer): Hex =>
  keccak256(claimMessage(n, claimIssuer, identity, topic, data));
/** OZ secp256k1 sig_data: uncompressed public key (65) || r || s (64) || recovery id (u32 BE). */
export function ethSigData(publicKey: Hex, signature: Hex): Buffer {
  const sig = Buffer.from(signature.slice(2), "hex");
  if (sig.length !== 65) throw new Error("expected a 65-byte signature");
  const v = sig[64]!;
  const rid = v >= 27 ? v - 27 : v;
  if (rid !== 0 && rid !== 1) throw new Error("bad signature recovery id");
  const r = Buffer.alloc(4); r.writeUInt32BE(rid);
  return Buffer.concat([Buffer.from(publicKey.slice(2), "hex"), sig.subarray(0, 64), r]);
}
/** What the issuer signs once to name their claim-signing wallet (a hardware wallet behind MetaMask works). */
export { claimSignerMessage } from "../../web/src/lib/claims";

// ------------------------------------------------------------------ transactions the issuer / investor signs (Freighter)
/** Prepared (simulated, footprint + fee) transaction with `source` as the signer, for Freighter. */
async function prepareFor(n: StellarNetwork, source: string, contract: string, fn: string, args: xdr.ScVal[]): Promise<string> {
  const s = server(n);
  const acct = await s.getAccount(source);
  const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: n.passphrase })
    .addOperation(Operation.invokeContractFunction({ contract, function: fn, args })).setTimeout(300).build();
  return (await s.prepareTransaction(tx)).toXDR();
}
/** The signed envelope is exactly one call of `fn(args)` on `contract`, from `source`; null otherwise. */
function exactCall(n: StellarNetwork, signedXdr: string, source: string, contract: string, fn: string, args: xdr.ScVal[]) {
  let tx: any;
  try { tx = TransactionBuilder.fromXDR(signedXdr, n.passphrase); } catch { return null; }
  const op = tx.operations?.[0];
  const expected = Operation.fromXDRObject(Operation.invokeContractFunction({ contract, function: fn, args })) as any;
  const same = tx.operations?.length === 1 && op?.type === "invokeHostFunction" && op.func.toXDR("base64") === expected.func.toXDR("base64");
  return tx.source === source && same ? tx : null;
}
async function submitSigned(n: StellarNetwork, tx: any): Promise<string> {
  const s = server(n);
  const sent = await s.sendTransaction(tx);
  if (sent.status === "ERROR") throw new Error("Stellar rejected the transaction");
  for (let i = 0; i < 40; i++) {
    const r = await s.getTransaction(sent.hash);
    if (r.status === rpc.Api.GetTransactionStatus.SUCCESS) return sent.hash;
    if (r.status === rpc.Api.GetTransactionStatus.FAILED) throw new Error(`Transaction failed: ${sent.hash}`);
    await new Promise((res) => setTimeout(res, 1_500));
  }
  throw new Error(`Not confirmed yet: ${sent.hash}`);
}

// ------------------------------------------------------------------ primary sale (contracts/sale)
/** Testnet override for e2e (a test asset instead of Circle USDC); ignored on mainnet. */
export const payTokenOf = (n: StellarNetwork) =>
  (n.testnet && process.env[`STELLAR_PAY_TOKEN_${n.key.toUpperCase()}`]) || n.payToken.contract;
/** Same as web/src/lib/rules.ts saleWindow (that file is browser-side): YYYY-MM-DD → unix seconds, "" → 0. */
const dayTs = (d: string | undefined) => (d ? BigInt(Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000)) : 0n);
const saleWindow = (r: any) => ({ startsAt: dayTs(r?.saleStartsAt), endsAt: dayTs(r?.saleEndsAt) });
function scaleDec(v: string, dp: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(v.trim());
  if (!m) throw new Error(`not a decimal: ${v}`);
  const frac = (m[2] ?? "").slice(0, dp).padEnd(dp, "0");
  return BigInt(m[1]!) * 10n ** BigInt(dp) + BigInt(frac || "0");
}
/** Sale terms chosen in the sale wizard (W12). Anything left out falls back to the offering's terms. */
export type SaleTerms = { price?: string; minimum?: string; treasury?: string; capTokens?: string; startsAt?: number; endsAt?: number };
async function deploySale(n: StellarNetwork, asset: any, issuer: string, token: string, t: SaleTerms = {}): Promise<string> {
  const price = t.price || asset.pricePerToken;
  if (!price) throw new Error("Set a price per token before opening a sale");
  const w = saleWindow(asset.rules);
  const pd = n.payToken.decimals;
  const min = t.minimum ?? asset.minInvestment;
  const cap = t.capTokens ? BigInt(t.capTokens) : BigInt(asset.totalSupply);
  return deploy(n, "sale", [
    addr(issuer), addr(relayer(n).publicKey()), addr(token), addr(payTokenOf(n)), addr(t.treasury || issuer),
    i128(scaleDec(price, pd)), i128(min ? scaleDec(min, pd) : 0n),
    i128(cap * UNIT), u64(t.startsAt !== undefined ? BigInt(t.startsAt) : w.startsAt), u64(t.endsAt !== undefined ? BigInt(t.endsAt) : w.endsAt),
  ]);
}
/** Live facts about a Stellar account for the wizards: does it exist, is it a real multisig, can it receive the pay token. */
export async function accountFacts(n: StellarNetwork, account: string) {
  const out = { exists: false, signers: 0, medThreshold: 0, multisig: false, why: "" as string, canReceive: false, payToken: n.payToken.code };
  try {
    const e: any = await (server(n) as any).getAccountEntry(account);
    out.exists = true;
    const val = (v: any) => (typeof v === "function" ? v.call(e) : v);
    const thr = val(e.thresholds);
    const th: Uint8Array = thr?.value ?? thr;
    const signers: any[] = val(e.signers) ?? [];
    const weights = [th[0] ?? 0, ...signers.map((x: any) => Number(typeof x.weight === "function" ? x.weight() : x.weight))].filter((w: number) => w > 0);
    out.signers = weights.length;
    out.medThreshold = th[2] ?? 0;
  } catch { out.why = "it doesn't exist on Stellar yet"; return out; }
  const ms = await multisigOf(n, account);
  out.multisig = ms.ok; out.why = ms.why ?? "";
  out.canReceive = await readContract(n.key, payTokenOf(n), "balance", [addr(account)], { fresh: true }).then(() => true, () => false);
  return out;
}
const grantArgs = (sale: string, issuer: string) => [addr(sale), sym("manager"), addr(issuer)];
async function saleCanMint(n: StellarNetwork, token: string, sale: string) {
  const r = await readContract(n.key, token, "has_role", [addr(sale), sym("manager")], { fresh: true }).catch(() => null);
  return r !== null && r !== undefined;
}
/** AssetOracle.isVerified(anchor): every required check (verifiers + Chainlink) currently passes. */
async function proofPasses(n: StellarNetwork, anchor: string): Promise<boolean> {
  if (n.testnet && process.env.STELLAR_SALE_SKIP_PROOF === "1") return true; // e2e on testnet only
  const evm = networkById(n.anchorChainId);
  if (!evm?.assetOracle) return false;
  const pc = createPublicClient({ transport: http(rpcUrl(evm), { timeout: 20_000 }) });
  return pc.readContract({
    address: evm.assetOracle.address, functionName: "isVerified", args: [anchor as Hex],
    abi: [{ type: "function", name: "isVerified", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] }],
  }).catch(() => false);
}
/** Job: close any open Stellar sale whose offering stopped passing its proof checks (EVM sales stop on their own). */
export async function closeLapsedSales(deps: Deps) {
  let checked = 0, closed = 0;
  for (const a of await deps.allAssets()) {
    const n = stellarById(a.chainId);
    const sale = a.deployment?.sale;
    if (!n || a.standard !== "stellar-rwa" || a.status !== "deployed" || !sale || !stellarConfigured(n)) continue;
    checked++;
    const open = await readContract(n.key, sale, "is_open", [], { fresh: true }).catch(() => false);
    if (!open || await proofPasses(n, a.deployment.anchor.address)) continue;
    await call(n, sale, "set_open", xdr.ScVal.scvBool(false), addr(relayer(n).publicKey()));
    a.stellar.saleClosedByProof = new Date().toISOString();
    await deps.saveAsset(a);
    closed++;
  }
  return { checked, closed };
}

// ------------------------------------------------------------------ mainnet gates
/** A real Stellar multisig: at least two signers with weight, and the medium threshold needs more than one. */
async function multisigOf(n: StellarNetwork, account: string): Promise<{ ok: boolean; why?: string }> {
  try {
    const e: any = await (server(n) as any).getAccountEntry(account);
    // SDK 17 exposes plain properties (older SDKs: methods). thresholds = [master, low, medium, high].
    const val = (v: any) => (typeof v === "function" ? v.call(e) : v);
    const thr = val(e.thresholds);
    const th: Uint8Array = thr?.value ?? thr;
    const master = th[0] ?? 0, med = th[2] ?? 0;
    const signers: any[] = val(e.signers) ?? [];
    const weights = [master, ...signers.map((x: any) => Number(typeof x.weight === "function" ? x.weight() : x.weight))].filter((w: number) => w > 0);
    if (weights.length < 2) return { ok: false, why: "it has a single signer" };
    const top = Math.max(...weights);
    if (med <= top) return { ok: false, why: "one signer alone can approve (raise the medium threshold above any single signer's weight)" };
    return { ok: true };
  } catch {
    return { ok: false, why: "it doesn't exist on Stellar yet" };
  }
}
/** The offering fee: a successful Stellar payment of ≥ fee USDC to the platform fee account (STELLAR_FEE_ACCOUNT_<NET>). */
async function feePaid(n: StellarNetwork, hash: string, feeUsd: number): Promise<string | null> {
  const dest = process.env[`STELLAR_FEE_ACCOUNT_${n.key.toUpperCase()}`];
  if (!dest || !StrKey.isValidEd25519PublicKey(dest)) return `${n.name} isn't open for offerings yet (no platform fee account)`;
  const r: any = await server(n).getTransaction(hash).catch(() => null);
  if (!r || r.status !== rpc.Api.GetTransactionStatus.SUCCESS) return "fee payment not found or not successful (pay it, then paste the transaction hash within a few days)";
  const tx: any = TransactionBuilder.fromXDR(r.envelopeXdr.toXDR("base64"), n.passphrase);
  const ops: any[] = tx.operations ?? (tx.innerTransaction?.operations ?? []);
  // Testnet e2e can't get Circle USDC from a script: STELLAR_FEE_ASSET_TESTNET="CODE:ISSUER" stands in (testnet only).
  const [code, issuer] = (n.testnet && process.env.STELLAR_FEE_ASSET_TESTNET?.split(":")) || [n.payToken.code, n.payToken.issuer];
  let paid = 0n;
  for (const op of ops)
    if (op.type === "payment" && op.destination === dest && op.asset?.code === code && op.asset?.issuer === issuer)
      paid += scaleDec(String(op.amount), 7); // SDK amounts are 7-decimal strings ("2500.0000000")
  const need = BigInt(Math.round(feeUsd * 1e7));
  if (paid < need) return `offering fee not found: expected ${feeUsd} ${n.payToken.code} to ${dest} in ${hash}`;
  return null;
}

// ------------------------------------------------------------------ deployment plan
type Rules = { countryMode?: "none" | "allow" | "block"; countries?: number[]; lockupDays?: number; maxHolderPct?: number; accreditedOnly?: boolean; maxHolders?: number; resaleApproval?: boolean; maturity?: string };
export type StellarState = {
  network: number;
  /** Admin of the offering's contracts: the issuer's wallet on testnet, the issuer's multisig on mainnet. */
  issuer: string;
  /** Day-to-day manager (verify, issue, freeze): = issuer on testnet; the issuer's own wallet on mainnet. */
  operator: string;
  /** Mainnet: the offering-fee payment (Stellar tx hash), checked before deploy and never reused. */
  feeTx?: string;
  /** Mainnet verification in progress: identity contracts already set up by the platform, awaiting the operator. */
  pendingIdentities?: Record<string, string>;
  /** Mainnet: the issuer's claim-signing EVM wallet (its key is the claim issuer's only key, scheme 1). */
  claimSigner?: { address: string; publicKey: string };
  /** Mainnet verification in progress: claim data per topic awaiting the issuer's signature, per investor account. */
  pendingClaims?: Record<string, { identity: string; claims: { topic: number; data: string }[]; filed?: boolean }>;
  status: "deploying" | "deployed" | "failed";
  steps: Record<string, string>;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  /** Rules the Stellar modules can't enforce: the console shows them as off-chain only. */
  offChainRules: string[];
  investors: { account: string; country: number; identity: string; verifiedAt: string; frozen?: boolean }[];
  requests: { account: string; country: number; at: string }[];
  txs: string[];
};
/** The progress groups the deploy screen (X2) shows, in order. */
export const STELLAR_GROUPS = ["identity", "registry", "rules", "token", "chainlink", "handover"] as const;

function offChainRules(r: Rules): string[] {
  const out: string[] = [];
  if (r.maxHolders) out.push(`At most ${r.maxHolders} holders`);
  if (r.resaleApproval) out.push("Resales need your approval");
  if (r.maturity) out.push(`Matures ${r.maturity}`);
  return out;
}

async function runDeploy(n: StellarNetwork, deps: Deps, id: string, tenantId: string) {
  const load = async () => {
    const a = await deps.loadAsset(id, tenantId);
    if (!a?.stellar) throw new Error("asset vanished");
    return a;
  };
  const save = async (patch: (s: StellarState) => void) => {
    const a = await load();
    patch(a.stellar);
    await deps.saveAsset(a);
    return a;
  };
  const step = async (key: string, run: () => Promise<string>) => {
    const a = await load();
    if (a.stellar.steps[key]) return a.stellar.steps[key] as string;
    const v = await run();
    await save((s) => { s.steps[key] = v; });
    return v;
  };

  try {
    const asset = await load();
    const st: StellarState = asset.stellar;
    const issuer = st.issuer;
    const me = relayer(n).publicKey();
    // Managers at construction: the relayer does setup; on mainnet the issuer's operator wallet is a manager from the
    // start and the relayer renounces at the end (handover), so no platform key keeps the manager role.
    const managers = vec([addr(me), ...(strict(n) && st.operator && st.operator !== me ? [addr(st.operator)] : [])]);
    const rules: Rules = asset.rules ?? {};
    const supply = BigInt(asset.totalSupply) * UNIT;

    // identity
    const cti = await step("identity.cti", () => deploy(n, "cti", [addr(issuer), managers]));
    const topics = [TOPIC_KYC, TOPIC_AML, ...(rules.accreditedOnly ? [TOPIC_ACCREDITED] : [])];
    for (const t of topics) await step(`identity.topic${t}`, async () => (await call(n, cti, "add_claim_topic", u32(t), addr(me))).hash);
    const claimIssuer = await step("identity.claimIssuer", () => deploy(n, "claimIssuer", [addr(me)]));
    await step("identity.trusted", async () => (await call(n, cti, "add_trusted_issuer", addr(claimIssuer), vec(topics.map(u32)), addr(me))).hash);
    // Claim key: mainnet = the issuer's own EVM wallet (Ethereum personal_sign; the platform holds no claim key);
    // testnet = the platform's Ed25519 claim key.
    for (const t of topics) await step(`identity.key${t}`, async () => (strict(n)
      ? await call(n, claimIssuer, "allow_eth_key", bytes(Buffer.from(st.claimSigner!.publicKey.slice(2), "hex")), addr(cti), u32(t))
      : await call(n, claimIssuer, "allow_key", bytes(Buffer.from(claimKey(n).rawPublicKey())), addr(cti), u32(t))).hash);

    // registry
    const registry = await step("registry.irs", () => deploy(n, "registry", [addr(issuer), managers]));
    const verifier = await step("registry.verifier", () => deploy(n, "verifier", [addr(issuer), addr(me), addr(registry), addr(cti)]));

    // rules
    const compliance = await step("rules.compliance", () => deploy(n, "compliance", [addr(issuer), managers]));
    const mods: { key: string; wasm: StellarWasm; irs: boolean; hooks: string[]; set: (m: string, token: string) => Promise<unknown>[] }[] = [
      { key: "supplyLimit", wasm: "supplyLimit", irs: false, hooks: ["Created", "Destroyed"], set: (m, t) => [call(n, m, "set_supply_limit", addr(t), i128(supply), addr(me))] },
    ];
    if (rules.maxHolderPct && rules.maxHolderPct > 0) {
      const max = (supply * BigInt(Math.round(rules.maxHolderPct * 100))) / 10_000n;
      mods.push({ key: "maxBalance", wasm: "maxBalance", irs: true, hooks: ["Transferred", "Created", "Destroyed"], set: (m, t) => [call(n, m, "set_max_balance", addr(t), i128(max), addr(me))] });
    }
    const countries = rules.countries ?? [];
    if (rules.countryMode === "allow" && countries.length)
      mods.push({ key: "countryAllow", wasm: "countryAllow", irs: true, hooks: ["Transferred", "Created"], set: (m, t) => countries.map((cc) => call(n, m, "add_allowed_country", addr(t), u32(cc), addr(me))) });
    if (rules.countryMode === "block" && countries.length)
      mods.push({ key: "countryRestrict", wasm: "countryRestrict", irs: true, hooks: ["Transferred", "Created"], set: (m, t) => countries.map((cc) => call(n, m, "add_country_restriction", addr(t), u32(cc), addr(me))) });
    if (rules.lockupDays && rules.lockupDays > 0)
      mods.push({ key: "lockup", wasm: "lockup", irs: false, hooks: ["Transferred", "Created", "Destroyed"], set: (m, t) => [call(n, m, "set_lockup_period", addr(t), u32(rules.lockupDays! * LEDGERS_PER_DAY), addr(me))] });
    const modAddr: Record<string, string> = {};
    // Modules: the relayer is admin too, because binding a module to its compliance contract is admin-only and the
    // issuer signs nothing during deploy. The issuer stays admin of the compliance contract, so it can always unhook
    // any module (grant itself "manager" there, then remove_module_from).
    for (const m of mods) modAddr[m.key] = await step(`rules.${m.key}`, () => deploy(n, m.wasm, [addr(me), addr(me)]));

    // token
    const token = await step("token.token", () => deploy(n, "token", [str(asset.name), str(asset.symbol), addr(issuer), managers, addr(compliance), addr(verifier)]));
    await step("token.bindRegistry", async () => (await call(n, registry, "bind_token", addr(token), addr(me))).hash);
    await step("token.bindCompliance", async () => (await call(n, compliance, "bind_token", addr(token), addr(me))).hash);
    // Each module is fully configured before it is hooked in (a hooked module enforces from the next operation).
    for (const m of mods) {
      const ma = modAddr[m.key]!;
      await step(`rules.${m.key}.compliance`, async () => (await call(n, ma, "set_compliance_address", addr(token), addr(compliance), addr(me))).hash);
      if (m.irs) await step(`rules.${m.key}.irs`, async () => (await call(n, ma, "set_identity_registry_storage", addr(token), addr(registry), addr(me))).hash);
      await step(`rules.${m.key}.policy`, async () => { for (const p of m.set(ma, token)) await p; return "done"; });
      for (const h of m.hooks) await step(`rules.${m.key}.hook.${h}`, async () => (await call(n, compliance, "add_module_to", unitEnum(h), addr(ma), addr(me))).hash);
    }

    // The online sale is created afterwards from the sale wizard (W12), with the terms the issuer picks there.

    // chainlink: EVM identity on the anchor chain, registered on AssetOracle (CRE attests it; it can't write to Stellar)
    await step("chainlink.anchor", async () => {
      const evm = networkById(n.anchorChainId);
      const key = process.env.TREX_RELAYER_KEY;
      if (!evm?.assetOracle || !key) throw new Error("Chainlink registration isn't configured on this server");
      const account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex);
      const chain = { id: evm.id, name: evm.name, nativeCurrency: evm.native, rpcUrls: { default: { http: [rpcUrl(evm)] } } } as const;
      const pc = createPublicClient({ chain, transport: http(rpcUrl(evm), { timeout: 30_000 }) });
      const wc = createWalletClient({ account, chain, transport: http(rpcUrl(evm), { timeout: 60_000 }) });
      const hash = await wc.deployContract({ abi: anchorArtifact.abi as Abi, bytecode: anchorArtifact.bytecode as Hex, args: [n.key, token, account.address] });
      const r = await pc.waitForTransactionReceipt({ hash });
      if (r.status !== "success" || !r.contractAddress) throw new Error(`anchor deploy failed: ${hash}`);
      const anchor = getAddress(r.contractAddress);
      const cls = asset.assetClass as keyof typeof CLASS_CHECKS;
      const kinds = [...new Set([...(CLASS_CHECKS[cls] ?? []), "REGISTRY"])].map((k) => keccak256(toHex(k)));
      const reg = await wc.writeContract({
        address: evm.assetOracle.address, functionName: "register", args: [anchor, keccak256(toHex(cls)), kinds],
        abi: [{ type: "function", name: "register", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "bytes32" }, { type: "bytes32[]" }], outputs: [] }],
      });
      const rr = await pc.waitForTransactionReceipt({ hash: reg });
      if (rr.status !== "success") throw new Error(`oracle registration failed: ${reg}`);
      return anchor;
    });

    // handover (mainnet): the platform gives up every role it held for setup. Core contracts keep the issuer's
    // multisig as admin and its operator wallet as manager; modules end with no admin and no manager, so the rules
    // the offering launched with can't be changed by anyone (the admin can still unhook a module via compliance).
    if (strict(n)) {
      const mgr = sym("manager");
      for (const [k, c] of [["cti", cti], ["registry", registry], ["compliance", compliance], ["token", token]] as const)
        await step(`handover.${k}`, async () => (await call(n, c, "renounce_role", mgr, addr(me))).hash);
      for (const m of mods) {
        await step(`handover.${m.key}.manager`, async () => (await call(n, modAddr[m.key]!, "renounce_role", mgr, addr(me))).hash);
        await step(`handover.${m.key}.admin`, async () => (await call(n, modAddr[m.key]!, "renounce_admin")).hash);
      }
      // The claim issuer's key list is fixed: nobody (the platform included) can add a signing key later. If the issuer
      // loses the key, their multisig (claim-topics admin) trusts a new claim issuer instead.
      await step("handover.claimIssuer", async () => (await call(n, claimIssuer, "renounce_ownership")).hash);
    }

    await save((s) => { s.status = "deployed"; s.finishedAt = new Date().toISOString(); delete s.error; });
    const done = await load();
    done.status = "deployed";
    done.deployment = {
      chainId: n.id, token, registry, compliance, verifier, claimTopicsAndIssuers: cti, claimIssuer,
      modules: modAddr, anchor: { chainId: n.anchorChainId, address: done.stellar.steps["chainlink.anchor"] },
      ...(done.stellar.steps["token.sale"] ? { sale: done.stellar.steps["token.sale"], payToken: payTokenOf(n) } : {}),
      deployedAt: done.stellar.finishedAt,
    };
    await deps.saveAsset(done);
  } catch (e) {
    console.error("[stellar deploy]", id, e);
    await save((s) => { s.status = "failed"; s.error = (e as Error).message.slice(0, 300); }).catch(() => {});
  }
}

// ------------------------------------------------------------------ investor operations
/** The platform's part of verifying an investor: an identity contract (relayer as custodian) holding the KYC/AML
 *  (and accredited) claims signed by the platform claim key. Returns the identity contract. */
const claimTopics = (asset: any) => [TOPIC_KYC, TOPIC_AML, ...(asset.rules?.accreditedOnly ? [TOPIC_ACCREDITED] : [])];
const claimUri = (asset: any, account: string, t: number) => `https://tokenize.diamondz.one/claims/${asset.id}/${account}/${t}`;
async function prepareIdentity(n: StellarNetwork, asset: any, account: string): Promise<string> {
  const d = asset.deployment;
  const me = relayer(n).publicKey();
  const topics = claimTopics(asset);
  const identity = await deploy(n, "identity", [addr(me)]);
  for (const t of topics) {
    const c = signClaim(n, d.claimIssuer, identity, t);
    await call(n, identity, "add_claim", u32(t), u32(ED25519_SCHEME), addr(d.claimIssuer), bytes(c.signature), bytes(c.data),
      str(claimUri(asset, account, t)));
  }
  return identity;
}
/** Mainnet: files the issuer-signed claims (scheme 1) on the investor's identity, after checking each signature
 *  recovers to the offering's claim signer. */
async function fileIssuerClaims(n: StellarNetwork, asset: any, account: string, pending: { identity: string; claims: { topic: number; data: string }[] }, signatures: { topic: number; signature: Hex }[]) {
  const d = asset.deployment;
  const signer = asset.stellar.claimSigner as { address: string; publicKey: Hex };
  for (const c of pending.claims) {
    const s = signatures.find((x) => x.topic === c.topic);
    if (!s) throw Object.assign(new Error(`Missing the signature for claim topic ${c.topic}`), { status: 400 });
    const digest = claimDigest(n, d.claimIssuer, pending.identity, c.topic, Buffer.from(c.data, "hex"));
    const who = await recoverMessageAddress({ message: { raw: digest }, signature: s.signature });
    if (getAddress(who) !== getAddress(signer.address)) throw Object.assign(new Error(`That signature is from ${who}, not this offering's claim signer ${signer.address}`), { status: 400 });
  }
  for (const c of pending.claims) {
    const s = signatures.find((x) => x.topic === c.topic)!;
    await call(n, pending.identity, "add_claim", u32(c.topic), u32(ETH_PERSONAL_SIGN_SCHEME), addr(d.claimIssuer), bytes(ethSigData(signer.publicKey, s.signature)),
      bytes(Buffer.from(c.data, "hex")), str(claimUri(asset, account, c.topic)));
  }
}
/** Registry entry args; the operator (manager) is the relayer on testnet and the issuer's wallet on mainnet. */
const addIdentityArgs = (account: string, identity: string, country: number, operator: string) =>
  [addr(account), addr(identity), vec([countryProfile(country)]), addr(operator)];

/** Contract errors (contracts/sale SaleError, SAC balance/trustline) in plain words. */
function buyError(m: string): string {
  const code = /Error\(Contract, #(\d+)\)/.exec(m)?.[1];
  const sale: Record<string, string> = {
    "1": "The sale is closed right now", "2": "The sale hasn't started yet", "3": "The sale has ended",
    "4": "That's below the minimum investment", "5": "Not that many tokens are left", "6": "Enter a whole number of tokens",
  };
  if (code && sale[code]) return sale[code]!;
  if (/trustline|#13\b/i.test(m)) return "Add a USDC trustline to your Stellar wallet first";
  if (/balance|#10\b/i.test(m)) return "Not enough USDC in your Stellar wallet";
  if (/Account not found|404/i.test(m)) return "Your Stellar wallet isn't funded yet";
  return m.length > 200 ? `${m.slice(0, 200)}…` : m;
}

// ------------------------------------------------------------------ routes
const G = z.string().refine((a) => StrKey.isValidEd25519PublicKey(a), "a Stellar account (G…)");
const Country = z.number().int().min(1).max(999);

export function mountStellarOps(app: Hono<any>, deps: Deps) {
  const ctx = async (c: Context) => {
    const a = await deps.adminAsset(c, c.req.param("id") ?? "");
    if (!a) return { err: c.json({ error: "Not found" }, 404) } as const;
    const n = stellarById(a.chainId);
    if (!n || a.standard !== "stellar-rwa") return { err: c.json({ error: "Not a Stellar offering" }, 409) } as const;
    if (!stellarConfigured(n)) return { err: c.json({ error: "Stellar isn't set up on this server yet" }, 503) } as const;
    return { a, n } as const;
  };

  // Deploy. Testnet: { issuer } (one wallet is admin and manager; the platform keeps manager for convenience).
  // Mainnet: { admin, operator, feeTx } with the same gates as EVM mainnet offerings: a paid plan, legal sign-off,
  // a multisig admin, the flat offering fee, and the platform gives up every role after setup.
  app.post("/assets/:id/stellar/deploy", deps.requireAdmin, async (c) => {
    const x = await ctx(c);
    if ("err" in x) return x.err;
    const { a, n } = x;
    if (a.status === "deployed") return c.json({ error: "Already deployed" }, 409);
    if (a.stellar?.status === "deploying") return c.json(a);
    if (!stellarCodeReady(n)) return c.json({ error: `${n.name} isn't open yet: the platform's contract code isn't uploaded there` }, 409);
    const raw = await c.req.json().catch(() => null);
    let admin: string, operator: string, feeTx: string | undefined;
    let claimSigner: { address: string; publicKey: string } | undefined;
    if (!strict(n)) {
      const body = z.object({ issuer: G }).safeParse(raw);
      if (!body.success) return c.json({ error: "Connect your Stellar wallet first" }, 400);
      admin = operator = body.data.issuer;
    } else {
      const body = z.object({
        admin: G, operator: G, feeTx: z.string().regex(/^[0-9a-f]{64}$/i),
        claimSigner: z.object({ address: z.string().refine(isAddress), signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) }),
      }).safeParse(raw);
      if (!body.success) return c.json({ error: "Enter your multisig (admin), connect your wallet (operator), name your claim-signing wallet and paste the fee payment's transaction hash" }, 400);
      ({ admin, operator, feeTx } = body.data);
      const cs = body.data.claimSigner;
      const message = claimSignerMessage(a.id, n, cs.address);
      const publicKey = await recoverPublicKey({ hash: hashMessage(message), signature: cs.signature as Hex }).catch(() => null);
      const who = await recoverMessageAddress({ message, signature: cs.signature as Hex }).catch(() => null);
      if (!publicKey || !who || getAddress(who) !== getAddress(cs.address)) return c.json({ error: "The claim-signing wallet's signature doesn't match its address: sign the message again" }, 400);
      claimSigner = { address: getAddress(cs.address), publicKey };
      const rules = deps.mainnetRules(c);
      const errs: string[] = [];
      if (rules.testnetOnly) errs.push(`the Free plan runs on test networks only: choose a plan to go live on ${n.name}`);
      for (const r of deps.legalReasons ? await deps.legalReasons(a) : ["legal sign-off isn't available"]) errs.push(`mainnet needs: ${r}`);
      if (admin === operator) errs.push("the admin must be your multisig, not the wallet you use day to day");
      const ms = await multisigOf(n, admin);
      if (!ms.ok) errs.push(`the admin account must be a multisig, but ${ms.why}`);
      const prevFee = (await deps.allAssets()).some((o: any) => o.id !== a.id && o.stellar?.feeTx?.toLowerCase() === feeTx!.toLowerCase());
      if (prevFee) errs.push("that fee payment was already used for another offering");
      else {
        const feeErr = await feePaid(n, feeTx!, rules.offeringFeeUsd);
        if (feeErr) errs.push(feeErr);
      }
      if (errs.length) return c.json({ error: `Can't deploy yet: ${errs.join("; ")}` }, 422);
    }
    if (a.stellar?.issuer && (a.stellar.issuer !== admin || a.stellar.operator !== operator)) return c.json({ error: `Resume with the same admin (${a.stellar.issuer}) and wallet` }, 409);
    if (a.stellar?.claimSigner && claimSigner && a.stellar.claimSigner.address !== claimSigner.address) return c.json({ error: `Resume with the same claim-signing wallet (${a.stellar.claimSigner.address})` }, 409);
    const prev: StellarState | undefined = a.stellar;
    a.stellar = {
      network: n.id, issuer: admin, operator, ...(feeTx ? { feeTx } : {}), ...(claimSigner ?? prev?.claimSigner ? { claimSigner: claimSigner ?? prev!.claimSigner } : {}), status: "deploying", steps: prev?.steps ?? {}, startedAt: prev?.startedAt ?? new Date().toISOString(),
      offChainRules: offChainRules(a.rules ?? {}), investors: prev?.investors ?? [], requests: prev?.requests ?? [], txs: prev?.txs ?? [],
    } satisfies StellarState;
    await deps.saveAsset(a);
    void runDeploy(n, deps, a.id, a.tenantId);
    return c.json(a);
  });

  // Verify an investor. Testnet: the relayer does everything. Mainnet: the platform sets up the identity and claims,
  // then the issuer's operator wallet signs the registry entry:
  //   { account, country }             → { xdr }  (identity prepared; the operator signs add_identity)
  //   { account, country, signedXdr }  → asset    (checked to be exactly that call, submitted, investor recorded)
  app.post("/assets/:id/stellar/verify", deps.requireAdmin, async (c) => {
    const x = await ctx(c);
    if ("err" in x) return x.err;
    const { a, n } = x;
    if (a.status !== "deployed") return c.json({ error: "Deploy the token first" }, 409);
    const Sig = z.object({ topic: z.number().int(), signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) });
    const body = z.object({ account: G, country: Country, signedXdr: z.string().max(20_000).optional(), claimSignatures: z.array(Sig).max(5).optional() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Enter a Stellar account (G…) and the investor's country" }, 400);
    const { account, country, signedXdr, claimSignatures } = body.data;
    if (a.stellar.investors.some((i: any) => i.account === account)) return c.json({ error: "Already verified" }, 409);
    const record = async (identity: string) => {
      const fresh = await deps.adminAsset(c, a.id);
      fresh.stellar.investors.push({ account, country, identity, verifiedAt: new Date().toISOString() });
      fresh.stellar.requests = fresh.stellar.requests.filter((r: any) => r.account !== account);
      if (fresh.stellar.pendingIdentities) delete fresh.stellar.pendingIdentities[account];
      if (fresh.stellar.pendingClaims) delete fresh.stellar.pendingClaims[account];
      await deps.saveAsset(fresh);
      return fresh;
    };
    try {
      if (!strict(n)) {
        const identity = await prepareIdentity(n, a, account);
        await call(n, a.deployment.registry, "add_identity", ...addIdentityArgs(account, identity, country, relayer(n).publicKey()));
        return c.json(await record(identity));
      }
      const op = a.stellar.operator as string;
      if (!a.stellar.claimSigner) return c.json({ error: "This offering has no claim-signing wallet: it was deployed before issuer-signed claims" }, 409);
      // 1) identity contract + claim data (platform) → 2) the issuer's claim wallet signs each claim → 3) the operator
      //    signs the registry entry. The platform never signs a claim on mainnet.
      let pending: { identity: string; claims: { topic: number; data: string }[]; filed?: boolean } | undefined = a.stellar.pendingClaims?.[account];
      if (!pending) {
        const identity = await deploy(n, "identity", [addr(relayer(n).publicKey())]);
        pending = { identity, claims: claimTopics(a).map((topic) => ({ topic, data: newClaimData().toString("hex") })) };
        const fresh = await deps.adminAsset(c, a.id);
        fresh.stellar.pendingClaims = { ...(fresh.stellar.pendingClaims ?? {}), [account]: pending };
        await deps.saveAsset(fresh);
      }
      if (!pending.filed) {
        if (!claimSignatures) {
          const claims = pending.claims.map((x) => ({ topic: x.topic, digest: claimDigest(n, a.deployment.claimIssuer, pending!.identity, x.topic, Buffer.from(x.data, "hex")) }));
          return c.json({ claims, claimSigner: a.stellar.claimSigner.address, identity: pending.identity });
        }
        await fileIssuerClaims(n, a, account, pending, claimSignatures as { topic: number; signature: Hex }[]);
        const fresh = await deps.adminAsset(c, a.id);
        fresh.stellar.pendingClaims[account] = { ...pending, filed: true };
        await deps.saveAsset(fresh);
      }
      const identity = pending.identity;
      const args = addIdentityArgs(account, identity, country, op);
      if (!signedXdr) return c.json({ xdr: await prepareFor(n, op, a.deployment.registry, "add_identity", args), signer: op });
      const tx = exactCall(n, signedXdr, op, a.deployment.registry, "add_identity", args);
      if (!tx) return c.json({ error: "That transaction isn't the verification this page prepared" }, 400);
      await submitSigned(n, tx);
      return c.json(await record(identity));
    } catch (e) {
      return c.json({ error: (e as Error).message }, (e as any)?.status === 400 ? 400 : 422);
    }
  });

  /** Manager actions: the relayer on testnet; on mainnet a prepared tx the issuer's operator wallet signs. */
  const managerAct = async (c: Context, n: StellarNetwork, a: any, contract: string, fn: string, argsFor: (operator: string) => xdr.ScVal[], signedXdr: string | undefined) => {
    if (!strict(n)) return { tx: (await call(n, contract, fn, ...argsFor(relayer(n).publicKey()))).hash };
    const op = a.stellar.operator as string;
    const args = argsFor(op);
    if (!signedXdr) return { xdr: await prepareFor(n, op, contract, fn, args), signer: op };
    const tx = exactCall(n, signedXdr, op, contract, fn, args);
    if (!tx) throw Object.assign(new Error("That transaction isn't the one this page prepared"), { status: 400 });
    return { tx: await submitSigned(n, tx) };
  };

  app.post("/assets/:id/stellar/issue", deps.requireAdmin, async (c) => {
    const x = await ctx(c);
    if ("err" in x) return x.err;
    const { a, n } = x;
    const body = z.object({ account: G, amount: z.string().regex(/^[1-9]\d{0,15}$/), signedXdr: z.string().max(20_000).optional() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Enter a Stellar account and a whole number of tokens" }, 400);
    if (!a.stellar?.investors?.some((i: any) => i.account === body.data.account)) return c.json({ error: "Verify this investor first" }, 409);
    try {
      const r = await managerAct(c, n, a, a.deployment.token, "mint", (op) => [addr(body.data.account), i128(BigInt(body.data.amount) * UNIT), addr(op)], body.data.signedXdr);
      return c.json(r.xdr ? r : { ok: true, tx: r.tx });
    } catch (e) {
      return c.json({ error: (e as Error).message }, ((e as any).status ?? 422) as 400 | 422);
    }
  });

  app.post("/assets/:id/stellar/freeze", deps.requireAdmin, async (c) => {
    const x = await ctx(c);
    if ("err" in x) return x.err;
    const { a, n } = x;
    const body = z.object({ account: G, freeze: z.boolean(), signedXdr: z.string().max(20_000).optional() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Bad request" }, 400);
    try {
      const r = await managerAct(c, n, a, a.deployment.token, "set_address_frozen", (op) => [addr(body.data.account), xdr.ScVal.scvBool(body.data.freeze), addr(op)], body.data.signedXdr);
      if (r.xdr) return c.json(r);
      const fresh = await deps.adminAsset(c, a.id);
      for (const i of fresh.stellar.investors) if (i.account === body.data.account) i.frozen = body.data.freeze;
      await deps.saveAsset(fresh);
      return c.json({ ok: true, tx: r.tx });
    } catch (e) {
      return c.json({ error: (e as Error).message }, ((e as any).status ?? 422) as 400 | 422);
    }
  });

  // Pause / unpause is admin-only on the token, so the issuer signs it in Freighter:
  //   { paused }             → { xdr }  unsigned, prepared transaction with the issuer as source
  //   { paused, signedXdr }  → { tx }   the signed envelope, checked to be exactly that call, then submitted
  app.post("/assets/:id/stellar/pause", deps.requireAdmin, async (c) => {
    const x = await ctx(c);
    if ("err" in x) return x.err;
    const { a, n } = x;
    const body = z.object({ paused: z.boolean(), signedXdr: z.string().max(20_000).optional() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Bad request" }, 400);
    const fn = body.data.paused ? "pause" : "unpause";
    const issuer = a.stellar.issuer as string;
    const args = [addr(issuer)];
    try {
      if (!body.data.signedXdr) return c.json({ xdr: await prepareFor(n, issuer, a.deployment.token, fn, args) });
      const tx = exactCall(n, body.data.signedXdr, issuer, a.deployment.token, fn, args);
      if (!tx) return c.json({ error: "That transaction isn't the pause request this page prepared" }, 400);
      return c.json({ ok: true, tx: await submitSigned(n, tx) });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 422);
    }
  });

  // ---- primary sale (issuer)
  app.post("/assets/:id/stellar/sale/setup", deps.requireAdmin, async (c) => {
    const x = await ctx(c);
    if ("err" in x) return x.err;
    const { a, n } = x;
    if (a.status !== "deployed") return c.json({ error: "Deploy the token first" }, 409);
    if (a.deployment.sale) return c.json(a);
    const dec = (d: number) => z.string().regex(new RegExp(`^\\d{1,12}(\\.\\d{1,${d}})?$`));
    const tb = z.object({
      price: dec(6).refine((v) => Number(v) > 0, "price must be above zero").optional(), minimum: dec(2).optional(),
      treasury: G.optional(), capTokens: z.string().regex(/^[1-9]\d{0,17}$/).optional(),
      startsAt: z.number().int().min(0).optional(), endsAt: z.number().int().min(0).optional(),
    }).safeParse(await c.req.json().catch(() => ({})) ?? {});
    if (!tb.success) return c.json({ error: tb.error.issues.map((i) => i.message).join("; ") }, 400);
    const t: SaleTerms = tb.data;
    if (t.capTokens && BigInt(t.capTokens) > BigInt(a.totalSupply)) return c.json({ error: "You can't sell more than the total supply" }, 400);
    if (t.startsAt && t.endsAt && t.endsAt <= t.startsAt) return c.json({ error: "The sale must end after it starts" }, 400);
    if (t.treasury) {
      const f = await accountFacts(n, t.treasury);
      if (!f.exists) return c.json({ error: "That treasury account doesn't exist on Stellar yet" }, 422);
      if (!f.canReceive) return c.json({ error: `That treasury account can't receive ${n.payToken.code} yet: add a ${n.payToken.code} trustline to it first` }, 422);
    }
    try {
      const sale = await deploySale(n, a, a.stellar.issuer, a.deployment.token, t);
      const fresh = await deps.adminAsset(c, a.id);
      fresh.deployment.sale = sale;
      fresh.deployment.saleTerms = { ...t, treasury: t.treasury ?? a.stellar.issuer };
      fresh.deployment.payToken = payTokenOf(n);
      await deps.saveAsset(fresh);
      return c.json(fresh);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 422);
    }
  });

  // The token's mint role for the sale is admin-only: the issuer signs grant_role in Freighter.
  app.post("/assets/:id/stellar/sale/grant", deps.requireAdmin, async (c) => {
    const x = await ctx(c);
    if ("err" in x) return x.err;
    const { a, n } = x;
    if (!a.deployment?.sale) return c.json({ error: "Set up the sale first" }, 409);
    const body = z.object({ signedXdr: z.string().max(20_000).optional() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "Bad request" }, 400);
    const issuer = a.stellar.issuer as string;
    const args = grantArgs(a.deployment.sale, issuer);
    try {
      if (await saleCanMint(n, a.deployment.token, a.deployment.sale)) return c.json({ ok: true, already: true });
      if (!body.data.signedXdr) return c.json({ xdr: await prepareFor(n, issuer, a.deployment.token, "grant_role", args) });
      const tx = exactCall(n, body.data.signedXdr, issuer, a.deployment.token, "grant_role", args);
      if (!tx) return c.json({ error: "That transaction isn't the approval this page prepared" }, 400);
      return c.json({ ok: true, tx: await submitSigned(n, tx) });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 422);
    }
  });

  app.post("/assets/:id/stellar/sale/open", deps.requireAdmin, async (c) => {
    const x = await ctx(c);
    if ("err" in x) return x.err;
    const { a, n } = x;
    const sale = a.deployment?.sale;
    if (!sale) return c.json({ error: "Set up the sale first" }, 409);
    const body = z.object({ open: z.boolean() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Bad request" }, 400);
    try {
      if (body.data.open) {
        if (!(await saleCanMint(n, a.deployment.token, sale))) return c.json({ error: "Approve the sale in Freighter first (it needs permission to issue tokens)" }, 409);
        if (!(await proofPasses(n, a.deployment.anchor.address))) return c.json({ error: "Sales open once every proof-of-asset check passes" }, 409);
        const pt = (a.deployment.payToken as string | undefined) ?? payTokenOf(n);
        const payTo = (a.deployment.saleTerms?.treasury as string | undefined) ?? a.stellar.issuer;
        const hasLine = await readContract(n.key, pt, "balance", [addr(payTo)], { fresh: true }).then(() => true, () => false);
        if (!hasLine) return c.json({ error: `The account sale money goes to (${payTo}) needs a ${pt === n.payToken.contract ? n.payToken.code : "payment token"} trustline to receive payments. Add it in Freighter, then open the sale.` }, 409);
      }
      const r = await call(n, sale, "set_open", xdr.ScVal.scvBool(body.data.open), addr(relayer(n).publicKey()));
      if (body.data.open) {
        const fresh = await deps.adminAsset(c, a.id);
        delete fresh.stellar.saleClosedByProof;
        await deps.saveAsset(fresh);
      }
      return c.json({ ok: true, tx: r.hash });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 422);
    }
  });

  // Investor (listing page): ask the issuer to verify this Stellar wallet. Approval happens in the console.
  app.post("/stellar/assets/:id/requests", async (c) => {
    if (deps.tooMany(`stellar-req:${deps.ipKey(c)}`, 10, 60 * 60_000)) return c.json({ error: "Too many requests, try later" }, 429);
    const a = await deps.publicAsset(c, c.req.param("id") ?? "");
    if (!a || a.standard !== "stellar-rwa" || !a.stellar) return c.json({ error: "Not found" }, 404);
    const body = z.object({ account: G, country: Country }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Connect a Stellar wallet and pick your country" }, 400);
    const { account, country } = body.data;
    if (a.stellar.investors.some((i: any) => i.account === account)) return c.json({ status: "verified" });
    if (!a.stellar.requests.some((r: any) => r.account === account)) {
      if (a.stellar.requests.length >= 500) return c.json({ error: "This offering isn't taking new requests right now" }, 409);
      a.stellar.requests.push({ account, country, at: new Date().toISOString() });
      await deps.saveAsset(a);
    }
    return c.json({ status: "requested" });
  });

  // Sale state for the listing and the console.
  app.get("/stellar/assets/:id/sale", async (c) => {
    const a = await deps.publicAsset(c, c.req.param("id") ?? "") ?? await deps.adminAsset(c, c.req.param("id") ?? "").catch(() => null);
    const n = a ? stellarById(a.chainId) : undefined;
    if (!a || !n || !a.deployment?.sale) return c.json({ sale: null });
    const sale = a.deployment.sale as string;
    try {
      const [cfg, sold, open, canMint] = await Promise.all([
        readContract(n.key, sale, "config"), readContract(n.key, sale, "sold", [], { fresh: true }), readContract(n.key, sale, "is_open", [], { fresh: true }),
        saleCanMint(n, a.deployment.token, sale),
      ]);
      const k: any = cfg;
      const pt = a.deployment.payToken as string;
      return c.json({ sale: {
        address: sale, open: Boolean(open), canMint, price: String(k.price), minPurchase: String(k.min_purchase), cap: String(k.cap),
        sold: String(sold), startsAt: Number(k.starts_at), endsAt: Number(k.ends_at),
        payToken: { contract: pt, code: pt === n.payToken.contract ? n.payToken.code : "Test USD", issuer: pt === n.payToken.contract ? n.payToken.issuer : null, decimals: n.payToken.decimals },
        closedByProof: a.stellar?.saleClosedByProof ?? null,
      } });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 422);
    }
  });

  // Investor purchase: { buyer, amount } → prepared tx to sign in Freighter; { …, signedXdr } → submitted.
  app.post("/stellar/assets/:id/buy", async (c) => {
    if (deps.tooMany(`stellar-buy:${deps.ipKey(c)}`, 30, 10 * 60_000)) return c.json({ error: "Too many requests, try later" }, 429);
    const a = await deps.publicAsset(c, c.req.param("id") ?? "");
    const n = a ? stellarById(a.chainId) : undefined;
    if (!a || !n || a.standard !== "stellar-rwa" || !a.deployment?.sale) return c.json({ error: "This offering has no online sale" }, 404);
    const body = z.object({ buyer: G, amount: z.string().regex(/^[1-9]\d{0,15}$/), signedXdr: z.string().max(20_000).optional() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Connect your Stellar wallet and enter a whole number of tokens" }, 400);
    const { buyer, amount } = body.data;
    if (!a.stellar.investors.some((i: any) => i.account === buyer && !i.frozen)) return c.json({ error: "Verify your wallet before buying" }, 409);
    const args = [addr(buyer), i128(BigInt(amount) * UNIT)];
    try {
      if (!body.data.signedXdr) return c.json({ xdr: await prepareFor(n, buyer, a.deployment.sale, "buy", args) });
      const tx = exactCall(n, body.data.signedXdr, buyer, a.deployment.sale, "buy", args);
      if (!tx) return c.json({ error: "That transaction isn't the purchase this page prepared" }, 400);
      return c.json({ ok: true, tx: await submitSigned(n, tx) });
    } catch (e) {
      return c.json({ error: buyError((e as Error).message) }, 422);
    }
  });

  // Wizards: live account check (exists / multisig / can receive the pay token).
  app.get("/stellar-account/:network/:account", deps.requireAdmin, async (c) => {
    const n = (await import("../../web/src/lib/chains")).STELLAR_NETWORKS.find((x) => x.key === c.req.param("network"));
    const acct = c.req.param("account") ?? "";
    if (!n) return c.json({ error: "Unknown network" }, 404);
    if (!StrKey.isValidEd25519PublicKey(acct)) return c.json({ error: "That isn't a Stellar account address (G…)" }, 400);
    return c.json(await accountFacts(n, acct));
  });
  // Sale wizard: add the pay-token trustline to a wallet the issuer controls (prepare → Freighter signs → submit).
  app.post("/stellar-trustline/:network", deps.requireAdmin, async (c) => {
    const n = (await import("../../web/src/lib/chains")).STELLAR_NETWORKS.find((x) => x.key === c.req.param("network"));
    if (!n) return c.json({ error: "Unknown network" }, 404);
    const b = z.object({ account: G, signedXdr: z.string().max(20_000).optional() }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "Bad request" }, 400);
    // Testnet e2e: STELLAR_PAY_ASSET_TESTNET="CODE:ISSUER" matches STELLAR_PAY_TOKEN_TESTNET.
    const [code, issuer] = (n.testnet && process.env.STELLAR_PAY_ASSET_TESTNET?.split(":")) || [n.payToken.code, n.payToken.issuer];
    const asset = new ClassicAsset(code!, issuer!);
    try {
      if (!b.data.signedXdr) {
        const acct = await server(n).getAccount(b.data.account);
        const tx = new TransactionBuilder(acct, { fee: String(Number(BASE_FEE) * 10), networkPassphrase: n.passphrase })
          .addOperation(Operation.changeTrust({ asset })).setTimeout(300).build();
        return c.json({ xdr: tx.toXDR() });
      }
      const tx: any = TransactionBuilder.fromXDR(b.data.signedXdr, n.passphrase);
      const ops: any[] = tx.operations ?? [];
      const ok = tx.source === b.data.account && ops.length === 1 && ops[0].type === "changeTrust" && ops[0].line?.code === code && ops[0].line?.issuer === issuer;
      if (!ok) return c.json({ error: "That transaction isn't the trustline this page prepared" }, 400);
      return c.json({ ok: true, tx: await submitSigned(n, tx) });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 422);
    }
  });

  // Go-live wizard: check an offering-fee payment before deploying (same check the deploy runs).
  app.post("/stellar-fee-check/:network", deps.requireAdmin, async (c) => {
    const n = (await import("../../web/src/lib/chains")).STELLAR_NETWORKS.find((x) => x.key === c.req.param("network"));
    if (!n) return c.json({ error: "Unknown network" }, 404);
    const b = z.object({ feeTx: z.string().regex(/^[0-9a-f]{64}$/i), assetId: z.string().max(64) }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ ok: false, error: "Paste the 64-character transaction hash" }, 400);
    const used = (await deps.allAssets()).some((o: any) => o.id !== b.data.assetId && o.stellar?.feeTx?.toLowerCase() === b.data.feeTx.toLowerCase());
    if (used) return c.json({ ok: false, error: "That payment was already used for another offering" });
    const err = await feePaid(n, b.data.feeTx, deps.mainnetRules(c).offeringFeeUsd);
    return c.json(err ? { ok: false, error: err } : { ok: true });
  });

  // Mainnet terms for the deploy screen: where to pay the offering fee, how much, and whether mainnet is open.
  app.get("/stellar-terms/:network", deps.requireAdmin, async (c) => {
    const n = (await import("../../web/src/lib/chains")).STELLAR_NETWORKS.find((x) => x.key === c.req.param("network"));
    if (!n) return c.json({ error: "Unknown network" }, 404);
    const r = deps.mainnetRules(c);
    const feeAccount = process.env[`STELLAR_FEE_ACCOUNT_${n.key.toUpperCase()}`] ?? null;
    return c.json({
      network: n.key, open: stellarCodeReady(n) && stellarConfigured(n) && !!feeAccount, codeReady: stellarCodeReady(n),
      feeAccount, feeUsd: r.offeringFeeUsd, payToken: { code: n.payToken.code, issuer: n.payToken.issuer },
      testnetOnlyPlan: r.testnetOnly, counselReady: r.counselReady,
    });
  });

  // Chainlink CRE targets (cre/asset-feeds): every deployed Stellar offering on the platform. Addresses only — the
  // workflow builds its own read-only calls and checks each claim on chain (anchor → contract on the EVM side,
  // token → compliance → supply-limit module on Stellar), so this list can't make it attest anything false.
  app.get("/stellar/cre-targets", async (c) => {
    const out = (await deps.allAssets())
      .filter((a) => a.standard === "stellar-rwa" && a.status === "deployed" && a.deployment?.anchor?.address && a.deployment?.modules?.supplyLimit)
      .map((a) => {
        const n = stellarById(a.chainId)!;
        return { network: n.key, contract: a.deployment.token, anchor: a.deployment.anchor.address, compliance: a.deployment.compliance, supplyLimit: a.deployment.modules.supplyLimit, decimals: DECIMALS };
      })
      .sort((x, y) => (x.contract < y.contract ? -1 : 1));
    c.header("cache-control", "public, max-age=60");
    return c.json({ targets: out });
  });

  // Investor status for one wallet (listing checklist).
  app.get("/stellar/assets/:id/status/:account", async (c) => {
    const a = await deps.publicAsset(c, c.req.param("id") ?? "");
    if (!a || a.standard !== "stellar-rwa" || !a.stellar) return c.json({ error: "Not found" }, 404);
    const acct = c.req.param("account");
    const inv = a.stellar.investors.find((i: any) => i.account === acct);
    return c.json({ status: inv ? (inv.frozen ? "frozen" : "verified") : a.stellar.requests.some((r: any) => r.account === acct) ? "requested" : "none" });
  });
}
