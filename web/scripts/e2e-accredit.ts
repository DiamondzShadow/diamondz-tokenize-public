// Accredited-investor flow end to end against a throwaway API and a MOCK Mastercard relay (same routes as mc-relay):
// wallet-signed request → identity details passed to Mastercard and NOT stored → Data Connect link → accounts linked →
// VOI report → numbers-only summary → issuer sees live owner names → decision.   bun scripts/e2e-accredit.ts
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { privateKeyToAccount } from "viem/accounts";
import { accreditationMessage } from "../../api/src/mastercard";

const PORT_API = 8951, PORT_RELAY = 8952;
const API = `http://127.0.0.1:${PORT_API}`;
const RELAY_TOKEN = randomBytes(32).toString("hex");
const investor = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const stranger = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
let failed = false;
const check = (ok: boolean, l: string) => (console.log(`${ok ? "PASS" : "FAIL"}  ${l}`), ok || (failed = true));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- mock relay: 24 months of HIGH-confidence income at $20,000 gross / month ⇒ $240,000 a year
const seen: { consumer?: any; reportPurpose?: string | null } = {};
const now = new Date();
const months = Array.from({ length: 24 }, (_, i) => Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1 - i, 1) / 1000));
const report = {
  id: "rpt-voi-1", type: "voi", status: "success", createdDate: Math.floor(Date.now() / 1000),
  institutions: [{ id: 1, name: "FinBank", accounts: [{ id: 11, type: "checking", number: "111111", ownerName: "Alex Morgan", incomeStreams: [{ estimateInclusion: "HIGH" }] }, { id: 12, type: "savings", number: "222222", ownerName: "Alex Morgan", incomeStreams: [] }] }],
  income: [{ confidenceType: "HIGH", netMonthly: months.map((m) => ({ month: m, net: 14_000, gross: 20_000 })) }, { confidenceType: "LOW", netMonthly: months.map((m) => ({ month: m, net: 9_999, gross: 9_999 })) }],
};
const relay = Bun.serve({
  port: PORT_RELAY,
  async fetch(req) {
    if (req.headers.get("x-relay-token") !== RELAY_TOKEN) return new Response('{"error":"unauthorized"}', { status: 401 });
    const u = new URL(req.url);
    const p = u.pathname;
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : null;
    if (p === "/customers") return Response.json({ id: "7001234567", username: body.username }, { status: 201 });
    if (/\/consumer$/.test(p)) { seen.consumer = body; return Response.json({ id: "c0nsumer1" }, { status: 201 }); }
    if (/\/connect$/.test(p)) return Response.json({ link: "https://connect2.finicity.com/?customerId=7001234567&signature=test" });
    if (/\/accounts\/refresh$/.test(p)) return Response.json({ accounts: [] });
    if (/\/reports\/voi$/.test(p)) return Response.json({ id: "rpt-voi-1", status: "inProgress" });
    if (/\/reports\/rpt-voi-1$/.test(p)) { seen.reportPurpose = u.searchParams.get("purpose"); return Response.json(report); }
    return new Response('{"error":"not found"}', { status: 404 });
  },
});

