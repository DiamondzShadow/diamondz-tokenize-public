// Lawyer sign-off through Adobe Acrobat Sign, end to end (design E6). Stand-in Adobe + Stripe + email server and a
// throwaway API + database; no chain needed. The typed-name path (no Adobe key) stays covered by e2e-legal.ts.
//   bun scripts/e2e-counsel-adobe.ts
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const PORT = 8983, FAKE = 8984;
const API = `http://127.0.0.1:${PORT}`, FAKE_URL = `http://127.0.0.1:${FAKE}`;
let failed = false;
const check = (ok: boolean, l: string) => (console.log(`${ok ? "PASS" : "FAIL"}  ${l}`), ok || (failed = true));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const mails: { to: string[]; subject: string; text: string }[] = [];
const docs = new Map<string, Uint8Array>();
const agreements = new Map<string, { body: any; status: string }>();
const SIGNED = new TextEncoder().encode("%PDF-1.4\ncounsel sign-off, signed in Adobe\n%%EOF\n");
const AUDIT = new TextEncoder().encode("%PDF-1.4\naudit: GOV_ID verified, e-signed\n%%EOF\n");

const fake = Bun.serve({
  port: FAKE,
  async fetch(req) {
    const u = new URL(req.url);
    const j = (x: unknown, s = 200) => new Response(JSON.stringify(x), { status: s, headers: { "content-type": "application/json" } });
    if (u.pathname === "/emails") { const b = (await req.json()) as any; mails.push({ to: b.to, subject: b.subject, text: b.text }); return j({ id: "m1" }); }
    if (u.pathname === "/v1/accounts" && req.method === "POST") return j({ id: "acct_TEST1" });
    if (u.pathname === "/v1/accounts/acct_TEST1") return j({ id: "acct_TEST1", details_submitted: true, requirements: { currently_due: [], past_due: [], disabled_reason: null }, capabilities: { transfers: "active" }, company: { name: "Harbor Private Credit Fund I LLC" } });
    if (!u.pathname.startsWith("/api/rest/v6")) return j({ error: { message: "fake: no route" } }, 404);
    if (req.headers.get("authorization") !== "Bearer test-integration-key") return j({ code: "INVALID_ACCESS_TOKEN" }, 401);
    const p = u.pathname.replace(/^\/api\/rest\/v6/, "");
    if (p === "/baseUris") return j({ apiAccessPoint: `${FAKE_URL}/` });
    if (p === "/transientDocuments") { const f = (await req.formData()).get("File") as File; const id = `td_${randomBytes(3).toString("hex")}`; docs.set(id, new Uint8Array(await f.arrayBuffer())); return j({ transientDocumentId: id }, 201); }
    if (p === "/agreements" && req.method === "POST") { const id = `CBJCHBCAABAA${randomBytes(6).toString("hex")}`; agreements.set(id, { body: await req.json(), status: "OUT_FOR_SIGNATURE" }); return j({ id }, 201); }
    const m = /^\/agreements\/([^/]+)(\/.*)?$/.exec(p);
    const ag = m ? agreements.get(m[1]!) : undefined;
    if (!m || !ag) return j({ code: "INVALID_AGREEMENT_ID" }, 404);
    const sub = m[2] ?? "";
    if (sub === "") return j({ id: m[1], status: ag.status });
    if (sub === "/signingUrls") return ag.status === "OUT_FOR_SIGNATURE" ? j({ signingUrlSetInfos: [{ signingUrls: [{ esignUrl: `https://secure.na1.adobesign.com/public/apiesign?pid=${m[1]}` }] }] }) : j({ code: "AGREEMENT_NOT_SIGNABLE" }, 400);
    if (sub === "/state") { ag.status = ((await req.json()) as any).state; return j({}); }
    if (sub === "/members") return j({ participantSets: [{ status: "WAITING_FOR_MY_SIGNATURE", memberInfos: [{ id: "pm_1" }] }] });
    if (sub === "/reminders") return j({ id: "r1" }, 201);
    if (sub.startsWith("/combinedDocument")) return new Response(SIGNED);
    if (sub === "/auditTrail") return new Response(AUDIT);
    return j({ code: "NOT_FOUND" }, 404);
  },
});

