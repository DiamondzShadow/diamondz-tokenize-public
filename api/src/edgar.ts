// SEC EDGAR: find an issuer's Form D (Regulation D notice of exempt offering) and attach it to an offering.
//
// Providers, in order:
//   1. SEC EDGAR itself (free; SEC_EDGAR_UA = "<app name> <contact email>", required by the SEC's fair-access policy):
//      name → efts full-text search over Form D/D/A; CIK → data.sec.gov submissions; each filing's primary_doc.xml is read
//      for the figures. Throttled to 8 requests/second (the SEC allows 10).
//   2. sec-api.io (SEC_API_KEY), only when EDGAR is unreachable or not configured. Its free tier is a small, fixed
//      number of calls, so for it:
//   - only signed-in issuers can search (public pages read the filing saved on the offering — zero calls);
//   - every search is cached (SEC_CACHE_DAYS, default 7) and every filing it returned is kept by accession number;
//   - a hard platform-wide budget (SEC_API_MAX_CALLS) and a per-tenant daily limit (SEC_API_TENANT_DAILY);
//   - nothing calls it on a timer.
// The SEC's own data.sec.gov is free but needs a contact email in the User-Agent; it can be added as a second
// provider behind the same `searchFormD` without touching the routes or the saved filing shape.
import type { Hono } from "hono";
import { XMLParser } from "fast-xml-parser";
import type { Store } from "./store";

export type FormDFiling = {
  accessionNo: string;
  form: string; // "D" | "D/A"
  filedAt: string;
  cik: string;
  entityName: string;
  entityType: string | null;
  jurisdiction: string | null;
  yearOfInc: string | null;
  city: string | null;
  state: string | null;
  industry: string | null;
  exemptions: { code: string; label: string }[];
  dateOfFirstSale: string | null;
  moreThanOneYear: boolean | null;
  minimumInvestment: number | null;
  totalOfferingAmount: number | null; // null = indefinite
  totalAmountSold: number | null;
  totalRemaining: number | null; // null = indefinite
  investors: number | null;
  hasNonAccredited: boolean | null;
  url: string;
  source: string;
};

const EXEMPTIONS: Record<string, string> = {
  "04": "Rule 504(b)(1)",
  "04a": "Rule 504(b)(1)(i)",
  "04b": "Rule 504(b)(1)(ii)",
  "04c": "Rule 504(b)(1)(iii)",
  "06b": "Rule 506(b)",
  "06c": "Rule 506(c)",
  "3C": "Investment Company Act §3(c)",
  "3C.1": "Investment Company Act §3(c)(1)",
  "3C.5": "Investment Company Act §3(c)(5)",
  "3C.7": "Investment Company Act §3(c)(7)",
  "4a5": "Securities Act §4(a)(5)",
};
export const exemptionLabel = (code: string) => EXEMPTIONS[code] ?? EXEMPTIONS[code.replace(/^3C\.(\d+)$/, "3C.$1")] ?? (/^3C\.\d+$/.test(code) ? `Investment Company Act §3(c)(${code.slice(3)})` : code);

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null; // Form D uses -1 for "indefinite"
};
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() && v !== "None" ? v.trim() : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : null);

