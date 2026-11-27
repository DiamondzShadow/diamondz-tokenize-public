// Contact-form inbox end to end against a throwaway API (own SQLite) and a MOCK Resend (never sends real email):
// the message is stored and an alert goes to the tenant's own recipients (platform tenant falls back to
// LEADS_NOTIFY_TO), reply-to is the visitor, header injection is neutralised, alert recipients stay private,
// the inbox is admin-only and per-tenant, read/archive/unarchive, and a failing mail provider never loses a message.
//   bun scripts/e2e-messages.ts
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";

const PORT_API = 8961, PORT_MAIL = 8962;
const API = `http://127.0.0.1:${PORT_API}`, API2 = `http://localhost:${PORT_API}`;
const KEY = "re_test_" + randomBytes(8).toString("hex");
let failed = false;
const check = (ok: boolean, l: string) => (console.log(`${ok ? "PASS" : "FAIL"}  ${l}`), ok || (failed = true));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- mock Resend: records every email; can be told to fail
const sent: any[] = [];
let mailDown = false;
const mail = Bun.serve({
  port: PORT_MAIL,
  async fetch(req) {
    if (req.headers.get("authorization") !== `Bearer ${KEY}`) return new Response("unauthorized", { status: 401 });
    if (mailDown) return new Response("boom", { status: 500 });
    sent.push(await req.json());
    return Response.json({ id: "email_" + sent.length });
  },
});
const waitMail = async (n: number) => { for (let i = 0; i < 40 && sent.length < n; i++) await sleep(50); return sent.length >= n; };

