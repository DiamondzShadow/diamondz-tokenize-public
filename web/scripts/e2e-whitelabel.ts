// White-label site setup, end to end (designs W1–W6): stand-in Cloudflare (custom hostnames) + Resend (domains,
// emails) and a throwaway API + database. No real DNS: WL_TEST_ASSUME_DNS=1 treats records as found.
//   bun scripts/e2e-whitelabel.ts
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const PORT = 8985, FAKE = 8986;
const API = `http://127.0.0.1:${PORT}`, FAKE_URL = `http://127.0.0.1:${FAKE}`;
const TOKEN = "t".repeat(40);
let failed = false;
const check = (ok: boolean, l: string) => (console.log(`${ok ? "PASS" : "FAIL"}  ${l}`), ok || (failed = true));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (b: string) => createHash("sha256").update(b).digest("hex");

const hostnames = new Map<string, { id: string; hostname: string; status: string; ssl: { status: string } }>();
const mails: { from: string; to: string[]; subject: string; reply_to?: string }[] = [];
let resendVerified = false;
const dns: any[] = [];
let fallback: { origin: string; status: string } | null = null;
const fake = Bun.serve({
  port: FAKE,
  async fetch(req) {
    const u = new URL(req.url);
    const j = (x: unknown, s = 200) => new Response(JSON.stringify(x), { status: s, headers: { "content-type": "application/json" } });
    // ---- Resend
    if (u.pathname === "/emails") { const b = (await req.json()) as any; mails.push({ from: b.from, to: b.to, subject: b.subject, reply_to: b.reply_to }); return j({ id: "m1" }); }
    if (u.pathname === "/domains" && req.method === "POST") {
      const b = (await req.json()) as any;
      return j({ id: "dom_1", name: b.name, status: "not_started", records: [
        { record: "DKIM", type: "TXT", name: `resend._domainkey`, value: "p=MIGf", status: "not_started" },
        { record: "SPF", type: "MX", name: "send", value: "feedback-smtp.example", priority: 10, status: "not_started" },
        { record: "SPF", type: "TXT", name: "send", value: "v=spf1 include:example ~all", status: "not_started" },
      ] });
    }
    if (u.pathname === "/domains/dom_1/verify") return j({ object: "domain", id: "dom_1" });
    if (u.pathname === "/domains/dom_1") return j({ id: "dom_1", status: resendVerified ? "verified" : "pending", records: [{ type: "TXT", name: "resend._domainkey", value: "p=MIGf", status: resendVerified ? "verified" : "pending" }, { type: "MX", name: "send", value: "feedback-smtp.example", priority: 10, status: resendVerified ? "verified" : "pending" }, { type: "TXT", name: "send", value: "v=spf1 include:example ~all", status: resendVerified ? "verified" : "pending" }] });
    // ---- Cloudflare
    if (req.headers.get("authorization") !== "Bearer cf-test-token") return j({ success: false, errors: [{ message: "auth" }] }, 403);
    const base = "/client/v4/zones/zone1";
    if (u.pathname === `${base}/custom_hostnames` && req.method === "POST") {
      const b = (await req.json()) as any;
      if ([...hostnames.values()].some((h) => h.hostname === b.hostname)) return j({ success: false, errors: [{ message: "Duplicate custom hostname found." }] }, 409);
      const h = { id: `ch_${randomBytes(3).toString("hex")}`, hostname: b.hostname, status: "pending", ssl: { status: "pending_validation" } };
      hostnames.set(h.id, h);
      return j({ success: true, result: { ...h, ownership_verification: { type: "txt", name: `_cf-custom-hostname.${b.hostname}`, value: "uuid-1234" } } });
    }
    const m = /^\/client\/v4\/zones\/zone1\/custom_hostnames\/(ch_[0-9a-f]+)$/.exec(u.pathname);
    if (m) {
      const h = hostnames.get(m[1]!);
      if (!h) return j({ success: false, errors: [{ message: "not found" }] }, 404);
      if (req.method === "DELETE") { hostnames.delete(h.id); return j({ success: true, result: { id: h.id } }); }
      return j({ success: true, result: { ...h, ownership_verification: { type: "txt", name: `_cf-custom-hostname.${h.hostname}`, value: "uuid-1234" } } });
    }
    if (u.pathname === `${base}/dns_records` && req.method === "GET") {
      const name = u.searchParams.get("name");
      return j({ success: true, result: name === "tokenize.diamondz.one" ? [{ type: "A", name, content: "203.0.113.7" }] : dns.filter((r) => r.name === name) });
    }
    if (u.pathname === `${base}/dns_records` && req.method === "POST") { const b = (await req.json()) as any; dns.push(b); return j({ success: true, result: b }); }
    if (u.pathname === `${base}/custom_hostnames/fallback_origin`) {
      if (req.method === "PUT") { fallback = { origin: ((await req.json()) as any).origin, status: "active" }; }
      return fallback ? j({ success: true, result: fallback }) : j({ success: false, errors: [{ message: "not set" }] }, 404);
    }
    return j({ success: false, errors: [{ message: "fake: no route" }] }, 404);
  },
});

