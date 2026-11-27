// Legal sign-off (L1–L4, 2026-11-20) against a throwaway API with a fake Stripe and a fake email service:
// company verified by Stripe Connect, lawyer invited only at an independent firm domain, the lawyer proves the inbox
// with a code, uploads a PDF and signs (issuer can't), Diamondz reviews with a license check, terms changes reset it,
// and only the platform can review.
//   bun scripts/e2e-legal.ts
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const PORT = 8978, FAKE = 8979;
const API = `http://127.0.0.1:${PORT}`;
let failed = false;
const check = (ok: boolean, l: string) => (console.log(`${ok ? "PASS" : "FAIL"}  ${l}`), ok || (failed = true));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mails: { to: string[]; subject: string; text: string }[] = [];
let verified = false;
const fake = Bun.serve({
  port: FAKE,
  async fetch(req) {
    const u = new URL(req.url);
    const j = (x: unknown, s = 200) => new Response(JSON.stringify(x), { status: s, headers: { "content-type": "application/json" } });
    if (u.pathname === "/emails") { const b = (await req.json()) as any; mails.push({ to: b.to, subject: b.subject, text: b.text }); return j({ id: "m1" }); }
    if (u.pathname === "/v1/accounts" && req.method === "POST") return j({ id: "acct_TEST1" });
    if (u.pathname === "/v1/account_links") return j({ url: "https://connect.stripe.com/setup/e/acct_TEST1/xyz" });
    if (u.pathname === "/v1/accounts/acct_TEST1") return j(verified
      ? { id: "acct_TEST1", details_submitted: true, requirements: { currently_due: [], past_due: [], disabled_reason: null }, capabilities: { transfers: "active" }, company: { name: "Harbor Private Credit Fund I LLC" } }
      : { id: "acct_TEST1", details_submitted: false, requirements: { currently_due: ["company.tax_id"], past_due: [] }, capabilities: { transfers: "inactive" } });
    return j({ error: { message: "fake: no route" } }, 404);
  },
});
let proc: ReturnType<typeof spawn> | null = null;
try {
  const dir = mkdtempSync(`${tmpdir()}/e2e-legal-`);
  proc = spawn("bun", ["src/server.ts"], {
    cwd: import.meta.dir + "/../../api",
    env: { ...process.env, STORE: "", MONGO_URI: "", PORT: String(PORT), DB_PATH: `${dir}/t.db`, EVIDENCE_DIR: `${dir}/ev`, DEFAULT_HOSTS: "127.0.0.1", ADMIN_DOMAINS: "example.com", BANK_PROOF_TICK: "0", TEMPORAL_JOBS: "", MFA_ENC_KEY: "",
      STRIPE_BASE: `http://127.0.0.1:${FAKE}`, STRIPE_AI_AGENT_KEY: "rk_test_agent", STRIPE_SECRET_KEY: "", RESEND_API_KEY: "re_test", NOTIFY_FROM: "Test <t@mail.example>", RESEND_API_URL: `http://127.0.0.1:${FAKE}/emails` },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 80 && !(await fetch(`${API}/api/health`).then((r) => r.ok, () => false)); i++) await sleep(150);
  const db = new Database(`${dir}/t.db`);
  const jar = new Map<string, string>();
  const call = async (who: string, method: string, path: string, body?: unknown, raw?: { body: Uint8Array; type: string }) => {
    const cookie = jar.get(who);
    const r = await fetch(`${API}/api${path}`, { method, body: raw ? raw.body : body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": raw?.type ?? "application/json", origin: API, ...(cookie ? { cookie } : {}) } });
    for (const sc of r.headers.getSetCookie?.() ?? []) { const m = /^(dt_session|dt_counsel)=([^;]+)/.exec(sc); if (m) jar.set(who, `${m[1]}=${m[2]}`); }
    const t = await r.text(); let jj: any = null; try { jj = JSON.parse(t); } catch { /* */ }
    return { status: r.status, body: jj };
  };
  const login = async (who: string, acct: ReturnType<typeof privateKeyToAccount>, email: string) => {
    const n = await call(who, "GET", "/auth/nonce");
    const message = n.body.message.replace("{address}", acct.address);
    return call(who, "POST", "/auth/thirdweb", { address: acct.address, chainId: 84532, nonce: n.body.nonce, issuedAt: n.body.issuedAt, signature: await acct.signMessage({ message }), email });
  };
  const owner = privateKeyToAccount(generatePrivateKey());
  await login("iss", owner, "owner@harborbank.com");
  await call("iss", "POST", "/workspaces", { name: "Harbor Private Bank" });
  const d = await call("iss", "POST", "/assets", { name: "Harbor Credit Note I", symbol: "HCN", assetClass: "private-credit", standard: "erc7943", chainId: 42161, totalSupply: "5000000", exemption: "506c" });
  const id = d.body?.id ?? d.body?.asset?.id;
  const L = `/assets/${id}/legal`;
  // platform reviewer = Google Workspace session on the platform tenant
  const psid = randomBytes(16).toString("hex");
  db.query("INSERT INTO sessions (id_hash, tenant_id, email, name, expires_at) VALUES (?, 'diamondz', 'yakini@example.com', 'Yakini', ?)").run(createHash("sha256").update(psid).digest("hex"), Date.now() + 3_600_000);
  jar.set("plat", `dt_session=${psid}`);

  const s0 = await call("iss", "GET", L);
  check(s0.status === 200 && s0.body.cleared === false && s0.body.company.status === "not started" && s0.body.reasons.length >= 2, "a new offering isn't cleared: company and lawyer both missing");
  const co = await call("iss", "POST", "/legal/company?back=/app", {});
  check(co.status === 200 && co.body.url.startsWith("https://connect.stripe.com/"), "issuer is sent to Stripe to verify the company");

  const inv = (email: string) => call("iss", "POST", `${L}/invite`, { name: "Dana Whitfield", firm: "Whitfield & Park LLP", email, barState: "NY", barNumber: "4821907" });
  check((await inv("dana@gmail.com")).status === 400, "a free email address is refused for the lawyer");
  check((await inv("counsel@harborbank.com")).status === 400, "an address on the issuer's own domain is refused");
  const okInv = await inv("dwhitfield@whitfieldpark.com");
  check(okInv.status === 200 && !JSON.stringify(okInv.body).includes("/counsel/"), "invite accepted; the link is NOT shown to the issuer");
  const m1 = mails.at(-1)!;
  check(m1.to[0] === "dwhitfield@whitfieldpark.com" && /\/counsel\/[A-Za-z0-9_-]+/.test(m1.text), "the link was emailed to the lawyer");
  const token = /\/counsel\/([A-Za-z0-9_-]+)/.exec(m1.text)![1]!;
  check(!JSON.stringify(db.query("SELECT data FROM docs").all()).includes(token), "the link token is stored only as a hash");

  const g0 = await call("law", "GET", `/counsel/${token}`);
  check(g0.status === 200 && g0.body.needsCode === true && !g0.body.offering && g0.body.email.startsWith("d•••@"), "opening the link alone shows nothing but a code prompt");
  check((await call("iss", "GET", `/counsel/${token}`)).body.needsCode === true, "the issuer can't open it either");
  await call("law", "POST", `/counsel/${token}/code`, {});
  const code = /(\d{6})/.exec(mails.at(-1)!.subject)![1]!;
  check(mails.at(-1)!.to[0] === "dwhitfield@whitfieldpark.com", "the code goes to the lawyer's inbox");
  check((await call("law", "POST", `/counsel/${token}/verify`, { code: code === "000000" ? "111111" : "000000" })).status === 400, "a wrong code is refused");
  check((await call("law", "POST", `/counsel/${token}/verify`, { code })).status === 200, "the right code opens the page");
  const g1 = await call("law", "GET", `/counsel/${token}`);
  check(g1.body.needsCode === false && g1.body.offering?.name === "Harbor Credit Note I" && g1.body.offering.exemption === "506c", "the lawyer sees the offering and its terms");
  check((await call("iss", "POST", `/counsel/${token}/sign`, { barState: "NY", barNumber: "4821907", statements: [true, true, true], name: "Dana Whitfield" })).status === 401, "the issuer can't sign for the lawyer");
  check((await call("law", "POST", `/counsel/${token}/sign`, { barState: "NY", barNumber: "4821907", statements: [true, true, true], name: "Dana Whitfield" })).status === 400, "signing needs the letter first");
  check((await call("law", "POST", `/counsel/${token}/letter`, undefined, { body: new TextEncoder().encode("not a pdf at all ".repeat(10)), type: "application/pdf" })).status === 400, "a non-PDF letter is refused");
  const pdf = new TextEncoder().encode("%PDF-1.7\n" + "x".repeat(400) + "\n%%EOF");
  check((await call("law", "POST", `/counsel/${token}/letter`, undefined, { body: pdf, type: "application/pdf" })).status === 200, "the signed PDF letter is uploaded");
  check((await call("law", "POST", `/counsel/${token}/sign`, { barState: "NY", barNumber: "4821907", statements: [true, true, false], name: "Dana Whitfield" })).status === 400, "all three statements must be confirmed");
  check((await call("law", "POST", `/counsel/${token}/sign`, { barState: "NY", barNumber: "4821907", statements: [true, true, true], name: "Someone Else" })).status === 400, "the typed name must be the invited lawyer's");
  check((await call("law", "POST", `/counsel/${token}/sign`, { barState: "NY", barNumber: "4821907", statements: [true, true, true], name: "dana whitfield" })).status === 200, "the lawyer signs");
  const s1 = await call("iss", "GET", L);
  check(s1.body.stage === "signed" && s1.body.cleared === false, "issuer sees it signed, still not cleared (company + review pending)");

  // platform review
  check((await call("iss", "GET", "/platform/reviews")).status === 404, "an issuer can't open the review queue");
  const q = await call("plat", "GET", "/platform/reviews");
  check(q.status === 200 && q.body.reviews.some((r: any) => r.assetId === id && r.emailDomainOk && r.termsMatch), "the platform reviewer sees it with the automatic checks");
  const lt = await fetch(`${API}/api/platform/reviews/${id}/letter`, { headers: { cookie: jar.get("plat")! } });
  check(lt.ok && lt.headers.get("content-type") === "application/pdf", "the reviewer can open the letter");
  check((await call("plat", "POST", `/platform/reviews/${id}`, { decision: "approve", licenseFound: false })).status === 400, "approval needs the license confirmed");
  check((await call("plat", "POST", `/platform/reviews/${id}`, { decision: "approve", licenseFound: true })).status === 409, "…and the company verified by Stripe");
  verified = true;
  check((await call("plat", "POST", `/platform/reviews/${id}`, { decision: "approve", licenseFound: true })).status === 200, "company verified + license found: approved");
  const s2 = await call("iss", "GET", L);
  check(s2.body.cleared === true && s2.body.stage === "approved" && s2.body.reasons.length === 0, "the offering is cleared for a real network");

  // terms change → no longer cleared
  await call("iss", "PATCH", `/assets/${id}`, { minInvestment: "25000" });
  const s3 = await call("iss", "GET", L);
  check(s3.body.cleared === false && s3.body.stage === "changed" && s3.body.reasons.some((r: string) => /terms changed/.test(r)), "changing the terms after sign-off un-clears it");
  check((await call("plat", "POST", `/platform/reviews/${id}`, { decision: "approve", licenseFound: true })).status === 409, "a changed offering can't be approved on the old signature");
} catch (e) { console.error(e); failed = true; } finally { proc?.kill(); fake.stop(true); }
console.log(failed ? "\nLEGAL: FAILURES" : "\nLEGAL: ALL PASS");
process.exit(failed ? 1 : 0);