export function filingUrl(cik: string, accessionNo: string) {
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionNo.replace(/-/g, "")}/${accessionNo}-index.htm`;
}

/** Normalises one sec-api.io Form D record. Returns null if it lacks what we need to identify it. */
export function toFiling(o: any, source = "sec-api.io"): FormDFiling | null {
  const iss = o?.primaryIssuer ?? {};
  const off = o?.offeringData ?? {};
  const accessionNo = str(o?.accessionNo);
  const cik = str(iss.cik);
  const entityName = str(iss.entityName);
  if (!accessionNo || !/^\d{10}-\d{2}-\d{6}$/.test(accessionNo) || !cik || !/^\d{1,10}$/.test(cik) || !entityName) return null;
  const items: unknown[] = Array.isArray(off.federalExemptionsExclusions?.item) ? off.federalExemptionsExclusions.item : off.federalExemptionsExclusions?.item ? [off.federalExemptionsExclusions.item] : [];
  const sales = off.offeringSalesAmounts ?? {};
  return {
    accessionNo,
    form: str(o.submissionType) ?? "D",
    filedAt: str(o.filedAt) ?? "",
    cik: cik.padStart(10, "0"),
    entityName,
    entityType: str(iss.entityType),
    jurisdiction: str(iss.jurisdictionOfInc),
    yearOfInc: str(iss.yearOfInc?.value),
    city: str(iss.issuerAddress?.city),
    state: str(iss.issuerAddress?.stateOrCountry),
    industry: str(off.industryGroup?.industryGroupType),
    exemptions: items.filter((x): x is string => typeof x === "string").map((code) => ({ code, label: exemptionLabel(code) })),
    dateOfFirstSale: str(off.typeOfFiling?.dateOfFirstSale?.value),
    moreThanOneYear: bool(off.durationOfOffering?.moreThanOneYear),
    minimumInvestment: num(off.minimumInvestmentAccepted),
    totalOfferingAmount: num(sales.totalOfferingAmount),
    totalAmountSold: num(sales.totalAmountSold),
    totalRemaining: num(sales.totalRemaining),
    investors: num(off.investors?.totalNumberAlreadyInvested),
    hasNonAccredited: bool(off.investors?.hasNonAccreditedInvestors),
    url: filingUrl(cik, accessionNo),
    source,
  };
}

/** Issuer name or CIK → a safe Lucene query, or null if too short. Strips every Lucene operator character. */
export function formDQuery(input: string): { key: string; query: string; cik?: string; name?: string } | null {
  const raw = input.trim();
  if (/^\d{1,10}$/.test(raw)) {
    const cik = raw.padStart(10, "0");
    return { key: `cik:${cik}`, query: `primaryIssuer.cik:"${cik}"`, cik };
  }
  const name = raw.replace(/[+\-&|!(){}\[\]^"~*?:\\\/]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  if (name.replace(/[^\p{L}\p{N}]/gu, "").length < 3) return null;
  return { key: `name:${name.toLowerCase()}`, query: `primaryIssuer.entityName:"${name}"`, name };
}

export class EdgarError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}

type Config = {
  apiKey: string | null; baseUrl: string; maxCalls: number; tenantDaily: number; cacheDays: number;
  secUa: string | null; eftsUrl: string; dataUrl: string; archivesUrl: string; secMaxFilings: number;
};
export function edgarConfig(env = process.env): Config {
  return {
    apiKey: /^[0-9a-f]{64}$/i.test(env.SEC_API_KEY ?? "") ? env.SEC_API_KEY! : null,
    baseUrl: env.SEC_API_URL ?? "https://api.sec-api.io/mcp",
    maxCalls: Math.max(0, Number(env.SEC_API_MAX_CALLS ?? 90)),
    tenantDaily: Math.max(0, Number(env.SEC_API_TENANT_DAILY ?? 10)),
    cacheDays: Math.max(0, Number(env.SEC_CACHE_DAYS ?? 7)),
    // The SEC requires a real contact in the User-Agent; refuse anything that doesn't look like "<name> <email>".
    secUa: /\S+\s+\S+@\S+\.\S+/.test(env.SEC_EDGAR_UA ?? "") ? env.SEC_EDGAR_UA!.trim() : null,
    eftsUrl: env.SEC_EFTS_URL ?? "https://efts.sec.gov/LATEST/search-index",
    dataUrl: env.SEC_DATA_URL ?? "https://data.sec.gov",
    archivesUrl: env.SEC_ARCHIVES_URL ?? "https://www.sec.gov/Archives",
    secMaxFilings: Math.max(1, Math.min(20, Number(env.SEC_MAX_FILINGS ?? 10))),
  };
}

const CALLS = "secapi:calls";
const today = () => new Date().toISOString().slice(0, 10);

/** One sec-api.io MCP tool call. Throws EdgarError with a message safe to show the issuer (never the key). */
async function secApiTool(cfg: Config, tool: string, args: Record<string, unknown>) {
  const res = await fetch(`${cfg.baseUrl}?apiKey=${cfg.apiKey}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
    signal: AbortSignal.timeout(45_000),
  }).catch(() => null);
  if (!res) throw new EdgarError("Couldn't reach the SEC data service. Try again shortly.");
  if (res.status === 401 || res.status === 403) throw new EdgarError("The SEC data service refused our key. The platform team has to renew it.", 503);
  if (res.status === 429) throw new EdgarError("The SEC data service is rate-limiting us. Try again in a minute.", 503);
  if (!res.ok) throw new EdgarError(`The SEC data service answered ${res.status}. Try again shortly.`);
  const text = await res.text();
  // Streamable HTTP may answer as SSE: take the last `data:` line.
  const body = text.trimStart().startsWith("{") ? text : (text.split("\n").filter((l) => l.startsWith("data:")).pop() ?? "").slice(5);
  let msg: any;
  try { msg = JSON.parse(body); } catch { throw new EdgarError("The SEC data service sent an unreadable answer."); }
  if (msg.error) throw new EdgarError(/limit|quota|exceed/i.test(msg.error.message ?? "") ? "The SEC data service's call allowance is used up." : "The SEC data service couldn't run that search.", 503);
  const content = msg.result?.content?.[0]?.text;
  if (msg.result?.isError) throw new EdgarError(/limit|quota|exceed/i.test(content ?? "") ? "The SEC data service's call allowance is used up." : "The SEC data service couldn't run that search.", 503);
  try { return JSON.parse(content); } catch { throw new EdgarError("The SEC data service sent an unreadable answer."); }
}

