// SEC Form D lookup end to end against a MOCK sec-api.io (never spends real calls): issuer-only search, query
// sanitising, caching, per-tenant daily limit, platform-wide budget, attach only what the search returned, drafts keep
// the filing through edits, the public listing shows it, detach.
//   bun scripts/e2e-edgar.ts
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";

const PORT_API = 8957, PORT_SEC = 8958;
const API = `http://127.0.0.1:${PORT_API}`;
const KEY = randomBytes(32).toString("hex");
let failed = false;
const check = (ok: boolean, l: string) => (console.log(`${ok ? "PASS" : "FAIL"}  ${l}`), ok || (failed = true));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- mock sec-api.io MCP: records every tool call
const seen: { tool: string; query: string }[] = [];
const filing = (acc: string, form: string, filedAt: string) => ({
  submissionType: form, accessionNo: acc, filedAt,
  primaryIssuer: { cik: "0002088554", entityName: "Harbor Lofts SPV, LLC", entityType: "Limited Liability Company", jurisdictionOfInc: "DELAWARE", yearOfInc: { value: "2026" }, issuerAddress: { city: "MIAMI", stateOrCountry: "FL" } },
  offeringData: {
    industryGroup: { industryGroupType: "Residential" }, federalExemptionsExclusions: { item: ["06c", "3C.1"] },
    typeOfFiling: { dateOfFirstSale: { value: "2026-09-01" } }, durationOfOffering: { moreThanOneYear: false },
    minimumInvestmentAccepted: 25000, offeringSalesAmounts: { totalOfferingAmount: -1, totalAmountSold: 1250000, totalRemaining: -1 },
    investors: { hasNonAccreditedInvestors: false, totalNumberAlreadyInvested: 14 },
  },
});
const sec = Bun.serve({
  port: PORT_SEC,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.searchParams.get("apiKey") !== KEY) return new Response("unauthorized", { status: 401 });
    if (!(req.headers.get("accept") ?? "").includes("text/event-stream")) return Response.json({ jsonrpc: "2.0", error: { code: -32000, message: "Not Acceptable" }, id: null });
    const msg = (await req.json()) as any;
    const { name, arguments: args } = msg.params;
    seen.push({ tool: name, query: args.query });
    const offerings = [filing("0002088554-26-000002", "D/A", "2026-10-01T09:00:00-04:00"), filing("0002088554-26-000001", "D", "2026-09-10T09:00:00-04:00"), { accessionNo: "junk" }];
    // answer as SSE, like the real server can
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify({ total: { value: 2 }, offerings }) }], isError: false } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  },
});

