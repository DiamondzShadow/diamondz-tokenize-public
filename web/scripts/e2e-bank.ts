// Proof of asset from the SPV bank end to end: anvil (posing as RH testnet 46630) + v2 AssetOracle + a throwaway API +
// a MOCK Mastercard relay serving transactions. Issuer links the account → picks it + expected rent → the platform's
// data source signs RENT_INCOME through the relayer (attestBySig) → the oracle shows it with the month's income.
//   bun scripts/e2e-bank.ts
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { createPublicClient, createWalletClient, http, parseUnits, type Address } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import artifacts from "../src/contracts/artifacts.json";
import { CLASS_CHECKS, classHash, kindHash, maxValiditySeconds } from "../src/lib/verification";

const PORT_RPC = 8565, PORT_API = 8955, PORT_RELAY = 8956;
const RPC = `http://127.0.0.1:${PORT_RPC}`, API = `http://127.0.0.1:${PORT_API}`;
const chain = { id: 46630, name: "anvil", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const K = ["0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"] as const;
const [platform, issuer, relayerAcct] = K.map((k) => privateKeyToAccount(k));
const dsKey = generatePrivateKey();
const ds = privateKeyToAccount(dsKey);
const A = artifacts as any;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const RELAY_TOKEN = randomBytes(32).toString("hex");
const pc = createPublicClient({ chain, transport: http(RPC) });
const wc = (a: typeof issuer) => createWalletClient({ account: a, chain, transport: http(RPC) });
let failed = false;
const check = (ok: boolean, l: string) => (console.log(`${ok ? "PASS" : "FAIL"}  ${l}`), ok || (failed = true));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function deploy(a: typeof issuer, n: string, args: unknown[]) {
  const r = await pc.waitForTransactionReceipt({ hash: await wc(a).deployContract({ abi: A[n].abi, bytecode: A[n].bytecode, args }) });
  return r.contractAddress as Address;
}
async function write(a: typeof issuer, address: Address, n: string, fn: string, args: unknown[]) {
  const r = await pc.waitForTransactionReceipt({ hash: await wc(a).writeContract({ address, abi: A[n].abi, functionName: fn, args }) });
  if (r.status !== "success") throw new Error(`${fn} reverted`);
}

// ---- mock relay: last complete month has $41,850 of rent from the tenant payer + a $5,000 own-account transfer
const now = new Date();
const lastMonth = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 5) / 1000);
const prevMonth = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 5) / 1000);
const txs = [
  { id: 1, accountId: 6001, amount: 40000, postedDate: lastMonth, description: "HARBOR TENANTS LLC ACH", categorization: { normalizedPayeeName: "Harbor Tenants LLC", category: "Income" } },
  { id: 2, accountId: 6001, amount: 1850, postedDate: lastMonth + 86400, description: "UNIT 4B RENT", categorization: { normalizedPayeeName: "Harbor Tenants LLC", category: "Income" } },
  { id: 3, accountId: 6001, amount: 5000, postedDate: lastMonth + 2 * 86400, description: "TRANSFER FROM SAVINGS", categorization: { normalizedPayeeName: "Transfer", category: "Transfer" } },
  { id: 4, accountId: 6001, amount: -1200, postedDate: lastMonth, description: "PROPERTY TAX", categorization: { normalizedPayeeName: "County", category: "Taxes" } },
  { id: 5, accountId: 6002, amount: 99999, postedDate: lastMonth, description: "OTHER ACCOUNT", categorization: { normalizedPayeeName: "Harbor Tenants LLC", category: "Income" } },
  { id: 6, accountId: 6001, amount: 38900, postedDate: prevMonth, description: "HARBOR TENANTS LLC ACH", categorization: { normalizedPayeeName: "Harbor Tenants LLC", category: "Income" } },
];
const relay = Bun.serve({
  port: PORT_RELAY,
  async fetch(req) {
    if (req.headers.get("x-relay-token") !== RELAY_TOKEN) return new Response('{"error":"unauthorized"}', { status: 401 });
    const p = new URL(req.url).pathname;
    if (p === "/customers") return Response.json({ id: "7009998887" }, { status: 201 });
    if (/\/connect$/.test(p)) return Response.json({ link: "https://connect2.finicity.com/?customerId=7009998887&signature=test" });
    const accounts = [{ id: 6001, name: "Operating", type: "checking", realAccountNumberLast4: "2323" }, { id: 6002, name: "Reserve", type: "savings", realAccountNumberLast4: "9090" }, { id: 6003, name: "Brokerage", type: "investment" }];
    if (/\/accounts\/refresh$/.test(p) || /\/accounts$/.test(p)) return Response.json({ accounts });
    if (/\/transactions$/.test(p)) return Response.json({ transactions: txs, moreAvailable: "false" });
    return new Response('{"error":"not found"}', { status: 404 });
  },
});

