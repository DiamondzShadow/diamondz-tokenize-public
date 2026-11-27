// ERC-3643 end to end on a throwaway anvil chain (posing as Robinhood Chain Testnet 46630 → platform Test USD) + a
// throwaway API, using the real audited T-REX 4.1.6 / OnchainID 2.2.1 bytecode:
//   platform core (trex.ts deployCore) → v2 oracle + v2 payout contract → API /trex/prepare (claim issuer + suite,
//   whole suite owned by the issuer) → issuer wallet: own upgrade authority, sale, sale as agent, oracle register →
//   API verification → issuer-signed KYC via /trex/identity + /trex/kyc → proof checks → purchase → live checks →
//   payout preview.   bun scripts/e2e-3643.ts
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { createPublicClient, createWalletClient, http, keccak256, parseUnits, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import artifacts from "../src/contracts/artifacts.json";
import { CLASS_CHECKS, classHash, kindHash, maxValiditySeconds } from "../src/lib/verification";
import { TREX_ARTIFACTS as TX, deployCore } from "../../api/src/trex";

const PORT_RPC = 8564, PORT_API = 8934;
const RPC = `http://127.0.0.1:${PORT_RPC}`, API = `http://127.0.0.1:${PORT_API}`;
const chain = { id: 46630, name: "anvil", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const K = [ // anvil default dev keys (public, test-only)
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
] as const;
const [platform, issuer, alice, bob, relayer] = K.map((k) => privateKeyToAccount(k));
const A = artifacts as any;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const pc = createPublicClient({ chain, transport: http(RPC) });
const wc = (a: typeof issuer) => createWalletClient({ account: a, chain, transport: http(RPC) });
let failed = false;
const check = (ok: boolean, l: string) => (console.log(`${ok ? "PASS" : "FAIL"}  ${l}`), ok || (failed = true));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function deploy(a: typeof issuer, n: string, args: unknown[]) {
  const hash = await wc(a).deployContract({ abi: A[n].abi, bytecode: A[n].bytecode, args });
  const r = await pc.waitForTransactionReceipt({ hash });
  return { address: r.contractAddress as Address, hash };
}
async function write(a: typeof issuer, address: Address, abi: any, fn: string, args: unknown[]) {
  const hash = await wc(a).writeContract({ address, abi, functionName: fn, args });
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${fn} reverted`);
  return hash;
}
const read = (address: Address, abi: any, fn: string, args: unknown[] = []) => pc.readContract({ address, abi, functionName: fn, args }) as Promise<any>;
const reverts = (p: Promise<unknown>) => p.then(() => false, () => true);

const anvil = spawn("anvil", ["--chain-id", "46630", "--port", String(PORT_RPC), "--silent"]);
let apiProc: ReturnType<typeof spawn> | null = null;
try {
  for (let i = 0; i < 50 && !(await pc.getBlockNumber().then(() => true, () => false)); i++) await sleep(100);

  // ---- platform: Test USD at RH testnet's real address, ERC-3643 core, v2 oracle + v2 payout contract
  const usd0 = await deploy(issuer, "TestUSD", []);
  const usd = "0xf2b2a7D121d2167BedBC6619A4A805786723e8CB" as Address;
  await pc.request({ method: "anvil_setCode" as any, params: [usd, await pc.getCode({ address: usd0.address })] as any });
  for (const slot of ["0x3", "0x4"])
    await pc.request({ method: "anvil_setStorageAt" as any, params: [usd, slot, await pc.getStorageAt({ address: usd0.address, slot: slot as Hex })] as any });
  const core = await deployCore(wc(relayer) as any, pc as any, () => {});
  check(core.trexFactory !== ZERO && core.idFactory !== ZERO, "platform ERC-3643 core deployed from the audited artifacts (one transaction each)");
  check((await read(core.trexFactory, TX.TREXFactory.abi, "owner")) === relayer.address, "factory owned by the platform's T-REX relayer");
  const oracle = (await deploy(platform, "AssetOracle", [platform.address])).address;
  const kinds = CLASS_CHECKS["real-estate"];
  for (const k of kinds) await write(platform, oracle, A.AssetOracle.abi, "setMaxValidity", [kindHash(k), BigInt(maxValiditySeconds(k))]);
  await write(platform, oracle, A.AssetOracle.abi, "setClassRequirements", [classHash("real-estate"), kinds.map(kindHash)]);
  await write(platform, oracle, A.AssetOracle.abi, "setVerifier", [platform.address, true, "TEST all-in-one verifier"]);
  for (const k of kinds) await write(platform, oracle, A.AssetOracle.abi, "setVerifierKind", [platform.address, kindHash(k), true]);
  const dist = (await deploy(platform, "Distributor", [platform.address, platform.address])).address;
  await write(platform, dist, A.Distributor.abi, "setPayoutToken", [usd, true, 0n]);

  // ---- API on a throwaway DB
  const dir = mkdtempSync(`${tmpdir()}/e2e-3643-`);
  const env = {
    ...process.env, PORT: String(PORT_API), DB_PATH: `${dir}/t.db`, EVIDENCE_DIR: `${dir}/ev`, DEFAULT_HOSTS: "127.0.0.1", ADMIN_DOMAINS: "example.com",
    RPC_46630: RPC, ASSET_ORACLE_46630: `${oracle}:0`, DISTRIBUTOR_46630: `${dist}:0`, TREX_46630: JSON.stringify({ ...core, fromBlock: 0 }),
    TREX_RELAYER_KEY: K[4],
  };
  apiProc = spawn("bun", ["src/server.ts"], { cwd: import.meta.dir + "/../../api", env, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 80 && !(await fetch(`${API}/api/health`).then((r) => r.ok, () => false)); i++) await sleep(150);
  const db = new Database(`${dir}/t.db`);
  const sid = randomBytes(16).toString("hex");
  db.query("INSERT INTO sessions (id_hash, tenant_id, email, name, expires_at) VALUES (?, 'diamondz', 'qa@example.com', 'QA', ?)").run(createHash("sha256").update(sid).digest("hex"), Date.now() + 3_600_000);
  const draft = { name: "Harbor Lofts", symbol: "HARB", assetClass: "real-estate", standard: "erc3643", chainId: 46630, totalSupply: "10000", pricePerToken: "10", minInvestment: "100", status: "draft", listed: false, description: "", imageUrl: "", location: "", schedule: "Quarterly", lockup: "" };
  const now = new Date().toISOString();
  db.query("INSERT INTO assets (id, tenant_id, data, created_at, updated_at) VALUES ('ast_harbor', 'diamondz', ?, ?, ?)").run(JSON.stringify(draft), now, now);
  const call = async (path: string, body?: unknown) => {
    const r = await fetch(`${API}/api${path}`, { method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json", origin: API, cookie: `dt_session=${sid}` } });
    return { status: r.status, body: (await r.json()) as any };
  };

  // ---- 1. platform deploys the suite for the issuer's wallet
  const prep = await call("/assets/ast_harbor/trex/prepare", { wallet: issuer.address });
  if (prep.status !== 200) console.log(prep.body);
  check(prep.status === 200 && !!prep.body.token && !!prep.body.claimIssuer, "API deploys the issuer's claim issuer + the ERC-3643 suite");
  const { token, identityRegistry: ir, claimIssuer } = prep.body as { token: Address; identityRegistry: Address; claimIssuer: Address };
  const irs = await read(ir, TX.IdentityRegistry.abi, "identityStorage");
  const owners = await Promise.all([[token, "Token"], [ir, "IdentityRegistry"], [irs, "IdentityRegistryStorage"]].map(([a, n]) => read(a as Address, TX[n as string].abi, "owner")));
  check(owners.every((o) => o === issuer.address), "token, identity registry and its storage are all owned by the issuer's wallet");
  check((await read(claimIssuer, TX.ClaimIssuer.abi, "keyHasPurpose", [keccak256(`0x${"0".repeat(24)}${issuer.address.slice(2).toLowerCase()}` as Hex), 3n])) === true, "the issuer's wallet is the key on its claim issuer");
  check(!(await read(token, TX.Token.abi, "isAgent", [relayer.address])), "the platform is not a token agent (can't mint, freeze or force)");
  const again = await call("/assets/ast_harbor/trex/prepare", { wallet: issuer.address });
  check(again.status === 200 && again.body.token === token, "prepare is idempotent (same suite on retry)");
  const other = await call("/assets/ast_harbor/trex/prepare", { wallet: bob.address });
  check(other.status === 422 && /belongs to/.test(other.body.error), "a different wallet can't take over the offering's suite");

  // ---- 2. issuer wallet: own upgrade authority (default), sale, sale as agent, proof registration
  await write(issuer, core.implementationAuthority, TX.TREXImplementationAuthority.abi, "changeImplementationAuthority", [token, ZERO]);
  const ownIA = await read(token, [{ type: "function", name: "getImplementationAuthority", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }], "getImplementationAuthority");
  check(ownIA !== core.implementationAuthority && (await read(ownIA, TX.TREXImplementationAuthority.abi, "owner")) === issuer.address, "issuer took its own upgrade authority");
  const sale = await deploy(issuer, "PrimarySale3643", [{ token, payToken: usd, treasury: issuer.address, admin: issuer.address, price: parseUnits("10", 6), cap: 10_000n * 10n ** 18n, minPurchase: parseUnits("100", 6), startsAt: 0n, endsAt: 0n, feeRecipient: ZERO, feeBps: 0, oracle }]);
  const badSale = await deploy(issuer, "PrimarySale3643", [{ token, payToken: usd, treasury: issuer.address, admin: issuer.address, price: parseUnits("9", 6), cap: 10_000n * 10n ** 18n, minPurchase: parseUnits("100", 6), startsAt: 0n, endsAt: 0n, feeRecipient: ZERO, feeBps: 0, oracle }]);
  await write(issuer, token, TX.Token.abi, "addAgent", [sale.address]);
  await write(issuer, token, TX.Token.abi, "addAgent", [badSale.address]);
  await write(issuer, oracle, A.AssetOracle.abi, "register", [token, classHash("real-estate"), kinds.map(kindHash)]);

  // ---- 3. API verification
  const rec = (s: Address) => call("/assets/ast_harbor/deployment", { registry: ir, token, sale: s, payToken: usd, txs: [sale.hash] });
  const no = await rec(badSale.address);
  check(no.status === 422 && /price/.test(no.body.error), "API refuses a sale at the wrong price");
  const ok = await rec(sale.address);
  if (ok.status !== 200) console.log(ok.body);
  check(ok.status === 200 && ok.body.status === "deployed", "API verifies factory origin, claim topic, trusted issuer, sale, agent role and proof registration");
  const tenant = await call("/tenant");
  check(!tenant.body.registries?.["46630"], "the offering's identity registry isn't recorded as the tenant's reusable investor registry");

  // ---- 4. KYC: the issuer's wallet signs; the platform files it
  const idr = await call("/assets/ast_harbor/trex/identity", { wallet: alice.address });
  check(idr.status === 200 && !!idr.body.identity && idr.body.signer === issuer.address, "API creates the investor identity and returns what the issuer signs");
  const forged = await relayer.signMessage({ message: { raw: idr.body.digest } });
  const bad = await call("/assets/ast_harbor/trex/kyc", { wallet: alice.address, data: idr.body.data, signature: forged, country: 840 });
  check(bad.status === 422 && !(await read(ir, TX.IdentityRegistry.abi, "isVerified", [alice.address])), "a claim not signed by the issuer is refused (the platform can't verify anyone itself)");
  const sig = await issuer.signMessage({ message: { raw: idr.body.digest } });
  const kyc = await call("/assets/ast_harbor/trex/kyc", { wallet: alice.address, data: idr.body.data, signature: sig, country: 840 });
  if (kyc.status !== 200) console.log(kyc.body);
  check(kyc.status === 200 && kyc.body.verified === true, "issuer-signed KYC claim filed; alice verified on the token's identity registry");
  const sanctioned = await call("/assets/ast_harbor/trex/kyc", { wallet: "0x0330070FD38Ec3bB94F58FA55D40368271E9e54A", data: idr.body.data, signature: sig, country: 840 });
  check(sanctioned.status === 403, "a sanctioned wallet is refused before any claim is filed");

  // ---- 5. purchase, gated by proof of asset
  await write(alice, usd, A.TestUSD.abi, "mint", [alice.address, parseUnits("5000", 6)]);
  await write(alice, usd, A.TestUSD.abi, "approve", [sale.address, 2n ** 256n - 1n]);
  check(await reverts(wc(alice).writeContract({ address: sale.address, abi: A.PrimarySale3643.abi, functionName: "buy", args: [100n * 10n ** 18n] })), "purchase refused before the 3 real-estate checks are signed");
  const until = BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400);
  for (const k of kinds)
    await write(platform, oracle, A.AssetOracle.abi, "attest", [{ token, kind: kindHash(k), result: 1, validUntil: until, value: 0n, evidenceHash: keccak256(toHex(k)), evidenceURI: "ipfs://evidence" }]);
  await write(alice, sale.address, A.PrimarySale3643.abi, "buy", [100n * 10n ** 18n]);
  check((await read(token, TX.Token.abi, "balanceOf", [alice.address])) === 100n * 10n ** 18n && (await read(usd, A.TestUSD.abi, "balanceOf", [issuer.address])) === parseUnits("1000", 6), "alice bought 100 HARB for $1,000, paid to the treasury");
  check(await reverts(wc(bob).writeContract({ address: sale.address, abi: A.PrimarySale3643.abi, functionName: "buy", args: [100n * 10n ** 18n] })), "an unverified wallet can't buy");

  // ---- 6. live checks + payouts (v2 payout contract accepts the T-REX owner)
  process.env.RPC_46630 = RPC;
  process.env.ASSET_ORACLE_46630 = `${oracle}:0`;
  const { computeProof } = await import("../../api/src/proof");
  const p = await computeProof({ id: "ast_harbor", chainId: 46630, assetClass: "real-estate", standard: "erc3643", deployment: { token, sale: sale.address, registry: ir, payToken: usd } });
  check(p.verified === true && p.gated === true, "proof: verified, and the sale is gated by the oracle");
  check(p.live.find((l: any) => l.id === "supply-matches-sales")?.ok === true, "live check: all tokens issued through the sale");
  await pc.request({ method: "anvil_mine" as any, params: ["0x5"] as any });
  const pv = await call("/assets/ast_harbor/payouts/preview", { amount: "50", memo: "Q1 rent", snapshot: { mode: "now" }, claimMonths: 12, holdFrozen: true });
  if (pv.status !== 200) console.log(pv.body);
  check(pv.status === 200 && pv.body.holders?.[0]?.account === alice.address && pv.body.amount === "50000000", "payout preview: alice receives the whole $50 (sole holder)");

  // ---- 7. offering rules on ERC-3643 (wizard v2): accreditation claim topic + OfferingRulesModule
  const rules = { accreditedOnly: true, approvalDays: 365, countryMode: "allow", countries: [840], lockupDays: 365, lockBurns: false, maxHolders: 1, maxHolderPct: 0, resaleApproval: false, maturity: "", saleStartsAt: "", saleEndsAt: "" };
  db.query("INSERT INTO assets (id, tenant_id, data, created_at, updated_at) VALUES ('ast_rules', 'diamondz', ?, ?, ?)").run(JSON.stringify({ ...draft, name: "Harbor Lofts II", symbol: "HAR2", exemption: "506c", rules }), now, now);
  const prep2 = await call("/assets/ast_rules/trex/prepare", { wallet: issuer.address });
  if (prep2.status !== 200) console.log(prep2.body);
  check(prep2.status === 200 && !!prep2.body.rulesModule && prep2.body.accreditedOnly === true, "API deploys the rules module on first use and builds the suite with it");
  const t2 = prep2.body.token as Address, ir2 = prep2.body.identityRegistry as Address;
  const ctr = await read(ir2, TX.IdentityRegistry.abi, "topicsRegistry");
  const topics = (await read(ctr, TX.ClaimTopicsRegistry.abi, "getClaimTopics")) as bigint[];
  check(topics.length === 2 && topics.includes(1n) && topics.includes(2n), "accredited-only suite requires the KYC and accreditation claims");
  const compliance = await read(t2, TX.Token.abi, "compliance");
  const mod = prep2.body.rulesModule as Address;
  const st = await read(mod, TX.OfferingRulesModule.abi, "settings", [compliance]);
  check(st.lockup === 365n * 86_400n && Number(st.maxHolders) === 1 && Number(st.countryMode) === 1, "module settings applied by the factory: 12-month hold, 1 holder, US only");
  const id2 = await call("/assets/ast_rules/trex/identity", { wallet: bob.address });
  check(!!id2.body.accredited?.digest, "API returns a second, accreditation claim to sign");
  const sigK = await issuer.signMessage({ message: { raw: id2.body.digest } });
  const noAcc = await call("/assets/ast_rules/trex/kyc", { wallet: bob.address, data: id2.body.data, signature: sigK, country: 840 });
  check(noAcc.status === 400 && /accredited/.test(noAcc.body.error), "KYC alone is refused on an accredited-only offering");
  const sigA = await issuer.signMessage({ message: { raw: id2.body.accredited.digest } });
  const kyc2 = await call("/assets/ast_rules/trex/kyc", { wallet: bob.address, data: id2.body.data, signature: sigK, country: 840, accredited: { data: id2.body.accredited.data, signature: sigA } });
  check(kyc2.status === 200 && kyc2.body.verified === true, "KYC + accreditation claims filed; bob verified on the accredited-only offering");
  // alice holds the first offering's KYC claim only (same ONCHAINID): not enough here.
  const ida = await call("/assets/ast_rules/trex/identity", { wallet: alice.address });
  const kycA = await call("/assets/ast_rules/trex/kyc", { wallet: alice.address, data: ida.body.data, signature: await issuer.signMessage({ message: { raw: ida.body.digest } }), country: 840, accredited: { data: ida.body.accredited.data, signature: await issuer.signMessage({ message: { raw: ida.body.accredited.digest } }) } });
  check(kycA.status === 200, "alice verified too");
  const sale2 = await deploy(issuer, "PrimarySale3643", [{ token: t2, payToken: usd, treasury: issuer.address, admin: issuer.address, price: parseUnits("10", 6), cap: 10_000n * 10n ** 18n, minPurchase: parseUnits("100", 6), startsAt: 0n, endsAt: 0n, feeRecipient: ZERO, feeBps: 0, oracle }]);
  await write(issuer, t2, TX.Token.abi, "addAgent", [sale2.address]);
  await write(issuer, oracle, A.AssetOracle.abi, "register", [t2, classHash("real-estate"), kinds.map(kindHash)]);
  const rec2 = await call("/assets/ast_rules/deployment", { registry: ir2, token: t2, sale: sale2.address, payToken: usd, txs: [sale2.hash] });
  if (rec2.status !== 200) console.log(rec2.body);
  check(rec2.status === 200, "API verifies the accreditation topic and every module setting on chain");
  await write(issuer, t2, TX.Token.abi, "unpause", []);
  await write(issuer, t2, TX.Token.abi, "mint", [bob.address, 10n * 10n ** 18n]);
  check(await reverts(wc(issuer).writeContract({ address: t2, abi: TX.Token.abi, functionName: "mint", args: [alice.address, 1n] })), "a second holder is refused at the 1-holder limit");
  check(await reverts(wc(bob).writeContract({ address: t2, abi: TX.Token.abi, functionName: "transfer", args: [alice.address, 10n * 10n ** 18n] })), "resale inside the holding period is refused by T-REX compliance");
  await pc.request({ method: "evm_increaseTime" as any, params: [366 * 86_400] as any });
  await pc.request({ method: "evm_mine" as any, params: [] as any });
  await write(bob, t2, TX.Token.abi, "transfer", [alice.address, 10n * 10n ** 18n]);
  check((await read(t2, TX.Token.abi, "balanceOf", [alice.address])) === 10n * 10n ** 18n, "after 12 months bob sells out to alice (holder count stays at 1)");
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  apiProc?.kill();
  anvil.kill();
}
console.log(failed ? "\nE2E 3643: FAILED" : "\nE2E 3643: ALL PASS");
process.exit(failed ? 1 : 0);
