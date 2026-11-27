// Investor identity checks (KYC) through Sumsub — designs K1–K5 (approved 2026-11-18).
//
// One check per (issuer/tenant, wallet): Sumsub knows the investor as externalUserId `${tenant}:${wallet}`, so a single
// check covers all of that issuer's offerings. We store only Sumsub's applicant id, the status and, for "try again",
// Sumsub's message to the investor. Documents, selfies and names stay in Sumsub; the console fetches a short name and
// country LIVE when an issuer opens it (kept in memory for a few minutes, never written to the database).
//
// Status truth: Sumsub's applicant record. Webhooks (applicantPending/Reviewed/OnHold…) only tell us to re-read it, so
// out-of-order or duplicate deliveries can't put us in a wrong state. Investors can also trigger a re-read (throttled).
// Approving a wallet on chain stays a MANUAL issuer action (owner decision 2026-11-18).
//
//   GET  /api/kyc/config                      → { enabled }
//   POST /api/kyc/start   {wallet, chainId, ts, signature}  → { id, token, status }   (wallet signature proves ownership)
//   POST /api/kyc/:id/token {wallet}          → { token }  (SDK refresh)
//   GET  /api/kyc/:id?wallet=                 → status view (only with the private id + matching wallet)
//   POST /api/kyc/webhook                     ← Sumsub (x-payload-digest HMAC over the raw body)
//   GET  /api/kyc                              → issuer: every check for this tenant + live short name/country
//
// Licensees (IP registry, designs F2/F5) use the same flow under their own scope: `${tenant}-lic` (individuals, the
// investor level) or `${tenant}-lickyb` (companies, SUMSUB_KYB_LEVEL). Start with { licensee: { assetId, kind } }.
//
// Provider: Sumsub when its keys are set, otherwise Stripe Identity (STRIPE_SECRET_KEY): a hosted document + selfie
// check. The check row is the same; applicant_id holds Stripe's VerificationSession id. Stripe webhooks
// (identity.verification_session.*) go to POST /api/kyc/stripe-webhook (STRIPE_IDENTITY_WEBHOOK_SECRET) and, like
// Sumsub's, only trigger a re-read of the session. A sk_test_ key is test mode: the console labels every check "test".
//
// Env: SUMSUB_APP_TOKEN, SUMSUB_SECRET_KEY, SUMSUB_LEVEL (default "id-and-liveness"), SUMSUB_KYB_LEVEL (default
//      "kyb-basic", a business-verification level set up in the Sumsub dashboard), SUMSUB_WEBHOOK_SECRET,
//      SUMSUB_CLIENT_ID (the Sumsub account id, e.g. diamondzshadow.net — makes dashboard links open the right account),
//      SUMSUB_BASE (tests only).
import type { Hono, Context } from "hono";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getAddress, isAddress, type Hex } from "viem";
import { z } from "zod";
import type { KycRow, Store } from "./store";

