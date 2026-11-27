// Investor identity checks (Sumsub KYC) end to end against a throwaway API and a MOCK Sumsub that verifies our request
// signatures: wallet-signature gate, one check per (issuer, wallet), private status handle, webhook digest check
// (raw body), order-independent status from Sumsub's applicant record, retry message vs. silent final rejection,
// issuer list with live short names (never stored), tenant isolation, and "not configured" behaviour.
//   bun scripts/e2e-kyc.ts
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const PORT_API = 8965, PORT_SS = 8966, PORT_OFF = 8967;
const API = `http://127.0.0.1:${PORT_API}`, API2 = `http://localhost:${PORT_API}`;
const APP_TOKEN = "sbx:test-" + randomBytes(6).toString("hex"), SECRET = randomBytes(16).toString("hex"), HOOK = randomBytes(16).toString("hex");
let failed = false;
const check = (ok: boolean, l: string) => (console.log(`${ok ? "PASS" : "FAIL"}  ${l}`), ok || (failed = true));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- mock Sumsub: checks X-App-Access-Sig like the real API, serves configurable applicant states
type Rv = { reviewStatus: string; reviewResult?: any };
const applicants = new Map<string, { id: string; review: Rv; info: any }>(); // by externalUserId
let badSigs = 0, tokenCalls = 0;
const ss = Bun.serve({
  port: PORT_SS,
  async fetch(req) {
    const u = new URL(req.url);
    const pathQ = u.pathname + u.search;
    const body = req.method === "GET" ? "" : await req.text();
    const ts = req.headers.get("x-app-access-ts") ?? "";
    const want = createHmac("sha256", SECRET).update(ts + req.method + pathQ + body).digest("hex");
    if (req.headers.get("x-app-token") !== APP_TOKEN || req.headers.get("x-app-access-sig") !== want) { badSigs++; return Response.json({ code: 401 }, { status: 401 }); }
    if (req.method === "POST" && u.pathname === "/resources/accessTokens") {
      tokenCalls++;
      return Response.json({ token: `_act-sbx-${u.searchParams.get("userId")}-${u.searchParams.get("levelName")}`, userId: u.searchParams.get("userId") });
    }
    const byExt = /^\/resources\/applicants\/-;externalUserId=([^/]+)\/one$/.exec(u.pathname);
    if (byExt) { const a = applicants.get(decodeURIComponent(byExt[1]!)); return a ? Response.json(a) : Response.json({ code: 404 }, { status: 404 }); }
    const byId = /^\/resources\/applicants\/([^/]+)\/one$/.exec(u.pathname);
    if (byId) { const a = [...applicants.values()].find((x) => x.id === byId[1]); return a ? Response.json(a) : Response.json({ code: 404 }, { status: 404 }); }
    return Response.json({ code: 404 }, { status: 404 });
  },
});