let apiProc: ReturnType<typeof spawn> | null = null;
try {
  const dir = mkdtempSync(`${tmpdir()}/e2e-edgar-`);
  apiProc = spawn("bun", ["src/server.ts"], {
    cwd: import.meta.dir + "/../../api",
    env: { ...process.env, STORE: "", MONGO_URI: "", PORT: String(PORT_API), DB_PATH: `${dir}/t.db`, DEFAULT_HOSTS: "127.0.0.1", ADMIN_DOMAINS: "example.com", BANK_PROOF_TICK: "0", TEMPORAL_JOBS: "", SEC_API_KEY: KEY, SEC_API_URL: `http://127.0.0.1:${PORT_SEC}/mcp`, SEC_API_MAX_CALLS: "3", SEC_API_TENANT_DAILY: "2" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 80 && !(await fetch(`${API}/api/health`).then((r) => r.ok, () => false)); i++) await sleep(150);
  const db = new Database(`${dir}/t.db`);
  const sid = randomBytes(16).toString("hex");
  db.query("INSERT INTO sessions (id_hash, tenant_id, email, name, expires_at) VALUES (?, 'diamondz', 'qa@example.com', 'QA', ?)").run(createHash("sha256").update(sid).digest("hex"), Date.now() + 3_600_000);
  const t = new Date().toISOString();
  const base = { symbol: "HARB", assetClass: "real-estate", standard: "erc7943", chainId: 84532, totalSupply: "10000", pricePerToken: "10", minInvestment: "0", description: "", imageUrl: "", location: "", schedule: "", lockup: "" };
  db.query("INSERT INTO assets (id, tenant_id, data, created_at, updated_at) VALUES ('ast_00000000000000d1', 'diamondz', ?, ?, ?)").run(JSON.stringify({ ...base, name: "Harbor Draft", status: "draft", listed: false }), t, t);
  db.query("INSERT INTO assets (id, tenant_id, data, created_at, updated_at) VALUES ('ast_00000000000000d2', 'diamondz', ?, ?, ?)").run(JSON.stringify({ ...base, name: "Harbor Lofts", status: "deployed", listed: true, deployment: { chainId: 84532, token: "0x0000000000000000000000000000000000000001", sale: "0x0000000000000000000000000000000000000002", txs: [], deployedAt: t } }), t, t);
  const call = async (method: string, path: string, body?: unknown, admin = true) => {
    const r = await fetch(`${API}/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json", origin: API, ...(admin ? { cookie: `dt_session=${sid}` } : {}) } });
    const text = await r.text();
    return { status: r.status, body: JSON.parse(text) as any, text };
  };
  const D1 = "/assets/ast_00000000000000d1", D2 = "/assets/ast_00000000000000d2";

  check((await call("POST", `${D1}/formd/search`, { query: "Harbor Lofts SPV" }, false)).status === 401, "only signed-in issuers can search the SEC (protects the call budget)");
  const st = await call("GET", "/edgar/status");
  check(st.status === 200 && st.body.enabled && st.body.callsUsed === 0 && st.body.callsMax === 3 && st.body.searchesLeftToday === 2, "status: enabled, 0 of 3 calls used, 2 searches left today");
  check((await call("POST", `${D1}/formd/search`, { query: "ab" })).status === 400 && seen.length === 0, "a too-short name is refused without spending a call");

  const s1 = await call("POST", `${D1}/formd/search`, { query: "Harbor Lofts SPV" });
  const f = s1.body.results?.[0];
  check(s1.status === 200 && s1.body.cached === false && s1.body.results.length === 2 && s1.body.searchesLeftToday === 1, "search returns the filings (malformed record dropped); 1 search left today");
  check(seen[0]?.tool === "form-d" && seen[0].query === 'primaryIssuer.entityName:"Harbor Lofts SPV"', "query sent as an exact issuer-name phrase");
  check(f?.form === "D/A" && f.cik === "0002088554" && f.exemptions.map((e: any) => e.label).join() === "Rule 506(c),Investment Company Act §3(c)(1)", "form, CIK and exemptions (506(c), 3(c)(1)) mapped");
  check(f?.totalOfferingAmount === null && f.totalRemaining === null && f.totalAmountSold === 1250000 && f.minimumInvestment === 25000 && f.investors === 14, "amounts mapped; -1 (indefinite) becomes null");
  check(f?.url === "https://www.sec.gov/Archives/edgar/data/2088554/000208855426000002/0002088554-26-000002-index.htm", "links to the filing on sec.gov");
  check(!s1.text.includes(KEY), "the API key never reaches the browser");

  const s2 = await call("POST", `${D1}/formd/search`, { query: "  harbor   lofts spv " });
  check(s2.body.cached === true && seen.length === 1, "same name again (any spacing/case) is served from cache — no call");

  await call("POST", `${D1}/formd/search`, { query: 'Harbor" OR primaryIssuer.cik:* (x)' });
  check(seen[1]?.query === 'primaryIssuer.entityName:"Harbor OR primaryIssuer.cik x"', "Lucene operators are stripped from the name (no query injection)");

  const lim = await call("POST", `${D1}/formd/search`, { query: "2088554" });
  check(lim.status === 429 && seen.length === 2, "tenant's daily limit (2) reached: refused before calling");
  check((await call("GET", "/edgar/status")).body.callsUsed === 2, "a refused search doesn't count against the platform budget");

  db.query("DELETE FROM counters WHERE key LIKE 'secapi:tenant:%'").run();
  const cik = await call("POST", `${D1}/formd/search`, { query: "2088554" });
  check(cik.status === 200 && seen[2]?.query === 'primaryIssuer.cik:"0002088554"', "search by CIK (zero-padded)");
  db.query("DELETE FROM counters WHERE key LIKE 'secapi:tenant:%'").run();
  const cap = await call("POST", `${D1}/formd/search`, { query: "Another Issuer LLC" });
  check(cap.status === 503 && /allowance is used up/.test(cap.body.error) && seen.length === 3, "platform budget (3) used up: new searches paused, no call");
  check((await call("POST", `${D1}/formd/search`, { query: "Harbor Lofts SPV" })).body.cached === true, "cached results still work after the budget is spent");

  check((await call("POST", `${D1}/formd`, { accessionNo: "0009999999-26-000001" })).status === 400, "can't attach a filing the search didn't return");
  check((await call("POST", `${D1}/formd`, { accessionNo: "nope" })).status === 400, "malformed accession number refused");
  const at = await call("POST", `${D1}/formd`, { accessionNo: "0002088554-26-000002" });
  check(at.status === 200 && at.body.formD?.accessionNo === "0002088554-26-000002" && !!at.body.formD.attachedAt, "issuer attaches the latest amendment to the draft");
  const pt = await call("PATCH", D1, { description: "Updated" });
  check(pt.status === 200 && pt.body.description === "Updated" && pt.body.formD?.accessionNo === "0002088554-26-000002", "editing the draft keeps the attached filing");
  check((await call("PATCH", D1, { formD: { accessionNo: "forged" } })).body.formD?.accessionNo === "0002088554-26-000002", "the filing can't be overwritten through a normal edit");

  await call("POST", `${D2}/formd`, { accessionNo: "0002088554-26-000001" });
  const pub = await call("GET", "/market/ast_00000000000000d2", undefined, false);
  check(pub.status === 200 && pub.body.formD?.form === "D" && pub.body.formD.exemptions[0].label === "Rule 506(c)", "public listing shows the filing (read from the offering — no call)");
  const det = await call("DELETE", `${D2}/formd`);
  check(det.status === 200 && det.body.formD === undefined, "issuer can detach it");
  check((await call("GET", "/market/ast_00000000000000d2", undefined, false)).body.formD === undefined, "detached filing no longer public");
  check(seen.length === 3, `mock received exactly 3 calls in total (${seen.length})`);
  // ================= phase 2: SEC EDGAR (free) as the main source, sec-api.io only as fallback =================
  const UA = "Tokenize Test qa@example.com";
  const secSeen: { path: string; ua: string | null }[] = [];
  let secDown = false;
  const formDXml = (form: string, sold: number) => `<?xml version="1.0"?><edgarSubmission><schemaVersion>X0708</schemaVersion><submissionType>${form}</submissionType>
    <primaryIssuer><cik>0001234567</cik><entityName>Harbor Lofts SPV, LLC</entityName><issuerAddress><city>MIAMI BEACH</city><stateOrCountry>FL</stateOrCountry></issuerAddress>
    <jurisdictionOfInc>DELAWARE</jurisdictionOfInc><entityType>Limited Liability Company</entityType><yearOfInc><value>2026</value></yearOfInc></primaryIssuer>
    <offeringData><industryGroup><industryGroupType>Residential</industryGroupType></industryGroup><federalExemptionsExclusions><item>06c</item></federalExemptionsExclusions>
    <typeOfFiling><dateOfFirstSale><value>2026-09-01</value></dateOfFirstSale></typeOfFiling><minimumInvestmentAccepted>25000</minimumInvestmentAccepted>
    <offeringSalesAmounts><totalOfferingAmount>Indefinite</totalOfferingAmount><totalAmountSold>${sold}</totalAmountSold><totalRemaining>Indefinite</totalRemaining></offeringSalesAmounts>
    <investors><hasNonAccreditedInvestors>false</hasNonAccreditedInvestors><totalNumberAlreadyInvested>9</totalNumberAlreadyInvested></investors></offeringData></edgarSubmission>`;
  const secMock = Bun.serve({
    port: 8960,
    fetch(req) {
      const u = new URL(req.url);
      secSeen.push({ path: u.pathname + u.search, ua: req.headers.get("user-agent") });
      if (secDown) return new Response("busy", { status: 503 });
      if (u.pathname === "/efts") return Response.json({ hits: { hits: [
        { _id: "0001234567-26-000001:primary_doc.xml", _source: { adsh: "0001234567-26-000001", ciks: ["0001234567"], file_date: "2026-09-10", form: "D", display_names: ["Harbor Lofts SPV, LLC  (CIK 0001234567)"] } },
        { _id: "0001234567-26-000003:primary_doc.xml", _source: { adsh: "0001234567-26-000003", ciks: ["0001234567"], file_date: "2026-10-01", form: "D/A", display_names: ["Harbor Lofts SPV, LLC  (CIK 0001234567)"] } },
        { _id: "0009999999-26-000001:primary_doc.xml", _source: { adsh: "0009999999-26-000001", ciks: ["0009999999"], file_date: "2026-10-05", form: "D", display_names: ["Unrelated Fund LP  (CIK 0009999999)"] } },
      ] } });
      if (u.pathname === "/data/submissions/CIK0001234567.json") return Response.json({ name: "Harbor Lofts SPV, LLC", filings: { recent: {
        form: ["D/A", "10-K", "D"], accessionNumber: ["0001234567-26-000003", "0001234567-26-000002", "0001234567-26-000001"], filingDate: ["2026-10-01", "2026-09-20", "2026-09-10"] } } });
      if (u.pathname === "/arch/edgar/data/1234567/000123456726000003/primary_doc.xml") return new Response(formDXml("D/A", 900000), { headers: { "content-type": "text/xml" } });
      if (u.pathname === "/arch/edgar/data/1234567/000123456726000001/primary_doc.xml") return new Response(formDXml("D", 300000), { headers: { "content-type": "text/xml" } });
      return new Response("not found", { status: 404 });
    },
  });
  const api2 = spawn("bun", ["src/server.ts"], {
    cwd: import.meta.dir + "/../../api",
    env: { ...process.env, STORE: "", MONGO_URI: "", PORT: "8959", DB_PATH: `${dir}/t2.db`, DEFAULT_HOSTS: "127.0.0.1", ADMIN_DOMAINS: "example.com", BANK_PROOF_TICK: "0", TEMPORAL_JOBS: "",
      SEC_EDGAR_UA: UA, SEC_EFTS_URL: "http://127.0.0.1:8960/efts", SEC_DATA_URL: "http://127.0.0.1:8960/data", SEC_ARCHIVES_URL: "http://127.0.0.1:8960/arch",
      SEC_API_KEY: KEY, SEC_API_URL: `http://127.0.0.1:${PORT_SEC}/mcp`, SEC_API_MAX_CALLS: "10", SEC_API_TENANT_DAILY: "10" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  try {
    const API2 = "http://127.0.0.1:8959";
    for (let i = 0; i < 80 && !(await fetch(`${API2}/api/health`).then((r) => r.ok, () => false)); i++) await sleep(150);
    const db2 = new Database(`${dir}/t2.db`);
    db2.query("INSERT INTO sessions (id_hash, tenant_id, email, name, expires_at) VALUES (?, 'diamondz', 'qa@example.com', 'QA', ?)").run(createHash("sha256").update(sid).digest("hex"), Date.now() + 3_600_000);
    db2.query("INSERT INTO assets (id, tenant_id, data, created_at, updated_at) VALUES ('ast_00000000000000d1', 'diamondz', ?, ?, ?)").run(JSON.stringify({ ...base, name: "Harbor Draft", status: "draft", listed: false }), t, t);
    const call2 = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`${API2}/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json", origin: API2, cookie: `dt_session=${sid}` } });
      return { status: r.status, body: (await r.json()) as any };
    };
    const paidBefore = seen.length;
    const st2 = await call2("GET", "/edgar/status");
    check(st2.body.provider === "SEC EDGAR" && st2.body.fallback === "sec-api.io" && st2.body.searchesLeftToday === null, "status: SEC EDGAR first, sec-api.io as fallback, no daily count shown");
    const n = await call2("POST", `${D1}/formd/search`, { query: "Harbor Lofts SPV" });
    const r0 = n.body.results?.[0];
    check(n.status === 200 && n.body.results.length === 2 && seen.length === paidBefore, "name search served by SEC EDGAR (no sec-api.io call)");
    check(secSeen[0]?.path === `/efts?q=${encodeURIComponent('"Harbor Lofts SPV"')}&forms=D,D/A`, "EDGAR full-text search: exact phrase, Form D and D/A only");
    check(secSeen.every((x) => x.ua === UA), "every SEC request carries the contact User-Agent");
    check(!n.body.results.some((r: any) => r.cik === "0009999999"), "a filing that only mentions the name (other issuer) is dropped");
    check(r0?.form === "D/A" && r0.accessionNo === "0001234567-26-000003" && r0.filedAt === "2026-10-01" && n.body.results[1].form === "D", "newest first, read from each filing's own XML");
    check(r0?.exemptions?.[0]?.label === "Rule 506(c)" && r0.totalAmountSold === 900000 && r0.totalOfferingAmount === null && r0.minimumInvestment === 25000 && r0.investors === 9 && r0.hasNonAccredited === false && r0.source === "SEC EDGAR", "XML figures mapped the same way ('Indefinite' → null)");
    const k = await call2("POST", `${D1}/formd/search`, { query: "1234567" });
    check(k.status === 200 && k.body.results.length === 2 && secSeen.some((x) => x.path === "/data/submissions/CIK0001234567.json"), "CIK search via EDGAR submissions; the 10-K is ignored");
    const none = await call2("POST", `${D1}/formd/search`, { query: "7654321" });
    check(none.status === 200 && none.body.results.length === 0, "unknown CIK: no filings, no error");
    const atc = await call2("POST", `${D1}/formd`, { accessionNo: "0001234567-26-000003" });
    check(atc.status === 200 && atc.body.formD?.source === "SEC EDGAR", "an EDGAR result can be attached");
    secDown = true;
    const fb = await call2("POST", `${D1}/formd/search`, { query: "Harbor Lofts Fallback" });
    check(fb.status === 200 && fb.body.results.length === 2 && seen.length === paidBefore + 1 && seen[seen.length - 1]!.query === 'primaryIssuer.entityName:"Harbor Lofts Fallback"', "EDGAR down → falls back to sec-api.io (one budgeted call)");
    check((await call2("GET", "/edgar/status")).body.callsUsed === 1, "the fallback call counts against the sec-api.io budget");
  } finally {
    api2.kill();
    secMock.stop(true);
  }

} catch (e) {
  console.error(e);
  failed = true;
} finally {
  apiProc?.kill();
  sec.stop(true);
}
console.log(failed ? "\nE2E EDGAR: FAILED" : "\nE2E EDGAR: ALL PASS");
process.exit(failed ? 1 : 0);