// ------------------------------------------------------------------ SEC EDGAR (free)
const xml = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true, isArray: (name) => name === "item" || name === "relatedPersonInfo" });
let secChain: Promise<unknown> = Promise.resolve();
/** GET from sec.gov / data.sec.gov, one request at a time, ≥125 ms apart (8/s). Returns null on 404. */
function secGet(cfg: Config, url: string): Promise<string | null> {
  const run = async () => {
    const res = await fetch(url, { headers: { "user-agent": cfg.secUa!, accept: "application/json, application/xml, text/xml, */*" }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
    await new Promise((r) => setTimeout(r, 125));
    if (!res) throw new EdgarError("Couldn't reach SEC EDGAR. Try again shortly.");
    if (res.status === 404) return null;
    if (res.status === 403) throw new EdgarError("SEC EDGAR refused the request (contact header). The platform team has to check it.", 503);
    if (res.status === 429) throw new EdgarError("SEC EDGAR is rate-limiting us. Try again in a minute.", 503);
    if (!res.ok) throw new EdgarError(`SEC EDGAR answered ${res.status}. Try again shortly.`);
    return res.text();
  };
  const p = secChain.then(run, run);
  secChain = p.catch(() => {});
  return p;
}

/** One Form D's own XML → our shape (same element names sec-api.io mirrors). */
async function secFiling(cfg: Config, cik: string, accessionNo: string, filedAt: string): Promise<FormDFiling | null> {
  const body = await secGet(cfg, `${cfg.archivesUrl}/edgar/data/${Number(cik)}/${accessionNo.replace(/-/g, "")}/primary_doc.xml`);
  if (!body) return null;
  let doc: any;
  try { doc = xml.parse(body)?.edgarSubmission; } catch { return null; }
  if (!doc?.primaryIssuer) return null;
  return toFiling({ ...doc, accessionNo, filedAt }, "SEC EDGAR");
}

type Hit = { cik: string; accessionNo: string; filedAt: string; names: string };
async function secSearch(cfg: Config, q: { cik?: string; name?: string }): Promise<FormDFiling[]> {
  let hits: Hit[] = [];
  if (q.cik) {
    const body = await secGet(cfg, `${cfg.dataUrl}/submissions/CIK${q.cik}.json`);
    if (!body) return [];
    const r = JSON.parse(body)?.filings?.recent ?? {};
    const forms: string[] = r.form ?? [];
    hits = forms.flatMap((f, i) => (f === "D" || f === "D/A" ? [{ cik: q.cik!, accessionNo: r.accessionNumber[i], filedAt: r.filingDate[i], names: "" }] : []));
  } else {
    const body = await secGet(cfg, `${cfg.eftsUrl}?q=${encodeURIComponent(`"${q.name}"`)}&forms=D,D/A`);
    const raw: any[] = body ? JSON.parse(body)?.hits?.hits ?? [] : [];
    const seen = new Set<string>();
    for (const h of raw) {
      const s = h?._source ?? {};
      const acc = String(s.adsh ?? String(h?._id ?? "").split(":")[0]);
      const cik = Array.isArray(s.ciks) ? String(s.ciks[0] ?? "") : "";
      if (!/^\d{10}-\d{2}-\d{6}$/.test(acc) || !/^\d{1,10}$/.test(cik) || seen.has(acc)) continue;
      seen.add(acc);
      hits.push({ cik, accessionNo: acc, filedAt: String(s.file_date ?? ""), names: (s.display_names ?? []).join(" ") });
    }
    // Full-text search also matches filings that merely mention the name; prefer ones where it's the issuer.
    const own = hits.filter((h) => h.names.toLowerCase().includes(q.name!.toLowerCase()));
    if (own.length) hits = own;
  }
  hits.sort((a, b) => (b.filedAt + b.accessionNo).localeCompare(a.filedAt + a.accessionNo));
  const out: FormDFiling[] = [];
  for (const h of hits.slice(0, cfg.secMaxFilings)) {
    const f = await secFiling(cfg, h.cik, h.accessionNo, h.filedAt);
    if (f) out.push(f);
  }
  return out;
}

type Deps = {
  store: Store;
  requireAdmin: any;
  tenantId: (c: any) => string;
  adminAsset: (c: any, id: string) => Promise<any | null>;
  /** Loads the stored asset data, lets `fn` change it, saves it; returns the public asset or null if missing. */
  updateAssetData: (c: any, id: string, fn: (d: any) => void) => Promise<any | null>;
};

export function mountEdgar(app: Hono<any>, deps: Deps, cfg = edgarConfig()) {
  const { store } = deps;
  const now = () => new Date().toISOString();

  async function searchFormD(tenantId: string, input: string, fresh: boolean) {
    const q = formDQuery(input);
    if (!q) throw new EdgarError("Enter the issuer's legal name (at least 3 letters) or its SEC CIK number.", 400);
    const cacheKey = `formd:q:${q.key}`;
    const hit = await store.getKv(cacheKey);
    const age = hit ? Date.now() - Date.parse(hit.updated_at) : Infinity;
    // `fresh` (look for new amendments) still reuses anything under a day old.
    if (hit && age < (fresh ? 86_400_000 : cfg.cacheDays * 86_400_000)) return { results: JSON.parse(hit.value) as FormDFiling[], cached: true, fetchedAt: hit.updated_at };
    if (!cfg.secUa && !cfg.apiKey) throw new EdgarError("SEC lookups aren't set up on this site yet.", 503);

    if (cfg.secUa) {
      try { return await save(cacheKey, await secSearch(cfg, q)); }
      catch (e) {
        if (!cfg.apiKey) throw e;
        console.error("edgar: SEC EDGAR failed, falling back to sec-api.io:", e instanceof Error ? e.message : e);
      }
    }

    // sec-api.io. Budget: platform-wide cap first, then this tenant's daily share. Undo the bump when refused.
    const used = await store.bumpCounter(CALLS);
    if (used > cfg.maxCalls) {
      await store.bumpCounter(CALLS, -1);
      throw new EdgarError("The platform's SEC lookup allowance is used up. Saved filings still show; new searches are paused.", 503);
    }
    const dayKey = `secapi:tenant:${tenantId}:${today()}`;
    if ((await store.bumpCounter(dayKey)) > cfg.tenantDaily) {
      await store.bumpCounter(dayKey, -1);
      await store.bumpCounter(CALLS, -1);
      throw new EdgarError(`You've used today's ${cfg.tenantDaily} SEC searches. Saved results still work; try new searches tomorrow.`, 429);
    }
    const out = await secApiTool(cfg, "form-d", { query: q.query, from: 0, size: 20, sort: [{ filedAt: { order: "desc" } }] });
    return save(cacheKey, (Array.isArray(out?.offerings) ? out.offerings : []).map((o: any) => toFiling(o)).filter(Boolean) as FormDFiling[]);
  }

  async function save(cacheKey: string, results: FormDFiling[]) {
    const t = now();
    await store.setKv(cacheKey, JSON.stringify(results), t);
    for (const f of results) await store.setKv(`formd:acc:${f.accessionNo}`, JSON.stringify(f), t);
    return { results, cached: false, fetchedAt: t };
  }

  // Daily limits only apply to the paid fallback; with SEC EDGAR configured there's no count to show.
  const left = async (tenantId: string) => (cfg.secUa ? null : Math.max(0, cfg.tenantDaily - ((await store.bumpCounter(`secapi:tenant:${tenantId}:${today()}`, 0)) || 0)));

  const fail = (c: any, e: any) =>
    e instanceof EdgarError ? c.json({ error: e.message }, e.status) : (console.error("edgar", e), c.json({ error: "SEC lookup failed. Try again shortly." }, 422));

  app.get("/edgar/status", deps.requireAdmin, async (c) => {
    const used = (await store.bumpCounter(CALLS, 0)) || 0;
    return c.json({ enabled: !!(cfg.secUa || cfg.apiKey), provider: cfg.secUa ? "SEC EDGAR" : cfg.apiKey ? "sec-api.io" : null, fallback: cfg.secUa && cfg.apiKey ? "sec-api.io" : null, callsUsed: used, callsMax: cfg.maxCalls, tenantDaily: cfg.tenantDaily, searchesLeftToday: await left(deps.tenantId(c)), budgetLeft: Math.max(0, cfg.maxCalls - used), cacheDays: cfg.cacheDays });
  });

  app.post("/assets/:id/formd/search", deps.requireAdmin, async (c) => {
    const asset = await deps.adminAsset(c, c.req.param("id"));
    if (!asset) return c.json({ error: "Not found" }, 404);
    const body = (await c.req.json().catch(() => null)) as { query?: unknown; fresh?: unknown } | null;
    if (typeof body?.query !== "string") return c.json({ error: "query: enter the issuer's legal name or CIK" }, 400);
    try { return c.json({ ...(await searchFormD(deps.tenantId(c), body.query, body.fresh === true)), searchesLeftToday: await left(deps.tenantId(c)) }); }
    catch (e) { return fail(c, e); }
  });

  // Attach only a filing the SEC search actually returned (by accession number) — issuers can't type in their own.
  app.post("/assets/:id/formd", deps.requireAdmin, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { accessionNo?: unknown } | null;
    const acc = typeof body?.accessionNo === "string" ? body.accessionNo.trim() : "";
    if (!/^\d{10}-\d{2}-\d{6}$/.test(acc)) return c.json({ error: "accessionNo: pick a filing from the search results" }, 400);
    const saved = await store.getKv(`formd:acc:${acc}`);
    if (!saved) return c.json({ error: "Search for the filing first, then pick it from the results" }, 400);
    const filing = { ...(JSON.parse(saved.value) as FormDFiling), checkedAt: saved.updated_at, attachedAt: now() };
    const a = await deps.updateAssetData(c, c.req.param("id"), (d) => void (d.formD = filing));
    return a ? c.json(a) : c.json({ error: "Not found" }, 404);
  });

  app.delete("/assets/:id/formd", deps.requireAdmin, async (c) => {
    const a = await deps.updateAssetData(c, c.req.param("id"), (d) => void delete d.formD);
    return a ? c.json(a) : c.json({ error: "Not found" }, 404);
  });
}