const anvil = spawn("anvil", ["--chain-id", "46630", "--port", String(PORT_RPC), "--silent"]);
let apiProc: ReturnType<typeof spawn> | null = null;
try {
  for (let i = 0; i < 50 && !(await pc.getBlockNumber().then(() => true, () => false)); i++) await sleep(100);
  // ---- platform oracle (v2) with real-estate checks; the data source may sign RENT_INCOME only
  const oracle = await deploy(platform, "AssetOracle", [platform.address]);
  const kinds = [...CLASS_CHECKS["real-estate"], "RENT_INCOME" as const];
  for (const k of kinds) await write(platform, oracle, "AssetOracle", "setMaxValidity", [kindHash(k), BigInt(maxValiditySeconds(k))]);
  await write(platform, oracle, "AssetOracle", "setClassRequirements", [classHash("real-estate"), CLASS_CHECKS["real-estate"].map(kindHash)]);
  await write(platform, oracle, "AssetOracle", "setVerifier", [ds.address, true, "Mastercard Open Finance data source"]);
  await write(platform, oracle, "AssetOracle", "setVerifierKind", [ds.address, kindHash("RENT_INCOME"), true]);
  // ---- issuer offering: token + gated sale, registered WITH the optional rent check
  const reg = await deploy(issuer, "InvestorRegistry", [issuer.address, issuer.address, ZERO]);
  const token = await deploy(issuer, "PermissionedToken", [{ name: "Harbor Lofts", symbol: "HARB", decimals: 18, maxSupply: 10_000n * 10n ** 18n, admin: issuer.address, registry: reg, documentURI: "", rules: "0x0000000000000000000000000000000000000000" }]);
  const usd = await deploy(issuer, "TestUSD", []);
  const sale = await deploy(issuer, "PrimarySale", [{ token, payToken: usd, treasury: issuer.address, admin: issuer.address, price: parseUnits("10", 6), cap: 10_000n * 10n ** 18n, minPurchase: 0n, startsAt: 0n, endsAt: 0n, feeRecipient: ZERO, feeBps: 0, oracle }]);
  await write(issuer, oracle, "AssetOracle", "register", [token, classHash("real-estate"), kinds.map(kindHash)]);

  // ---- API
  const dir = mkdtempSync(`${tmpdir()}/e2e-bank-`);
  apiProc = spawn("bun", ["src/server.ts"], {
    cwd: import.meta.dir + "/../../api",
    env: { ...process.env, PORT: String(PORT_API), DB_PATH: `${dir}/t.db`, EVIDENCE_DIR: `${dir}/ev`, DEFAULT_HOSTS: "127.0.0.1", ADMIN_DOMAINS: "example.com", RPC_46630: RPC, ASSET_ORACLE_46630: `${oracle}:0`, MC_RELAY_URL: `http://127.0.0.1:${PORT_RELAY}`, MC_RELAY_NO_ID: "1", MC_RELAY_TOKEN: RELAY_TOKEN, MC_DATA_SOURCE_KEY: dsKey, TREX_RELAYER_KEY: K[2], BANK_PROOF_TICK: "0" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 80 && !(await fetch(`${API}/api/health`).then((r) => r.ok, () => false)); i++) await sleep(150);
  const db = new Database(`${dir}/t.db`);
  const sid = randomBytes(16).toString("hex");
  db.query("INSERT INTO sessions (id_hash, tenant_id, email, name, expires_at) VALUES (?, 'diamondz', 'qa@example.com', 'QA', ?)").run(createHash("sha256").update(sid).digest("hex"), Date.now() + 3_600_000);
  const t = new Date().toISOString();
  const asset = { name: "Harbor Lofts", symbol: "HARB", assetClass: "real-estate", standard: "erc7943", chainId: 46630, totalSupply: "10000", pricePerToken: "10", minInvestment: "0", status: "deployed", listed: true, description: "", imageUrl: "", location: "", schedule: "", lockup: "", deployment: { chainId: 46630, registry: reg, token, sale, payToken: usd, txs: [], deployedAt: t } };
  db.query("INSERT INTO assets (id, tenant_id, data, created_at, updated_at) VALUES ('ast_0123456789abcdee', 'diamondz', ?, ?, ?)").run(JSON.stringify(asset), t, t);
  const call = async (path: string, body?: unknown, admin = true) => {
    const r = await fetch(`${API}/api${path}`, { method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json", origin: API, ...(admin ? { cookie: `dt_session=${sid}` } : {}) } });
    return { status: r.status, body: (await r.json()) as any };
  };
  const A_ID = "/assets/ast_0123456789abcdee/bank";

  check((await call(A_ID, undefined, false)).status === 401, "only signed-in issuers can see bank proof");
  const s0 = await call(A_ID);
  check(s0.status === 200 && s0.body.linked === false && s0.body.kind === "RENT_INCOME" && s0.body.dataSource === ds.address, "real estate → rent check, signed by the platform data source");
  const con = await call(`${A_ID}/connect`, {});
  check(con.status === 200 && con.body.link.startsWith("https://connect2.finicity.com/"), "Data Connect link for the SPV account");
  const lk = await call(`${A_ID}/linked`, {});
  check(lk.status === 200 && lk.body.accounts.length === 2 && lk.body.accounts[0].last4 === "2323", "linked: deposit accounts listed (brokerage excluded)");
  const early = await call(`${A_ID}/check`, {});
  check(early.status === 200 && early.body.signed === false && /Pick the account/.test(early.body.reason), "no signing before the account and expected rent are set");
  check((await call(`${A_ID}/settings`, { accountId: "9999", expectedMonthly: 40000 })).status === 400, "an account that isn't linked is refused");
  check((await call(`${A_ID}/settings`, { accountId: "6001", expectedMonthly: 42000, payers: ["Harbor Tenants"] })).status === 200, "settings saved: operating account, $42,000 expected, payer marked");
  const short = await call(`${A_ID}/check`, {});
  check(short.body.signed === false && short.body.income?.cents === 4_185_000, "short month ($41,850 < $42,000): not signed; transfer, other account and debits excluded");
  await call(`${A_ID}/settings`, { accountId: "6001", expectedMonthly: 40000, payers: ["Harbor Tenants"] });
  const st = await call(A_ID);
  check(st.body.months?.[0]?.cents === 4_185_000 && st.body.months?.[1]?.cents === 3_890_000, "issuer sees monthly income read from the bank");
  const ok = await call(`${A_ID}/check`, {});
  if (!ok.body.signed) console.log(ok.body);
  check(ok.status === 200 && ok.body.signed === true && /^0x/.test(ok.body.tx), "month met ($41,850 ≥ $40,000): platform data source signed the rent check via the relayer");
  const [att] = (await pc.readContract({ address: oracle, abi: A.AssetOracle.abi, functionName: "attestation", args: [token, kindHash("RENT_INCOME")] }).then((a: any) => [a], () => [null])) as any[];
  const latest = att ?? (await pc.readContract({ address: oracle, abi: A.AssetOracle.abi, functionName: "latest", args: [token, kindHash("RENT_INCOME")] }).catch(() => null));
  check(!!latest && String(latest.verifier ?? latest[0]).toLowerCase() === ds.address.toLowerCase() && BigInt(latest.value ?? latest[4]) === 4_185_000n, "on chain: rent check by the data source, value $41,850.00");
  const again = await call(`${A_ID}/check`, {});
  check(again.body.signed === false && /already signed/.test(again.body.reason), "the same month is never signed twice");
  const ev = await fetch(`${API}/api/proof/bank/ast_0123456789abcdee/${ok.body.month}`).then((r) => r.json() as any);
  check(ev.incomeCents === 4_185_000 && ev.source === "Mastercard Open Finance" && !JSON.stringify(ev).includes("Tenants"), "public evidence: numbers only, no payer names");
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  apiProc?.kill();
  anvil.kill();
  relay.stop(true);
}
console.log(failed ? "\nE2E BANK: FAILED" : "\nE2E BANK: ALL PASS");
process.exit(failed ? 1 : 0);