const base = () => process.env.SUMSUB_BASE || "https://api.sumsub.com";
const level = () => process.env.SUMSUB_LEVEL || "id-and-liveness";
const kybLevel = () => process.env.SUMSUB_KYB_LEVEL || "kyb-basic";
/** Licensee scopes (see header). Companies get the business-verification level. */
export const licenseeScope = (tenantId: string, kind: "company" | "individual") => `${tenantId}-${kind === "company" ? "lickyb" : "lic"}`;
const levelFor = (scope: string) => (scope.endsWith("-lickyb") ? kybLevel() : level());
const sumsubOn = () => !!(process.env.SUMSUB_APP_TOKEN && process.env.SUMSUB_SECRET_KEY);
export const kycProvider = (): "sumsub" | "stripe" | null => (sumsubOn() ? "sumsub" : process.env.STRIPE_SECRET_KEY ? "stripe" : null);
export const kycEnabled = () => kycProvider() !== null;
const kycTestMode = () => (kycProvider() === "sumsub" ? (process.env.SUMSUB_APP_TOKEN ?? "").startsWith("sbx:") : (process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_test_"));

// ---------------------------------------------------------------- Stripe Identity
interface VSession {
  id: string; status: "requires_input" | "processing" | "verified" | "canceled"; url: string | null;
  last_error: { code: string | null; reason: string | null } | null;
  verified_outputs?: { first_name?: string | null; last_name?: string | null; address?: { country?: string | null } | null } | null;
}
async function stripe<T>(method: "GET" | "POST", path: string, form?: Record<string, string>): Promise<T> {
  const res = await fetch((process.env.STRIPE_BASE || "https://api.stripe.com") + path, {
    method,
    headers: { authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await res.json().catch(() => null)) as any;
  if (!res.ok) throw new Error(`Stripe ${path.split("?")[0]} failed (HTTP ${res.status}${j?.error?.code ? ` ${j.error.code}` : ""})`);
  return j as T;
}
/** Stripe's session → our status. Stripe has no final rejection: a failed attempt asks for another try. */
export function statusFromSession(v: VSession | null): Pick<KycRow, "status" | "reject_labels" | "user_comment"> {
  if (!v || v.status === "canceled") return { status: "init", reject_labels: null, user_comment: null };
  if (v.status === "verified") return { status: "approved", reject_labels: null, user_comment: null };
  if (v.status === "processing") return { status: "pending", reject_labels: null, user_comment: null };
  if (v.last_error?.code) return { status: "retry", reject_labels: JSON.stringify([v.last_error.code]), user_comment: v.last_error.reason?.slice(0, 500) ?? null };
  return { status: "init", reject_labels: null, user_comment: null };
}
async function newSession(row: KycRow, returnUrl: string): Promise<VSession> {
  return stripe<VSession>("POST", "/v1/identity/verification_sessions", {
    type: "document",
    "options[document][require_matching_selfie]": "true",
    "options[document][require_live_capture]": "true",
    client_reference_id: `${row.tenant_id}:${row.wallet}`,
    "metadata[kyc_id]": row.id, "metadata[tenant]": row.tenant_id, "metadata[wallet]": row.wallet,
    return_url: returnUrl,
  });
}
/** Stripe-Signature: t=…,v1=… — HMAC-SHA256 of `${t}.${raw}`, within 5 minutes. */
export function stripeSigOk(raw: Buffer, header: string, secret: string, now = Date.now()) {
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!t || Math.abs(now / 1000 - t) > 300) return false;
  const want = createHmac("sha256", secret).update(`${t}.`).update(raw).digest();
  return header.split(",").filter((kv) => kv.startsWith("v1=")).some((kv) => {
    const got = Buffer.from(kv.slice(3), "hex");
    return got.length === want.length && timingSafeEqual(got, want);
  });
}

export const kycMessage = (p: { tenantId: string; wallet: string; ts: number }) =>
  `Diamondz Tokenize identity check\nIssuer: ${p.tenantId}\nWallet: ${p.wallet}\nTime: ${p.ts}`;
const SIG_MAX_AGE_S = 600;

// ---------------------------------------------------------------- Sumsub API (App Token + HMAC-SHA256 signature)
async function sumsub<T>(method: "GET" | "POST", pathQ: string, body?: unknown): Promise<{ status: number; json: T | null }> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const payload = body === undefined ? "" : JSON.stringify(body);
  const sig = createHmac("sha256", process.env.SUMSUB_SECRET_KEY!).update(ts + method + pathQ + payload).digest("hex");
  const res = await fetch(base() + pathQ, {
    method,
    headers: { "X-App-Token": process.env.SUMSUB_APP_TOKEN!, "X-App-Access-Ts": ts, "X-App-Access-Sig": sig, accept: "application/json", ...(payload ? { "content-type": "application/json" } : {}) },
    body: payload || undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json: T | null = null;
  try { json = text ? (JSON.parse(text) as T) : null; } catch { /* non-JSON error page */ }
  return { status: res.status, json };
}

const userIdOf = (tenantId: string, wallet: string) => `${tenantId}:${wallet.toLowerCase()}`;

async function accessToken(tenantId: string, wallet: string): Promise<string> {
  const q = `/resources/accessTokens?userId=${encodeURIComponent(userIdOf(tenantId, wallet))}&levelName=${encodeURIComponent(levelFor(tenantId))}&ttlInSecs=1200`;
  const r = await sumsub<{ token?: string }>("POST", q);
  if (r.status !== 200 || !r.json?.token) throw new Error(`Sumsub token failed (HTTP ${r.status})`);
  return r.json.token;
}

interface Applicant {
  id: string;
  info?: { firstName?: string; lastName?: string; country?: string };
  fixedInfo?: { firstName?: string; lastName?: string; country?: string };
  review?: { reviewStatus?: string; reviewResult?: { reviewAnswer?: "GREEN" | "RED"; reviewRejectType?: "RETRY" | "FINAL"; rejectLabels?: string[]; moderationComment?: string } };
}

async function applicantByUser(tenantId: string, wallet: string): Promise<Applicant | null> {
  const r = await sumsub<Applicant>("GET", `/resources/applicants/-;externalUserId=${encodeURIComponent(userIdOf(tenantId, wallet))}/one`);
  if (r.status === 404) return null;
  if (r.status !== 200 || !r.json?.id) throw new Error(`Sumsub applicant lookup failed (HTTP ${r.status})`);
  return r.json;
}

/** Sumsub's review → our status. Only a completed GREEN review counts as approved. */
export function statusFromReview(a: Applicant | null): Pick<KycRow, "status" | "reject_labels" | "user_comment"> {
  const rv = a?.review;
  if (!a || !rv?.reviewStatus || rv.reviewStatus === "init") return { status: "init", reject_labels: null, user_comment: null };
  if (rv.reviewStatus !== "completed") return { status: "pending", reject_labels: null, user_comment: null };
  const res = rv.reviewResult;
  if (res?.reviewAnswer === "GREEN") return { status: "approved", reject_labels: null, user_comment: null };
  if (res?.reviewAnswer === "RED") {
    const labels = res.rejectLabels?.length ? JSON.stringify(res.rejectLabels.slice(0, 20)) : null;
    return res.reviewRejectType === "RETRY"
      ? { status: "retry", reject_labels: labels, user_comment: res.moderationComment?.slice(0, 500) ?? null }
      : { status: "rejected", reject_labels: labels, user_comment: null };
  }
  return { status: "pending", reject_labels: null, user_comment: null };
}

/** Investor-facing view: no reject reasons for a final rejection (design K3). */
const publicView = (r: KycRow) => ({ id: r.id, wallet: r.wallet, status: r.status, message: r.status === "retry" ? r.user_comment : null, updatedAt: r.updated_at });

// Live short names for the console: memory only, a few minutes.
const nameCache = new Map<string, { at: number; v: { name: string | null; country: string | null } }>();
async function shortName(applicantId: string) {
  const hit = nameCache.get(applicantId);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.v;
  if (applicantId.startsWith("vs_")) {
    const r = await stripe<VSession>("GET", `/v1/identity/verification_sessions/${encodeURIComponent(applicantId)}?expand[]=verified_outputs`).catch(() => null);
    const o = r?.verified_outputs;
    const v = { name: o?.first_name ? `${o.first_name}${o.last_name ? ` ${o.last_name[0]}.` : ""}` : null, country: o?.address?.country ?? null };
    nameCache.set(applicantId, { at: Date.now(), v });
    return v;
  }
  const r = await sumsub<Applicant>("GET", `/resources/applicants/${encodeURIComponent(applicantId)}/one`).catch(() => null);
  const i = r?.json?.fixedInfo?.firstName ? r.json.fixedInfo : r?.json?.info;
  const v = { name: i?.firstName ? `${i.firstName}${i.lastName ? ` ${i.lastName[0]}.` : ""}` : null, country: i?.country ?? null };
  nameCache.set(applicantId, { at: Date.now(), v });
  return v;
}

interface Deps {
  store: Store;
  requireAdmin: (c: Context<any>, next: () => Promise<void>) => Promise<Response | void>;
  tenantId: (c: Context) => string;
  /** Whether records of this issuer may be read through this website (platform site: every self-serve workspace). */
  siteHas: (c: Context, tenantId: string) => boolean;
  /** A listed offering on this website, with `tenantId` = its issuer. */
  listedAsset: (c: Context, id: string) => Promise<any | null>;
  /** A deployed offering whose asset is registered in the IP registry (licensees may verify for it, listed or not). */
  ipAsset?: (c: Context, id: string) => Promise<any | null>;
  /** This website's https origin (Stripe sends the investor back here). */
  origin?: (c: Context) => string;
  /** Verifies an EOA or ERC-1271 wallet signature on the given network. */
  verifySig: (chainId: number, wallet: `0x${string}`, message: string, signature: Hex) => Promise<boolean>;
}

export function mountKyc(app: Hono<any>, deps: Deps) {
  const { store } = deps;
  const hits = new Map<string, number[]>();
  const limited = (key: string, max: number, windowMs: number) => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) return true;
    hits.set(key, [...recent, now]);
    return false;
  };
  const ipOf = (c: Context) => c.req.header("x-real-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";

  /** Re-read the applicant from Sumsub and store the result. */
  async function refresh(row: KycRow): Promise<KycRow> {
    let next: Pick<KycRow, "applicant_id" | "status" | "reject_labels" | "user_comment">;
    if (row.applicant_id?.startsWith("vs_") || (!row.applicant_id && kycProvider() === "stripe")) {
      const v = row.applicant_id ? await stripe<VSession>("GET", `/v1/identity/verification_sessions/${encodeURIComponent(row.applicant_id)}`) : null;
      next = { applicant_id: row.applicant_id, ...statusFromSession(v) };
    } else {
      const a = await applicantByUser(row.tenant_id, row.wallet);
      next = { applicant_id: a?.id ?? row.applicant_id, ...statusFromReview(a) };
    }
    if (next.status === row.status && next.applicant_id === row.applicant_id && next.user_comment === row.user_comment && next.reject_labels === row.reject_labels) return row;
    const updated_at = new Date().toISOString();
    await store.updateKyc(row.id, { ...next, updated_at });
    return { ...row, ...next, updated_at };
  }

  app.get("/kyc/config", (c) => c.json({ enabled: kycEnabled(), provider: kycProvider(), testMode: kycEnabled() ? kycTestMode() : false, level: kycProvider() === "sumsub" ? level() : null }));

  app.post("/kyc/start", async (c) => {
    if (!kycEnabled()) return c.json({ error: "Identity checks aren't set up on this platform yet" }, 503);
    if (limited(`start:${ipOf(c)}`, 10, 10 * 60_000)) return c.json({ error: "Too many attempts, try again in a few minutes" }, 429);
    const b = z.object({
      wallet: z.string(), chainId: z.number().int(), ts: z.number().int(), signature: z.string().regex(/^0x[0-9a-fA-F]+$/), assetId: z.string().max(40).optional(),
      licensee: z.object({ assetId: z.string().max(40), kind: z.enum(["company", "individual"]) }).optional(),
    }).safeParse(await c.req.json().catch(() => null));
    if (!b.success || !isAddress(b.data.wallet)) return c.json({ error: "Bad request" }, 400);
    if (Math.abs(Date.now() / 1000 - b.data.ts) > SIG_MAX_AGE_S) return c.json({ error: "Signature expired, sign again" }, 400);
    // The check belongs to the offering's issuer (several issuers share the platform site); without an offering, the site's.
    let tenantId = deps.tenantId(c);
    if (b.data.licensee) {
      const asset = deps.ipAsset ? await deps.ipAsset(c, b.data.licensee.assetId) : null;
      if (!asset) return c.json({ error: "Asset not found" }, 404);
      tenantId = licenseeScope(asset.tenantId, b.data.licensee.kind);
    } else if (b.data.assetId) {
      const asset = await deps.listedAsset(c, b.data.assetId);
      if (!asset) return c.json({ error: "Offering not found" }, 404);
      tenantId = asset.tenantId;
    }
    const wallet = getAddress(b.data.wallet);
    const signedFor = b.data.licensee ? tenantId.replace(/-lic(kyb)?$/, "") : tenantId;
    const ok = await deps.verifySig(b.data.chainId, wallet, kycMessage({ tenantId: signedFor, wallet, ts: b.data.ts }), b.data.signature as Hex).catch(() => false);
    if (!ok) return c.json({ error: "Signature doesn't match the wallet" }, 401);
    let row = await store.kycByWallet(tenantId, wallet);
    if (!row) {
      const now = new Date().toISOString();
      row = { id: `kyc_${randomBytes(12).toString("hex")}`, tenant_id: tenantId, wallet: wallet.toLowerCase(), applicant_id: null, status: "init", reject_labels: null, user_comment: null, created_at: now, updated_at: now };
      try { await store.insertKyc(row); } catch { row = (await store.kycByWallet(tenantId, wallet))!; } // two tabs at once
    }
    if (kycProvider() === "stripe") {
      try {
        row = await refresh(row);
        if (row.status === "approved" || row.status === "pending") return c.json({ id: row.id, token: null, url: null, provider: "stripe", status: publicView(row) });
        const site = deps.origin ? deps.origin(c) : "https://tokenize.diamondz.one";
        const back = b.data.licensee ? `${site}/ip/${encodeURIComponent(b.data.licensee.assetId)}?stripe=done` : `${site}/verify/${encodeURIComponent(b.data.assetId ?? "")}?stripe=done`;
        // Reuse the open session (its url is live while it needs input); a canceled or missing one gets a new session.
        let v = row.applicant_id ? await stripe<VSession>("GET", `/v1/identity/verification_sessions/${encodeURIComponent(row.applicant_id)}`) : null;
        if (!v || v.status === "canceled" || !v.url) {
          v = await newSession(row, back);
          const updated_at = new Date().toISOString();
          await store.updateKyc(row.id, { applicant_id: v.id, updated_at });
          row = { ...row, applicant_id: v.id, updated_at };
        }
        return c.json({ id: row.id, token: null, url: v.url, provider: "stripe", status: publicView(row) });
      } catch (e) {
        console.error(`[kyc] stripe start: ${(e as Error).message}`);
        return c.json({ error: "Couldn't reach the verification service, try again shortly" }, 422);
      }
    }
    try {
      const token = await accessToken(tenantId, wallet);
      row = await refresh(row).catch(() => row!);
      return c.json({ id: row.id, token, provider: "sumsub", status: publicView(row) });
    } catch (e) {
      console.error(`[kyc] start: ${(e as Error).message}`);
      return c.json({ error: "Couldn't reach the verification service, try again shortly" }, 422);
    }
  });

  const owned = async (c: Context, wallet: string | undefined) => {
    const row = await store.getKyc(c.req.param("id") ?? "");
    // Licensee checks live under `${issuer}-lic` / `-lickyb`; the website shows the issuer itself.
    if (!row || !deps.siteHas(c, row.tenant_id.replace(/-lic(kyb)?$/, "")) || !wallet || row.wallet !== wallet.toLowerCase()) return null;
    return row;
  };

  app.post("/kyc/:id/token", async (c) => {
    if (kycProvider() !== "sumsub") return c.json({ error: "Identity checks aren't set up" }, 503);
    const body = (await c.req.json().catch(() => null)) as { wallet?: string } | null;
    const row = await owned(c, body?.wallet);
    if (!row) return c.json({ error: "Not found" }, 404);
    if (limited(`tok:${row.id}`, 20, 60 * 60_000)) return c.json({ error: "Too many attempts" }, 429);
    try { return c.json({ token: await accessToken(row.tenant_id, row.wallet) }); }
    catch { return c.json({ error: "Couldn't reach the verification service" }, 422); }
  });

  app.get("/kyc/:id", async (c) => {
    let row = await owned(c, c.req.query("wallet"));
    if (!row) return c.json({ error: "Not found" }, 404);
    // Waiting on Sumsub: re-read at most every 20 s per check (webhooks normally get there first).
    const stale = Date.now() - Date.parse(row.updated_at) > 20_000;
    if (kycEnabled() && (row.status === "init" || row.status === "pending") && stale && !limited(`poll:${row.id}`, 1, 20_000)) {
      row = await refresh(row).catch(() => row!);
    }
    return c.json(publicView(row));
  });

  // Sumsub → us. Verify over the RAW body before parsing; any valid delivery just triggers a re-read.
  app.post("/kyc/webhook", async (c) => {
    const secret = process.env.SUMSUB_WEBHOOK_SECRET;
    if (!secret) return c.json({ error: "Webhook not configured" }, 503);
    const raw = Buffer.from(await c.req.arrayBuffer());
    const alg = ({ HMAC_SHA1_HEX: "sha1", HMAC_SHA256_HEX: "sha256", HMAC_SHA512_HEX: "sha512" } as Record<string, string>)[c.req.header("x-payload-digest-alg") ?? "HMAC_SHA256_HEX"];
    const given = c.req.header("x-payload-digest") ?? "";
    if (!alg || !/^[0-9a-f]+$/i.test(given)) return c.json({ error: "Bad signature" }, 401);
    const want = createHmac(alg, secret).update(raw).digest();
    const got = Buffer.from(given, "hex");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return c.json({ error: "Bad signature" }, 401);
    let evt: { externalUserId?: string } = {};
    try { evt = JSON.parse(raw.toString("utf8")); } catch { return c.json({ ok: true }); }
    const m = /^([a-z0-9_-]{1,64}):(0x[0-9a-f]{40})$/.exec(evt.externalUserId ?? "");
    if (!m) return c.json({ ok: true }); // not one of ours (e.g. another integration on the same Sumsub account)
    const row = await store.kycByWallet(m[1]!, m[2]!);
    if (row) await refresh(row).catch((e) => console.error(`[kyc] webhook refresh: ${(e as Error).message}`));
    return c.json({ ok: true });
  });

  // Stripe → us (identity.verification_session.*). Signature over the RAW body; any valid delivery triggers a re-read.
  app.post("/kyc/stripe-webhook", async (c) => {
    const secret = process.env.STRIPE_IDENTITY_WEBHOOK_SECRET;
    if (!secret) return c.json({ error: "Webhook not configured" }, 503);
    const raw = Buffer.from(await c.req.arrayBuffer());
    if (!stripeSigOk(raw, c.req.header("stripe-signature") ?? "", secret)) return c.json({ error: "Bad signature" }, 401);
    let evt: any = {};
    try { evt = JSON.parse(raw.toString("utf8")); } catch { return c.json({ ok: true }); }
    const kycId = evt?.data?.object?.metadata?.kyc_id;
    if (typeof evt.type !== "string" || !evt.type.startsWith("identity.verification_session.") || typeof kycId !== "string") return c.json({ ok: true });
    const row = await store.getKyc(kycId);
    if (row && row.applicant_id === evt.data.object.id) await refresh(row).catch((e) => console.error(`[kyc] stripe webhook refresh: ${(e as Error).message}`));
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- issuer (design K5)
  app.get("/kyc", deps.requireAdmin, async (c) => {
    // ?scope=licensees → the issuer's licensee checks (individuals and companies).
    const t = deps.tenantId(c);
    const rows = c.req.query("scope") === "licensees"
      ? [...(await store.kycForTenant(licenseeScope(t, "company"), 300)), ...(await store.kycForTenant(licenseeScope(t, "individual"), 300))]
      : await store.kycForTenant(t, 300);
    const out = [];
    for (const [i, r] of rows.entries()) {
      // Short name + country live from Sumsub for the 60 newest checks that reached Sumsub.
      const who = kycEnabled() && r.applicant_id && r.status !== "init" && i < 60 ? await shortName(r.applicant_id) : { name: null, country: null };
      out.push({ id: r.id, wallet: getAddress(r.wallet), kind: r.tenant_id.endsWith("-lickyb") ? "company" : "individual", status: r.status, applicantId: r.applicant_id, rejectLabels: r.reject_labels ? (JSON.parse(r.reject_labels) as string[]) : [], name: who.name, country: who.country, createdAt: r.created_at, updatedAt: r.updated_at });
    }
    return c.json({ enabled: kycEnabled(), provider: kycProvider(), sandbox: kycEnabled() && kycTestMode(), clientId: process.env.SUMSUB_CLIENT_ID || null, checks: out });
  });
}

/** Licensee check status for an issuer (api/src/ip.ts): "approved" only after a completed GREEN Sumsub review. */
export async function licenseeStatus(store: Store, tenantId: string, wallet: string) {
  const rows = (await Promise.all([store.kycByWallet(licenseeScope(tenantId, "company"), wallet), store.kycByWallet(licenseeScope(tenantId, "individual"), wallet)])).filter(Boolean) as KycRow[];
  return rows.find((r) => r.status === "approved") ?? rows[0] ?? null;
}
