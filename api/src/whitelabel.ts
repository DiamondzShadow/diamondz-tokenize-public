// White-label site setup (designs W1–W6, canvas Kkq7dLzdNRZn5oUVJ5KEuz, approved 2026-11-27).
//
// A workspace on the White-label plan connects its own domain (Cloudflare for SaaS: CNAME + ownership TXT, certificate
// issued and renewed by Cloudflare), sends email from its own domain (Resend domains: DKIM + SPF + bounce MX), and
// publishes its own legal pages. The team keeps using the console on the platform site; the custom domain serves the
// investor side. The domain opens to the public when the owner presses Go live; before that it shows "opening soon"
// unless the visitor has the workspace's preview link.
//
// Routing: the domain is added to `tenant_hosts` for this workspace as soon as it's registered (the API resolves the
// tenant from Host), and a root-owned sync (deploy/nginx/tokenize-sync-hosts) adds registered domains to nginx from
// GET /api/internal/custom-hosts.
//
// Issuer:   GET /api/whitelabel · POST/DELETE /api/whitelabel/domain · POST /api/whitelabel/check · POST /api/whitelabel/live
//           POST /api/whitelabel/email · POST /api/whitelabel/email/verify · POST /api/whitelabel/email/test
//           GET /api/whitelabel/legal · PUT/DELETE /api/whitelabel/legal/:slug · POST …/:slug/publish · POST …/:slug/pdf
// Public:   GET /api/site/legal · GET /api/site/legal/:slug · GET /api/site/legal/:slug/pdf · GET /api/site/preview?k=
// Platform: GET /api/platform/whitelabel · POST /api/platform/whitelabel/setup · POST /api/platform/whitelabel/recheck
import type { Context, Hono } from "hono";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { resolveCname, resolveTxt } from "node:dns/promises";
import { mkdirSync } from "node:fs";
import { z } from "zod";
import { CfError, cfConfigured, createHostname, deleteHostname, ensureFallbackOrigin, fallbackOrigin, getHostname, saasTarget } from "./cfsaas";
import { registerJob } from "./jobs";
import { emailConfigured, escHtml, sendEmail } from "./notify";
import type { Store, TenantRow } from "./store";

const SITE = "wl_site", LEGAL = "wl_legal";
const EVIDENCE_DIR = process.env.EVIDENCE_DIR ?? `${import.meta.dir}/../data/evidence`;
const RESEND = () => (process.env.RESEND_API_BASE ?? "https://api.resend.com").replace(/\/+$/, "");
const now = () => new Date().toISOString();
const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const HOST_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){2,}[a-z]{2,63}$/;
/** Domains the platform itself uses: never a customer's custom domain. */
const RESERVED = ["diamondz.one", "diamondzshadow.net", "diamondzshadow.info", "billionairesrow.io", "billionairesrow.com"];
export const DEFAULT_LEGAL = [{ slug: "terms", title: "Terms of use" }, { slug: "privacy", title: "Privacy policy" }, { slug: "risk", title: "Risk disclosures" }];

export interface WlSite {
  domain?: string;
  cf?: { id: string; status: string; ssl: string; ownership: { name: string; value: string } | null; errors: string[] };
  dns?: { cname: boolean; txt: boolean };
  answers?: boolean;
  checkedAt?: string;
  addedAt?: string;
  live?: { at: string; by: string } | null;
  previewKey?: string;
  email?: {
    name: string; address: string; replyTo: string | null; domain: string; resendId: string; status: string;
    records: { type: string; name: string; value: string; priority?: number; status: string }[]; checkedAt: string;
  };
}
interface LegalPage {
  slug: string; title: string; draft: string; draftAt: string | null;
  published: { text: string; at: string; by: string } | null; versions: { text: string; at: string; by: string }[];
  pdf: { sha256: string; bytes: number; at: string } | null;
}