let proc: ReturnType<typeof spawn> | null = null;
try {
  const dir = mkdtempSync(`${tmpdir()}/e2e-wl-`);
  proc = spawn("bun", ["src/server.ts"], {
    cwd: import.meta.dir + "/../../api",
    env: { ...process.env, STORE: "", MONGO_URI: "", PORT: String(PORT), DB_PATH: `${dir}/t.db`, EVIDENCE_DIR: `${dir}/ev`, DEFAULT_HOSTS: "127.0.0.1", ADMIN_DOMAINS: "example.com", BANK_PROOF_TICK: "0", TEMPORAL_JOBS: "", MFA_ENC_KEY: "",
      RESEND_API_KEY: "re_test", NOTIFY_FROM: "Diamondz Tokenize <notify@mail.example>", RESEND_API_URL: `${FAKE_URL}/emails`, RESEND_API_BASE: FAKE_URL,
      CF_API_TOKEN: "cf-test-token", CF_ZONE_ID: "zone1", CF_API: `${FAKE_URL}/client/v4`, WL_TEST_ASSUME_DNS: "1", INTERNAL_JOB_TOKEN: TOKEN,
      ADOBE_SIGN_INTEGRATION_KEY: "", LOG_INDEX_NO_PERSIST: "1", STRIPE_AI_AGENT_KEY: "", STRIPE_SECRET_KEY: "" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 80 && !(await fetch(`${API}/api/health`).then((r) => r.ok, () => false)); i++) await sleep(150);
  const db = new Database(`${dir}/t.db`);
  const jar = new Map<string, string>();
  const call = async (who: string, method: string, path: string, body?: unknown, host?: string, raw?: Uint8Array) => {
    const cookie = jar.get(who);
    const r = await fetch(`${API}/api${path}`, { method, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), headers: { "content-type": raw ? "application/pdf" : "application/json", origin: API, ...(cookie ? { cookie } : {}), ...(host ? { host } : {}) } });
    for (const sc of r.headers.getSetCookie?.() ?? []) { const mm = /^(dt_session)=([^;]+)/.exec(sc); if (mm) jar.set(who, `${mm[1]}=${mm[2]}`); }
    const t = await r.text(); let jj: any = null; try { jj = JSON.parse(t); } catch { jj = t; }
    return { status: r.status, body: jj };
  };
  const owner = privateKeyToAccount(generatePrivateKey());
  const n = await call("iss", "GET", "/auth/nonce");
  await call("iss", "POST", "/auth/thirdweb", { address: owner.address, chainId: 84532, nonce: n.body.nonce, issuedAt: n.body.issuedAt, signature: await owner.signMessage({ message: n.body.message.replace("{address}", owner.address) }), email: "owner@harborprivate.com" });
  const ws = await call("iss", "POST", "/workspaces", { name: "Harbor Private Bank" });
  const tid = ws.body?.id ?? ws.body?.workspace?.id ?? (db.query("SELECT id FROM tenants WHERE id LIKE 'ws_%'").get() as any).id;
  const psid = randomBytes(16).toString("hex");
  db.query("INSERT INTO sessions (id_hash, tenant_id, email, name, expires_at) VALUES (?, 'diamondz', 'admin@example.com', 'Admin', ?)").run(sha(psid), Date.now() + 3_600_000);
  jar.set("plat", `dt_session=${psid}`);

  const g0 = await call("iss", "GET", "/whitelabel");
  check(g0.status === 200 && g0.body.whitelabel === false, "a workspace on another plan sees the upgrade page");
  check((await call("iss", "POST", "/whitelabel/domain", { domain: "invest.harborprivate.com" })).status === 402, "domain setup is refused without the White-label plan");
  const row = db.query("SELECT config FROM tenants WHERE id = ?").get(tid) as { config: string };
  db.query("UPDATE tenants SET config = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(row.config), plan: "whitelabel" }), tid);
  const g1 = await call("iss", "GET", "/whitelabel");
  check(g1.body.whitelabel === true && g1.body.cfConnected === true && g1.body.total === 7 && g1.body.steps.identity === true && g1.body.ready === false, "White-label plan: checklist of 7 steps, nothing ready to go live");

  // ---- domain
  check((await call("iss", "POST", "/whitelabel/domain", { domain: "harborprivate.com" })).status === 400, "a bare apex domain is refused (use a subdomain)");
  check((await call("iss", "POST", "/whitelabel/domain", { domain: "x.tokenize.diamondz.one" })).status === 400, "platform domains are refused");
  const d1 = await call("iss", "POST", "/whitelabel/domain", { domain: "https://Invest.HarborPrivate.com/" });
  check(d1.status === 200 && d1.body.domain?.name === "invest.harborprivate.com" && d1.body.domain.cname.value === "sites.tokenize.diamondz.one" && d1.body.domain.txt?.name === "_cf-custom-hostname.invest.harborprivate.com", "domain connected: CNAME to sites.tokenize.diamondz.one + Cloudflare's ownership TXT");
  check([...hostnames.values()].some((h) => h.hostname === "invest.harborprivate.com"), "Cloudflare custom hostname created");
  const t1 = await call("anon", "GET", "/tenant", undefined, "invest.harborprivate.com");
  check(t1.status === 200 && t1.body.id === tid && t1.body.site?.live === false && t1.body.site.customDomain === "invest.harborprivate.com", "the custom domain serves this workspace's site, not live yet");
  check((await call("anon", "GET", "/tenant", undefined, "127.0.0.1")).body.site?.live === true, "the platform site is unaffected");
  check(g1.body.preview === null && !!(await call("iss", "GET", "/whitelabel")).body.preview, "a private preview link exists once the domain is connected");
  const pv = (await call("iss", "GET", "/whitelabel")).body.preview as string;
  const key = new URL(pv).searchParams.get("preview")!;
  check((await call("anon", "GET", `/site/preview?k=${key}`, undefined, "invest.harborprivate.com")).body.ok === true && (await call("anon", "GET", `/site/preview?k=${"x".repeat(key.length)}`, undefined, "invest.harborprivate.com")).body.ok === false, "the preview key opens the site; a wrong one doesn't");

  // second workspace can't take the same domain
  const other = privateKeyToAccount(generatePrivateKey());
  const n2 = await call("o", "GET", "/auth/nonce");
  await call("o", "POST", "/auth/thirdweb", { address: other.address, chainId: 84532, nonce: n2.body.nonce, issuedAt: n2.body.issuedAt, signature: await other.signMessage({ message: n2.body.message.replace("{address}", other.address) }), email: "x@other.com" });
  await call("o", "POST", "/workspaces", { name: "Other Co" });
  const tid2 = (db.query("SELECT id FROM tenants WHERE id LIKE 'ws_%' AND id != ?").get(tid) as any).id;
  const r2 = db.query("SELECT config FROM tenants WHERE id = ?").get(tid2) as { config: string };
  db.query("UPDATE tenants SET config = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(r2.config), plan: "whitelabel" }), tid2);
  check((await call("o", "POST", "/whitelabel/domain", { domain: "invest.harborprivate.com" })).status === 409, "another workspace can't claim a connected domain");

  // nginx sync list
  check((await call("anon", "GET", "/internal/custom-hosts", undefined, "127.0.0.1")).status === 404, "the nginx host list needs the internal token");
  const hl = await fetch(`${API}/api/internal/custom-hosts`, { headers: { "x-job-token": TOKEN } });
  check(hl.ok && (await hl.text()).trim() === "invest.harborprivate.com", "nginx host list = the registered custom domains");
  const hl2 = await fetch(`${API}/api/internal/custom-hosts`, { headers: { "x-job-token": TOKEN, "x-forwarded-for": "1.2.3.4" } });
  check(hl2.status !== 200 && !(await hl2.text()).includes("harborprivate"), "the host list is unreachable through the proxy");

  // certificate goes active
  for (const h of hostnames.values()) { h.status = "active"; h.ssl.status = "active"; }
  const c1 = await call("iss", "POST", "/whitelabel/check");
  check(c1.body.steps.domain === true && c1.body.domain.cname.found && c1.body.domain.txt.found && c1.body.domain.answers, "check: DNS found, ownership verified, certificate active, site answers");

  // ---- email
  const e1 = await call("iss", "POST", "/whitelabel/email", { name: "Harbor Private Bank", address: "notify@invest.harborprivate.com", replyTo: "investors@harborprivate.com" });
  check(e1.status === 200 && e1.body.email.records.length === 3 && e1.body.email.status !== "verified", "email: three DNS records to add");
  check((await call("iss", "POST", "/whitelabel/email/test")).status === 409, "no test email before the domain verifies");
  resendVerified = true;
  const e2 = await call("iss", "POST", "/whitelabel/email/verify");
  check(e2.body.steps.email === true && e2.body.email.records.every((r: any) => r.status === "verified"), "email verified");
  const te = await call("iss", "POST", "/whitelabel/email/test");
  check(te.status === 200 && mails.at(-1)!.from === "Harbor Private Bank <notify@invest.harborprivate.com>" && mails.at(-1)!.reply_to === "investors@harborprivate.com" && mails.at(-1)!.to[0] === "owner@harborprivate.com", "test email goes out from the customer's address with their reply-to");
  check((await call("iss", "POST", "/whitelabel/email", { name: "X", address: "notify@diamondz.one" })).status === 400, "a platform address can't be used as the sender");

  // lawyer invite uses the customer's sender
  const a = await call("iss", "POST", "/assets", { name: "Harbor Credit Note", symbol: "HCN", assetClass: "private-credit", standard: "erc7943", chainId: 42161, totalSupply: "1000", exemption: "506c" });
  const aid = a.body?.id ?? a.body?.asset?.id;
  await call("iss", "POST", `/assets/${aid}/legal/invite`, { name: "Dana Whitfield", firm: "Whitfield & Park LLP", email: "dwhitfield@whitfieldpark.com", barState: "NY", barNumber: "4821907" });
  check(mails.at(-1)!.to[0] === "dwhitfield@whitfieldpark.com" && mails.at(-1)!.from.includes("notify@invest.harborprivate.com"), "lawyer invitations come from the customer's address");

  // ---- legal pages
  const l0 = await call("iss", "GET", "/whitelabel/legal");
  check(l0.body.pages.map((p: any) => p.slug).join(",") === "terms,privacy,risk", "terms, privacy and risk pages start empty");
  await call("iss", "PUT", "/whitelabel/legal/terms", { title: "Terms of use", text: "## 1. Who we are\nHarbor Private Bank operates this site." });
  check((await call("anon", "GET", "/site/legal/terms", undefined, "invest.harborprivate.com")).status === 404, "a draft isn't public");
  check((await call("iss", "POST", "/whitelabel/legal/terms/publish")).status === 200, "terms published");
  await call("iss", "PUT", "/whitelabel/legal/terms", { title: "Terms of use", text: "## 1. Who we are\nHarbor Private Bank, version 2." });
  await call("iss", "POST", "/whitelabel/legal/terms/publish");
  const lp = await call("anon", "GET", "/site/legal/terms", undefined, "invest.harborprivate.com");
  check(lp.status === 200 && lp.body.text.includes("version 2"), "the customer's domain serves the published terms");
  check((await call("iss", "GET", "/whitelabel/legal")).body.pages.find((p: any) => p.slug === "terms").versions.length === 1, "the earlier version is kept");
  check((await call("anon", "GET", "/site/legal/terms", undefined, "127.0.0.1")).status === 404, "the platform site keeps its own terms");
  const pdf = new TextEncoder().encode("%PDF-1.7\n" + "privacy ".repeat(40) + "\n%%EOF");
  check((await call("iss", "POST", "/whitelabel/legal/privacy/pdf", undefined, undefined, pdf)).status === 200, "privacy policy uploaded as a PDF");
  const pp = await fetch(`${API}/api/site/legal/privacy/pdf`, { headers: { host: "invest.harborprivate.com" } });
  check(pp.ok && pp.headers.get("content-type") === "application/pdf", "the PDF is served on the customer's domain");
  const t2 = await call("anon", "GET", "/tenant", undefined, "invest.harborprivate.com");
  check(t2.body.site.legal.map((p: any) => p.slug).sort().join(",") === "privacy,terms", "the site lists the customer's legal pages");

  // ---- go live
  const st = await call("iss", "GET", "/whitelabel");
  check(st.body.ready === true, "domain, email and legal pages ready");
  check((await call("iss", "POST", "/whitelabel/live", { live: true })).body.live?.at != null, "owner takes the site live");
  check((await call("anon", "GET", "/tenant", undefined, "invest.harborprivate.com")).body.site.live === true, "the custom domain is now public");

  // ---- platform admin
  check((await call("iss", "GET", "/platform/whitelabel")).status === 403, "an issuer can't open the white-label admin");
  const pa = await call("plat", "GET", "/platform/whitelabel");
  const mine = pa.body.sites?.find((s: any) => s.tenantId === tid);
  check(pa.status === 200 && mine?.name === "Harbor Private Bank" && mine.steps.domain && mine.live, "admin sees the customer, their domain and that it's live");
  const su = await call("plat", "POST", "/platform/whitelabel/setup");
  check(su.status === 200 && dns.some((r) => r.name === "sites.tokenize.diamondz.one" && r.content === "203.0.113.7" && r.proxied) && fallback?.origin === "sites.tokenize.diamondz.one", "setup creates sites.tokenize.diamondz.one (proxied, same origin) and sets it as the fallback origin");

  // ---- disconnect
  const rm = await call("iss", "DELETE", "/whitelabel/domain");
  check(rm.status === 200 && rm.body.domain === null && hostnames.size === 0, "disconnect removes the Cloudflare hostname");
  check((await call("anon", "GET", "/tenant", undefined, "invest.harborprivate.com")).status === 404, "the domain no longer resolves to the workspace");
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  proc?.kill();
  fake.stop(true);
}
console.log(failed ? "\nE2E WHITELABEL: FAILED" : "\nE2E WHITELABEL: ALL PASS");
process.exit(failed ? 1 : 0);
