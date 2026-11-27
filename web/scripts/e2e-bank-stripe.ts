// Bank-proven income through Stripe Financial Connections (2026-11-20) against a fake Stripe and a throwaway API:
// session for the SPV as a Stripe customer, linked accounts limited to the offering's own customer, cash accounts only,
// monthly income from posted deposits (pending, debits, transfers and other accounts excluded), payer filter, account-
// holder name checked against the owning company, and no mixing with a Mastercard link. On-chain signing is the same
// code path as Mastercard (covered by e2e-bank.ts).
//   bun scripts/e2e-bank-stripe.ts
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";

const PORT = 8975, FAKE = 8976;
const API = `http://127.0.0.1:${PORT}`;
let failed = false;
const check = (ok: boolean, l: string) => (console.log(`${ok ? "PASS" : "FAIL"}  ${l}`), ok || (failed = true));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// last complete month, mid-month timestamps
const now = new Date();
const lastM = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)).getTime() / 1000;
const prevM = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 15)).getTime() / 1000;
const tx = (id: string, account: string, amount: number, at: number, description: string, status = "posted") => ({ id, account, amount, transacted_at: at, description, status });
const TXS = [
  tx("t1", "fca_opAAAAAA", 2_000_000, lastM, "ACH DEPOSIT HARBOR TENANTS"),
  tx("t2", "fca_opAAAAAA", 2_185_000, lastM + 3600, "HARBOR TENANTS RENT"),
  tx("t3", "fca_opAAAAAA", 500_000, lastM + 7200, "TRANSFER FROM SAVINGS"),
  tx("t4", "fca_opAAAAAA", -300_000, lastM + 9000, "PROPERTY TAX"),
  tx("t5", "fca_opAAAAAA", 99_999, lastM + 9500, "HARBOR TENANTS LATE FEE", "pending"),
  tx("t6", "fca_resBBBBBB", 700_000, lastM, "HARBOR TENANTS"),
  tx("t7", "fca_opAAAAAA", 3_890_000, prevM, "HARBOR TENANTS RENT"),
];
const seen: string[] = [];
const fake = Bun.serve({
  port: FAKE,
  async fetch(req) {
    const u = new URL(req.url);
    const body = req.method === "POST" ? new URLSearchParams(await req.text()) : null;
    seen.push(`${req.method} ${u.pathname}`);
    const j = (x: unknown, s = 200) => new Response(JSON.stringify(x), { status: s, headers: { "content-type": "application/json" } });
    if (u.pathname === "/v1/customers") return j({ id: "cus_spv1", name: body?.get("name") });
    if (u.pathname === "/v1/financial_connections/sessions") {
      if (body?.getAll("permissions[]").sort().join() !== "balances,ownership,transactions") return j({ error: { message: "bad permissions" } }, 400);
      return j({ id: "fcsess_A1", client_secret: "fcsess_A1_secret_x", account_holder: { customer: body.get("account_holder[customer]") } });
    }
    const acct = (id: string, customer = "cus_spv1", category = "cash") => ({ id, category, subcategory: "checking", display_name: id === "fca_opAAAAAA" ? "Operating" : id === "fca_resBBBBBB" ? "Reserve" : "Card", last4: id === "fca_opAAAAAA" ? "2323" : "9090", institution_name: "Harbor Bank", account_holder: { customer }, ownership: "fcaowns_1" });
    if (u.pathname === "/v1/financial_connections/sessions/fcsess_A1") return j({ id: "fcsess_A1", account_holder: { customer: "cus_spv1" }, accounts: { data: [acct("fca_opAAAAAA"), acct("fca_resBBBBBB"), acct("fca_cardDDDDDD", "cus_spv1", "credit")] } });
    if (u.pathname === "/v1/financial_connections/sessions/fcsess_OTHER") return j({ id: "fcsess_OTHER", account_holder: { customer: "cus_someone_else" }, accounts: { data: [acct("fca_xxCCCCCC", "cus_someone_else")] } });
    if (/\/subscribe$|\/refresh$/.test(u.pathname)) return j({ ok: true });
    const m = /^\/v1\/financial_connections\/accounts\/([^/]+)(\/owners)?$/.exec(u.pathname);
    if (m && m[2]) return j({ data: [{ name: "Harbor Lofts, LLC" }] });
    if (m) return m[1] === "fca_xxCCCCCC" ? j(acct("fca_xxCCCCCC", "cus_someone_else")) : j(acct(m[1]!));
    if (u.pathname === "/v1/financial_connections/transactions") {
      const a = u.searchParams.get("account");
      return j({ data: TXS.filter((t) => t.account === a), has_more: false });
    }
    return j({ error: { message: `fake: no route ${u.pathname}` } }, 404);
  },
});
let proc: ReturnType<typeof spawn> | null = null;
try {
  const dir = mkdtempSync(`${tmpdir()}/e2e-bstripe-`);
  proc = spawn("bun", ["src/server.ts"], {
    cwd: import.meta.dir + "/../../api",
    env: { ...process.env, STORE: "", MONGO_URI: "", PORT: String(PORT), DB_PATH: `${dir}/t.db`, DEFAULT_HOSTS: "127.0.0.1", ADMIN_DOMAINS: "example.com", BANK_PROOF_TICK: "0", TEMPORAL_JOBS: "", STRIPE_BASE: `http://127.0.0.1:${FAKE}`, STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_PUBLISHABLE_KEY: "pk_test_fake", MFA_ENC_KEY: "" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 80 && !(await fetch(`${API}/api/health`).then((r) => r.ok, () => false)); i++) await sleep(150);
  const db = new Database(`${dir}/t.db`);
  const sid = randomBytes(16).toString("hex");
  db.query("INSERT INTO sessions (id_hash, tenant_id, email, name, expires_at) VALUES (?, 'diamondz', 'qa@example.com', 'QA', ?)").run(createHash("sha256").update(sid).digest("hex"), Date.now() + 3_600_000);
  const t = new Date().toISOString();
  const asset = (name: string, owner: string) => ({ name, symbol: "HARB", assetClass: "real-estate", standard: "erc7943", chainId: 84532, totalSupply: "10000", pricePerToken: "10", minInvestment: "0", status: "deployed", listed: true, description: "", imageUrl: "", location: "", schedule: "", lockup: "", details: { owner }, deployment: { chainId: 84532, token: "0x0000000000000000000000000000000000000001", sale: "0x0000000000000000000000000000000000000002", txs: [], deployedAt: t } });
  db.query("INSERT INTO assets (id, tenant_id, data, created_at, updated_at) VALUES ('ast_00000000000000s1', 'diamondz', ?, ?, ?)").run(JSON.stringify(asset("Harbor Lofts", "Harbor Lofts LLC")), t, t);
  const call = async (path: string, body?: unknown) => {
    const r = await fetch(`${API}/api${path}`, { method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json", origin: API, cookie: `dt_session=${sid}` } });
    return { status: r.status, body: (await r.json()) as any };
  };
  const B = "/assets/ast_00000000000000s1/bank";

  const cfg = await fetch(`${API}/api/stripe/fc-config`).then((r) => r.json() as any);
  check(cfg.enabled === true && cfg.publishableKey === "pk_test_fake", "the browser gets the publishable key (never the secret)");
  check((await call(B)).body.stripeAvailable === true, "the panel offers Stripe");
  const ses = await call(`${B}/stripe/session`, {});
  check(ses.status === 200 && ses.body.clientSecret === "fcsess_A1_secret_x", "session created with transactions, ownership and balances");
  check(seen.includes("POST /v1/customers"), "the SPV becomes its own Stripe customer");
  check((await call(`${B}/stripe/linked`, { sessionId: "fcsess_OTHER" })).status === 400, "a bank link from another customer is refused");
  const lk = await call(`${B}/stripe/linked`, { sessionId: "fcsess_A1" });
  check(lk.status === 200 && lk.body.accounts.length === 2 && lk.body.accounts.every((a: any) => a.id !== "fca_cardDDDDDD"), "only cash accounts are offered (no credit cards)");
  check((await call(`${B}/settings`, { accountId: "fca_xxCCCCCC", expectedMonthly: 40000 })).status === 400, "an account that isn't this offering's is refused");
  check((await call(`${B}/settings`, { accountId: "fca_opAAAAAA", expectedMonthly: 40000, payers: ["Harbor Tenants"] })).status === 200, "operating account + $40,000 expected + payer saved");
  const st = await call(B);
  check(st.body.provider === "stripe" && st.body.accountLabel === "Harbor Bank Operating ending 2323", "status shows Stripe and the account");
  check(st.body.months?.[0]?.cents === 4_185_000 && st.body.months?.[0]?.deposits === 2, "last month: $41,850 from 2 rent deposits (transfer, debit, pending and other account excluded)");
  check(st.body.months?.[1]?.cents === 3_890_000, "the month before is read too");
  check(st.body.holder?.match === true && st.body.holder.names[0] === "Harbor Lofts, LLC", "account holder 'Harbor Lofts, LLC' matches owning company 'Harbor Lofts LLC'");
  await call(`${B}/settings`, { accountId: "fca_opAAAAAA", expectedMonthly: 40000, payers: [] });
  const auto = await call(B);
  check(auto.body.months?.[0]?.cents === 2_185_000, "with nobody named, only REGULAR payers count (one-off deposit and transfer excluded)");
  const dep = auto.body.depositors ?? [];
  check(dep.some((d: any) => d.name === "HARBOR TENANTS RENT" && d.regular && d.months === 2) && dep.some((d: any) => d.name === "HARBOR TENANTS" && !d.regular), "the issuer sees who deposits and which count");
  check(!dep.some((d: any) => /TRANSFER/.test(d.name)), "transfers between own accounts aren't listed as payers");

  db.query("UPDATE assets SET data = ? WHERE id = 'ast_00000000000000s1'").run(JSON.stringify(asset("Harbor Lofts", "Someone Else Holdings LLC")));
  check((await call(B)).body.holder?.match === false, "a different account holder is flagged as not matching");
  check(!JSON.stringify(db.query("SELECT * FROM bank_proof").all()).includes("HARBOR TENANTS"), "raw transactions are never stored");
} catch (e) { console.error(e); failed = true; } finally { proc?.kill(); fake.stop(true); }
console.log(failed ? "\nBANK STRIPE: FAILURES" : "\nBANK STRIPE: ALL PASS");
process.exit(failed ? 1 : 0);
