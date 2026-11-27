// Offering rules end to end (wizard v2, designs W7–W12) on a throwaway anvil chain posing as Robinhood Chain Testnet
// (46630 → platform Test USD) + a throwaway API:
//   draft with step-2 answers, step-5 rules and document fingerprints (API validation)
//   → wizard-identical deploy: registry, OfferingRules, token (rules + documentURI), sale (window), bind, minter
//   → API reads every rule back from chain and refuses mismatches → public documents manifest
//   → accredited-only, US-only, holding period, per-investor cap and holder limit enforced on real purchases/transfers.
//   bun scripts/e2e-rules.ts
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { createPublicClient, createWalletClient, http, keccak256, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import artifacts from "../src/contracts/artifacts.json";
import { manifestHash, rulesConfig, saleWindow, suggestedRules, type Rules } from "../src/lib/rules";

const PORT_RPC = 8571, PORT_API = 8941;
const RPC = `http://127.0.0.1:${PORT_RPC}`, API = `http://127.0.0.1:${PORT_API}`;
const chain = { id: 46630, name: "anvil", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const K = [ // anvil default dev keys (public, test-only)
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
] as const;
const [issuer, alice, bob, carol, dave, erin] = K.map((k) => privateKeyToAccount(k));
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
  if (r.status !== "success") throw new Error(`deploy ${n} reverted`);
  return { address: r.contractAddress as Address, hash };
}
async function write(a: typeof issuer, address: Address, n: string, fn: string, args: unknown[]) {
  const hash = await wc(a).writeContract({ address, abi: A[n].abi, functionName: fn, args });
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${fn} reverted`);
  return hash;
}
const read = (address: Address, n: string, fn: string, args: unknown[] = []) => pc.readContract({ address, abi: A[n].abi, functionName: fn, args }) as Promise<any>;
const reverts = (p: Promise<unknown>) => p.then(() => false, () => true);
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const anvil = spawn("anvil", ["--chain-id", "46630", "--port", String(PORT_RPC), "--silent"]);
let apiProc: ReturnType<typeof spawn> | null = null;
try {
  for (let i = 0; i < 50 && !(await pc.getBlockNumber().then(() => true, () => false)); i++) await sleep(100);

  // ---- platform Test USD at RH testnet's real address (the API requires it as the payment token)
  const usd0 = await deploy(issuer, "TestUSD", []);
  const STABLE = "0xf2b2a7D121d2167BedBC6619A4A805786723e8CB" as Address;
  await pc.request({ method: "anvil_setCode" as any, params: [STABLE, await pc.getCode({ address: usd0.address })] as any });
  for (const slot of ["0x3", "0x4"])
    await pc.request({ method: "anvil_setStorageAt" as any, params: [STABLE, slot, await pc.getStorageAt({ address: usd0.address, slot: slot as Hex })] as any });
  const usd = STABLE;

  // ---- throwaway API (no proof-of-asset oracle on this chain, so purchases aren't gated by attestations)
  const dir = mkdtempSync(`${tmpdir()}/e2e-rules-`);
  const env = { ...process.env, PORT: String(PORT_API), DB_PATH: `${dir}/t.db`, EVIDENCE_DIR: `${dir}/ev`, DEFAULT_HOSTS: "127.0.0.1", ADMIN_DOMAINS: "example.com", RPC_46630: RPC, ASSET_ORACLE_46630: "none" };
  apiProc = spawn("bun", ["src/server.ts"], { cwd: import.meta.dir + "/../../api", env, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 60 && !(await fetch(`${API}/api/health`).then((r) => r.ok, () => false)); i++) await sleep(150);
  const db = new Database(`${dir}/t.db`);
  const sid = randomBytes(16).toString("hex");
  db.query("INSERT INTO sessions (id_hash, tenant_id, email, name, expires_at) VALUES (?, 'diamondz', 'qa@example.com', 'QA', ?)").run(createHash("sha256").update(sid).digest("hex"), Date.now() + 3_600_000);
  const call = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`${API}/api${path}`, { ...init, headers: { "content-type": "application/json", origin: API, cookie: `dt_session=${sid}` } });
    return { status: r.status, body: (await r.json()) as any };
  };

  // ---- 1. the wizard's draft: real estate under 506(c), suggested rules + a sale window
  const details = { address: "1420 Biscayne Blvd, Miami, FL", propertyType: "multifamily", units: "12", appraisedValue: "4800000", mortgage: "2000000", unitsAre: "llc" };
  const rules: Rules = { ...suggestedRules("real-estate", "506c", details), maxHolders: 2, saleStartsAt: day(-1), saleEndsAt: day(30) };
  check(rules.accreditedOnly && rules.lockupDays === 365 && rules.countryMode === "allow" && rules.maxHolderPct === 10, "506(c) real-estate preset: accredited, 12-month hold, US only, 10% cap");
  const documents = [
    { kind: "title", name: "title_harbor.pdf", sha256: createHash("sha256").update("title").digest("hex") },
    { kind: "appraisal", name: "appraisal.pdf", sha256: createHash("sha256").update("appraisal").digest("hex") },
  ];
  const base = { name: "Harbor Lofts", symbol: "HARB", assetClass: "real-estate", standard: "erc7943", chainId: 46630, totalSupply: "100000", pricePerToken: "10", minInvestment: "10", exemption: "506c", schedule: "Quarterly" };
  const bad = await call("/assets", { method: "POST", body: JSON.stringify({ ...base, rules: { ...rules, countries: [] } }) });
  check(bad.status === 400 && /countries/.test(bad.body.error), "API refuses an allow-list with no countries");
  const badDoc = await call("/assets", { method: "POST", body: JSON.stringify({ ...base, documents: [{ kind: "title", name: "x", sha256: "nothex" }] }) });
  check(badDoc.status === 400, "API refuses a malformed document fingerprint");
  const film = await call("/assets", { method: "POST", body: JSON.stringify({ ...base, assetClass: "film", symbol: "NITE", details: { title: "Night Shift", holderPct: "30", license: "commercialRemix" } }) });
  check(film.status === 201 && film.body.assetClass === "film" && film.body.details.license === "commercialRemix", "film is a supported asset class with its own answers");
  const draft = await call("/assets", { method: "POST", body: JSON.stringify({ ...base, details, rules, documents }) });
  check(draft.status === 201 && draft.body.rules.lockupDays === 365 && draft.body.details.units === "12", "draft saved with answers, rules and fingerprints");
  const id = draft.body.id as string;

  // ---- 2. wizard-identical deploy (AssetDetail.tsx DeployPanel, erc7943 + rules path)
  const supply = 100_000n * 10n ** 18n;
  const reg = await deploy(issuer, "InvestorRegistry", [issuer.address, issuer.address, ZERO]);
  const asset = { standard: "erc7943" as const, totalSupply: "100000" };
  const rulesC = await deploy(issuer, "OfferingRules", [rulesConfig(rules, asset, issuer.address)]);
  const wrongRules = await deploy(issuer, "OfferingRules", [rulesConfig({ ...rules, lockupDays: 182 }, asset, issuer.address)]);
  const docURI = `${API}/api/documents/${id}#sha256=${await manifestHash(documents)}`;
  const tokCfg = { name: "Harbor Lofts", symbol: "HARB", decimals: 18, maxSupply: supply, admin: issuer.address, registry: reg.address, documentURI: docURI };
  const tok = await deploy(issuer, "PermissionedToken", [{ ...tokCfg, rules: rulesC.address }]);
  const tokWrong = await deploy(issuer, "PermissionedToken", [{ ...tokCfg, rules: wrongRules.address }]);
  const win = saleWindow(rules);
  const saleCfg = { token: tok.address, payToken: usd, treasury: issuer.address, admin: issuer.address, price: parseUnits("10", 6), cap: supply, minPurchase: parseUnits("10", 6), ...win, feeRecipient: ZERO, feeBps: 0, oracle: ZERO };
  const sale = await deploy(issuer, "PrimarySale", [saleCfg]);
  const minter = keccak256(new TextEncoder().encode("MINTER_ROLE"));
  const rec = (token: Address, s: Address, r: Address) => call(`/assets/${id}/deployment`, { method: "POST", body: JSON.stringify({ registry: reg.address, token, sale: s, payToken: usd, rules: r, txs: [reg.hash, tok.hash, sale.hash] }) });

  const notBound = await rec(tok.address, sale.address, rulesC.address);
  check(notBound.status === 422 && /aren't bound/.test(notBound.body.error), "API refuses rules that aren't bound to the token yet");
  const bindTx = await write(issuer, rulesC.address, "OfferingRules", "bindToken", [tok.address]);
  await write(issuer, wrongRules.address, "OfferingRules", "bindToken", [tokWrong.address]);
  await write(issuer, tok.address, "PermissionedToken", "grantRole", [minter, sale.address]);
  const wrongSale = await deploy(issuer, "PrimarySale", [{ ...saleCfg, token: tokWrong.address }]);
  await write(issuer, tokWrong.address, "PermissionedToken", "grantRole", [minter, wrongSale.address]);
  const mismatch = await rec(tokWrong.address, wrongSale.address, wrongRules.address);
  check(mismatch.status === 422 && /holding period doesn't match/.test(mismatch.body.error), "API reads the rules back and refuses a 6-month hold when the draft says 12");
  const noWindowSale = await deploy(issuer, "PrimarySale", [{ ...saleCfg, startsAt: 0n, endsAt: 0n }]);
  await write(issuer, tok.address, "PermissionedToken", "grantRole", [minter, noWindowSale.address]);
  const noWin = await rec(tok.address, noWindowSale.address, rulesC.address);
  check(noWin.status === 422 && /closing date/.test(noWin.body.error), "API refuses a sale without the draft's closing date");
  const ok = await rec(tok.address, sale.address, rulesC.address);
  if (ok.status !== 200) console.log(ok.body);
  check(ok.status === 200 && ok.body.status === "deployed" && ok.body.deployment.rules?.toLowerCase() === rulesC.address.toLowerCase(), "API verifies token, rules, documents and sale window on chain");
  void bindTx;

  // ---- 3. public documents manifest and listing
  const man = await fetch(`${API}/api/documents/${id}`).then((r) => r.json() as any);
  check(man.manifestSha256 === (await manifestHash(documents)) && man.documents.length === 2 && (await read(tok.address, "PermissionedToken", "documentURI")).endsWith(man.manifestSha256), "token's documentURI matches the public fingerprint manifest");
  await call(`/assets/${id}`, { method: "PATCH", body: JSON.stringify({ listed: true }) });
  const market = (await fetch(`${API}/api/market`).then((r) => r.json())) as any[];
  const pub = market.find((m) => m.id === id);
  check(!!pub && pub.rules?.lockupDays === 365 && pub.details?.units === "12" && pub.documents?.length === 2, "marketplace shows the asset facts, rules and fingerprints");

  // ---- 4. rules on real purchases and transfers
  await write(issuer, reg.address, "InvestorRegistry", "setInvestor", [alice.address, true, 840, 0n]);
  await write(issuer, reg.address, "InvestorRegistry", "setInvestor", [bob.address, true, 840, 0n]);
  await write(issuer, reg.address, "InvestorRegistry", "setInvestor", [carol.address, false, 840, 0n]); // not accredited
  await write(issuer, reg.address, "InvestorRegistry", "setInvestor", [dave.address, true, 826, 0n]); // UK
  await write(issuer, reg.address, "InvestorRegistry", "setInvestor", [erin.address, true, 840, 0n]);
  for (const w of [alice, bob, carol, dave, erin]) {
    await write(w, usd, "TestUSD", "mint", [w.address, parseUnits("100000", 6)]);
    await write(w, usd, "TestUSD", "approve", [sale.address, 2n ** 256n - 1n]);
  }
  const buy = (w: typeof issuer, n: bigint) => wc(w).writeContract({ address: sale.address, abi: A.PrimarySale.abi, functionName: "buy", args: [n * 10n ** 18n] }).then((h) => pc.waitForTransactionReceipt({ hash: h })).then((r) => { if (r.status !== "success") throw new Error("reverted"); });
  await buy(alice, 1000n);
  check((await read(tok.address, "PermissionedToken", "balanceOf", [alice.address])) === 1000n * 10n ** 18n, "accredited US investor buys 1,000 HARB");
  check(await reverts(buy(carol, 100n)), "verified but non-accredited investor can't buy (506(c) enforced by the token)");
  check(await reverts(buy(dave, 100n)), "UK investor can't buy a US-only offering");
  check(await reverts(buy(bob, 10_001n)), "no one can hold more than 10% (10,000 of 100,000)"); // $100,010 > mint cap, so fund first

  await buy(bob, 500n);
  check(await reverts(buy(erin, 100n)), "a third holder is refused at the 2-holder limit");
  const xfer = (from: typeof issuer, to: Address, n: bigint) => wc(from).writeContract({ address: tok.address, abi: A.PermissionedToken.abi, functionName: "transfer", args: [to, n * 10n ** 18n] }).then((h) => pc.waitForTransactionReceipt({ hash: h })).then((r) => { if (r.status !== "success") throw new Error("reverted"); });
  check(await reverts(xfer(alice, bob.address, 10n)), "resale inside the 12-month holding period is blocked");
  check((await read(tok.address, "PermissionedToken", "canTransfer", [alice.address, bob.address, 10n * 10n ** 18n])) === false, "canTransfer reports the block before anyone tries");
  await pc.request({ method: "evm_increaseTime" as any, params: [366 * 86_400] as any });
  await pc.request({ method: "evm_mine" as any, params: [] as any });
  await xfer(alice, bob.address, 10n);
  check((await read(tok.address, "PermissionedToken", "balanceOf", [bob.address])) === 510n * 10n ** 18n, "after 12 months the same resale goes through");
  check(await reverts(xfer(bob, carol.address, 1n)), "secondary transfers to a non-accredited wallet stay blocked");

  // ---- 5. terms and rules lock after deploy
  const edit = await call(`/assets/${id}`, { method: "PATCH", body: JSON.stringify({ rules: { ...rules, lockupDays: 0 } }) });
  check(edit.status === 409, "rules can't be edited in the app after deploy (they're on chain)");
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  apiProc?.kill();
  anvil.kill();
}
console.log(failed ? "\nE2E RULES: FAILED" : "\nE2E RULES: ALL PASS");
process.exit(failed ? 1 : 0);
