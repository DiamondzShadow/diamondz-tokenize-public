// Accredited-investor checks through Mastercard Open Finance US (design canvas UzMg5WJ2BGKFGCzBaWkMRu, approved 2026-11-18).
//
// Flow: the investor (wallet-signed request) picks a route (income | assets), gives Mastercard their identity details
// and their FCRA written instruction (purpose 1W), links accounts in Mastercard Data Connect, and Mastercard prepares
// a Verification of Income (VOI) or of Assets (VOA). The issuer reviews a summary + the live report and decides; on
// approval it signs the investor's KYC claim / verifies the wallet as usual. The issuer always decides.
//
// Privacy: name, date of birth, state and email go straight to Mastercard (consumer record) and are NEVER stored here.
// We keep Mastercard's customer id, the report id, the consent text + time, and a numbers-only summary. The full
// report (with names and accounts) is fetched live from Mastercard when an issuer opens it, never persisted.
//
// All Mastercard calls go through mc-relay (Cloud Run us-central1): Open Finance only accepts US/UK/CA/AU IPs.
//
// Endpoints
//   public (investor; requests bound to a wallet signature):
//     POST /api/accreditation/start                 → { id, link }      (Data Connect URL)
//     POST /api/accreditation/:id/linked            → { status }        (accounts linked: generate the report)
//     GET  /api/accreditation/:id?wallet=0x..       → { status, decision, route, preparedAt }
//   issuer console (admin session, tenant-scoped):
//     GET  /api/assets/:id/accreditation            → rows (in-progress reports are polled)
//     GET  /api/accreditation/:id/report            → summary + live owner names / institutions from Mastercard
//     POST /api/accreditation/:id/decision          { decision: approve | decline | more }
import type { AccreditationRow, Store } from "./store";
import type { Hono } from "hono";
import { randomBytes, createHash } from "node:crypto";
import { createPublicClient, getAddress, http, isAddress, verifyMessage, type Address, type Hex } from "viem";
import { z } from "zod";
import { networkById, rpcUrl } from "./chains";
import { registerJob } from "./jobs";

// ------------------------------------------------------------------ relay client
const RELAY_URL = (process.env.MC_RELAY_URL ?? "https://mc-relay-645985546491.us-central1.run.app").replace(/\/$/, "");
const SANDBOX = process.env.MC_OF_TESTING !== "0"; // sandbox ("testing") customers until production access exists
export const CONSENT_TEXT_VERSION = "2026-11-18";

