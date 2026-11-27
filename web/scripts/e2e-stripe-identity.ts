// Stripe Identity as the investor identity check (when Sumsub isn't configured), against a Stripe TEST account.
//   STRIPE env from ~/.stripe-diamondz.env (sk_test_ only — refuses a live key)
//   bun scripts/e2e-stripe-identity.ts
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { statusFromSession, stripeSigOk } from "../../api/src/kyc";

const PORT = 8945;
const API = `http://127.0.0.1:${PORT}`;
let failed = false;
const check = (ok: boolean, l: string) => (console.log(`${ok ? "PASS" : "FAIL"}  ${l}`), ok || (failed = true));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const env0 = Object.fromEntries(readFileSync(`${homedir()}/.stripe-diamondz.env`, "utf8").split("\n").map((l) => l.match(/^(STRIPE_SECRET_KEY)=(.*)$/)).filter(Boolean).map((m) => [m![1], m![2]!.trim().replace(/^"|"$/g, "")]));
const SK = env0.STRIPE_SECRET_KEY ?? "";
if (!SK.startsWith("sk_test_")) throw new Error("needs a Stripe TEST key");
const WHSEC = `whsec_${randomBytes(16).toString("hex")}`;
const stripeGet = async (p: string) => (await fetch(`https://api.stripe.com${p}`, { headers: { authorization: `Bearer ${SK}` } })).json() as Promise<any>;
const stripePost = async (p: string) => (await fetch(`https://api.stripe.com${p}`, { method: "POST", headers: { authorization: `Bearer ${SK}` } })).json() as Promise<any>;

// ---- pure mapping (no network)
check(statusFromSession({ id: "vs_1", status: "verified", url: null, last_error: null }).status === "approved", "verified session → approved");
check(statusFromSession({ id: "vs_1", status: "processing", url: null, last_error: null }).status === "pending", "processing → pending");
const retry = statusFromSession({ id: "vs_1", status: "requires_input", url: "x", last_error: { code: "document_expired", reason: "The document is expired." } });
check(retry.status === "retry" && retry.user_comment === "The document is expired.", "failed attempt → retry with Stripe's reason");
check(statusFromSession({ id: "vs_1", status: "requires_input", url: "x", last_error: null }).status === "init", "not started yet → init");
check(statusFromSession({ id: "vs_1", status: "canceled", url: null, last_error: null }).status === "init", "canceled → init (a new session is made)");
const raw = Buffer.from('{"a":1}');
const t = Math.floor(Date.now() / 1000);
const sig = (secret: string, ts = t, body = raw) => `t=${ts},v1=${createHmac("sha256", secret).update(`${ts}.`).update(body).digest("hex")}`;
check(stripeSigOk(raw, sig(WHSEC), WHSEC), "webhook signature accepted");
check(!stripeSigOk(raw, sig("whsec_other"), WHSEC), "wrong secret rejected");
check(!stripeSigOk(raw, sig(WHSEC, t - 900), WHSEC), "stale timestamp rejected");
check(!stripeSigOk(Buffer.from('{"a":2}'), sig(WHSEC), WHSEC), "tampered body rejected");

