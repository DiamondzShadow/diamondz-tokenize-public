// ERC-4626 fund vault end to end on a throwaway anvil chain (posing as Robinhood Chain Testnet, 46630 → Test USD)
// + a throwaway API: wizard-identical deploy → API on-chain verification → deposits within the cap → live checks →
// a payout to vault holders.   bun scripts/e2e-vault.ts
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { createPublicClient, createWalletClient, http, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import artifacts from "../src/contracts/artifacts.json";

const PORT_RPC = 8561, PORT_API = 8931;
const RPC = `http://127.0.0.1:${PORT_RPC}`, API = `http://127.0.0.1:${PORT_API}`;
const chain = { id: 46630, name: "anvil", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const K = [ // anvil default dev keys (public, test-only)
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
] as const;
const [platform, issuer, alice, bob] = K.map((k) => privateKeyToAccount(k));
const A = artifacts as any;
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
  const r = await pc.waitForTransactionReceipt({ hash: await wc(a).writeContract({ address, abi: A[n].abi, functionName: fn, args }) });
  if (r.status !== "success") throw new Error(`${fn} reverted`);
}
const read = (address: Address, n: string, fn: string, args: unknown[] = []) => pc.readContract({ address, abi: A[n].abi, functionName: fn, args }) as Promise<any>;
const reverts = (p: Promise<unknown>) => p.then(() => false, () => true);

const anvil = spawn("anvil", ["--chain-id", "46630", "--port", String(PORT_RPC), "--silent"]);
let apiProc: ReturnType<typeof spawn> | null = null;
try {
  for (let i = 0; i < 50 && !(await pc.getBlockNumber().then(() => true, () => false)); i++) await sleep(100);

  // ---- wizard-identical deploy: Test USD, registry, vault (cap = $1 × 1,000)
  // RH testnet's payment token is the shared platform Test USD (chains.ts): put a TestUSD at that exact address.
  const usd0 = await deploy(issuer, "TestUSD", []);
  const STABLE = "0xf2b2a7D121d2167BedBC6619A4A805786723e8CB" as Address;
  await pc.request({ method: "anvil_setCode" as any, params: [STABLE, await pc.getCode({ address: usd0.address })] as any });
  for (const slot of ["0x3", "0x4"]) // OZ ERC20 name, symbol
    await pc.request({ method: "anvil_setStorageAt" as any, params: [STABLE, slot, await pc.getStorageAt({ address: usd0.address, slot: slot as Hex })] as any });
  const usd = { ...usd0, address: STABLE };
  const reg = await deploy(issuer, "InvestorRegistry", [issuer.address, issuer.address, "0x0000000000000000000000000000000000000000"]);
  const vault = await deploy(issuer, "PermissionedVault", [{ asset: usd.address, name: "Harbor Income Fund", symbol: "HIF", admin: issuer.address, registry: reg.address, maxNavChangeBps: 2000, oracle: "0x0000000000000000000000000000000000000000", depositCap: parseUnits("1", 6) * 1000n, rules: "0x0000000000000000000000000000000000000000" }]);
  const bad = await deploy(issuer, "PermissionedVault", [{ asset: usd.address, name: "Harbor Income Fund", symbol: "HIF", admin: issuer.address, registry: reg.address, maxNavChangeBps: 2000, oracle: "0x0000000000000000000000000000000000000000", depositCap: 10n ** 30n, rules: "0x0000000000000000000000000000000000000000" }]);

  // ---- API on a throwaway DB
  const dir = mkdtempSync(`${tmpdir()}/vault-e2e-`);
  apiProc = spawn("bun", ["src/server.ts"], {
    cwd: import.meta.dir + "/../../api",
    env: { ...process.env, PORT: String(PORT_API), DB_PATH: `${dir}/t.db`, EVIDENCE_DIR: `${dir}/ev`, DEFAULT_HOSTS: "127.0.0.1", ADMIN_DOMAINS: "example.com", RPC_46630: RPC, ASSET_ORACLE_46630: "none" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 60 && !(await fetch(`${API}/api/health`).then((r) => r.ok, () => false)); i++) await sleep(150);
  const db = new Database(`${dir}/t.db`);
  const sid = randomBytes(16).toString("hex");
  db.query("INSERT INTO sessions (id_hash, tenant_id, email, name, expires_at) VALUES (?, 'diamondz', 'qa@example.com', 'QA', ?)").run(createHash("sha256").update(sid).digest("hex"), Date.now() + 3_600_000);
  const draft = { name: "Harbor Income Fund", symbol: "HIF", assetClass: "funds", standard: "erc4626", chainId: 46630, totalSupply: "1000", pricePerToken: "1", minInvestment: "0", status: "draft", listed: true, description: "", imageUrl: "", location: "", schedule: "", lockup: "" };
  const now = new Date().toISOString();
  db.query("INSERT INTO assets (id, tenant_id, data, created_at, updated_at) VALUES ('ast_vault', 'diamondz', ?, ?, ?)").run(JSON.stringify(draft), now, now);
  const call = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`${API}/api${path}`, { ...init, headers: { "content-type": "application/json", origin: API, cookie: `dt_session=${sid}` } });
    return { status: r.status, body: (await r.json()) as any };
  };

  // ---- 1. on-chain verification: a tampered vault is refused, the real one accepted
  const rec = (v: Address, txs: Hex[]) => call("/assets/ast_vault/deployment", { method: "POST", body: JSON.stringify({ registry: reg.address, token: v, sale: v, payToken: usd.address, txs }) });
  const no = await rec(bad.address, [usd.hash, reg.hash, bad.hash]);
  check(no.status === 422 && /deposit cap/.test(no.body.error), "API refuses a vault whose cap doesn't match the offering");
  const ok = await rec(vault.address, [usd.hash, reg.hash, vault.hash]);
  if (ok.status !== 200) console.log(ok.body);
  check(ok.status === 200 && ok.body.status === "deployed", "API verifies the vault on chain and marks it deployed");

  // ---- 2. deposits: verified only, within the cap
  for (const w of [alice, bob]) {
    await write(issuer, reg.address, "InvestorRegistry", "setInvestor", [w.address, true, 840, 0n]);
    await write(w, usd.address, "TestUSD", "mint", [w.address, parseUnits("1000", 6)]);
    await write(w, usd.address, "TestUSD", "approve", [vault.address, 2n ** 256n - 1n]);
  }
  await write(alice, vault.address, "PermissionedVault", "deposit", [parseUnits("600", 6), alice.address]);
  await write(bob, vault.address, "PermissionedVault", "deposit", [parseUnits("300", 6), bob.address]);
  check(await reverts(wc(bob).writeContract({ address: vault.address, abi: A.PermissionedVault.abi, functionName: "deposit", args: [parseUnits("101", 6), bob.address] })), "deposit beyond the $1,000 offering size is refused");
  check((await read(vault.address, "PermissionedVault", "capRemaining")) === parseUnits("100", 6), "$100 of capacity left");

  // ---- 3. live checks on the listing
  process.env.RPC_46630 = RPC;
  process.env.ASSET_ORACLE_46630 = "none";
  const { computeProof } = await import("../../api/src/proof");
  const p = await computeProof({ id: "ast_vault", chainId: 46630, assetClass: "funds", standard: "erc4626", deployment: { token: vault.address, sale: vault.address, registry: reg.address, payToken: usd.address } });
  const within = p.live.find((l: any) => l.id === "within-cap");
  check(!!within && within.ok === true && within.detail.includes("900") && within.detail.includes("1,000"), "live check: $900 of $1,000 raised");
  check(p.live.some((l: any) => l.id === "liquid") && p.live.find((l: any) => l.id === "sale-state")?.detail === "open", "live checks: cash in vault, deposits open");

  // ---- 4. payouts to vault holders (shares are an ERC-20; Distributor works unchanged)
  const dist = await deploy(platform, "Distributor", [platform.address, platform.address]);
  await write(platform, dist.address, "Distributor", "setPayoutToken", [usd.address, true, 0n]);
  apiProc.kill();
  apiProc = spawn("bun", ["src/server.ts"], {
    cwd: import.meta.dir + "/../../api",
    env: { ...process.env, PORT: String(PORT_API), DB_PATH: `${dir}/t.db`, EVIDENCE_DIR: `${dir}/ev`, DEFAULT_HOSTS: "127.0.0.1", ADMIN_DOMAINS: "example.com", RPC_46630: RPC, ASSET_ORACLE_46630: "none", DISTRIBUTOR_46630: `${dist.address}:0` },
    stdio: ["ignore", "ignore", "inherit"],
  });
  await sleep(400);
  for (let i = 0; i < 60 && !(await fetch(`${API}/api/health`).then((r) => r.ok, () => false)); i++) await sleep(150);
  // "Holders right now" snapshots 3 blocks behind the tip (reorg safety); let the chain move on as real time would.
  await pc.request({ method: "anvil_mine" as any, params: ["0x5"] as any });
  const pv = await call("/assets/ast_vault/payouts/preview", { method: "POST", body: JSON.stringify({ amount: "90", memo: "Q1 income", snapshot: { mode: "now" }, claimMonths: 12, holdFrozen: true }) });
  if (pv.status !== 200) console.log(pv.body);
  const sh = Object.fromEntries((pv.body.holders ?? []).map((h: any) => [h.account, h.amount]));
  // Vault shares carry inflation-attack rounding, so allow a 1-unit (one millionth of a dollar) difference.
  const near = (v: string | undefined, want: bigint) => v !== undefined && (BigInt(v) - want <= 1n && want - BigInt(v) <= 1n);
  check(pv.status === 200 && near(sh[alice.address], 60_000_000n) && near(sh[bob.address], 30_000_000n) && pv.body.amount === "90000000", "payout to vault holders splits pro rata ($60 / $30), adds up exactly");
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  apiProc?.kill();
  anvil.kill();
}
console.log(failed ? "\nE2E VAULT: FAILED" : "\nE2E VAULT: ALL PASS");
process.exit(failed ? 1 : 0);