export interface WhitelabelDeps {
  store: Store;
  requireAdmin: (c: Context<any>, next: () => Promise<void>) => Promise<Response | void>;
  isPlatformAdmin: (c: Context<any>) => boolean;
  tenantId: (c: Context<any>) => string;
  siteId: (c: Context<any>) => string;
  member: (c: Context<any>) => { account: string | null; role: string; email?: string | null };
  plan: (tenantId: string) => Promise<string>;
  tenantConfig: (tenantId: string) => Promise<any | null>;
  tenantName: (tenantId: string) => Promise<string>;
  tooMany: (key: string, max: number, windowMs: number) => boolean;
}

export function mountWhitelabel(app: Hono<any>, deps: WhitelabelDeps) {
  const { store } = deps;
  mkdirSync(`${EVIDENCE_DIR}/site`, { recursive: true });
  const getSite = async (tid: string) => { const d = await store.getDoc(SITE, tid); return { site: d ? (JSON.parse(d.data) as WlSite) : ({} as WlSite), created: d?.created_at }; };
  const putSite = (tid: string, s: WlSite, created?: string) => store.putDoc({ coll: SITE, id: tid, tenant_id: tid, data: JSON.stringify(s), created_at: created ?? now(), updated_at: now() });
  const legalPages = async (tid: string) => (await store.listDocs(LEGAL, tid)).map((d) => JSON.parse(d.data) as LegalPage);
  const getPage = async (tid: string, slug: string) => { const d = await store.getDoc(LEGAL, `${tid}:${slug}`); return d ? { p: JSON.parse(d.data) as LegalPage, created: d.created_at } : null; };
  const putPage = (tid: string, p: LegalPage, created?: string) => store.putDoc({ coll: LEGAL, id: `${tid}:${p.slug}`, tenant_id: tid, data: JSON.stringify(p), created_at: created ?? now(), updated_at: now() });

  // ---------------------------------------------------------------- checks
  async function dnsChecks(domain: string, ownership: { name: string; value: string } | null) {
    if (process.env.WL_TEST_ASSUME_DNS === "1") return { cname: true, txt: !!ownership }; // e2e only: no real DNS in tests
    const timeout = <T,>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 5000))]);
    const cname = await timeout(resolveCname(domain)).then((r) => r.some((x) => x.toLowerCase().replace(/\.$/, "") === saasTarget()), () => false);
    const txt = ownership ? await timeout(resolveTxt(ownership.name)).then((r) => r.some((parts) => parts.join("") === ownership.value), () => false) : false;
    return { cname, txt };
  }
  async function answers(domain: string, tid: string) {
    if (process.env.WL_TEST_ASSUME_DNS === "1") return true;
    try {
      const r = await fetch(`https://${domain}/api/tenant`, { signal: AbortSignal.timeout(8000), redirect: "manual" });
      return r.ok && ((await r.json()) as any)?.id === tid;
    } catch { return false; }
  }
  /** Re-read Cloudflare, DNS and the site itself. */
  async function refresh(tid: string) {
    const { site, created } = await getSite(tid);
    if (site.domain && site.cf) {
      try {
        const h = await getHostname(site.cf.id);
        site.cf = { id: h.id, status: h.status, ssl: h.ssl?.status ?? "unknown", ownership: h.ownership_verification ? { name: h.ownership_verification.name, value: h.ownership_verification.value } : site.cf.ownership, errors: [...(h.verification_errors ?? []), ...(h.ssl?.validation_errors ?? []).map((e) => e.message)].slice(0, 5) };
      } catch (e: any) { site.cf.errors = [e?.message ?? "Couldn't reach Cloudflare"]; }
      site.dns = await dnsChecks(site.domain, site.cf.ownership);
      site.answers = site.cf.status === "active" && site.cf.ssl === "active" ? await answers(site.domain, tid) : false;
    }
    if (site.email) {
      try {
        const d = await resend<any>("GET", `/domains/${encodeURIComponent(site.email.resendId)}`);
        site.email = { ...site.email, status: String(d.status ?? site.email.status), records: mapRecords(d.records ?? site.email.records), checkedAt: now() };
      } catch { /* keep the last known status */ }
    }
    site.checkedAt = now();
    await putSite(tid, site, created);
    return site;
  }

  // ---------------------------------------------------------------- Resend (sender domains)
  async function resend<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!emailConfigured()) throw Object.assign(new Error("Email isn't set up on the platform yet"), { status: 503 });
    const res = await fetch(`${RESEND()}${path}`, { method, headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
    const j = (await res.json().catch(() => null)) as any;
    if (!res.ok) throw Object.assign(new Error(`Email provider: ${j?.message ?? `HTTP ${res.status}`}`), { status: res.status >= 500 ? 502 : 400 });
    return j as T;
  }
  const mapRecords = (rs: any[]) => (rs ?? []).map((r: any) => ({ type: String(r.type), name: String(r.name), value: String(r.value), priority: r.priority ?? undefined, status: String(r.status ?? "not_started") }));

  /** The verified sender for a workspace's emails, or null (then the platform sender is used). */
  async function senderFor(tid: string) {
    const { site } = await getSite(tid);
    const e = site.email;
    if (!e || e.status !== "verified") return null;
    return { from: `${e.name.replace(/[<>"\r\n]/g, "")} <${e.address}>`, replyTo: e.replyTo };
  }

  // ---------------------------------------------------------------- issuer
  const isWl = async (c: any) => (await deps.plan(deps.tenantId(c))) === "whitelabel";
  const gate = async (c: any) => (await isWl(c) ? null : c.json({ error: "Custom domains, email and legal pages come with the White-label plan" }, 402));
  const err = (c: any, e: any) => c.json({ error: e?.message ?? "Something went wrong" }, (e instanceof CfError ? e.status : e?.status ?? 502) as any);

  async function status(tid: string) {
    const { site } = await getSite(tid);
    const cfg = await deps.tenantConfig(tid);
    const pages = await legalPages(tid);
    const published = new Set(pages.filter((p) => p.published || p.pdf).map((p) => p.slug));
    const steps = {
      brand: !!(cfg?.onboarding?.brandingDone || cfg?.brand?.logoUrl),
      domain: !!(site.domain && site.cf?.status === "active" && site.cf.ssl === "active" && site.answers),
      team: (await store.membersOf(tid)).length >= 1,
      email: site.email?.status === "verified",
      identity: true,
      legal: published.has("terms") && published.has("privacy"),
      footer: cfg?.poweredBy === false,
    };
    return { steps, ready: steps.domain && steps.email && steps.legal, site, pages };
  }
  const view = (tid: string, s: Awaited<ReturnType<typeof status>>, plan: string) => ({
    plan, whitelabel: plan === "whitelabel", cfConnected: cfConfigured(), emailConnected: emailConfigured(), target: saasTarget(),
    steps: s.steps, done: Object.values(s.steps).filter(Boolean).length, total: Object.keys(s.steps).length, ready: s.ready,
    domain: s.site.domain ? {
      name: s.site.domain, addedAt: s.site.addedAt ?? null, checkedAt: s.site.checkedAt ?? null,
      cname: { type: "CNAME", name: s.site.domain, value: saasTarget(), found: !!s.site.dns?.cname },
      txt: s.site.cf?.ownership ? { type: "TXT", name: s.site.cf.ownership.name, value: s.site.cf.ownership.value, found: !!s.site.dns?.txt } : null,
      cfStatus: s.site.cf?.status ?? null, ssl: s.site.cf?.ssl ?? null, answers: !!s.site.answers, errors: s.site.cf?.errors ?? [],
    } : null,
    email: s.site.email ? { name: s.site.email.name, address: s.site.email.address, replyTo: s.site.email.replyTo, domain: s.site.email.domain, status: s.site.email.status, records: s.site.email.records } : null,
    legal: s.pages.map((p) => ({ slug: p.slug, title: p.title, published: !!p.published || !!p.pdf })),
    live: s.site.live ?? null,
    preview: s.site.domain && s.site.previewKey ? `https://${s.site.domain}/?preview=${s.site.previewKey}` : null,
  });

  app.get("/whitelabel", deps.requireAdmin, async (c) => {
    const tid = deps.tenantId(c);
    return c.json(view(tid, await status(tid), await deps.plan(tid)));
  });

  app.post("/whitelabel/domain", deps.requireAdmin, async (c) => {
    const g = await gate(c); if (g) return g;
    const tid = deps.tenantId(c);
    const b = z.object({ domain: z.string().trim().toLowerCase().max(253) }).safeParse(await c.req.json().catch(() => null));
    const domain = b.success ? b.data.domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "") : "";
    if (!HOST_RE.test(domain)) return c.json({ error: "Enter a subdomain you own, like invest.yourfirm.com" }, 400);
    if (RESERVED.some((r) => domain === r || domain.endsWith(`.${r}`))) return c.json({ error: "That domain belongs to the platform. Use one of your own." }, 400);
    const owner = await store.tenantByHost(domain);
    if (owner && owner.id !== tid) return c.json({ error: "That domain is already connected to another site" }, 409);
    if (deps.tooMany(`wl-domain:${tid}`, 10, 86_400_000)) return c.json({ error: "Too many domain changes today" }, 429);
    const { site, created } = await getSite(tid);
    if (site.domain === domain && site.cf) return c.json(view(tid, await status(tid), "whitelabel"));
    try {
      const h = await createHostname(domain);
      if (site.domain && site.cf) { await deleteHostname(site.cf.id).catch(() => {}); await store.removeHost(site.domain, tid); }
      site.domain = domain; site.addedAt = now(); site.live = null; site.previewKey = randomBytes(18).toString("base64url");
      site.cf = { id: h.id, status: h.status, ssl: h.ssl?.status ?? "initializing", ownership: h.ownership_verification ? { name: h.ownership_verification.name, value: h.ownership_verification.value } : null, errors: [] };
      site.dns = { cname: false, txt: false }; site.answers = false;
      await putSite(tid, site, created);
      await store.addHost(domain, tid);
    } catch (e) { return err(c, e); }
    return c.json(view(tid, await status(tid), "whitelabel"));
  });

  app.delete("/whitelabel/domain", deps.requireAdmin, async (c) => {
    const tid = deps.tenantId(c);
    const { site, created } = await getSite(tid);
    if (!site.domain) return c.json({ error: "No domain connected" }, 404);
    if (site.cf) await deleteHostname(site.cf.id).catch((e) => console.error("[wl] delete hostname", e?.message));
    await store.removeHost(site.domain, tid);
    const { domain: _d, cf: _c, dns: _n, answers: _a, live: _l, previewKey: _p, addedAt: _t, ...rest } = site;
    await putSite(tid, rest, created);
    return c.json(view(tid, await status(tid), await deps.plan(tid)));
  });

  app.post("/whitelabel/check", deps.requireAdmin, async (c) => {
    const tid = deps.tenantId(c);
    if (deps.tooMany(`wl-check:${tid}`, 60, 3_600_000)) return c.json({ error: "Checked a lot already. Try again in a few minutes." }, 429);
    await refresh(tid);
    return c.json(view(tid, await status(tid), await deps.plan(tid)));
  });

  app.post("/whitelabel/live", deps.requireAdmin, async (c) => {
    const g = await gate(c); if (g) return g;
    const tid = deps.tenantId(c);
    const b = z.object({ live: z.boolean() }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "Bad request" }, 400);
    if (!["owner", "admin"].includes(deps.member(c).role)) return c.json({ error: "Only an owner or admin can take the site live" }, 403);
    const s = await status(tid);
    if (b.data.live && !s.ready) return c.json({ error: "Finish your domain, email and legal pages first" }, 409);
    const { site, created } = await getSite(tid);
    site.live = b.data.live ? { at: now(), by: deps.member(c).account ?? deps.member(c).email ?? "admin" } : null;
    await putSite(tid, site, created);
    return c.json(view(tid, await status(tid), "whitelabel"));
  });

  // ---- email
  app.post("/whitelabel/email", deps.requireAdmin, async (c) => {
    const g = await gate(c); if (g) return g;
    const tid = deps.tenantId(c);
    const b = z.object({ name: z.string().trim().min(2).max(60), address: z.string().trim().toLowerCase().email().max(120), replyTo: z.string().trim().toLowerCase().email().max(120).nullable().optional() }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "Enter a sender name and a sender address at your domain" }, 400);
    const domain = b.data.address.split("@")[1]!;
    if (!HOST_RE.test(domain) && !/^[a-z0-9-]+\.[a-z]{2,63}$/.test(domain)) return c.json({ error: "Use an address at a domain you own" }, 400);
    if (RESERVED.some((r) => domain === r || domain.endsWith(`.${r}`))) return c.json({ error: "Use an address at your own domain" }, 400);
    if (deps.tooMany(`wl-email:${tid}`, 10, 86_400_000)) return c.json({ error: "Too many changes today" }, 429);
    const { site, created } = await getSite(tid);
    try {
      if (!site.email || site.email.domain !== domain) {
        if (site.email) await resend("DELETE", `/domains/${encodeURIComponent(site.email.resendId)}`).catch(() => {});
        const d = await resend<any>("POST", "/domains", { name: domain });
        site.email = { name: b.data.name, address: b.data.address, replyTo: b.data.replyTo ?? null, domain, resendId: String(d.id), status: String(d.status ?? "not_started"), records: mapRecords(d.records), checkedAt: now() };
      } else site.email = { ...site.email, name: b.data.name, address: b.data.address, replyTo: b.data.replyTo ?? null };
      await putSite(tid, site, created);
    } catch (e) { return err(c, e); }
    return c.json(view(tid, await status(tid), "whitelabel"));
  });

  app.post("/whitelabel/email/verify", deps.requireAdmin, async (c) => {
    const tid = deps.tenantId(c);
    const { site } = await getSite(tid);
    if (!site.email) return c.json({ error: "Add your sender address first" }, 409);
    if (deps.tooMany(`wl-email-verify:${tid}`, 30, 3_600_000)) return c.json({ error: "Checked a lot already. Try again in a few minutes." }, 429);
    await resend("POST", `/domains/${encodeURIComponent(site.email.resendId)}/verify`).catch(() => {});
    await refresh(tid);
    return c.json(view(tid, await status(tid), await deps.plan(tid)));
  });

  app.post("/whitelabel/email/test", deps.requireAdmin, async (c) => {
    const tid = deps.tenantId(c);
    const to = deps.member(c).email;
    const s = await senderFor(tid);
    if (!s) return c.json({ error: "Your sender domain isn't verified yet" }, 409);
    if (!to) return c.json({ error: "Your account has no email address to send the test to" }, 400);
    if (deps.tooMany(`wl-email-test:${tid}`, 5, 3_600_000)) return c.json({ error: "Too many test emails. Try again later." }, 429);
    const name = await deps.tenantName(tid);
    const r = await sendEmail({ to: [to], from: s.from, replyTo: s.replyTo, subject: `Test email from ${name}`, text: `This is a test from ${name}. Emails to your investors and lawyers will look like this.`, html: `<p style="font:15px -apple-system,Segoe UI,sans-serif">This is a test from <b>${escHtml(name)}</b>. Emails to your investors and lawyers will look like this.</p>` });
    return r === "sent" ? c.json({ ok: true, to }) : c.json({ error: "The test email didn't send. Try again shortly." }, 502);
  });

  // ---- legal pages
  const SLUG = /^[a-z][a-z0-9-]{1,39}$/;
  app.get("/whitelabel/legal", deps.requireAdmin, async (c) => {
    const tid = deps.tenantId(c);
    const have = await legalPages(tid);
    const all = [...have, ...DEFAULT_LEGAL.filter((d) => !have.some((p) => p.slug === d.slug)).map((d) => ({ ...d, draft: "", draftAt: null, published: null, versions: [], pdf: null }))];
    return c.json({ pages: all.map((p) => ({ slug: p.slug, title: p.title, draft: p.draft, draftAt: p.draftAt, published: p.published ? { at: p.published.at, text: p.published.text } : null, versions: p.versions.map((v) => ({ at: v.at, by: v.by })), pdf: p.pdf })) });
  });

  app.put("/whitelabel/legal/:slug", deps.requireAdmin, async (c) => {
    const g = await gate(c); if (g) return g;
    const tid = deps.tenantId(c), slug = c.req.param("slug") ?? "";
    if (!SLUG.test(slug)) return c.json({ error: "Page address: lowercase letters, numbers and dashes" }, 400);
    const b = z.object({ title: z.string().trim().min(2).max(80), text: z.string().max(200_000) }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "Enter a title and the page text" }, 400);
    if ((await legalPages(tid)).length >= 12 && !(await getPage(tid, slug))) return c.json({ error: "Up to 12 legal pages" }, 400);
    const cur = await getPage(tid, slug);
    const p: LegalPage = cur?.p ?? { slug, title: b.data.title, draft: "", draftAt: null, published: null, versions: [], pdf: null };
    await putPage(tid, { ...p, title: b.data.title, draft: b.data.text, draftAt: now() }, cur?.created);
    return c.json({ ok: true });
  });

  app.post("/whitelabel/legal/:slug/publish", deps.requireAdmin, async (c) => {
    const g = await gate(c); if (g) return g;
    const tid = deps.tenantId(c);
    const cur = await getPage(tid, c.req.param("slug") ?? "");
    if (!cur || !cur.p.draft.trim()) return c.json({ error: "Write the page before publishing" }, 400);
    const by = deps.member(c).account ?? deps.member(c).email ?? "admin";
    const p = cur.p;
    if (p.published) p.versions = [p.published, ...p.versions].slice(0, 20);
    p.published = { text: p.draft, at: now(), by };
    await putPage(tid, p, cur.created);
    return c.json({ ok: true, publishedAt: p.published.at });
  });

  app.post("/whitelabel/legal/:slug/pdf", deps.requireAdmin, async (c) => {
    const g = await gate(c); if (g) return g;
    const tid = deps.tenantId(c), slug = c.req.param("slug") ?? "";
    if (!SLUG.test(slug)) return c.json({ error: "Bad page" }, 400);
    const buf = new Uint8Array(await c.req.arrayBuffer());
    if (buf.length > 10 * 1024 * 1024) return c.json({ error: "The PDF must be 10 MB or smaller" }, 413);
    if (buf.length < 100 || new TextDecoder().decode(buf.slice(0, 5)) !== "%PDF-") return c.json({ error: "Upload a PDF" }, 400);
    const h = sha(buf);
    await Bun.write(`${EVIDENCE_DIR}/site/${h}.pdf`, buf);
    const cur = await getPage(tid, slug);
    const title = cur?.p.title ?? DEFAULT_LEGAL.find((d) => d.slug === slug)?.title ?? slug;
    const p: LegalPage = cur?.p ?? { slug, title, draft: "", draftAt: null, published: null, versions: [], pdf: null };
    await putPage(tid, { ...p, pdf: { sha256: h, bytes: buf.length, at: now() } }, cur?.created);
    return c.json({ ok: true, sha256: h });
  });

  app.delete("/whitelabel/legal/:slug", deps.requireAdmin, async (c) => {
    const tid = deps.tenantId(c);
    await store.deleteDoc(LEGAL, `${tid}:${c.req.param("slug") ?? ""}`);
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- public (the site being visited)
  app.get("/site/legal", async (c) => {
    const pages = (await legalPages(deps.siteId(c))).filter((p) => p.published || p.pdf);
    c.header("Cache-Control", "public, max-age=60");
    return c.json({ pages: pages.map((p) => ({ slug: p.slug, title: p.title, updatedAt: p.published?.at ?? p.pdf?.at ?? null, pdf: !!p.pdf })) });
  });
  app.get("/site/legal/:slug", async (c) => {
    const cur = await getPage(deps.siteId(c), c.req.param("slug") ?? "");
    if (!cur || (!cur.p.published && !cur.p.pdf)) return c.json({ error: "Not found" }, 404);
    c.header("Cache-Control", "public, max-age=60");
    return c.json({ slug: cur.p.slug, title: cur.p.title, text: cur.p.published?.text ?? null, publishedAt: cur.p.published?.at ?? cur.p.pdf?.at ?? null, pdf: cur.p.pdf ? `/api/site/legal/${cur.p.slug}/pdf` : null });
  });
  app.get("/site/legal/:slug/pdf", async (c) => {
    const cur = await getPage(deps.siteId(c), c.req.param("slug") ?? "");
    if (!cur?.p.pdf) return c.json({ error: "Not found" }, 404);
    const f = Bun.file(`${EVIDENCE_DIR}/site/${cur.p.pdf.sha256}.pdf`);
    if (!(await f.exists())) return c.json({ error: "Not found" }, 404);
    return new Response(f, { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${cur.p.slug}.pdf"`, "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" } });
  });
  app.get("/site/preview", async (c) => {
    const { site } = await getSite(deps.siteId(c));
    const k = c.req.query("k") ?? "";
    const ok = !!site.previewKey && k.length === site.previewKey.length && timingSafeEqual(Buffer.from(k), Buffer.from(site.previewKey));
    return c.json({ ok });
  });

  /** For GET /api/tenant: is this host a white-label domain that hasn't gone live yet? */
  async function siteInfo(tenantId: string, host: string) {
    const { site } = await getSite(tenantId);
    const pages = (await legalPages(tenantId)).filter((p) => p.published || p.pdf).map((p) => ({ slug: p.slug, title: p.title }));
    return { customDomain: site.domain ?? null, live: !site.domain || host !== site.domain ? true : !!site.live, legal: pages };
  }

  // ---------------------------------------------------------------- platform admin
  const platformOnly = async (c: any, next: () => Promise<void>) => (deps.isPlatformAdmin(c) ? next() : c.json({ error: "Platform admins only" }, 403));
  app.get("/platform/whitelabel", deps.requireAdmin, platformOnly, async (c) => {
    const ids = new Set((await store.docsSince(SITE, "1970-01-01T00:00:00Z")).map((d) => d.tenant_id));
    for (const a of await store.allAssets()) if (!ids.has(a.tenant_id) && (await deps.plan(a.tenant_id)) === "whitelabel") ids.add(a.tenant_id);
    const rows = [];
    for (const tid of ids) {
      const plan = await deps.plan(tid);
      const s = await status(tid);
      rows.push({ tenantId: tid, name: await deps.tenantName(tid), ...view(tid, s, plan) });
    }
    return c.json({ cfConnected: cfConfigured(), target: saasTarget(), fallback: cfConfigured() ? await fallbackOrigin() : null, sites: rows });
  });
  app.post("/platform/whitelabel/setup", deps.requireAdmin, platformOnly, async (c) => {
    try { return c.json({ fallback: await ensureFallbackOrigin(process.env.CF_ORIGIN_HOST ?? "tokenize.diamondz.one") }); }
    catch (e) { return err(c, e); }
  });
  app.post("/platform/whitelabel/recheck", deps.requireAdmin, platformOnly, async (c) => {
    let n = 0;
    for (const d of await store.docsSince(SITE, "1970-01-01T00:00:00Z")) { await refresh(d.tenant_id).catch(() => {}); n++; }
    return c.json({ rechecked: n });
  });

  // ---------------------------------------------------------------- nginx sync (local root job) + background checks
  app.get("/internal/custom-hosts", async (c) => {
    if (c.req.header("x-real-ip") || c.req.header("x-forwarded-for") || c.req.header("cf-connecting-ip")) return c.json({ error: "Not found" }, 404);
    const want = process.env.INTERNAL_JOB_TOKEN ?? "", got = c.req.header("x-job-token") ?? "";
    if (want.length < 32 || got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) return c.json({ error: "Not found" }, 404);
    const hosts = (await store.docsSince(SITE, "1970-01-01T00:00:00Z")).map((d) => (JSON.parse(d.data) as WlSite).domain).filter((h): h is string => !!h && HOST_RE.test(h));
    return c.text([...new Set(hosts)].sort().join("\n") + "\n");
  });

  registerJob("whitelabel-check", async () => {
    let n = 0;
    for (const d of await store.docsSince(SITE, "1970-01-01T00:00:00Z")) {
      const s = JSON.parse(d.data) as WlSite;
      const pending = (s.domain && !(s.cf?.status === "active" && s.cf.ssl === "active" && s.answers)) || (s.email && s.email.status !== "verified");
      if (pending) { await refresh(d.tenant_id).catch(() => {}); n++; }
    }
    return { checked: n };
  }, 5 * 60_000, 90_000);

  return { senderFor, siteInfo };
}

export type { TenantRow };