// ---- live against the Stripe test account
const dir = mkdtempSync(`${tmpdir()}/e2e-sid-`);
const env = { PATH: process.env.PATH!, HOME: process.env.HOME!, STRIPE_SECRET_KEY: SK, STRIPE_IDENTITY_WEBHOOK_SECRET: WHSEC, PORT: String(PORT), DB_PATH: `${dir}/t.db`, EVIDENCE_DIR: `${dir}/ev`, DEFAULT_HOSTS: "127.0.0.1", ADMIN_DOMAINS: "example.com" };
const proc = spawn("bun", ["src/server.ts"], { cwd: import.meta.dir + "/../../api", env, stdio: ["ignore", "ignore", "inherit"] });
const sessions: string[] = [];
try {
  for (let i = 0; i < 100 && !(await fetch(`${API}/api/health`).then((r) => r.ok, () => false)); i++) await sleep(100);
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`${API}/api${path}`, { method: "POST", headers: { "content-type": "application/json", origin: API, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  };
  const cfg = await (await fetch(`${API}/api/kyc/config`)).json() as any;
  check(cfg.enabled && cfg.provider === "stripe" && cfg.testMode === true, `config: Stripe Identity, test mode (${JSON.stringify(cfg)})`);

  const acct = privateKeyToAccount(generatePrivateKey());
  const startBody = async () => {
    const ts = Math.floor(Date.now() / 1000);
    const message = `Diamondz Tokenize identity check\nIssuer: diamondz\nWallet: ${acct.address}\nTime: ${ts}`;
    return { wallet: acct.address, chainId: 84532, ts, signature: await acct.signMessage({ message }) };
  };
  const s1 = await post("/kyc/start", await startBody());
  check(s1.status === 200 && s1.body?.provider === "stripe" && /^https:\/\/verify\.stripe\.com\//.test(s1.body?.url ?? "") && s1.body?.status?.status === "init", `start: hosted Stripe check URL, status init (${s1.body?.error ?? ""})`);
  const id = s1.body.id as string;
  const db = new Database(`${dir}/t.db`);
  const vs1 = (db.query("SELECT applicant_id FROM kyc WHERE id = ?").get(id) as any)?.applicant_id as string;
  sessions.push(vs1);
  const live = await stripeGet(`/v1/identity/verification_sessions/${vs1}`);
  check(live.status === "requires_input" && live.metadata?.kyc_id === id && live.options?.document?.require_matching_selfie === true, "Stripe session has our check id and requires a selfie");
  const s2 = await post("/kyc/start", await startBody());
  check(s2.body?.id === id && (db.query("SELECT applicant_id FROM kyc WHERE id = ?").get(id) as any).applicant_id === vs1, "starting again reuses the open session");
  const bad = await post("/kyc/start", { ...(await startBody()), signature: "0x" + "11".repeat(65) });
  check(bad.status === 401, "a wrong wallet signature is refused");

  // webhook: signed delivery re-reads; unsigned refused
  const evt = JSON.stringify({ type: "identity.verification_session.processing", data: { object: { id: vs1, metadata: { kyc_id: id } } } });
  const wt = Math.floor(Date.now() / 1000);
  const goodSig = `t=${wt},v1=${createHmac("sha256", WHSEC).update(`${wt}.`).update(evt).digest("hex")}`;
  check((await post("/kyc/stripe-webhook", evt, { "stripe-signature": goodSig })).status === 200, "signed webhook accepted");
  check((await post("/kyc/stripe-webhook", evt, { "stripe-signature": `t=${wt},v1=${"00".repeat(32)}` })).status === 401, "unsigned webhook refused");
  const st = await (await fetch(`${API}/api/kyc/${id}?wallet=${acct.address}`)).json() as any;
  check(st.status === "init", "status re-read from Stripe (still waiting for the investor)");

  // a canceled session is replaced
  await stripePost(`/v1/identity/verification_sessions/${vs1}/cancel`);
  const s3 = await post("/kyc/start", await startBody());
  const vs2 = (db.query("SELECT applicant_id FROM kyc WHERE id = ?").get(id) as any).applicant_id as string;
  sessions.push(vs2);
  check(s3.status === 200 && vs2 !== vs1 && !!s3.body?.url, "a canceled session is replaced by a new one");
  // the issuer console labels Stripe test mode
  const sid = randomBytes(16).toString("hex");
  db.query("INSERT INTO sessions (id_hash, tenant_id, email, name, expires_at) VALUES (?, 'diamondz', 'qa@example.com', 'QA', ?)").run(createHash("sha256").update(sid).digest("hex"), Date.now() + 3_600_000);
  const list = await (await fetch(`${API}/api/kyc`, { headers: { cookie: `dt_session=${sid}` } })).json() as any;
  check(list.provider === "stripe" && list.sandbox === true && list.checks?.some((c: any) => c.id === id), "issuer console: Stripe, marked test mode, check listed");
} finally {
  for (const s of sessions) await stripePost(`/v1/identity/verification_sessions/${s}/cancel`).catch(() => {});
  proc.kill();
}
console.log(`\n${failed ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED"}`);
process.exit(failed ? 1 : 0);