const procs: ReturnType<typeof spawn>[] = [];
const startApi = (port: number, dir: string, withKeys: boolean) => {
  const p = spawn("bun", ["src/server.ts"], {
    cwd: import.meta.dir + "/../../api",
    env: { ...process.env, STORE: "", MONGO_URI: "", PORT: String(port), DB_PATH: `${dir}/t.db`, DEFAULT_HOSTS: "127.0.0.1", ADMIN_DOMAINS: "example.com", BANK_PROOF_TICK: "0", TEMPORAL_JOBS: "",
      SUMSUB_APP_TOKEN: withKeys ? APP_TOKEN : "", SUMSUB_SECRET_KEY: withKeys ? SECRET : "", SUMSUB_WEBHOOK_SECRET: withKeys ? HOOK : "", SUMSUB_BASE: `http://127.0.0.1:${PORT_SS}`, SUMSUB_LEVEL: "id-and-liveness" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  procs.push(p);
};
const up = async (base: string) => { for (let i = 0; i < 80 && !(await fetch(`${base}/api/health`).then((r) => r.ok, () => false)); i++) await sleep(150); };

try {
  const dir = mkdtempSync(`${tmpdir()}/e2e-kyc-`);
  startApi(PORT_API, dir, true);
  await up(API);
  const db = new Database(`${dir}/t.db`);
  const cfg = JSON.parse((db.query("SELECT config FROM tenants WHERE id = 'diamondz'").get() as any).config);
  db.query("INSERT INTO tenants (id, config, admin_key_hash) VALUES ('acme', ?, 'disabled')").run(JSON.stringify({ ...cfg, name: "Acme Invest" }));
  db.query("INSERT INTO tenant_hosts (host, tenant_id) VALUES ('localhost', 'acme')").run();
  const session = (tenant: string) => {
    const sid = randomBytes(16).toString("hex");
    db.query("INSERT INTO sessions (id_hash, tenant_id, email, name, expires_at) VALUES (?, ?, 'qa@example.com', 'QA', ?)").run(createHash("sha256").update(sid).digest("hex"), tenant, Date.now() + 3_600_000);
    return sid;
  };
  const sidD = session("diamondz");
  const call = async (base: string, method: string, path: string, body?: unknown, sid?: string, headers: Record<string, string> = {}) => {
    const r = await fetch(`${base}/api${path}`, { method, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", origin: base, ...(sid ? { cookie: `dt_session=${sid}` } : {}), ...headers } });
    const text = await r.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: r.status, body: json };
  };
  const msg = (tenantId: string, wallet: string, ts: number) => `Diamondz Tokenize identity check\nIssuer: ${tenantId}\nWallet: ${wallet}\nTime: ${ts}`;
  const investor = privateKeyToAccount(generatePrivateKey());
  const other = privateKeyToAccount(generatePrivateKey());
  const signed = async (acct: typeof investor, tenantId: string, ts = Math.floor(Date.now() / 1000)) => ({ wallet: acct.address, chainId: 84532, ts, signature: await acct.signMessage({ message: msg(tenantId, acct.address, ts) }) });
  const hook = (payload: object, secret = HOOK) => { const raw = JSON.stringify(payload); return { raw, headers: { "x-payload-digest": createHmac("sha256", secret).update(raw).digest("hex"), "x-payload-digest-alg": "HMAC_SHA256_HEX" } }; };
  const uid = (t: string, a: string) => `${t}:${a.toLowerCase()}`;

  check((await call(API, "GET", "/kyc/config")).body?.enabled === true, "config: enabled with keys");

  // 1. wallet signature gate
  const forged = { ...(await signed(other, "diamondz")), wallet: investor.address };
  check((await call(API, "POST", "/kyc/start", forged)).status === 401, "someone else's signature is refused");
  const old = await signed(investor, "diamondz", Math.floor(Date.now() / 1000) - 3600);
  check((await call(API, "POST", "/kyc/start", old)).status === 400, "an hour-old signature is refused");
  const wrongIssuer = await signed(investor, "acme");
  check((await call(API, "POST", "/kyc/start", wrongIssuer)).status === 401, "a signature for another issuer is refused");

  const s1 = await call(API, "POST", "/kyc/start", await signed(investor, "diamondz"));
  const kid = s1.body?.id;
  check(s1.status === 200 && /^kyc_[0-9a-f]{24}$/.test(kid ?? "") && s1.body.token === `_act-sbx-${uid("diamondz", investor.address)}-id-and-liveness` && s1.body.status.status === "init", "start: private id + Sumsub token for diamondz:<wallet> at the id-and-liveness level");
  check(badSigs === 0, "every request to Sumsub carried a valid signature");
  const s1b = await call(API, "POST", "/kyc/start", await signed(investor, "diamondz"));
  check(s1b.body?.id === kid, "starting again reuses the same check (no duplicate applicant)");

  // 2. status needs the private id AND the wallet
  check((await call(API, "GET", `/kyc/${kid}?wallet=${other.address}`)).status === 404, "status with the wrong wallet: not found");
  check((await call(API, "GET", `/kyc/kyc_${"0".repeat(24)}?wallet=${investor.address}`)).status === 404, "status with a guessed id: not found");
  check((await call(API2, "GET", `/kyc/${kid}?wallet=${investor.address}`)).status === 404, "status from another issuer's site: not found");
  check((await call(API, "POST", `/kyc/${kid}/token`, { wallet: investor.address })).body?.token?.startsWith("_act-sbx-"), "SDK token refresh with id + wallet");
  check((await call(API, "POST", `/kyc/${kid}/token`, { wallet: other.address })).status === 404, "token refresh for another wallet is refused");

  // 3. webhook: digest over the raw body, then status re-read from Sumsub (order-independent)
  applicants.set(uid("diamondz", investor.address), { id: "app_1", review: { reviewStatus: "pending" }, info: { firstName: "Jordan", lastName: "Ellis", country: "USA" } });
  const evt = { type: "applicantReviewed", externalUserId: uid("diamondz", investor.address), reviewResult: { reviewAnswer: "GREEN" } };
  const forgedHook = hook(evt, "wrong-secret");
  check((await call(API, "POST", "/kyc/webhook", forgedHook.raw, undefined, forgedHook.headers)).status === 401, "webhook with a bad digest is refused");
  const h1 = hook(evt);
  check((await call(API, "POST", "/kyc/webhook", h1.raw, undefined, h1.headers)).status === 200, "signed webhook accepted");
  check((await call(API, "GET", `/kyc/${kid}?wallet=${investor.address}`)).body?.status === "pending", "a GREEN webhook body doesn't approve anyone: Sumsub's record still says pending");
  applicants.get(uid("diamondz", investor.address))!.review = { reviewStatus: "completed", reviewResult: { reviewAnswer: "RED", reviewRejectType: "RETRY", rejectLabels: ["BAD_PHOTO"], moderationComment: "The photo of your document is blurry." } };
  const h2 = hook({ type: "applicantReviewed", externalUserId: uid("diamondz", investor.address) });
  await call(API, "POST", "/kyc/webhook", h2.raw, undefined, h2.headers);
  const st2 = (await call(API, "GET", `/kyc/${kid}?wallet=${investor.address}`)).body;
  check(st2?.status === "retry" && st2.message === "The photo of your document is blurry.", "retry: investor sees Sumsub's message");
  applicants.get(uid("diamondz", investor.address))!.review = { reviewStatus: "completed", reviewResult: { reviewAnswer: "GREEN" } };
  const h3 = hook({ type: "applicantReviewed", externalUserId: uid("diamondz", investor.address) }, HOOK);
  await call(API, "POST", "/kyc/webhook", h3.raw, undefined, { ...h3.headers });
  check((await call(API, "GET", `/kyc/${kid}?wallet=${investor.address}`)).body?.status === "approved", "approved after Sumsub's record turns GREEN");
  const h4 = hook({ type: "applicantReviewed", externalUserId: "someone-else:abc" });
  check((await call(API, "POST", "/kyc/webhook", h4.raw, undefined, h4.headers)).status === 200, "webhook for a user that isn't ours is ignored (200, no retries)");

  // 4. final rejection hides the reason from the investor
  const s2 = await call(API, "POST", "/kyc/start", await signed(other, "diamondz"));
  applicants.set(uid("diamondz", other.address), { id: "app_2", review: { reviewStatus: "completed", reviewResult: { reviewAnswer: "RED", reviewRejectType: "FINAL", rejectLabels: ["FORGERY"], moderationComment: "secret detail" } }, info: { firstName: "Mo", lastName: "Reed", country: "USA" } });
  const h5 = hook({ type: "applicantReviewed", externalUserId: uid("diamondz", other.address) });
  await call(API, "POST", "/kyc/webhook", h5.raw, undefined, h5.headers);
  const st5 = (await call(API, "GET", `/kyc/${s2.body.id}?wallet=${other.address}`)).body;
  check(st5?.status === "rejected" && st5.message === null, "final rejection: no reason shown to the investor");

  // 5. issuer list: admin-only, per tenant, live short names never stored
  check((await call(API, "GET", "/kyc")).status === 401, "issuer list needs a signed-in admin");
  const list = (await call(API, "GET", "/kyc", undefined, sidD)).body;
  const mine = list?.checks?.find((x: any) => x.wallet === investor.address), rej = list?.checks?.find((x: any) => x.wallet === other.address);
  check(list?.checks?.length === 2 && mine?.status === "approved" && mine.name === "Jordan E." && mine.country === "USA", "issuer sees status + live 'Jordan E.' + country");
  check(JSON.stringify(rej?.rejectLabels) === '["FORGERY"]', "issuer sees the reject labels");
  const stored = JSON.stringify(db.query("SELECT * FROM kyc").all());
  check(!/Jordan|Ellis|Reed|secret detail/.test(stored), "no names or private comments in the database");
  const sidA = session("acme");
  check((await call(API2, "GET", "/kyc", undefined, sidA)).body?.checks?.length === 0, "another issuer sees none of these checks");
  const a1 = await call(API2, "POST", "/kyc/start", await signed(investor, "acme"));
  check(a1.status === 200 && a1.body.id !== kid && a1.body.status.status === "init", "same wallet with another issuer: a separate check");

  // 5b. stage 2: on the platform site, a check started from a self-serve workspace's offering belongs to that issuer
  const t1 = new Date().toISOString();
  db.query("INSERT INTO tenants (id, config, admin_key_hash) VALUES ('ws_00000000abcd', ?, 'disabled')").run(JSON.stringify({ ...cfg, name: "Harbor Partners", adminDomains: [] }));
  db.query("INSERT INTO assets (id, tenant_id, data, created_at, updated_at) VALUES ('ast_000000000000ws01', 'ws_00000000abcd', ?, ?, ?)").run(JSON.stringify({ name: "Harbor Lofts", symbol: "HRB", assetClass: "real-estate", standard: "erc7943", chainId: 84532, totalSupply: "1000", status: "deployed", listed: true, deployment: { chainId: 84532, token: "0x0000000000000000000000000000000000000001", sale: "0x0000000000000000000000000000000000000002", txs: [], deployedAt: t1 } }), t1, t1);
  const third = privateKeyToAccount(generatePrivateKey());
  const ws1 = await call(API, "POST", "/kyc/start", { ...(await signed(third, "ws_00000000abcd")), assetId: "ast_000000000000ws01" });
  check(ws1.status === 200 && (db.query("SELECT tenant_id FROM kyc WHERE id = ?").get(ws1.body.id) as any)?.tenant_id === "ws_00000000abcd", "check started from Harbor's offering is filed under Harbor, not the website");
  check(ws1.body?.token === `_act-sbx-${uid("ws_00000000abcd", third.address)}-id-and-liveness`, "Sumsub knows the investor as ws_…:<wallet>");
  check((await call(API, "GET", `/kyc/${ws1.body.id}?wallet=${third.address}`)).body?.status === "init", "status readable on the platform site");
  check((await call(API2, "GET", `/kyc/${ws1.body.id}?wallet=${third.address}`)).status === 404, "…but not through a white-label domain");
  check((await call(API, "POST", "/kyc/start", { ...(await signed(third, "diamondz")), assetId: "ast_000000000000ws01" })).status === 401, "signing for the website instead of the offering's issuer is refused");
  check(!(await call(API, "GET", "/kyc", undefined, sidD)).body.checks.some((x: any) => x.wallet === third.address), "the platform's console doesn't list Harbor's investor");

  // 6. not configured
  const dir2 = mkdtempSync(`${tmpdir()}/e2e-kyc-off-`);
  startApi(PORT_OFF, dir2, false);
  const OFF = `http://127.0.0.1:${PORT_OFF}`;
  await up(OFF);
  check((await call(OFF, "GET", "/kyc/config")).body?.enabled === false, "without keys: config says disabled");
  check((await call(OFF, "POST", "/kyc/start", await signed(investor, "diamondz"))).status === 503, "without keys: start explains it isn't set up");
  check((await call(OFF, "POST", "/kyc/webhook", "{}", undefined, { "x-payload-digest": "00" })).status === 503, "without a webhook secret: webhook refused");
  check(badSigs === 0, `no bad signatures reached Sumsub (${tokenCalls} token calls)`);
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  procs.forEach((p) => p.kill());
  ss.stop(true);
}
console.log(failed ? "\nE2E KYC: FAILED" : "\nE2E KYC: ALL PASS");
process.exit(failed ? 1 : 0);