let idTok: { value: string; at: number } | null = null;
/** Cloud Run only admits the platform VM's Google identity: an ID token for the relay, from the metadata server. */
async function identityToken(): Promise<string | null> {
  if (process.env.MC_RELAY_NO_ID === "1") return null; // local mock relay in tests
  if (idTok && Date.now() - idTok.at < 45 * 60_000) return idTok.value;
  const r = await fetch(`http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(RELAY_URL)}`, {
    headers: { "Metadata-Flavor": "Google" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!r.ok) throw new Error(`couldn't get the relay identity (${r.status})`);
  idTok = { value: await r.text(), at: Date.now() };
  return idTok.value;
}

export class McError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function relay<T = any>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const token = process.env.MC_RELAY_TOKEN;
  if (!token) throw new McError(503, "Mastercard isn't configured on this server");
  const id = await identityToken();
  const r = await fetch(`${RELAY_URL}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-relay-token": token, ...(id ? { authorization: `Bearer ${id}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  const text = await r.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!r.ok) {
    // Mastercard error bodies can echo submitted fields: keep only its code/message, never log the body.
    const msg = data?.message ?? data?.error ?? `Mastercard error ${r.status}`;
    throw new McError(r.status >= 500 ? 502 : r.status, String(msg).slice(0, 200));
  }
  return data as T;
}

// ------------------------------------------------------------------ report summary (numbers only)
export interface Summary {
  route: "income" | "assets";
  reportType: string;
  preparedAt: string | null;
  institutions: number;
  accounts: number;
  // income route (VOI): gross income per rolling 12 months, from complete calendar months
  incomeLast12?: number;
  incomePrior12?: number;
  monthsObserved?: number;
  incomeStreams?: number;
  // assets route (VOA): balances across linked accounts (debts are NOT included)
  assetsCurrent?: number;
  assetsTwoMonthAvg?: number;
  /** meets | short | insufficient-history: the platform's reading of the report, not a determination. */
  reading: "meets" | "short" | "insufficient-history";
}

export function summarize(report: any, route: "income" | "assets"): Summary {
  const insts: any[] = report?.institutions ?? [];
  const accounts = insts.reduce((n, i) => n + (i?.accounts?.length ?? 0), 0);
  const base = {
    route, reportType: String(report?.type ?? (route === "income" ? "voi" : "voa")),
    preparedAt: report?.createdDate ? new Date(Number(report.createdDate) * 1000).toISOString() : null,
    institutions: insts.length, accounts,
  };
  if (route === "income") {
    // Income records grouped by Mastercard's confidence; count HIGH and MODERATE only.
    const byMonth = new Map<number, number>();
    let streams = 0;
    for (const g of report?.income ?? []) {
      if (!["HIGH", "MODERATE"].includes(g?.confidenceType)) continue;
      for (const m of g?.netMonthly ?? []) {
        const v = Number(m?.gross ?? m?.net ?? 0);
        byMonth.set(Number(m.month), (byMonth.get(Number(m.month)) ?? 0) + (Number.isFinite(v) ? v : 0));
      }
    }
    for (const i of insts) for (const a of i?.accounts ?? []) streams += (a?.incomeStreams ?? []).filter((s: any) => ["HIGH", "MODERATE"].includes(s?.estimateInclusion)).length;
    const months = [...byMonth.keys()].sort((a, b) => b - a);
    const sum = (ms: number[]) => Math.round(ms.reduce((t, m) => t + (byMonth.get(m) ?? 0), 0));
    const last12 = sum(months.slice(0, 12)), prior12 = sum(months.slice(12, 24));
    const reading = months.length < 24 ? "insufficient-history" : last12 >= 200_000 && prior12 >= 200_000 ? "meets" : "short";
    return { ...base, incomeLast12: last12, incomePrior12: prior12, monthsObserved: months.length, incomeStreams: streams, reading };
  }
  const cur = Math.round(Number(report?.assets?.currentBalance ?? 0));
  const avg = Math.round(Number(report?.assets?.twoMonthAverage ?? 0));
  return { ...base, assetsCurrent: cur, assetsTwoMonthAvg: avg, reading: cur >= 1_000_000 ? "meets" : "short" };
}

// ------------------------------------------------------------------ storage (api/src/store.ts: SQLite or MongoDB)
type Row = AccreditationRow;

export function consentText(issuerName: string, offering: string) {
  return `I instruct Mastercard Open Finance to prepare an income or asset report from the accounts I link, and to share it with the issuer of ${offering} (${issuerName}) to check whether I'm an accredited investor. This is my written instruction under the Fair Credit Reporting Act.`;
}

export function accreditationMessage(p: { assetId: string; wallet: string; route: string; ts: number }) {
  return `Diamondz Tokenize accreditation request\nOffering: ${p.assetId}\nWallet: ${p.wallet}\nRoute: ${p.route}\nTime: ${p.ts}`;
}

const Start = z.object({
  assetId: z.string().regex(/^ast_[0-9a-f]{16}$/),
  wallet: z.string().refine(isAddress, "bad wallet"),
  route: z.enum(["income", "assets"]),
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().min(1).max(60),
  birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  state: z.string().regex(/^[A-Z]{2}$/),
  email: z.string().email().max(200),
  consent: z.literal(true),
  ts: z.number().int(),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/).max(4000),
});

type Deps = {
  store: Store;
  requireAdmin: any;
  tenant: (c: any) => { id: string; name: string };
  /** A listed offering on this website (any issuer it shows), with `tenantId` = its issuer. */
  listedAsset: (c: any, id: string) => Promise<any | null>;
  issuerOf: (tenantId: string) => Promise<{ id: string; name: string }>;
  /** Whether records of this issuer may be read through this website. */
  siteHas: (c: any, tenantId: string) => boolean;
  adminAsset: (c: any, id: string) => Promise<any | null>;
  adminEmail: (c: any) => string;
};

const hits = new Map<string, number[]>();
function limited(key: string, n: number, windowMs: number) {
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  return list.length > n;
}

/** Poll an in-progress report; on success store the numbers-only summary. */
async function advance(store: Store, row: Row): Promise<Row> {
  if (row.status !== "reporting" || !row.report_id) return row;
  try {
    const rep = await relay("GET", `/customers/${row.mc_customer_id}/reports/${encodeURIComponent(row.report_id)}?purpose=1W`);
    if (rep?.status === "inProgress") return row;
    const now = new Date().toISOString();
    if (rep?.status !== "success") {
      await store.updateAccreditation(row.id, { status: "failed", error: "Mastercard couldn't prepare the report", updated_at: now });
      return { ...row, status: "failed" };
    }
    const sum = summarize(rep, row.route);
    await store.updateAccreditation(row.id, { status: "ready", summary: JSON.stringify(sum), report_type: sum.reportType, updated_at: now });
    return { ...row, status: "ready", summary: JSON.stringify(sum) };
  } catch (e: any) {
    console.error("[mastercard] report poll", row.id, e?.status ?? "", String(e?.message ?? e).slice(0, 120));
    return row;
  }
}

