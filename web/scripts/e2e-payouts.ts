// Payouts end to end on a throwaway anvil chain (posing as Base Sepolia, 84532) + a throwaway API database.
// Investors buy → issuer previews a payout (snapshot + pro-rata split + Merkle tree) → funds it from its wallet
// → API verifies it on chain → investors claim gas-free through the relayer.   bun scripts/e2e-payouts.ts
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { createPublicClient, createWalletClient, http, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import artifacts from "../src/contracts/artifacts.json";

const PORT_RPC = 8559, PORT_API = 8929;
const RPC = `http://127.0.0.1:${PORT_RPC}`, API = `http://127.0.0.1:${PORT_API}`;
const chain = { id: 84532, name: "anvil", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const K = [ // anvil default dev keys (public, test-only)
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
] as const;
const [platform, issuer, alice, bob, carol, relayer] = K.map((k) => privateKeyToAccount(k));
const A = artifacts as any;
const pc = createPublicClient({ chain, transport: http(RPC) });
const wc = (a: typeof issuer) => createWalletClient({ account: a, chain, transport: http(RPC) });
let failed = false;
const check = (ok: boolean, l: string) => (console.log(`${ok ? "PASS" : "FAIL"}  ${l}`), ok || (failed = true));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function deploy(a: typeof issuer, n: string, args: unknown[]) {
  const hash = await wc(a).deployContract({ abi: A[n].abi, bytecode: A[n].bytecode, args });
  const r = await pc.waitForTransactionReceipt({ hash });
  return { address: r.contractAddress as Address, hash, block: r.blockNumber };
}
async function write(a: typeof issuer, address: Address, n: string, fn: string, args: unknown[]) {
  const hash = await wc(a).writeContract({ address, abi: A[n].abi, functionName: fn, args });
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${fn} reverted`);
  return hash;
}
const read = (address: Address, n: string, fn: string, args: unknown[] = []) => pc.readContract({ address, abi: A[n].abi, functionName: fn, args }) as Promise<any>;

const anvil = spawn("anvil", ["--chain-id", "84532", "--port", String(PORT_RPC), "--silent"]);
let apiProc: ReturnType<typeof spawn> | null = null;
try {
  for (let i = 0; i < 50 && !(await pc.getBlockNumber().then(() => true, () => false)); i++) await sleep(100);

  // ---- an offering with three investors
  const usd = await deploy(issuer, "TestUSD", []);
  const reg = await deploy(issuer, "InvestorRegistry", [issuer.address, issuer.address, "0x0000000000000000000000000000000000000000"]);
  const tok = await deploy(issuer, "PermissionedToken", [{ name: "Oak Ridge", symbol: "OAKR", decimals: 18, maxSupply: 10n ** 24n, admin: issuer.address, registry: reg.address, documentURI: "", rules: "0x0000000000000000000000000000000000000000" }]);
  const sale = await deploy(issuer, "PrimarySale", [{ token: tok.address, payToken: usd.address, treasury: issuer.address, admin: issuer.address, price: parseUnits("1", 6), cap: 10n ** 24n, minPurchase: 0n, startsAt: 0n, endsAt: 0n, feeRecipient: "0x0000000000000000000000000000000000000000", feeBps: 0, oracle: "0x0000000000000000000000000000000000000000" }]);
  await write(issuer, tok.address, "PermissionedToken", "grantRole", [await read(tok.address, "PermissionedToken", "MINTER_ROLE"), sale.address]);
  for (const [who, n] of [[alice, 600n], [bob, 300n], [carol, 100n]] as const) {
    await write(issuer, reg.address, "InvestorRegistry", "setInvestor", [who.address, true, 840, 0n]);
    await write(who, usd.address, "TestUSD", "mint", [who.address, parseUnits("1000", 6)]);
    await write(who, usd.address, "TestUSD", "approve", [sale.address, 2n ** 256n - 1n]);
    await write(who, sale.address, "PrimarySale", "buy", [n * 10n ** 18n]);
  }
  await write(issuer, tok.address, "PermissionedToken", "grantRole", [await read(tok.address, "PermissionedToken", "ENFORCER_ROLE"), issuer.address]);
  await write(issuer, tok.address, "PermissionedToken", "setFrozenTokens", [carol.address, 50n * 10n ** 18n]);

  // ---- platform payout contract, flat $25 fee in this stablecoin
  const dist = await deploy(platform, "Distributor", [platform.address, platform.address]);
  await write(platform, dist.address, "Distributor", "setPayoutToken", [usd.address, true, parseUnits("25", 6)]);

  // ---- API on a throwaway DB, with the relayer key
  const dir = mkdtempSync(`${tmpdir()}/payouts-e2e-`);
  apiProc = spawn("bun", ["src/server.ts"], {
    cwd: import.meta.dir + "/../../api",
    env: { ...process.env, PORT: String(PORT_API), DB_PATH: `${dir}/t.db`, EVIDENCE_DIR: `${dir}/ev`, DEFAULT_HOSTS: "127.0.0.1", ADMIN_DOMAINS: "example.com",
      RPC_84532: RPC, DISTRIBUTOR_84532: `${dist.address}:${dist.block}`, PAYOUT_RELAYER_KEY: K[5], ASSET_ORACLE_84532: "", CRE_FEED_84532: "" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 60 && !(await fetch(`${API}/api/health`).then((r) => r.ok, () => false)); i++) await sleep(150);
  const db = new Database(`${dir}/t.db`);
  const sid = randomBytes(16).toString("hex");
  db.query("INSERT INTO sessions (id_hash, tenant_id, email, name, expires_at) VALUES (?, 'diamondz', 'qa@example.com', 'QA', ?)").run(createHash("sha256").update(sid).digest("hex"), Date.now() + 3_600_000);
  const asset = { name: "Oak Ridge", symbol: "OAKR", assetClass: "real-estate", standard: "erc7943", chainId: 84532, totalSupply: "1000000", pricePerToken: "1", minInvestment: "0", status: "deployed", listed: true,
    deployment: { chainId: 84532, registry: reg.address, token: tok.address, sale: sale.address, payToken: usd.address, txs: [usd.hash, reg.hash, tok.hash, sale.hash] } };
  db.query("INSERT INTO assets (id, tenant_id, data, created_at, updated_at) VALUES ('ast_e2e', 'diamondz', ?, ?, ?)").run(JSON.stringify(asset), new Date().toISOString(), new Date().toISOString());
  const call = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`${API}/api${path}`, { ...init, headers: { "content-type": "application/json", origin: API, cookie: `dt_session=${sid}` } });
    return { status: r.status, body: (await r.json()) as any };
  };

  // ---- 1. preview: snapshot, split, frozen wallet held
  const pv = await call("/assets/ast_e2e/payouts/preview", { method: "POST", body: JSON.stringify({ amount: "1000.00", memo: "Q1 rent", snapshot: { mode: "now" }, claimMonths: 12, holdFrozen: true }) });
  if (pv.status !== 200) console.log(pv.body);
  const shares = Object.fromEntries((pv.body.holders ?? []).map((h: any) => [h.account, h.amount]));
  check(pv.status === 200 && shares[alice.address] === "600000000" && shares[bob.address] === "300000000", "preview splits pro rata (alice $600, bob $300)");
  check(pv.body.frozen?.length === 1 && pv.body.frozen[0].account === carol.address && pv.body.frozen[0].held && !shares[carol.address] && pv.body.amount === "900000000", "frozen wallet's $100 share is held; payout total $900");
  check(pv.body.fee === "25000000", "flat $25 fee quoted");

  // ---- 2. issuer funds it from its wallet (token admin)
  const a = pv.body.call.args;
  await write(issuer, usd.address, "TestUSD", "mint", [issuer.address, parseUnits("2000", 6)]);
  await write(issuer, usd.address, "TestUSD", "approve", [dist.address, BigInt(a[3]) + BigInt(a[7])]);
  const feeBefore = await read(usd.address, "TestUSD", "balanceOf", [platform.address]);
  const tx = await write(issuer, dist.address, "Distributor", "createDistribution", [a[0], a[1], a[2], BigInt(a[3]), BigInt(a[4]), BigInt(a[5]), a[6], BigInt(a[7])]);
  check((await read(usd.address, "TestUSD", "balanceOf", [platform.address])) - feeBefore === 25_000_000n, "platform received the flat fee on top");
  const sent = await call(`/payouts/${pv.body.id}/sent`, { method: "POST", body: JSON.stringify({ tx }) });
  check(sent.status === 200 && sent.body.distributionId === "0", "API verified the on-chain payout matches the preview");
  check((await call(`/payouts/${pv.body.id}/sent`, { method: "POST", body: JSON.stringify({ tx }) })).status === 409, "can't record the same payout twice");

  // ---- 3. investors see it and claim gas-free
  const pf = await call(`/portfolio/${alice.address}`);
  check(pf.body.claimable?.length === 1 && pf.body.claimable[0].amount === "600000000" && pf.body.claimable[0].memo === "Q1 rent", "alice sees $600 ready to claim");
  const aliceEthBefore = await pc.getBalance({ address: alice.address });
  const usdBefore = await read(usd.address, "TestUSD", "balanceOf", [alice.address]);
  const cl = await call(`/payouts/${pv.body.id}/claim`, { method: "POST", body: JSON.stringify({ account: alice.address }) });
  check(cl.status === 200 && (await read(usd.address, "TestUSD", "balanceOf", [alice.address])) - usdBefore === 600_000_000n, "alice claimed $600 into her wallet");
  check((await pc.getBalance({ address: alice.address })) === aliceEthBefore, "alice paid no gas (relayer did)");
  const again = await call(`/payouts/${pv.body.id}/claim`, { method: "POST", body: JSON.stringify({ account: alice.address }) });
  check(again.status === 409 || again.status === 429, "second claim refused");
  check((await call(`/payouts/${pv.body.id}/claim`, { method: "POST", body: JSON.stringify({ account: carol.address }) })).status === 404, "held (frozen) wallet has nothing to claim");
  const pf2 = await call(`/portfolio/${alice.address}`);
  check(pf2.body.claimable.length === 0 && pf2.body.paid.length === 1 && !!pf2.body.paid[0].tx, "alice's portfolio moves it to 'Paid to you' with the transaction");

  // ---- 4. console history
  const list = await call("/assets/ast_e2e/payouts");
  const row = list.body.payouts?.[0];
  check(row?.claimedCount === 1 && row?.holders === 2 && row?.claimedAmount === "600000000" && row?.frozenHeld === 1, "console shows 1 of 2 claimed, $600, 1 frozen share held");
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  apiProc?.kill();
  anvil.kill();
}
console.log(failed ? "\nE2E PAYOUTS: FAILED" : "\nE2E PAYOUTS: ALL PASS");
process.exit(failed ? 1 : 0);