let proc: ReturnType<typeof spawn> | null = null;
try {
  const dir = mkdtempSync(`${tmpdir()}/e2e-counsel-adobe-`);
  proc = spawn("bun", ["src/server.ts"], {
    cwd: import.meta.dir + "/../../api",
    env: { ...process.env, STORE: "", MONGO_URI: "", PORT: String(PORT), DB_PATH: `${dir}/t.db`, EVIDENCE_DIR: `${dir}/ev`, DEFAULT_HOSTS: "127.0.0.1", ADMIN_DOMAINS: "example.com", BANK_PROOF_TICK: "0", TEMPORAL_JOBS: "", MFA_ENC_KEY: "",
      STRIPE_BASE: FAKE_URL, STRIPE_AI_AGENT_KEY: "rk_test_agent", STRIPE_SECRET_KEY: "", RESEND_API_KEY: "re_test", NOTIFY_FROM: "Test <t@mail.example>", RESEND_API_URL: `${FAKE_URL}/emails`,
      ADOBE_SIGN_INTEGRATION_KEY: "test-integration-key", ADOBE_SIGN_API: FAKE_URL, ESIGN_ATTESTER_KEY: "", LOG_INDEX_NO_PERSIST: "1" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 80 && !(await fetch(`${API}/api/health`).then((r) => r.ok, () => false)); i++) await sleep(150);
  const db = new Database(`${dir}/t.db`);
  const jar = new Map<string, string>();
  const call = async (who: string, method: string, path: string, body?: unknown, raw?: { body: Uint8Array; type: string }) => {
    const cookie = jar.get(who);
    const r = await fetch(`${API}/api${path}`, { method, body: raw ? raw.body : body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": raw?.type ?? "application/json", origin: API, ...(cookie ? { cookie } : {}) } });
    for (const sc of r.headers.getSetCookie?.() ?? []) { const mm = /^(dt_session|dt_counsel)=([^;]+)/.exec(sc); if (mm) jar.set(who, `${mm[1]}=${mm[2]}`); }
    const t = await r.text(); let jj: any = null; try { jj = JSON.parse(t); } catch { /* */ }
    return { status: r.status, body: jj };
  };
  const owner = privateKeyToAccount(generatePrivateKey());
  const n = await call("iss", "GET", "/auth/nonce");
  await call("iss", "POST", "/auth/thirdweb", { address: owner.address, chainId: 84532, nonce: n.body.nonce, issuedAt: n.body.issuedAt, signature: await owner.signMessage({ message: n.body.message.replace("{address}", owner.address) }), email: "owner@harborbank.com" });
  await call("iss", "POST", "/workspaces", { name: "Harbor Private Bank" });
  const d = await call("iss", "POST", "/assets", { name: "Harbor Credit Note I", symbol: "HCN", assetClass: "private-credit", standard: "erc7943", chainId: 42161, totalSupply: "5000000", exemption: "506c" });
  const id = d.body?.id ?? d.body?.asset?.id;
  const L = `/assets/${id}/legal`;
  const psid = randomBytes(16).toString("hex");
  db.query("INSERT INTO sessions (id_hash, tenant_id, email, name, expires_at) VALUES (?, 'diamondz', 'admin@example.com', 'Admin', ?)").run(sha(psid), Date.now() + 3_600_000);
  jar.set("plat", `dt_session=${psid}`);
  await call("iss", "POST", "/legal/company?back=/app", {});

  const s0 = await call("iss", "GET", L);
  check(s0.body.adobeConnected === true && s0.body.adobe === null, "issuer sees that sign-off goes through Adobe");
  check((await call("iss", "POST", `${L}/invite`, { name: "Dana Whitfield", firm: "Whitfield & Park LLP", email: "dwhitfield@whitfieldpark.com", barState: "NY", barNumber: "4821907" })).status === 200, "issuer invites the lawyer (same private link + code as before)");
  const token = /\/counsel\/([A-Za-z0-9_-]+)/.exec(mails.at(-1)!.text)![1]!;
  await call("law", "POST", `/counsel/${token}/code`, {});
  const code = /(\d{6})/.exec(mails.at(-1)!.subject)![1]!;
  await call("law", "POST", `/counsel/${token}/verify`, { code });
  const g1 = await call("law", "GET", `/counsel/${token}`);
  check(g1.body.adobe?.connected === true && g1.body.adobe.waiting === false, "lawyer's page knows the sign-off happens in Adobe");
  const opinion = new TextEncoder().encode("%PDF-1.7\n" + "opinion ".repeat(60) + "\n%%EOF");
  await call("law", "POST", `/counsel/${token}/letter`, undefined, { body: opinion, type: "application/pdf" });
  const signBody = { barState: "NY", barNumber: "4821907", statements: [true, true, true], name: "Dana Whitfield" };
  check((await call("iss", "POST", `/counsel/${token}/sign`, signBody)).status === 401, "the issuer can't start the lawyer's sign-off");
  check((await call("law", "POST", `/counsel/${token}/sign`, { ...signBody, name: "Someone Else" })).status === 400, "typed name must still match the invited lawyer");
  const sg = await call("law", "POST", `/counsel/${token}/sign`, signBody);
  check(sg.status === 200 && sg.body.adobe === true && String(sg.body.url).startsWith("https://secure.na1.adobesign.com/"), "Sign off → Adobe agreement created, lawyer sent straight to Adobe");
  const [agr, ag] = [...agreements.entries()].at(-1)!;
  const mem = ag.body.participantSetsInfo[0].memberInfos[0];
  check(mem.email === "dwhitfield@whitfieldpark.com" && mem.securityOption.authenticationMethod === "GOV_ID" && ag.body.externalId.id === `legal:${id}`, "agreement goes to the invited lawyer with a government-ID check");
  const pdf = new TextDecoder("latin1").decode(docs.get(ag.body.fileInfos[0].transientDocumentId)!);
  check(pdf.includes(sha(opinion)) && pdf.includes("Rule 506\\(c\\)") && pdf.includes("In my opinion the offering may proceed") && pdf.includes("{{Sig_es_:signer1:signature}}") && pdf.includes("NY 4821907"), "sign-off letter carries the terms, the opinion's fingerprint, the 3 statements and the bar number");
  const s1 = await call("iss", "GET", L);
  check(s1.body.stage === "opened" && s1.body.adobe?.status === "out" && s1.body.cleared === false, "issuer sees it out for signature in Adobe; nothing is signed yet");
  const again = await call("law", "POST", `/counsel/${token}/sign`, signBody);
  check(again.status === 200 && agreements.size === 1, "pressing Sign off again reuses the same Adobe request");
  check((await call("law", "GET", `/counsel/${token}`)).body.adobe.waiting === true, "lawyer's page shows 'Open Adobe to sign'");
  check((await call("law", "POST", `/counsel/${token}/adobe`)).status === 200, "lawyer can reopen Adobe's signing page");
  check((await call("iss", "POST", `${L}/remind`)).status === 200 && (await call("iss", "POST", `${L}/remind`)).status === 429, "issuer can remind once a day");

  const hook = (event: string) => fetch(`${API}/api/esign/adobe/webhook`, { method: "POST", headers: { "content-type": "application/json", "X-AdobeSign-ClientId": "c1" }, body: JSON.stringify({ event, agreement: { id: agr } }) });
  await hook("AGREEMENT_WORKFLOW_COMPLETED");
  await sleep(600);
  check((await call("iss", "GET", L)).body.stage === "opened", "a webhook saying 'signed' is ignored while Adobe's API says out for signature");
  await hook("AGREEMENT_WEB_IDENTITY_AUTHENTICATED");
  await sleep(600);
  check(!!(await call("iss", "GET", L)).body.adobe.identityAt, "identity event: issuer's timeline shows identity confirmed");
  ag.status = "SIGNED";
  await hook("AGREEMENT_WORKFLOW_COMPLETED");
  let s2: any = null;
  for (let i = 0; i < 30; i++) { s2 = (await call("iss", "GET", L)).body; if (s2.stage === "signed") break; await sleep(200); }
  check(s2.stage === "signed" && s2.counsel.via === "adobe" && s2.adobe.status === "signed" && !!s2.counsel.signedAt, "signed in Adobe → sign-off recorded, waiting for Diamondz review");
  check((await call("law", "GET", `/counsel/${token}`)).body.signed?.via === "adobe", "lawyer's page shows it signed in Adobe");

  const q = await call("plat", "GET", "/platform/reviews");
  const rv = q.body.reviews.find((r: any) => r.assetId === id);
  check(!!rv?.adobe && rv.termsMatch, "platform review shows the Adobe sign-off");
  const so = await fetch(`${API}${rv.adobe.signoff}`, { headers: { cookie: jar.get("plat")! } });
  const au = await fetch(`${API}${rv.adobe.audit}`, { headers: { cookie: jar.get("plat")! } });
  check(so.ok && au.ok && sha(new Uint8Array(await so.arrayBuffer())) === sha(SIGNED) && sha(new Uint8Array(await au.arrayBuffer())) === sha(AUDIT), "reviewer opens Adobe's signed sign-off and audit report");
  check((await fetch(`${API}${rv.adobe.signoff}`, { headers: { cookie: jar.get("iss")! } })).status === 404, "the issuer can't open the reviewer's copies");
  check((await call("plat", "POST", `/platform/reviews/${id}`, { decision: "approve", licenseFound: true, note: "" })).status === 200, "reviewer approves");
  check((await call("iss", "GET", L)).body.cleared === true, "offering is cleared for a real network");
  const row = db.query("SELECT data FROM assets WHERE id = ?").get(id) as { data: string };
  db.query("UPDATE assets SET data = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(row.data), pricePerToken: "2" }), id);
  check((await call("iss", "GET", L)).body.stage === "changed", "changing the terms after the Adobe sign-off asks the lawyer again");
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  proc?.kill();
  fake.stop(true);
}
console.log(failed ? "\nE2E COUNSEL ADOBE: FAILED" : "\nE2E COUNSEL ADOBE: ALL PASS");
process.exit(failed ? 1 : 0);
