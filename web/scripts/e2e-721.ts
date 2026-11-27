// ERC-721 NFTs end to end on a throwaway anvil chain (posing as Robinhood Chain Testnet 46630 → platform Test USD)
// + a throwaway API: wizard-identical deploy (token, sale, minter, proof registration) → API on-chain verification →
// sale locked until the 3 real-estate checks are signed → verified-only purchase of whole NFTs in id order → wallet
// metadata per NFT → live checks → payouts refused for ERC-721.   bun scripts/e2e-721.ts
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { createPublicClient, createWalletClient, http, keccak256, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import artifacts from "../src/contracts/artifacts.json";
import { CLASS_CHECKS, classHash, kindHash, maxValiditySeconds } from "../src/lib/verification";

const PORT_RPC = 8563, PORT_API = 8933;
const RPC = `http://127.0.0.1:${PORT_RPC}`, API = `http://127.0.0.1:${PORT_API}`;
const chain = { id: 46630, name: "anvil", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const K = [ // anvil default dev keys (public, test-only)
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
] as const;
const [platform, issuer, alice, bob] = K.map((k) => privateKeyToAccount(k));
const A = artifacts as any;
const ZERO = "0x0000000000000000000000000000000000000000";
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
async function write(a: typeof issuer, address: Address, n: string, fn: string, args: unknown[]) {
  const hash = await wc(a).writeContract({ address, abi: A[n].abi, functionName: fn, args });
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${fn} reverted`);
  return hash;
}
const read = (address: Address, n: string, fn: string, args: unknown[] = []) => pc.readContract({ address, abi: A[n].abi, functionName: fn, args }) as Promise<any>;
const reverts = (p: Promise<unknown>) => p.then(() => false, () => true);

const anvil = spawn("anvil", ["--chain-id", "46630", "--port", String(PORT_RPC), "--silent"]);
let apiProc: ReturnType<typeof spawn> | null = null;
try {
  for (let i = 0; i < 50 && !(await pc.getBlockNumber().then(() => true, () => false)); i++) await sleep(100);

  // ---- platform: Test USD at RH testnet's real address + an AssetOracle with the collectibles checklist
  const usd0 = await deploy(issuer, "TestUSD", []);
  const STABLE = "0xf2b2a7D121d2167BedBC6619A4A805786723e8CB" as Address;
  await pc.request({ method: "anvil_setCode" as any, params: [STABLE, await pc.getCode({ address: usd0.address })] as any });
  for (const slot of ["0x3", "0x4"]) // OZ ERC20 name, symbol
    await pc.request({ method: "anvil_setStorageAt" as any, params: [STABLE, slot, await pc.getStorageAt({ address: usd0.address, slot: slot as Hex })] as any });
  const usd = STABLE;
  const oracle = (await deploy(platform, "AssetOracle", [platform.address])).address;
  const kinds = CLASS_CHECKS["real-estate"]; // TITLE, VALUATION, INSURANCE
  for (const k of kinds) {
    await write(platform, oracle, "AssetOracle", "setMaxValidity", [kindHash(k), BigInt(maxValiditySeconds(k))]);
  }
  await write(platform, oracle, "AssetOracle", "setClassRequirements", [classHash("real-estate"), kinds.map(kindHash)]);
  await write(platform, oracle, "AssetOracle", "setVerifier", [platform.address, true, "TEST all-in-one verifier"]);
  for (const k of kinds) await write(platform, oracle, "AssetOracle", "setVerifierKind", [platform.address, kindHash(k), true]);

  // ---- issuer: the wizard's exact steps (AssetDetail.tsx, erc721 path)
  const reg = await deploy(issuer, "InvestorRegistry", [issuer.address, issuer.address, ZERO]);
  const tok = await deploy(issuer, "PermissionedNFT", [{ name: "Harbor Lofts Deeds", symbol: "HLD", baseURI: `${API}/api/meta/ast_deed/`, maxSupply: 10n, admin: issuer.address, registry: reg.address, documentURI: "", rules: "0x0000000000000000000000000000000000000000" }]);
  const saleCfg = { token: tok.address, payToken: usd, treasury: issuer.address, admin: issuer.address, price: parseUnits("25", 6), cap: 10n, minPurchase: parseUnits("50", 6), startsAt: 0n, endsAt: 0n, feeRecipient: ZERO, feeBps: 0, oracle };
  const sale = await deploy(issuer, "PrimarySale721", [saleCfg]);
  const badSale = await deploy(issuer, "PrimarySale721", [{ ...saleCfg, cap: 9n }]);
  const itemTx = sale.hash;
  const minter = keccak256(new TextEncoder().encode("MINTER_ROLE"));
  const m1 = await write(issuer, tok.address, "PermissionedNFT", "grantRole", [minter, sale.address]);
  await write(issuer, tok.address, "PermissionedNFT", "grantRole", [minter, badSale.address]);
  const regTx = await write(issuer, oracle, "AssetOracle", "register", [tok.address, classHash("real-estate"), kinds.map(kindHash)]);

  // ---- API on a throwaway DB, with this anvil's oracle
  const dir = mkdtempSync(`${tmpdir()}/e2e-721-`);
  const env = { ...process.env, PORT: String(PORT_API), DB_PATH: `${dir}/t.db`, EVIDENCE_DIR: `${dir}/ev`, DEFAULT_HOSTS: "127.0.0.1", ADMIN_DOMAINS: "example.com", RPC_46630: RPC, ASSET_ORACLE_46630: `${oracle}:0` };
  apiProc = spawn("bun", ["src/server.ts"], { cwd: import.meta.dir + "/../../api", env, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 60 && !(await fetch(`${API}/api/health`).then((r) => r.ok, () => false)); i++) await sleep(150);
  const db = new Database(`${dir}/t.db`);
  const sid = randomBytes(16).toString("hex");
  db.query("INSERT INTO sessions (id_hash, tenant_id, email, name, expires_at) VALUES (?, 'diamondz', 'qa@example.com', 'QA', ?)").run(createHash("sha256").update(sid).digest("hex"), Date.now() + 3_600_000);
  const draft = { name: "Harbor Lofts Deeds", symbol: "HLD", assetClass: "real-estate", standard: "erc721", chainId: 46630, totalSupply: "10", pricePerToken: "25", minInvestment: "50", status: "draft", listed: true, description: "Ten loft deeds held in an SPV.", imageUrl: "https://example.com/loft.jpg", location: "", schedule: "", lockup: "" };
  const now = new Date().toISOString();
  db.query("INSERT INTO assets (id, tenant_id, data, created_at, updated_at) VALUES ('ast_deed', 'diamondz', ?, ?, ?)").run(JSON.stringify(draft), now, now);
  const call = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`${API}/api${path}`, { ...init, headers: { "content-type": "application/json", origin: API, cookie: `dt_session=${sid}` } });
    return { status: r.status, body: (await r.json()) as any };
  };

  // ---- 1. on-chain verification
  const meta0 = await fetch(`${API}/api/meta/ast_deed/1`);
  check(meta0.status === 404, "no wallet metadata before the offering is deployed");
  const rec = (s: Address) => call("/assets/ast_deed/deployment", { method: "POST", body: JSON.stringify({ registry: reg.address, token: tok.address, sale: s, payToken: usd, txs: [reg.hash, tok.hash, itemTx, sale.hash, m1, regTx] }) });
  const no = await rec(badSale.address);
  check(no.status === 422 && /sale cap/.test(no.body.error), "API refuses a sale whose cap doesn't match the number of NFTs");
  const ok = await rec(sale.address);
  if (ok.status !== 200) console.log(ok.body);
  check(ok.status === 200 && ok.body.status === "deployed", "API verifies token, sale, minter and proof registration on chain");

  // ---- 2. wallet metadata per NFT (tokenURI = base + id)
  const meta = await fetch(`${API}/api/meta/ast_deed/7`).then((r) => r.json() as any);
  check(meta.name === "Harbor Lofts Deeds #7" && meta.image === "https://example.com/loft.jpg" && meta.attributes?.[1]?.value === 7, "wallet metadata served for NFT #7");
  check((await fetch(`${API}/api/meta/ast_deed/11`)).status === 404 && (await fetch(`${API}/api/meta/ast_deed/0`)).status === 404, "no metadata outside NFTs 1..10");

  // ---- 3. sale locked until proof of asset, then verified-only purchases of whole fractions
  for (const w of [alice, bob]) {
    await write(w, usd, "TestUSD", "mint", [w.address, parseUnits("1000", 6)]);
    await write(w, usd, "TestUSD", "approve", [sale.address, 2n ** 256n - 1n]);
  }
  await write(issuer, reg.address, "InvestorRegistry", "setInvestor", [alice.address, true, 840, 0n]);
  check(await reverts(wc(alice).writeContract({ address: sale.address, abi: A.PrimarySale721.abi, functionName: "buy", args: [4n] })), "purchase refused before the 3 real-estate checks are signed");
  const until = BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400);
  for (const k of kinds) {
    await write(platform, oracle, "AssetOracle", "attest", [{ token: tok.address, kind: kindHash(k), result: 1, validUntil: until, value: 0n, evidenceHash: keccak256(new TextEncoder().encode(k)), evidenceURI: "ipfs://evidence" }]);
  }
  check((await read(sale.address, "PrimarySale721", "isOpen")) === true, "sale opens once every check is signed");
  await write(alice, sale.address, "PrimarySale721", "buy", [4n]);
  check((await read(tok.address, "PermissionedNFT", "balanceOf", [alice.address])) === 4n && (await read(tok.address, "PermissionedNFT", "ownerOf", [4n])) === alice.address, "verified investor bought NFTs #1–#4");
  check((await read(usd, "TestUSD", "balanceOf", [issuer.address])) === parseUnits("100", 6), "treasury received $100 (4 × $25)");
  check(await reverts(wc(bob).writeContract({ address: sale.address, abi: A.PrimarySale721.abi, functionName: "buy", args: [4n] })), "unverified wallet can't buy");
  check(await reverts(wc(alice).writeContract({ address: sale.address, abi: A.PrimarySale721.abi, functionName: "buy", args: [1n] })), "below the $50 minimum is refused");
  check(await reverts(wc(alice).writeContract({ address: sale.address, abi: A.PrimarySale721.abi, functionName: "buy", args: [7n] })), "can't buy more than the 6 NFTs left");

  // ---- 4. live checks (whole NFTs)
  process.env.RPC_46630 = RPC;
  process.env.ASSET_ORACLE_46630 = `${oracle}:0`;
  const { computeProof } = await import("../../api/src/proof");
  const asset = { id: "ast_deed", chainId: 46630, assetClass: "real-estate", standard: "erc721", deployment: { token: tok.address, sale: sale.address, registry: reg.address, payToken: usd } };
  let p = await computeProof(asset);
  check(p.verified === true && p.checks.every((c: any) => c.status === "current"), "proof: all 3 real-estate checks current");
  const sm = () => p.live.find((l: any) => l.id === "supply-matches-sales");
  check(sm()?.ok === true && /^4 issued/.test(sm()?.detail ?? ""), "live check counts whole NFTs (4 issued, all through the sale)");
  check(/4 of 10 sold/.test(p.live.find((l: any) => l.id === "within-cap")?.detail ?? ""), "live check: 4 of 10 sold");
  await write(issuer, tok.address, "PermissionedNFT", "mint", [alice.address]);
  p = await computeProof(asset);
  check(sm()?.ok === false && /minted outside the sale/.test(sm()?.detail ?? ""), "minting outside the sale is flagged");

  // ---- 5. payouts: not supported for ERC-721 yet
  const pv = await call("/assets/ast_deed/payouts/preview", { method: "POST", body: JSON.stringify({ amount: "10", memo: "x", snapshot: { mode: "now" }, claimMonths: 12, holdFrozen: true }) });
  check(pv.status === 400 && /ERC-721/.test(pv.body.error), "payout preview refused with a clear message");
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  apiProc?.kill();
  anvil.kill();
}
console.log(failed ? "\nE2E 721: FAILED" : "\nE2E 721: ALL PASS");
process.exit(failed ? 1 : 0);