let apiProc: ReturnType<typeof spawn> | null = null;
try {
  const dir = mkdtempSync(`${tmpdir()}/e2e-messages-`);
  apiProc = spawn("bun", ["src/server.ts"], {
    cwd: import.meta.dir + "/../../api",
    env: { ...process.env, STORE: "", MONGO_URI: "", PORT: String(PORT_API), DB_PATH: `${dir}/t.db`, DEFAULT_HOSTS: "127.0.0.1", ADMIN_DOMAINS: "example.com", BANK_PROOF_TICK: "0", TEMPORAL_JOBS: "",
      RESEND_API_KEY: KEY, RESEND_API_URL: `http://127.0.0.1:${PORT_MAIL}/emails`, NOTIFY_FROM: "Tokenize <alerts@example.com>", LEADS_NOTIFY_TO: "ops@example.com, not-an-email" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 80 && !(await fetch(`${API}/api/health`).then((r) => r.ok, () => false)); i++) await sleep(150);
  const db = new Database(`${dir}/t.db`);
  const session = (tenant: string) => {
    const sid = randomBytes(16).toString("hex");
    db.query("INSERT INTO sessions (id_hash, tenant_id, email, name, expires_at) VALUES (?, ?, 'qa@example.com', 'QA', ?)").run(createHash("sha256").update(sid).digest("hex"), tenant, Date.now() + 3_600_000);
    return sid;
  };
  // a second tenant on its own host
  const cfg = JSON.parse((db.query("SELECT config FROM tenants WHERE id = 'diamondz'").get() as any).config);
  db.query("INSERT INTO tenants (id, config, admin_key_hash) VALUES ('acme', ?, 'disabled')").run(JSON.stringify({ ...cfg, name: "Acme Invest" }));
  db.query("INSERT INTO tenant_hosts (host, tenant_id) VALUES ('localhost', 'acme')").run();
  const sidD = session("diamondz"), sidA = session("acme");
  const call = async (base: string, method: string, path: string, body?: unknown, sid?: string) => {
    const r = await fetch(`${base}/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json", origin: base, ...(sid ? { cookie: `dt_session=${sid}` } : {}) } });
    const text = await r.text();
    return { status: r.status, body: JSON.parse(text) as any };
  };

  check((await call(API, "GET", "/messages")).status === 401, "inbox is admin-only");
  check((await call(API, "GET", "/messages/settings")).status === 401, "alert settings are admin-only");

  // 1. platform tenant with no recipients set → falls back to LEADS_NOTIFY_TO (invalid entries dropped)
  const lead = { name: "Ana\r\nBcc: evil@x.com", email: "ana@buyer.com", company: "Buyer LLC", message: "Hi <script>alert(1)</script>\nInterested in Harbor.", kind: "platform" };
  check((await call(API, "POST", "/leads", lead)).status === 200, "visitor sends a message");
  check(await waitMail(1), "an alert email goes out");
  const m1 = sent[0];
  check(JSON.stringify(m1?.to) === JSON.stringify(["ops@example.com"]), "platform tenant falls back to LEADS_NOTIFY_TO (bad entries ignored)");
  check(m1?.reply_to === "ana@buyer.com", "replying to the alert answers the visitor");
  check(!/[\r\n]/.test(m1?.subject ?? "\n") && m1?.subject.includes("Diamondz Tokenize"), "subject has no line breaks (no header injection) and names the site");
  check(!m1?.html.includes("<script>") && m1?.html.includes("&lt;script&gt;"), "message text is escaped in the email");
  check(m1?.html.includes(`/app/messages`), "email links to the console inbox");

  // 2. settings: recipients are private and per-tenant
  const st = await call(API, "GET", "/messages/settings", undefined, sidD);
  check(st.status === 200 && st.body.emailConfigured === true && st.body.platformFallback === true && st.body.notifyEmails.length === 0, "settings: email configured, platform fallback in use");
  check((await call(API, "PUT", "/messages/settings", { notifyEmails: ["x"] }, sidD)).status === 400, "invalid address refused");
  check((await call(API, "PUT", "/messages/settings", { notifyEmails: Array.from({ length: 6 }, (_, i) => `a${i}@x.com`) }, sidD)).status === 400, "more than 5 addresses refused");
  const put = await call(API, "PUT", "/messages/settings", { notifyEmails: ["Owner@Example.com", "owner@example.com", "team@example.com"] }, sidD);
  check(put.status === 200 && JSON.stringify(put.body.notifyEmails) === JSON.stringify(["owner@example.com", "team@example.com"]), "recipients saved (lower-cased, de-duplicated)");
  const pub = await call(API, "GET", "/tenant");
  check(pub.status === 200 && !("notifyEmails" in pub.body) && !JSON.stringify(pub.body).includes("owner@example.com"), "public tenant info never shows alert recipients");
  check((await call(API, "PATCH", "/tenant", { notifyEmails: ["hijack@x.com"] }, sidD)).status === 200 && (await call(API, "GET", "/messages/settings", undefined, sidD)).body.notifyEmails[0] === "owner@example.com", "branding PATCH can't change recipients");

  await call(API, "POST", "/leads", { name: "Ben", email: "ben@b.com", kind: "platform" });
  check(await waitMail(2) && JSON.stringify(sent[1].to) === JSON.stringify(["owner@example.com", "team@example.com"]), "next alert goes to the tenant's own recipients");

  // 3. other tenant: no recipients → no email, message still stored, inboxes separate
  await call(API2, "POST", "/leads", { name: "Cara", email: "cara@c.com", message: "acme lead", kind: "tenant:acme" });
  await sleep(300);
  check(sent.length === 2, "tenant without recipients: no email sent (and no fallback to the platform's)");
  const inA = await call(API2, "GET", "/messages", undefined, sidA);
  check(inA.status === 200 && inA.body.messages.length === 1 && inA.body.messages[0].name === "Cara" && inA.body.unread === 1, "tenant sees only its own message");
  const inD = await call(API, "GET", "/messages", undefined, sidD);
  check(inD.body.messages.length === 2 && inD.body.messages[0].name === "Ben" && inD.body.unread === 2 && !("ip" in inD.body.messages[0]), "platform inbox: 2 messages newest first, unread 2, visitor IP not exposed");
  check((await call(API2, "GET", "/messages", undefined, sidD)).status === 401, "a platform session can't open another tenant's inbox");
  const anaId = inD.body.messages[1].id, caraId = inA.body.messages[0].id;
  check((await call(API, "PATCH", `/messages/${caraId}`, { read: true }, sidD)).status === 404, "can't change another tenant's message");

  // 4. read / archive / unarchive
  check((await call(API, "PATCH", `/messages/${anaId}`, { read: true }, sidD)).status === 200 && (await call(API, "GET", "/messages/unread", undefined, sidD)).body.unread === 1, "mark read → unread 1");
  check((await call(API, "PATCH", `/messages/${anaId}`, { read: false }, sidD)).body.ok && (await call(API, "GET", "/messages/unread", undefined, sidD)).body.unread === 2, "mark unread → unread 2");
  await call(API, "PATCH", `/messages/${anaId}`, { archived: true }, sidD);
  const inbox = await call(API, "GET", "/messages", undefined, sidD), arch = await call(API, "GET", "/messages?archived=1", undefined, sidD);
  check(inbox.body.messages.length === 1 && arch.body.messages.length === 1 && arch.body.messages[0].name.startsWith("Ana") && inbox.body.unread === 1, "archived message moves to the archive and stops counting as unread");
  await call(API, "PATCH", `/messages/${anaId}`, { archived: false }, sidD);
  check((await call(API, "GET", "/messages", undefined, sidD)).body.messages.length === 2, "unarchive brings it back");
  check((await call(API, "PATCH", `/messages/${anaId}`, { nope: 1 }, sidD)).status === 200 && (await call(API, "PATCH", `/messages/${anaId}`, "x", sidD)).status === 400, "bad bodies don't change anything");

  // 5. plan-change requests land in the PLATFORM inbox, stay private, and can be cancelled
  check((await call(API2, "POST", "/billing/plan-request", { plan: "growth", annual: true })).status === 401, "plan request needs a signed-in admin");
  check((await call(API2, "POST", "/billing/plan-request", { plan: "launch", annual: false }, sidA)).status === 400, "requesting your current plan is refused");
  const pr = await call(API2, "POST", "/billing/plan-request", { plan: "growth", annual: true }, sidA);
  check(pr.status === 200 && pr.body.planRequest.plan === "growth" && pr.body.planRequest.annual === true, "tenant requests Growth, yearly");
  const platformInbox = await call(API, "GET", "/messages", undefined, sidD);
  const reqMsg = platformInbox.body.messages[0];
  check(reqMsg?.company === "Acme Invest" && /Launch → Growth, billed yearly/.test(reqMsg.message ?? ""), "request arrives in the platform's inbox with the details");
  check((await call(API2, "GET", "/messages", undefined, sidA)).body.messages.every((m: any) => !/Plan change/.test(m.message ?? "")), "it does not appear in the tenant's own inbox");
  check((await call(API2, "GET", "/billing/plan-request", undefined, sidA)).body.planRequest?.plan === "growth", "tenant sees its pending request");
  check(!("planRequest" in (await call(API2, "GET", "/tenant")).body), "pending request is not in public tenant info");
  const n1 = (await call(API, "GET", "/messages", undefined, sidD)).body.messages.length;
  await call(API2, "POST", "/billing/plan-request", { plan: "growth", annual: true }, sidA);
  check((await call(API, "GET", "/messages", undefined, sidD)).body.messages.length === n1, "repeating the same request doesn't spam the inbox");
  await call(API2, "PATCH", "/tenant", { planRequest: { plan: "whitelabel", annual: false, at: "x" } }, sidA);
  check((await call(API2, "GET", "/billing/plan-request", undefined, sidA)).body.planRequest?.plan === "growth", "branding PATCH can't change the request");
  check((await call(API2, "DELETE", "/billing/plan-request", undefined, sidA)).status === 200 && (await call(API2, "GET", "/billing/plan-request", undefined, sidA)).body.planRequest === null, "cancel clears it");

  // 6. mail provider down → message still stored, visitor still gets OK
  mailDown = true;
  const r = await call(API, "POST", "/leads", { name: "Dee", email: "dee@d.com", kind: "platform" });
  await sleep(300);
  check(r.status === 200 && (await call(API, "GET", "/messages", undefined, sidD)).body.messages[0].name === "Dee", "mail provider failing never loses the message");
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  apiProc?.kill();
  mail.stop(true);
}
console.log(failed ? "\nE2E MESSAGES: FAILED" : "\nE2E MESSAGES: ALL PASS");
process.exit(failed ? 1 : 0);