const publicView = (r: Row) => ({
  id: r.id, assetId: r.asset_id, wallet: r.wallet, route: r.route, status: r.status, decision: r.decision,
  preparedAt: r.summary ? JSON.parse(r.summary).preparedAt : null, consentAt: r.consent_at,
});
const adminView = (r: Row) => ({ ...publicView(r), summary: r.summary ? (JSON.parse(r.summary) as Summary) : null, decidedAt: r.decided_at, decidedBy: r.decided_by, error: r.error, createdAt: r.created_at, consentText: r.consent_text });

export function mountMastercard(app: Hono<any>, deps: Deps) {
  const { store } = deps;
  const get = (id: string) => store.getAccreditation(id);

  // ---------------------------------------------------------------- investor
  /** The exact consent wording the investor sees; the same text is recorded with their request. */
  app.get("/accreditation/consent/:assetId", async (c) => {
    const asset = await deps.listedAsset(c, c.req.param("assetId"));
    if (!asset) return c.json({ error: "Offering not found" }, 404);
    return c.json({ text: consentText((await deps.issuerOf(asset.tenantId)).name, asset.name), version: CONSENT_TEXT_VERSION });
  });

  app.post("/accreditation/start", async (c) => {
    const ip = c.req.header("x-real-ip") ?? c.req.header("cf-connecting-ip") ?? "?";
    if (limited(`start:${ip}`, 5, 10 * 60_000)) return c.json({ error: "Too many attempts. Try again in a few minutes." }, 429);
    const p = Start.safeParse(await c.req.json().catch(() => null));
    if (!p.success) return c.json({ error: "Please complete every field and tick the consent box" }, 400);
    const b = p.data;
    const asset = await deps.listedAsset(c, b.assetId);
    if (!asset) return c.json({ error: "Offering not found" }, 404);
    const tenant = await deps.issuerOf(asset.tenantId); // the offering's issuer, not the website
    if (Math.abs(Date.now() / 1000 - b.ts) > 600) return c.json({ error: "Signature expired, sign again" }, 400);
    const wallet = getAddress(b.wallet);
    const message = accreditationMessage({ assetId: b.assetId, wallet, route: b.route, ts: b.ts });
    const net = networkById(asset.chainId);
    const client = net ? createPublicClient({ transport: http(rpcUrl(net), { timeout: 10_000 }) }) : null;
    // ERC-1271 smart wallets via the chain; plain EOAs offline as a fallback.
    const sigOk = (client && (await client.verifyMessage({ address: wallet, message, signature: b.signature as Hex }).catch(() => false)))
      || (await verifyMessage({ address: wallet, message, signature: b.signature as Hex }).catch(() => false));
    if (!sigOk) return c.json({ error: "The signature doesn't match this wallet" }, 401);
    if (limited(`start:${wallet}`, 3, 60 * 60_000)) return c.json({ error: "Too many requests for this wallet. Try again later." }, 429);

    const id = `acc_${randomBytes(12).toString("hex")}`;
    try {
      const cust = await relay<{ id: string }>("POST", "/customers", { username: `tk_${id}`, testing: SANDBOX });
      const [y, m, d] = b.birthday.split("-").map(Number);
      // Identity details go to Mastercard only; nothing below is persisted.
      await relay("POST", `/customers/${cust.id}/consumer`, {
        firstName: b.firstName, lastName: b.lastName, state: b.state, email: b.email, birthday: { year: y, month: m, dayOfMonth: d },
      });
      const { link } = await relay<{ link: string }>("POST", `/customers/${cust.id}/connect`, {});
      const now = new Date().toISOString();
      const consent = consentText(tenant.name, asset.name);
      await store.insertAccreditation({
        id, tenant_id: tenant.id, asset_id: b.assetId, wallet, route: b.route, status: "linking", mc_customer_id: String(cust.id),
        report_id: null, report_type: null, summary: null, consent_text: consent, consent_at: now, decision: null, decided_at: null,
        decided_by: null, error: null, created_at: now, updated_at: now,
      });
      return c.json({ id, link, consentText: consent, consentHash: createHash("sha256").update(consent).digest("hex") });
    } catch (e: any) {
      console.error("[mastercard] start", id, e?.status ?? "", String(e?.message ?? e).slice(0, 120));
      return c.json({ error: e instanceof McError ? `Mastercard: ${e.message}` : "Couldn't reach Mastercard. Try again shortly." }, e?.status === 400 ? 400 : 502);
    }
  });

  app.post("/accreditation/:id/linked", async (c) => {
    const row = await get(c.req.param("id"));
    const body = (await c.req.json().catch(() => ({}))) as { wallet?: string };
    if (!row || !body.wallet || row.wallet.toLowerCase() !== String(body.wallet).toLowerCase() || !deps.siteHas(c, row.tenant_id)) return c.json({ error: "Not found" }, 404);
    if (row.status !== "linking") return c.json(publicView(row));
    try {
      await relay("POST", `/customers/${row.mc_customer_id}/accounts/refresh`);
      const rep = await relay<{ id: string }>("POST", `/customers/${row.mc_customer_id}/reports/${row.route === "income" ? "voi" : "voa"}`, {});
      const now = new Date().toISOString();
      await store.updateAccreditation(row.id, { status: "reporting", report_id: String(rep.id), report_type: row.route === "income" ? "voi" : "voa", updated_at: now });
      return c.json(publicView({ ...row, status: "reporting", report_id: String(rep.id) }));
    } catch (e: any) {
      console.error("[mastercard] linked", row.id, e?.status ?? "", String(e?.message ?? e).slice(0, 120));
      return c.json({ error: e instanceof McError ? `Mastercard: ${e.message}` : "Couldn't reach Mastercard. Try again shortly." }, 422);
    }
  });

  app.get("/accreditation/:id", async (c) => {
    const row = await get(c.req.param("id"));
    const wallet = c.req.query("wallet") ?? "";
    if (!row || row.wallet.toLowerCase() !== wallet.toLowerCase() || !deps.siteHas(c, row.tenant_id)) return c.json({ error: "Not found" }, 404);
    return c.json(publicView(await advance(store, row)));
  });

  // Move Mastercard reports along without waiting for someone to open a page (Temporal schedule in production).
  registerJob("accreditation-poll", async () => {
    let ready = 0, waiting = 0;
    for (const r of await store.accreditationsReporting(100)) {
      const x = await advance(store, r);
      x.status === "reporting" ? waiting++ : ready++;
    }
    return { ready, waiting };
  }, 2 * 60_000, 45_000);

  // ---------------------------------------------------------------- issuer
  app.get("/assets/:id/accreditation", deps.requireAdmin, async (c) => {
    const asset = await deps.adminAsset(c, c.req.param("id"));
    if (!asset) return c.json({ error: "Not found" }, 404);
    const rows = await store.accreditationsForAsset(deps.tenant(c).id, asset.id);
    const out: Row[] = [];
    for (const r of rows) out.push(await advance(store, r));
    return c.json(out.map(adminView));
  });

  app.get("/accreditation/:id/report", deps.requireAdmin, async (c) => {
    const row = await get(c.req.param("id"));
    if (!row || row.tenant_id !== deps.tenant(c).id || !(await deps.adminAsset(c, row.asset_id))) return c.json({ error: "Not found" }, 404);
    if (!row.report_id || row.status !== "ready") return c.json({ error: "The report isn't ready yet" }, 409);
    try {
      // Live from Mastercard, never stored: owner names and institutions for the issuer's review.
      const rep = await relay("GET", `/customers/${row.mc_customer_id}/reports/${encodeURIComponent(row.report_id)}?purpose=1W`);
      const owners = new Set<string>();
      const institutions: { name: string; accounts: { type: string; ownerName: string | null; last4: string | null }[] }[] = [];
      for (const i of rep?.institutions ?? []) {
        institutions.push({
          name: String(i?.name ?? ""),
          accounts: (i?.accounts ?? []).map((a: any) => {
            if (a?.ownerName) owners.add(String(a.ownerName));
            return { type: String(a?.type ?? ""), ownerName: a?.ownerName ? String(a.ownerName) : null, last4: a?.number ? String(a.number).slice(-4) : null };
          }),
        });
      }
      return c.json({ ...adminView(row), owners: [...owners], institutions, reportStatus: rep?.status ?? null });
    } catch (e: any) {
      return c.json({ error: e instanceof McError ? `Mastercard: ${e.message}` : "Couldn't reach Mastercard. Try again shortly." }, 422);
    }
  });

  app.post("/accreditation/:id/decision", deps.requireAdmin, async (c) => {
    const row = await get(c.req.param("id"));
    if (!row || row.tenant_id !== deps.tenant(c).id || !(await deps.adminAsset(c, row.asset_id))) return c.json({ error: "Not found" }, 404);
    const p = z.object({ decision: z.enum(["approve", "decline", "more"]) }).safeParse(await c.req.json().catch(() => null));
    if (!p.success) return c.json({ error: "decision must be approve, decline or more" }, 400);
    if (row.status !== "ready") return c.json({ error: "Review the report once it's ready" }, 409);
    const now = new Date().toISOString();
    const decision = { approve: "approved", decline: "declined", more: "more" }[p.data.decision];
    await store.updateAccreditation(row.id, { decision, decided_at: now, decided_by: deps.adminEmail(c), updated_at: now });
    return c.json(adminView({ ...row, decision, decided_at: now, decided_by: deps.adminEmail(c) }));
  });
}
