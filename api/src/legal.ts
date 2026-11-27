// Legal sign-off you can trust (designs L1–L4, canvas 15R3n8ALvMUcS7iPxWEPTj, approved 2026-11-20).
//
// Before an offering goes live on a real network, three independent checks replace the old self-ticked box:
//   1. Company: the issuer verifies its company through Stripe Connect (tax ID, address, owners); "verified" = Stripe
//      activated the account's transfers capability with nothing due.
//   2. Lawyer: the issuer names its securities lawyer (firm-domain email only: no free mail, not the issuer's own
//      domains). We email the lawyer a private link; the lawyer proves the inbox with a code, uploads a signed PDF
//      letter, confirms three statements and signs. The issuer never sees the link.
//   3. Diamondz review: a platform owner/admin checks the bar license and approves or sends it back.
// If the terms change after the lawyer signs (exemption, rules, network, supply, price, minimum, documents), the
// sign-off no longer matches and has to be redone.
//
// Issuer (console):  GET /api/assets/:id/legal · POST /api/legal/company · POST /api/assets/:id/legal/invite
// Lawyer (link):     GET /api/counsel/:t · POST /api/counsel/:t/code · /verify · /letter (PDF body) · /sign · /comments
// Platform admin:    GET /api/platform/reviews · POST /api/platform/reviews/:assetId · GET …/:assetId/letter
import type { Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { z } from "zod";
import type { Store } from "./store";
import { emailConfigured, escHtml, sendEmail } from "./notify";

const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const EVIDENCE_DIR = process.env.EVIDENCE_DIR ?? `${import.meta.dir}/../data/evidence`;
const CODE_TTL = 10 * 60_000, LINK_TTL = 30 * 86_400_000;
const FREE_MAIL = new Set(["gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "aol.com", "icloud.com", "me.com", "mac.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net", "yandex.com", "mail.com", "zoho.com", "hey.com", "fastmail.com", "tutanota.com"]);
export const STATES = ["AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","PR"] as const;
const domainOf = (email: string) => email.split("@")[1]?.toLowerCase() ?? "";

/** What the lawyer signs: if any of this changes afterwards, the sign-off no longer applies. */
export function termsHash(a: any) {
  const docs = ((a.documents ?? []) as { kind: string; sha256: string }[]).map((d) => `${d.kind}:${d.sha256}`).sort();
  return sha(JSON.stringify({ e: a.exemption ?? null, r: a.rules ?? null, c: a.chainId, s: a.standard, t: a.totalSupply, p: a.pricePerToken, m: a.minInvestment, l: a.lockup ?? "", d: docs }));
}

interface Legal {
  counsel: { name: string; firm: string; email: string; barState: string; barNumber: string };
  tokenHash: string; invitedAt: string; invitedBy: string; expiresAt: string;
  openedAt?: string; code?: { hash: string; at: number; tries: number }; sessions?: string[];
  letter?: { sha256: string; bytes: number; at: string };
  signed?: { at: string; name: string; barState: string; barNumber: string; terms: string; ip: string | null };
  comments?: { at: string; text: string };
  review?: { decision: "approved" | "returned"; by: string; at: string; licenseFound: boolean; note: string; terms: string };
}

export interface LegalDeps {
  store: Store;
  requireAdmin: (c: Context<any>, next: () => Promise<void>) => Promise<Response | void>;
  tenantId: (c: Context<any>) => string;
  member: (c: Context<any>) => { account: string | null; role: string; email?: string };
  isPlatform: (c: Context<any>) => boolean;
  adminAsset: (c: Context<any>, id: string) => Promise<any | null>;
  anyAsset: (id: string) => Promise<any | null>;
  tenantName: (id: string) => Promise<string>;
  /** Emails on the issuer's side (members, notification addresses): the lawyer can't use those domains. */
  issuerEmails: (tenantId: string) => Promise<string[]>;
  origin: (c: Context<any>) => string;
  tooMany: (key: string, max: number, windowMs: number) => boolean;
}

// ------------------------------------------------------------------ Stripe Connect (company verification)
const connectKey = () => process.env.STRIPE_AI_AGENT_KEY || process.env.STRIPE_SECRET_KEY || "";
async function stripe<T>(method: "GET" | "POST", path: string, form: [string, string][] = []): Promise<T> {
  const body = form.length ? new URLSearchParams(form).toString() : undefined;
  const res = await fetch((process.env.STRIPE_BASE || "https://api.stripe.com") + path, {
    method, headers: { authorization: `Bearer ${connectKey()}`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) }, body, signal: AbortSignal.timeout(20_000),
  });
  const j = (await res.json().catch(() => null)) as any;
  if (!res.ok) throw Object.assign(new Error(j?.error?.message ? `Stripe: ${j.error.message}` : `Stripe ${path} failed (HTTP ${res.status})`), { status: res.status >= 500 ? 502 : 400 });
  return j as T;
}
export function companyStatus(acct: any) {
  if (!acct) return { status: "not started" as const, name: null };
  const due = [...(acct.requirements?.currently_due ?? []), ...(acct.requirements?.past_due ?? [])];
  const verified = !!acct.details_submitted && !acct.requirements?.disabled_reason && due.length === 0 && acct.capabilities?.transfers === "active";
  return { status: verified ? ("verified" as const) : acct.details_submitted ? ("in review" as const) : ("started" as const), name: acct.company?.name ?? acct.business_profile?.name ?? null, due: due.length };
}

export function mountLegal(app: Hono<any>, deps: LegalDeps) {
  const { store } = deps;
  const now = () => new Date().toISOString();
  const getLegal = async (assetId: string) => { const d = await store.getDoc("legal", assetId); return d ? { d, l: JSON.parse(d.data) as Legal } : null; };
  const putLegal = (assetId: string, tid: string, l: Legal, created?: string) => store.putDoc({ coll: "legal", id: assetId, tenant_id: tid, data: JSON.stringify(l), created_at: created ?? now(), updated_at: now() });
  const companyAccount = async (tid: string) => { const d = await store.getDoc("kyb", tid); return d ? (JSON.parse(d.data) as { accountId: string }).accountId : null; };
  const companyOf = async (tid: string) => {
    const id = await companyAccount(tid);
    if (!id) return { status: "not started" as const, name: null };
    return companyStatus(await stripe<any>("GET", `/v1/accounts/${encodeURIComponent(id)}`).catch(() => null));
  };

  /** Everything the deploy gates need. `reasons` empty = cleared for a real network. */
  async function clearance(asset: any) {
    const tid = asset.tenantId;
    const company = await companyOf(tid);
    const g = await getLegal(asset.id);
    const terms = termsHash(asset);
    const l = g?.l;
    const signedMatches = !!l?.signed && l.signed.terms === terms;
    const approved = l?.review?.decision === "approved" && l.review.terms === terms && signedMatches;
    const reasons: string[] = [];
    if (company.status !== "verified") reasons.push("verify your company with Stripe (Go live › Verify your company)");
    if (!l) reasons.push("invite your securities lawyer to sign off");
    else if (!l.signed) reasons.push("your lawyer hasn't signed off yet");
    else if (!signedMatches) reasons.push("the terms changed after your lawyer signed: they need to sign again");
    else if (!approved) reasons.push(l.review?.decision === "returned" ? "Diamondz sent the review back: see the note" : "Diamondz hasn't approved the review yet");
    return { company, legal: l, terms, signedMatches, approved, reasons };
  }

  const stage = (l: Legal | undefined, terms: string) => !l ? "none" : l.review?.decision === "approved" && l.review.terms === terms && l.signed?.terms === terms ? "approved"
    : l.review?.decision === "returned" && l.review.terms === terms ? "returned" : l.signed ? (l.signed.terms === terms ? "signed" : "changed") : l.comments ? "comments" : l.openedAt ? "opened" : "invited";

  // ---------------- issuer
  app.get("/assets/:id/legal", deps.requireAdmin, async (c) => {
    const a = await deps.adminAsset(c, c.req.param("id") ?? "");
    if (!a) return c.json({ error: "Not found" }, 404);
    const x = await clearance(a);
    const l = x.legal;
    return c.json({
      company: x.company, emailOn: emailConfigured(), stage: stage(l, x.terms), cleared: x.reasons.length === 0, reasons: x.reasons,
      counsel: l ? { ...l.counsel, invitedAt: l.invitedAt, openedAt: l.openedAt ?? null, signedAt: l.signed?.at ?? null, comments: l.comments ?? null } : null,
      review: l?.review ? { decision: l.review.decision, at: l.review.at, note: l.review.note } : null,
    });
  });

  app.post("/legal/company", deps.requireAdmin, async (c) => {
    const tid = deps.tenantId(c);
    if (!connectKey()) return c.json({ error: "Company verification isn't configured on this server" }, 503);
    try {
      let id = await companyAccount(tid);
      if (!id) {
        const acct = await stripe<{ id: string }>("POST", "/v1/accounts", [
          ["type", "express"], ["country", "US"], ["business_type", "company"],
          ["capabilities[transfers][requested]", "true"], ["metadata[workspace]", tid], ["business_profile[name]", (await deps.tenantName(tid)).slice(0, 100)],
        ]);
        id = acct.id;
        await store.putDoc({ coll: "kyb", id: tid, tenant_id: tid, data: JSON.stringify({ accountId: id }), created_at: now(), updated_at: now() });
      }
      const back = `${deps.origin(c)}${String(c.req.query("back") ?? "/app").replace(/[^\w/?=&-]/g, "")}`;
      const link = await stripe<{ url: string }>("POST", "/v1/account_links", [["account", id], ["type", "account_onboarding"], ["refresh_url", back], ["return_url", back]]);
      return c.json({ url: link.url });
    } catch (e: any) { return c.json({ error: e.message }, e.status ?? 502); }
  });

  app.post("/assets/:id/legal/invite", deps.requireAdmin, async (c) => {
    const a = await deps.adminAsset(c, c.req.param("id") ?? "");
    if (!a) return c.json({ error: "Not found" }, 404);
    if (!emailConfigured()) return c.json({ error: "Email isn't set up on this server yet, so we can't send your lawyer the link" }, 503);
    if (deps.tooMany(`legal-invite:${a.id}`, 10, 86_400_000)) return c.json({ error: "Too many invites today for this offering" }, 429);
    const b = z.object({
      name: z.string().trim().min(3).max(120), firm: z.string().trim().min(2).max(160), email: z.string().trim().toLowerCase().email().max(200),
      barState: z.enum(STATES), barNumber: z.string().trim().regex(/^[A-Za-z0-9-]{3,20}$/),
    }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "Enter the lawyer's name, firm, firm email, state and bar number" }, 400);
    const dom = domainOf(b.data.email);
    if (FREE_MAIL.has(dom)) return c.json({ error: "Use the lawyer's email at their law firm, not a free email address" }, 400);
    const own = new Set((await deps.issuerEmails(a.tenantId)).map(domainOf).filter((d) => d && !FREE_MAIL.has(d)));
    if (own.has(dom)) return c.json({ error: "That email is on your own company's domain. Your lawyer must be at an independent firm." }, 400);
    const old = await getLegal(a.id);
    const token = randomBytes(24).toString("base64url");
    const l: Legal = { counsel: b.data, tokenHash: sha(token), invitedAt: now(), invitedBy: deps.member(c).account ?? "admin", expiresAt: new Date(Date.now() + LINK_TTL).toISOString() };
    if (old) await store.deleteDoc("legal-links", old.l.tokenHash);
    await putLegal(a.id, a.tenantId, l);
    await store.putDoc({ coll: "legal-links", id: l.tokenHash, tenant_id: a.tenantId, data: JSON.stringify({ assetId: a.id }), created_at: now(), updated_at: now() });
    const issuer = await deps.tenantName(a.tenantId);
    const link = `${deps.origin(c)}/counsel/${token}`;
    const sent = await sendEmail({
      to: [b.data.email], subject: `Sign-off requested: ${a.name} (${issuer})`,
      html: `<div style="font:14px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:560px"><p>Dear ${escHtml(b.data.name)},</p><p><b>${escHtml(issuer)}</b> has named you as securities counsel for <b>${escHtml(a.name)}</b> and asks you to review and sign off before it goes live on Diamondz Tokenize.</p><p><a href="${escHtml(link)}">Review the offering and sign</a></p><p style="color:#666">For your security, the page sends a one-time code to this inbox before it opens. The link expires in 30 days. If you don't represent this issuer, ignore this email.</p></div>`,
      text: `Dear ${b.data.name},\n\n${issuer} has named you as securities counsel for ${a.name} and asks you to review and sign off before it goes live on Diamondz Tokenize.\n\nReview and sign: ${link}\n\nThe page sends a one-time code to this inbox before it opens. The link expires in 30 days.`,
    });
    if (sent !== "sent") return c.json({ error: "We couldn't send the email. Try again in a few minutes." }, 502);
    return c.json({ ok: true, invitedAt: l.invitedAt });
  });

  // ---------------- lawyer (public link + email code)
  async function byToken(token: string) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
    const link = await store.getDoc("legal-links", sha(token));
    if (!link) return null;
    const { assetId } = JSON.parse(link.data) as { assetId: string };
    const g = await getLegal(assetId);
    if (!g || g.l.tokenHash !== sha(token) || Date.parse(g.l.expiresAt) < Date.now()) return null;
    const asset = await deps.anyAsset(assetId);
    return asset ? { ...g, asset } : null;
  }
  const COOKIE = "dt_counsel";
  const hasSession = (c: Context<any>, l: Legal) => { const s = getCookie(c, COOKIE); return !!s && (l.sessions ?? []).includes(sha(s)); };
  const limited = (c: Context<any>, k: string) => deps.tooMany(`counsel-${k}:${c.req.header("x-real-ip") ?? "local"}`, 30, 600_000);
  const mask = (e: string) => e.replace(/^(.).*(@.*)$/, "$1•••$2");

  app.get("/counsel/:token", async (c) => {
    if (limited(c, "get")) return c.json({ error: "Too many requests" }, 429);
    const x = await byToken(c.req.param("token") ?? "");
    if (!x) return c.json({ error: "This link isn't valid or has expired. Ask the issuer to send a new one." }, 404);
    if (!hasSession(c, x.l)) return c.json({ needsCode: true, email: mask(x.l.counsel.email), issuer: await deps.tenantName(x.asset.tenantId) });
    if (!x.l.openedAt) await putLegal(x.asset.id, x.asset.tenantId, { ...x.l, openedAt: now() }, x.d.created_at);
    const a = x.asset;
    const company = await companyOf(a.tenantId);
    return c.json({
      needsCode: false, issuer: await deps.tenantName(a.tenantId), company,
      counsel: x.l.counsel, letter: x.l.letter ?? null, signed: x.l.signed && x.l.signed.terms === termsHash(a) ? x.l.signed : null,
      offering: { id: a.id, name: a.name, symbol: a.symbol, chainId: a.chainId, standard: a.standard, exemption: a.exemption ?? null, totalSupply: a.totalSupply, pricePerToken: a.pricePerToken, minInvestment: a.minInvestment, lockup: a.lockup ?? "", rules: a.rules ?? null, documents: (a.documents ?? []).map((d: any) => ({ kind: d.kind, name: d.name ?? d.kind, url: d.url ?? null, sha256: d.sha256 })) },
    });
  });

  app.post("/counsel/:token/code", async (c) => {
    if (limited(c, "code")) return c.json({ error: "Too many requests" }, 429);
    const x = await byToken(c.req.param("token") ?? "");
    if (!x) return c.json({ error: "This link isn't valid" }, 404);
    if (x.l.code && Date.now() - x.l.code.at < 60_000) return c.json({ error: "A code was just sent. Wait a minute before asking for another." }, 429);
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await putLegal(x.asset.id, x.asset.tenantId, { ...x.l, code: { hash: sha(code), at: Date.now(), tries: 0 } }, x.d.created_at);
    const sent = await sendEmail({ to: [x.l.counsel.email], subject: `Your Diamondz Tokenize code: ${code}`, html: `<p style="font:16px -apple-system,Segoe UI,sans-serif">Your code to open the sign-off page is <b style="font-size:22px;letter-spacing:2px">${code}</b>. It expires in 10 minutes.</p>`, text: `Your code: ${code} (expires in 10 minutes)` });
    if (sent !== "sent") return c.json({ error: "We couldn't send the code. Try again shortly." }, 502);
    return c.json({ ok: true, email: mask(x.l.counsel.email) });
  });

  app.post("/counsel/:token/verify", async (c) => {
    if (limited(c, "verify")) return c.json({ error: "Too many requests" }, 429);
    const x = await byToken(c.req.param("token") ?? "");
    if (!x) return c.json({ error: "This link isn't valid" }, 404);
    const b = z.object({ code: z.string().trim().regex(/^\d{6}$/) }).safeParse(await c.req.json().catch(() => null));
    const cd = x.l.code;
    if (!b.success || !cd || Date.now() - cd.at > CODE_TTL || cd.tries >= 5) return c.json({ error: "That code expired. Ask for a new one." }, 400);
    const ok = timingSafeEqual(Buffer.from(sha(b.data.code)), Buffer.from(cd.hash));
    if (!ok) { await putLegal(x.asset.id, x.asset.tenantId, { ...x.l, code: { ...cd, tries: cd.tries + 1 } }, x.d.created_at); return c.json({ error: "That code didn't match" }, 400); }
    const s = randomBytes(24).toString("base64url");
    await putLegal(x.asset.id, x.asset.tenantId, { ...x.l, code: undefined, sessions: [...(x.l.sessions ?? []).slice(-4), sha(s)] }, x.d.created_at);
    setCookie(c, COOKIE, s, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "Strict", path: "/api/counsel", maxAge: 12 * 3600 });
    return c.json({ ok: true });
  });

  app.post("/counsel/:token/letter", async (c) => {
    const x = await byToken(c.req.param("token") ?? "");
    if (!x || !hasSession(c, x.l)) return c.json({ error: "Enter the emailed code first" }, 401);
    const buf = new Uint8Array(await c.req.arrayBuffer());
    if (buf.length > 10 * 1024 * 1024) return c.json({ error: "The letter must be 10 MB or smaller" }, 413);
    if (buf.length < 100 || new TextDecoder().decode(buf.slice(0, 5)) !== "%PDF-") return c.json({ error: "Upload the letter as a PDF" }, 400);
    const h = sha(buf);
    mkdirSync(`${EVIDENCE_DIR}/legal`, { recursive: true });
    await Bun.write(`${EVIDENCE_DIR}/legal/${h}.pdf`, buf);
    await putLegal(x.asset.id, x.asset.tenantId, { ...x.l, letter: { sha256: h, bytes: buf.length, at: now() } }, x.d.created_at);
    return c.json({ ok: true, sha256: h });
  });

  app.post("/counsel/:token/sign", async (c) => {
    const x = await byToken(c.req.param("token") ?? "");
    if (!x || !hasSession(c, x.l)) return c.json({ error: "Enter the emailed code first" }, 401);
    const b = z.object({ barState: z.enum(STATES), barNumber: z.string().trim().regex(/^[A-Za-z0-9-]{3,20}$/), statements: z.tuple([z.literal(true), z.literal(true), z.literal(true)]), name: z.string().trim().min(3).max(120) }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "Confirm all three statements, your bar details, and type your full name" }, 400);
    if (!x.l.letter) return c.json({ error: "Upload your signed letter first" }, 400);
    if (b.data.name.toLowerCase().replace(/\s+/g, " ") !== x.l.counsel.name.toLowerCase().replace(/\s+/g, " ")) return c.json({ error: `Type your name exactly as invited: ${x.l.counsel.name}` }, 400);
    const signed = { at: now(), name: b.data.name, barState: b.data.barState, barNumber: b.data.barNumber, terms: termsHash(x.asset), ip: c.req.header("x-real-ip") ?? null };
    await putLegal(x.asset.id, x.asset.tenantId, { ...x.l, signed, comments: undefined, review: undefined }, x.d.created_at);
    return c.json({ ok: true, signedAt: signed.at });
  });

  app.post("/counsel/:token/comments", async (c) => {
    const x = await byToken(c.req.param("token") ?? "");
    if (!x || !hasSession(c, x.l)) return c.json({ error: "Enter the emailed code first" }, 401);
    const b = z.object({ text: z.string().trim().min(3).max(4000) }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "Write your comments" }, 400);
    await putLegal(x.asset.id, x.asset.tenantId, { ...x.l, comments: { at: now(), text: b.data.text } }, x.d.created_at);
    return c.json({ ok: true });
  });

  // ---------------- platform review
  const platformOnly = (c: Context<any>) => deps.isPlatform(c) && ["owner", "admin"].includes(deps.member(c).role);
  app.get("/platform/reviews", deps.requireAdmin, async (c) => {
    if (!platformOnly(c)) return c.json({ error: "Not found" }, 404);
    const out = [];
    for (const r of await store.allAssets()) {
      const g = await getLegal(r.id);
      if (!g?.l.signed) continue;
      const a = await deps.anyAsset(r.id);
      if (!a) continue;
      const x = await clearance(a);
      out.push({
        assetId: a.id, name: a.name, issuer: await deps.tenantName(a.tenantId), chainId: a.chainId, exemption: a.exemption ?? null,
        stage: stage(g.l, x.terms), company: x.company, counsel: g.l.counsel, signed: g.l.signed, letter: g.l.letter ?? null,
        emailDomainOk: !FREE_MAIL.has(domainOf(g.l.counsel.email)), termsMatch: x.signedMatches, review: g.l.review ?? null,
      });
    }
    return c.json({ reviews: out.sort((p, q) => String(q.signed?.at).localeCompare(String(p.signed?.at))) });
  });

  app.post("/platform/reviews/:assetId", deps.requireAdmin, async (c) => {
    if (!platformOnly(c)) return c.json({ error: "Not found" }, 404);
    const a = await deps.anyAsset(c.req.param("assetId") ?? "");
    const g = a ? await getLegal(a.id) : null;
    if (!a || !g?.l.signed) return c.json({ error: "Nothing to review" }, 404);
    const b = z.object({ decision: z.enum(["approve", "return"]), licenseFound: z.boolean(), note: z.string().trim().max(2000).default("") }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "Bad request" }, 400);
    const terms = termsHash(a);
    if (b.data.decision === "approve") {
      if (!b.data.licenseFound) return c.json({ error: "Confirm the lawyer's license in the state bar directory first" }, 400);
      if (g.l.signed.terms !== terms) return c.json({ error: "The terms changed after the lawyer signed" }, 409);
      if ((await companyOf(a.tenantId)).status !== "verified") return c.json({ error: "The company isn't verified by Stripe yet" }, 409);
    } else if (!b.data.note) return c.json({ error: "Tell the issuer why it's going back" }, 400);
    const m = deps.member(c);
    const review = { decision: b.data.decision === "approve" ? ("approved" as const) : ("returned" as const), by: m.email ?? m.account ?? "platform", at: now(), licenseFound: b.data.licenseFound, note: b.data.note, terms };
    await putLegal(a.id, a.tenantId, { ...g.l, review }, g.d.created_at);
    return c.json({ ok: true, review });
  });

  app.get("/platform/reviews/:assetId/letter", deps.requireAdmin, async (c) => {
    if (!platformOnly(c)) return c.json({ error: "Not found" }, 404);
    const g = await getLegal(c.req.param("assetId") ?? "");
    if (!g?.l.letter) return c.json({ error: "Not found" }, 404);
    const f = Bun.file(`${EVIDENCE_DIR}/legal/${g.l.letter.sha256}.pdf`);
    if (!(await f.exists())) return c.json({ error: "Not found" }, 404);
    return new Response(f, { headers: { "content-type": "application/pdf", "content-disposition": "inline", "cache-control": "private, no-store" } });
  });

  return { clearance };
}