let apiProc: ReturnType<typeof spawn> | null = null;
try {
  const dir = mkdtempSync(`${tmpdir()}/e2e-accredit-`);
  apiProc = spawn("bun", ["src/server.ts"], {
    cwd: import.meta.dir + "/../../api",
    env: { ...process.env, PORT: String(PORT_API), DB_PATH: `${dir}/t.db`, EVIDENCE_DIR: `${dir}/ev`, DEFAULT_HOSTS: "127.0.0.1", ADMIN_DOMAINS: "example.com", MC_RELAY_URL: `http://127.0.0.1:${PORT_RELAY}`, MC_RELAY_NO_ID: "1", MC_RELAY_TOKEN: RELAY_TOKEN, MC_OF_TESTING: "1", RPC_84532: "http://127.0.0.1:1" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 80 && !(await fetch(`${API}/api/health`).then((r) => r.ok, () => false)); i++) await sleep(150);
  const db = new Database(`${dir}/t.db`);
  const sid = randomBytes(16).toString("hex");
  db.query("INSERT INTO sessions (id_hash, tenant_id, email, name, expires_at) VALUES (?, 'diamondz', 'qa@example.com', 'QA', ?)").run(createHash("sha256").update(sid).digest("hex"), Date.now() + 3_600_000);
  const asset = { name: "Harbor Lofts", symbol: "HARB", assetClass: "real-estate", standard: "erc7943", chainId: 84532, totalSupply: "10000", pricePerToken: "10", minInvestment: "100", status: "deployed", listed: true, description: "", imageUrl: "", location: "", schedule: "", lockup: "", deployment: { chainId: 84532, registry: "0x0000000000000000000000000000000000000001", token: "0x0000000000000000000000000000000000000002", sale: "0x0000000000000000000000000000000000000003", payToken: "0x0000000000000000000000000000000000000004", txs: [], deployedAt: new Date().toISOString() } };
  const t = new Date().toISOString();
  db.query("INSERT INTO assets (id, tenant_id, data, created_at, updated_at) VALUES ('ast_0123456789abcdef', 'diamondz', ?, ?, ?)").run(JSON.stringify(asset), t, t);
  const call = async (path: string, body?: unknown, admin = false) => {
    const r = await fetch(`${API}/api${path}`, { method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json", origin: API, ...(admin ? { cookie: `dt_session=${sid}` } : {}) } });
    return { status: r.status, body: (await r.json()) as any };
  };

  const ts = Math.floor(Date.now() / 1000);
  const msg = accreditationMessage({ assetId: "ast_0123456789abcdef", wallet: investor.address, route: "income", ts });
  const details = { assetId: "ast_0123456789abcdef", wallet: investor.address, route: "income", firstName: "Alex", lastName: "Morgan", birthday: "1984-03-12", state: "NY", email: "alex.morgan.e2e@example.com", consent: true, ts };

  // ---- 1. start: signature must match the wallet
  const forged = await call("/accreditation/start", { ...details, signature: await stranger.signMessage({ message: msg }) });
  check(forged.status === 401, "a request signed by a different wallet is refused");
  const noConsent = await call("/accreditation/start", { ...details, consent: false, signature: await investor.signMessage({ message: msg }) });
  check(noConsent.status === 400, "no written consent, no request");
  const st = await call("/accreditation/start", { ...details, signature: await investor.signMessage({ message: msg }) });
  if (st.status !== 200) console.log(st.body);
  check(st.status === 200 && /^acc_/.test(st.body.id) && st.body.link.startsWith("https://connect2.finicity.com/"), "request accepted: Mastercard Data Connect link returned");
  check(seen.consumer?.firstName === "Alex" && seen.consumer?.birthday?.year === 1984 && seen.consumer?.state === "NY", "identity details passed through to Mastercard");
  const id = st.body.id as string;

  // ---- 2. privacy: none of the identity details are stored
  db.close();
  // Scan every SQLite file (WAL mode keeps recent writes in -wal until a checkpoint).
  const raw = ["t.db", "t.db-wal", "t.db-shm"].map((f) => { try { return readFileSync(`${dir}/${f}`).toString("latin1"); } catch { return ""; } }).join("");
  check(!raw.includes("Alex") && !raw.includes("1984") && !raw.includes("alex.morgan.e2e"), "name, birthday and email are NOT in the database");

  // ---- 3. accounts linked → report → summary
  const wrong = await call(`/accreditation/${id}?wallet=${stranger.address}`);
  check(wrong.status === 404, "another wallet can't read the request");
  const linked = await call(`/accreditation/${id}/linked`, { wallet: investor.address });
  check(linked.status === 200 && linked.body.status === "reporting", "accounts linked: Mastercard report requested");
  const status = await call(`/accreditation/${id}?wallet=${investor.address}`);
  check(status.body.status === "ready" && status.body.decision === null, "investor sees the report is ready and waiting for the issuer");
  check(seen.reportPurpose === "1W", "report pulled under the consumer's written instruction (purpose 1W)");

  // ---- 4. issuer review
  const list = await call("/assets/ast_0123456789abcdef/accreditation", undefined, true);
  const s = list.body?.[0]?.summary;
  check(list.status === 200 && s?.incomeLast12 === 240_000 && s?.incomePrior12 === 240_000 && s?.monthsObserved === 24 && s?.reading === "meets", "summary: $240,000 / $240,000 over 24 months, low-confidence income excluded, meets the test");
  check(s?.accounts === 2 && s?.institutions === 1 && s?.incomeStreams === 1, "summary counts accounts, institutions and income streams");
  const anon = await call("/assets/ast_0123456789abcdef/accreditation");
  check(anon.status === 401, "only signed-in issuers can see requests");
  const rep = await call(`/accreditation/${id}/report`, undefined, true);
  check(rep.status === 200 && rep.body.owners?.[0] === "Alex Morgan" && rep.body.institutions?.[0]?.accounts?.[0]?.last4 === "1111", "issuer sees the account owner's name live from Mastercard (not stored)");
  const dec = await call(`/accreditation/${id}/decision`, { decision: "approve" }, true);
  check(dec.status === 200 && dec.body.decision === "approved" && dec.body.decidedBy === "qa@example.com", "issuer approves; decision and who made it are recorded");
  const after = await call(`/accreditation/${id}?wallet=${investor.address}`);
  check(after.body.decision === "approved", "investor sees the approval");
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  apiProc?.kill();
  relay.stop(true);
}
console.log(failed ? "\nE2E ACCREDIT: FAILED" : "\nE2E ACCREDIT: ALL PASS");
process.exit(failed ? 1 : 0);
