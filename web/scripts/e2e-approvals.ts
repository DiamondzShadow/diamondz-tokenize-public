// Investors approved without an identity check (2026-11-20) on a local chain: the issuer approves three wallets on
// its InvestorRegistry (one passed an identity check, one didn't, one was later removed); the console lists each with
// its status, the public listing shows counts only, and a new identity check clears the flag.
//   bun scripts/e2e-approvals.ts
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { createPublicClient, createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import artifacts from "../src/contracts/artifacts.json";

const PORT_RPC = 8566, PORT_API = 8982;
const RPC = `http://127.0.0.1:${PORT_RPC}`, API = `http://127.0.0.1:${PORT_API}`;
const chain = { id: 46630, name: "anvil", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const issuer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const A = artifacts as any;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const pc = createPublicClient({ chain, transport: http(RPC) });
const wc = createWalletClient({ account: issuer, chain, transport: http(RPC) });
let failed = false;
const check = (ok: boolean, l: string) => (console.log(`${ok ? "PASS" : "FAIL"}  ${l}`), ok || (failed = true));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const anvil = spawn("anvil", ["--chain-id", "46630", "--port", String(PORT_RPC), "--silent"]);
let apiProc: ReturnType<typeof spawn> | null = null;
try {
  for (let i = 0; i < 50 && !(await pc.getBlockNumber().then(() => true, () => false)); i++) await sleep(100);
  const dep = await wc.deployContract({ abi: A.InvestorRegistry.abi, bytecode: A.InvestorRegistry.bytecode, args: [issuer.address, issuer.address, ZERO] });
  const reg = (await pc.waitForTransactionReceipt({ hash: dep })).contractAddress as Address;
  const set = async (fn: string, args: unknown[]) => pc.waitForTransactionReceipt({ hash: await wc.writeContract({ address: reg, abi: A.InvestorRegistry.abi, functionName: fn, args }) });
  const alice = privateKeyToAccount(generatePrivateKey()).address, bob = privateKeyToAccount(generatePrivateKey()).address, carol = privateKeyToAccount(generatePrivateKey()).address;
  const far = BigInt(Math.floor(Date.now() / 1000) + 365 * 86400);
  await set("setInvestor", [alice, true, 840, far]);
  await set("setInvestor", [bob, false, 840, far]);
  await set("setInvestor", [carol, false, 840, far]);
  await set("removeInvestor", [carol]).catch(async () => set("setInvestor", [carol, false, 840, 0n]));

  const dir = mkdtempSync(`${tmpdir()}/e2e-appr-`);
  apiProc = spawn("bun", ["src/server.ts"], { cwd: import.meta.dir + "/../../api", env: { ...process.env, STORE: "", MONGO_URI: "", PORT: String(PORT_API), DB_PATH: `${dir}/t.db`, DEFAULT_HOSTS: "127.0.0.1", ADMIN_DOMAINS: "example.com", RPC_46630: RPC, BANK_PROOF_TICK: "0", TEMPORAL_JOBS: "", MFA_ENC_KEY: "", LOG_REFRESH_MS: "0" }, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 80 && !(await fetch(`${API}/api/health`).then((r) => r.ok, () => false)); i++) await sleep(150);
  const db = new Database(`${dir}/t.db`);
  const sid = randomBytes(16).toString("hex");
  db.query("INSERT INTO sessions (id_hash, tenant_id, email, name, expires_at) VALUES (?, 'diamondz', 'qa@example.com', 'QA', ?)").run(createHash("sha256").update(sid).digest("hex"), Date.now() + 3_600_000);
  const t = new Date().toISOString();
  const asset = { name: "Harbor Lofts", symbol: "HARB", assetClass: "real-estate", standard: "erc7943", chainId: 46630, totalSupply: "10000", pricePerToken: "10", minInvestment: "0", status: "deployed", listed: true, description: "", imageUrl: "", location: "", schedule: "", lockup: "", deployment: { chainId: 46630, registry: reg, token: "0x00000000000000000000000000000000000000a1", sale: "0x00000000000000000000000000000000000000a2", payToken: ZERO, txs: [dep], deployedAt: t } };
  db.query("INSERT INTO assets (id, tenant_id, data, created_at, updated_at) VALUES ('ast_00000000000000a1', 'diamondz', ?, ?, ?)").run(JSON.stringify(asset), t, t);
  db.query("INSERT INTO kyc (id, tenant_id, wallet, applicant_id, status, reject_labels, user_comment, created_at, updated_at) VALUES ('k1', 'diamondz', ?, 'x', 'approved', NULL, NULL, ?, ?)").run(alice.toLowerCase(), t, t);
  const get = async (p: string, admin = true) => { const r = await fetch(`${API}/api${p}`, { headers: admin ? { cookie: `dt_session=${sid}` } : {} }); return { status: r.status, body: (await r.json()) as any }; };

  check((await get("/assets/ast_00000000000000a1/approvals", false)).status === 401, "the wallet list is for the issuer only");
  const a = await get("/assets/ast_00000000000000a1/approvals");
  check(a.status === 200 && a.body.covered && a.body.total === 2, "two wallets are currently approved (the removed one isn't counted)");
  const w = (addr: string) => a.body.wallets.find((x: any) => x.wallet.toLowerCase() === addr.toLowerCase());
  check(w(alice)?.checked === true && w(bob)?.checked === false && w(bob)?.identity === "none", "Alice passed an identity check; Bob was approved without one");
  check(a.body.checked === 1 && a.body.manual === 1 && a.body.testnet === true, "counts: 1 checked, 1 approved without a check (test network)");
  const pub = await get("/market/ast_00000000000000a1/approvals", false);
  check(pub.status === 200 && pub.body.manual === 1 && pub.body.total === 2 && !JSON.stringify(pub.body).toLowerCase().includes(bob.slice(2).toLowerCase()), "the public listing shows counts only, never wallets");
  db.query("INSERT INTO kyc (id, tenant_id, wallet, applicant_id, status, reject_labels, user_comment, created_at, updated_at) VALUES ('k2', 'diamondz', ?, 'x', 'approved', NULL, NULL, ?, ?)").run(bob.toLowerCase(), t, t);
  apiProc.kill(); await sleep(500);
  apiProc = spawn("bun", ["src/server.ts"], { cwd: import.meta.dir + "/../../api", env: { ...process.env, STORE: "", MONGO_URI: "", PORT: String(PORT_API), DB_PATH: `${dir}/t.db`, DEFAULT_HOSTS: "127.0.0.1", ADMIN_DOMAINS: "example.com", RPC_46630: RPC, BANK_PROOF_TICK: "0", TEMPORAL_JOBS: "", MFA_ENC_KEY: "" }, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 80 && !(await fetch(`${API}/api/health`).then((r) => r.ok, () => false)); i++) await sleep(150);
  const b = await get("/assets/ast_00000000000000a1/approvals");
  check(b.body.manual === 0 && b.body.checked === 2, "once Bob passes an identity check, the flag clears");
} catch (e) { console.error(e); failed = true; } finally { apiProc?.kill(); anvil.kill(); }
console.log(failed ? "\nAPPROVALS: FAILURES" : "\nAPPROVALS: ALL PASS");
process.exit(failed ? 1 : 0);
