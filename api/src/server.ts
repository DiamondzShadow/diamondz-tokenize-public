// Diamondz Tokenize API — multi-tenant. A tenant is resolved from the request Host header.
// Storage: SQLite (bun:sqlite) at $DB_PATH.
// Admin auth: "Sign in with Google". The browser gets a Google ID token; we verify its signature against
// Google's keys, then require a verified Workspace account whose domain (`hd`) is in the tenant's
// adminDomains. A random session id goes in an HttpOnly cookie; only its SHA-256 is stored.
import { Database } from "bun:sqlite";
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import { createPublicClient, http, getAddress, isAddress, parseUnits, keccak256, toHex, decodeEventLog, parseAbiItem, verifyMessage as viemVerifyMessage, type Address } from "viem";
import { NETWORKS, networkById, assetOracleFor, trexFor, rpcUrl } from "./chains";
import { PLANS, TRIAL_DAYS, planById } from "../../web/src/lib/pricing";
import { mountProof, oracleAbi } from "./proof";
import { mountPayouts } from "./payouts";
import { CLASS_CHECKS, classHash, kindByHash } from "../../web/src/lib/verification";
import { ITEM_ID } from "../../web/src/lib/catalog";
import { KYC_TOPIC, ACCREDITED_TOPIC, TREX_ARTIFACTS, mountTrex } from "./trex";
import { Rules, Details, Documents, verifyRules, verifyModule, saleWindow, hasRules, withSanctions } from "./rules";
import { mountMastercard } from "./mastercard";
import { mountBankProof } from "./bankproof";
import { mountJobs, registerJob } from "./jobs";
import { mountEdgar } from "./edgar";
import { mountMarkets } from "./markets";
import { canWrite, mountTeam, roleLabel } from "./team";
import { mountSignals } from "./secsignals";
import { collectEvidence } from "./evidence";
import { mfaGate, mountMfa } from "./mfa";
import { mountClients } from "./clients";
import { mountLegal } from "./legal";
import { mountEsign } from "./esign";
import { mountWhitelabel } from "./whitelabel";
import { mountCsp } from "./csp";
import { mountApprovals } from "./approvals";
import { MongoStore, SqliteStore, type Role, type Store, type TenantRow, type LeadRow } from "./store";
import { emailConfigured, sendLeadAlert } from "./notify";
import { kycEnabled, mountKyc } from "./kyc";
import { mountGeo } from "./geo";
import { mountIp } from "./ip";
import { mountCards } from "./cards";
import { mountRpcProxy } from "./rpcproxy";
import { mountStellar } from "./stellar";
import { closeLapsedSales, mountStellarOps } from "./stellardeploy";
import { STELLAR_NETWORKS, isStellarChain } from "../../web/src/lib/chains";
import { stats as logStats } from "./logindex";

const PORT = Number(process.env.PORT ?? 8911);
const DB_PATH = process.env.DB_PATH ?? `${import.meta.dir}/../data/tokenize.db`;
const DEFAULT_TENANT = "diamondz";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
// Investor sign-in (thirdweb in-app wallets). Public client id; sponsored chains = where the thirdweb project pays gas.
const THIRDWEB_CLIENT_ID = /^[0-9a-f]{32}$/.test(process.env.THIRDWEB_CLIENT_ID ?? "") ? process.env.THIRDWEB_CLIENT_ID! : null;
const THIRDWEB_SPONSORED_CHAINS = (process.env.THIRDWEB_SPONSORED_CHAINS ?? "").split(",").map(Number).filter((n) => n > 0);
const SESSION_COOKIE = "dt_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
// The platform's Safe ON EACH CHAIN (Safes are per-chain: the same address can be empty elsewhere).
// PLATFORM_FEE_RECIPIENTS="4663:0x…,42161:0x…". It receives the flat per-offering fee on mainnet deploys.
// PLATFORM_SALE_FEE_BPS is a %-of-sale fee kept for completeness; leave it 0 (a % of securities sales is
// transaction-based compensation). Every deployed sale is checked against both.
const PLATFORM_SALE_FEE_BPS = Math.max(0, Math.min(1000, Number(process.env.PLATFORM_SALE_FEE_BPS ?? 0)));
const PLATFORM_FEE_RECIPIENTS: Record<string, string> = {};
for (const part of (process.env.PLATFORM_FEE_RECIPIENTS ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
  const [id, addr] = part.split(":");
  const net = networkById(Number(id));
  if (!net || net.testnet || !addr || !isAddress(addr)) throw new Error(`PLATFORM_FEE_RECIPIENTS: bad entry "${part}"`);
  PLATFORM_FEE_RECIPIENTS[String(net.id)] = getAddress(addr);
}
/** The fee every sale on `chainId` must carry. */
function saleFeeFor(chainId: number) {
  const recipient = PLATFORM_FEE_RECIPIENTS[String(chainId)];
  return recipient && PLATFORM_SALE_FEE_BPS > 0 ? { recipient, bps: PLATFORM_SALE_FEE_BPS } : { recipient: ZERO, bps: 0 };
}
const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

const ASSET_CLASSES = ["real-estate", "energy", "private-equity", "private-credit", "funds", "music-ip", "film", "sports", "collectibles", "carbon"] as const;
const STANDARDS = ["erc3643", "erc7943", "erc4626", "erc721", "erc1155", "story-ip", "stellar-rwa"] as const;
const PAY_METHODS = ["card", "usdc", "usdg", "pyusd", "eurc", "bank", "deposit-token"] as const;

const ZERO = "0x0000000000000000000000000000000000000000";

// ------------------------------------------------------------------ db
await Bun.$`mkdir -p ${DB_PATH.substring(0, DB_PATH.lastIndexOf("/"))}`.quiet();
// STORE=mongo ⇒ MongoDB Atlas (shared by every API server); otherwise the single-file SQLite database.
const store: Store = process.env.STORE === "mongo"
  ? await MongoStore.connect(process.env.MONGO_URI ?? "", process.env.MONGO_DB ?? "tokenize")
  : new SqliteStore(new Database(DB_PATH, { create: true }));
console.log(`[store] ${store.kind}`);

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const Domain = z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/);
const envDomains = () => (process.env.ADMIN_DOMAINS ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);

const TenantConfig = z.object({
  /** Google Workspace sign-in domains. Self-serve workspaces (thirdweb accounts + memberships) may have none. */
  adminDomains: z.array(Domain),
  name: z.string().trim().min(1).max(60),
  brand: z.object({
    primary: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    theme: z.enum(["dark", "light"]),
    logoUrl: z.string().url().startsWith("https://").max(500).optional(),
  }),
  offerings: z.array(z.enum(ASSET_CLASSES)).max(ASSET_CLASSES.length),
  poweredBy: z.boolean(),
  // Setup checklist milestones the console can't derive from data (see web/src/app/onboarding.tsx).
  onboarding: z
    .object({ brandingDone: z.boolean(), paymentsDone: z.boolean(), counselReady: z.boolean(), counselName: z.string().trim().max(120), counselDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
    .partial()
    .default({}),
  payments: z.object({
    methods: z.array(z.enum(PAY_METHODS)).max(PAY_METHODS.length),
    payoutCurrency: z.string().max(40),
    distributionFeeBps: z.number().int().min(0).max(1000),
    treasury: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "treasury must be a full 0x address").optional(),
    /** The issuer's own Stripe account (Connect, Standard). Written only by POST /api/cards/connect, never by PATCH. */
    stripeAccount: z.string().regex(/^acct_[A-Za-z0-9]{6,64}$/).optional(),
  }),
  /** chainId -> InvestorRegistry. Written only by verified deployments, never by PATCH. */
  registries: z.record(z.string(), z.string()).default({}),
  /** "chainId:wallet" -> the issuer's ERC-3643 ClaimIssuer. Written only by /trex/prepare, never by PATCH. */
  claimIssuers: z.record(z.string(), z.string()).default({}),
  /** Pricing plan. Set by the platform operator, never by the tenant's own PATCH. */
  plan: z.enum(["free", "launch", "growth", "whitelabel"]).default("launch"),
  /** Growth trial end for self-serve workspaces (ISO). Set only when the workspace is created. */
  trialEndsAt: z.string().optional(),
  /** Who gets an email when someone uses the contact form. Private: never in publicTenant(). */
  notifyEmails: z.array(z.string().trim().toLowerCase().email().max(200)).max(5).default([]),
  /** A pending plan-change request (POST /billing/plan-request). Never via PATCH; cleared when the plan changes. */
  planRequest: z.object({ plan: z.enum(["launch", "growth", "whitelabel"]), annual: z.boolean(), at: z.string() }).optional(),
});
type TenantConfig = z.infer<typeof TenantConfig>;

/** Create the platform tenant on first boot (admin domains from $ADMIN_DOMAINS). */
async function bootstrap() {
  const existing = await store.getTenant(DEFAULT_TENANT);
  if (existing) {
    // Migration: tenants created before Google sign-in have no adminDomains.
    const cfg = JSON.parse(existing.config);
    if (!cfg.adminDomains?.length && envDomains().length) {
      cfg.adminDomains = envDomains();
      await store.setTenantConfig(DEFAULT_TENANT, JSON.stringify(cfg));
    }
    return;
  }
  const config: TenantConfig = {
    adminDomains: envDomains(),
    name: "Diamondz Tokenize",
    brand: { primary: "#7CE7F0", theme: "dark" },
    offerings: [...ASSET_CLASSES],
    poweredBy: false,
    onboarding: {},
    registries: {},
    plan: "launch",
    payments: { methods: ["card", "usdc", "usdg", "bank"], payoutCurrency: "USDC on Base", distributionFeeBps: 25 },
  };
  if (!config.adminDomains.length) console.warn("[bootstrap] ADMIN_DOMAINS is empty: nobody can sign in to the console");
  // admin_key_hash is a legacy column (admin keys were replaced by Google sign-in); store an unusable value.
  await store.insertTenant({ id: DEFAULT_TENANT, config: JSON.stringify(config), admin_key_hash: "disabled" });
  const hosts = (process.env.DEFAULT_HOSTS ?? "localhost,127.0.0.1,tokenize.diamondz.one").split(",");
  for (const h of hosts) await store.addHost(h.trim().toLowerCase(), DEFAULT_TENANT);
}
await bootstrap();

// ------------------------------------------------------------------ helpers

function hostOf(c: Context): string {
  // Only the Host header (nginx sets it with `proxy_set_header Host $host`). Never X-Forwarded-Host:
  // a client could spoof it to read another tenant's config.
  const h = c.req.header("host") ?? "";
  return h.trim().toLowerCase().replace(/:\d+$/, "");
}

function resolveTenant(c: Context): Promise<TenantRow | null> {
  return store.tenantByHost(hostOf(c));
}

const legalContact = () => {
  const e = (process.env.LEGAL_CONTACT_EMAIL ?? "").trim().toLowerCase();
  return z.string().email().safeParse(e).success ? e : null;
};
async function publicTenant(t: TenantRow) {
  const cfg = JSON.parse(t.config) as TenantConfig;
  const hosts = await store.hostsOf(t.id);
  const { adminDomains, notifyEmails: _private, planRequest: _private2, ...rest } = cfg;
  return { id: t.id, hosts, ...rest, onboarding: rest.onboarding ?? {}, registries: rest.registries ?? {},
    plan: planById(rest.plan), plans: PLANS,
    platform: { saleFeeBps: PLATFORM_SALE_FEE_BPS, feeRecipients: PLATFORM_FEE_RECIPIENTS },
    // Diamondz's own contact for privacy and legal requests (owner-set env), shown on /legal pages on every tenant.
    legal: { contactEmail: legalContact() }, auth: { googleClientId: GOOGLE_CLIENT_ID || null, domains: adminDomains, thirdwebClientId: THIRDWEB_CLIENT_ID, sponsoredChains: THIRDWEB_SPONSORED_CHAINS } };
}

interface Session { email: string; name: string | null; account: string | null }

/**
 * The signed-in user and the workspace (tenant) they act on.
 *  - Google Workspace sign-in (account = null): the site's own tenant, as before.
 *  - thirdweb account sign-in: only on the platform site; the session's ACTIVE workspace, and only while the account is
 *    still a member of it. `tenant: null` = signed in but no workspace yet (must create one).
 */
async function sessionFor(c: Context, site: TenantRow): Promise<{ session: Session; tenant: TenantRow | null; role: Role } | null> {
  const sid = getCookie(c, SESSION_COOKIE);
  if (!sid) return null;
  const row = await store.getSession(sha(sid));
  if (!row || row.expires_at < Date.now()) return null;
  const session: Session = { email: row.email, name: row.name, account: row.account ?? null };
  // Google Workspace sign-in (white-label admins) predates roles: full access, as before.
  if (!row.account) return row.tenant_id === site.id ? { session, tenant: site, role: "owner" } : null;
  if (site.id !== DEFAULT_TENANT) return null;
  const member = (await store.membershipsOf(row.account)).find((m) => m.tenant_id === row.tenant_id);
  if (!member) return { session, tenant: null, role: "viewer" };
  const ws = row.tenant_id === site.id ? site : await store.getTenant(row.tenant_id);
  return { session, tenant: ws, role: member.role };
}

/** Blocks cross-site writes: a state-changing request must come from this same site. */
function sameOrigin(c: Context): boolean {
  if (c.req.method === "GET" || c.req.method === "HEAD") return true;
  const origin = c.req.header("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host.toLowerCase().replace(/:\d+$/, "") === hostOf(c);
  } catch {
    return false;
  }
}

// Stellar networks validate here but stay out of NETWORKS (EVM-only code paths iterate that list).
const CHAIN_IDS = [...NETWORKS.map((n) => n.id), ...STELLAR_NETWORKS.map((n) => n.id)];
/** Stellar offerings use the Stellar RWA token and nothing else; EVM standards never deploy to Stellar. */
const chainStandardError = (d: { chainId: number; standard: string }) =>
  isStellarChain(d.chainId) !== (d.standard === "stellar-rwa") ? "On Stellar, the token type is the regulated security token (Stellar); other token types need an EVM network" : null;
const AssetCore = z.object({
  name: z.string().trim().min(1).max(64),
  symbol: z.string().regex(/^[A-Z0-9]{1,11}$/),
  assetClass: z.enum(ASSET_CLASSES),
  standard: z.enum(STANDARDS),
  chainId: z.number().int().refine((id) => CHAIN_IDS.includes(id), "unsupported network"),
  totalSupply: z.string().regex(/^[1-9]\d{0,17}$/, "whole number of tokens, 1 to 18 digits"),
  pricePerToken: z.string().regex(/^(\d{1,12}(\.\d{1,6})?)?$/).optional().default(""),
  minInvestment: z.string().regex(/^(\d{1,12}(\.\d{1,2})?)?$/).optional().default(""),
  schedule: z.string().max(40).optional().default(""),
  lockup: z.string().max(40).optional().default(""),
  /** The offering exemption the issuer expects (wizard step 4). Informational; counsel decides. */
  exemption: z.enum(["506c", "regs", "unsure"]).optional().default("unsure"),
  /** Wizard step 2: answers specific to the asset class (designs W7–W10). */
  details: Details.optional().default({}),
  /** Wizard step 5: rules the token enforces on chain (design W11). */
  rules: Rules.optional().default({} as any),
  /** sha256 fingerprints of the offering documents; their manifest hash becomes the token's documentURI. */
  documents: Documents.optional().default([]),
});
const Listing = z.object({
  description: z.string().max(4000).optional().default(""),
  imageUrl: z.union([z.literal(""), z.string().url().startsWith("https://").max(500)]).optional().default(""),
  location: z.string().max(120).optional().default(""),
  listed: z.boolean().optional().default(false),
});
const LISTING_KEYS = ["description", "imageUrl", "location", "listed"] as const;

// Drafts saved before networks had ids stored a chain name.
const LEGACY_CHAINS: Record<string, number> = {
  Base: 8453, Arbitrum: 42161, Polygon: 137, Ethereum: 1, "Base Sepolia (testnet)": 84532, "Arbitrum Sepolia (testnet)": 421614,
};
function upgradeAsset(d: any) {
  if (d.chainId == null && typeof d.chain === "string") d.chainId = LEGACY_CHAINS[d.chain] ?? 84532;
  delete d.chain;
  return d;
}

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");

// ------------------------------------------------------------------ app
type Env = { Variables: { tenant: TenantRow; site: TenantRow; session: Session; member: { account: string | null; role: Role } } };
const app = new Hono<Env>().basePath("/api");
mountSignals(app); // first, so it sees every response (security alerts)
mountGeo(app); // sanctioned-country visitors are refused before anything else runs

app.use("*", async (c, next) => {
  const t = await resolveTenant(c);
  if (!t) return c.json({ error: "Unknown site" }, 404);
  c.set("tenant", t);
  c.set("site", t); // the website being visited; "tenant" may later become the signed-in workspace
  await next();
});

const requireAdmin = async (c: Context<Env>, next: () => Promise<void>) => {
  const s = await sessionFor(c, c.get("tenant"));
  if (!s) return c.json({ error: "Please sign in" }, 401);
  if (!sameOrigin(c)) return c.json({ error: "Cross-site request blocked" }, 403);
  if (!s.tenant) return c.json({ error: "Create your workspace first", needsWorkspace: true }, 403);
  c.set("session", s.session);
  c.set("tenant", s.tenant); // from here on, "tenant" is the workspace being administered
  c.set("member", { account: s.session.account?.toLowerCase() ?? null, role: s.role });
  // Two-step sign-in (2026-11-20): enforced for account sign-ins; Google Workspace sign-ins rely on their IdP.
  if (s.session.account) {
    const gate = await mfaGate(store, s.session.account, sha(getCookie(c, SESSION_COOKIE)!), s.role, c.req.method);
    if (gate) return c.json(gate.body, gate.status as 401 | 403);
  }
  // Team roles (design 2): a member may only make the console writes their role allows.
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const path = c.req.path.replace(/^\/api/, "") || "/";
    const body = path === "/tenant" ? await c.req.json().catch(() => null) : undefined;
    if (!canWrite(s.role, c.req.method, path, body)) {
      await audit(c, s.tenant.id, s.session, s.role, path, 403);
      return c.json({ error: `Your role (${roleLabel(s.role)}) can't do this. Ask the workspace owner or an admin.`, role: s.role }, 403);
    }
    await next();
    await audit(c, s.tenant.id, s.session, s.role, path, c.res.status);
    return;
  }
  await next();
};

/** Audit trail of console writes (ISO 27001 A.8.15, SOC 2 CC7.2, NIST CSF DE.CM): who, role, what, when, result.
 *  Never the request body: it can hold personal data. Failures to record never block the request. */
async function audit(c: Context<Env>, tenantId: string, session: Session, role: Role, path: string, status: number) {
  const at = new Date().toISOString();
  const entry = { at, who: session.email, account: session.account?.toLowerCase() ?? null, role, method: c.req.method, path, status, ip: c.req.header("x-real-ip") ?? null };
  await store.putDoc({ coll: "audit", id: `${at}_${randomBytes(4).toString("hex")}`, tenant_id: tenantId, data: JSON.stringify(entry), created_at: at, updated_at: at })
    .catch((e) => console.error("[audit] write failed", (e as Error).message));
}

app.get("/audit", requireAdmin, async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 200) || 200, 1), 2000);
  const rows = (await store.listDocs("audit", c.get("tenant").id)).slice(0, limit).map((d) => JSON.parse(d.data));
  if (c.req.query("format") === "csv") {
    const cols = ["at", "who", "role", "method", "path", "status", "ip"] as const;
    const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", "attachment; filename=\"audit-log.csv\"");
    return c.body([cols.join(","), ...rows.map((r: any) => cols.map((k) => q(r[k])).join(","))].join("\n"));
  }
  return c.json({ entries: rows });
});
/** Signed in with a thirdweb account (workspace optional). */
const requireAccount = async (c: Context<Env>, next: () => Promise<void>) => {
  const s = await sessionFor(c, c.get("tenant"));
  if (!s || !s.session.account) return c.json({ error: "Please sign in" }, 401);
  if (!sameOrigin(c)) return c.json({ error: "Cross-site request blocked" }, 403);
  c.set("session", s.session);
  await next();
};

app.get("/health", (c) => c.json({ ok: true, logIndex: logStats }));
// Uptime monitoring (2026-11-20): the external checker hits this. 200 only when the database answers within 5 s.
app.get("/health/ready", async (c) => {
  const t0 = Date.now();
  const db = await Promise.race([store.getTenant(DEFAULT_TENANT).then((t) => !!t, () => false), new Promise<boolean>((r) => setTimeout(() => r(false), 5000))]);
  c.header("Cache-Control", "no-store");
  return c.json({ ok: db, db: db ? "up" : "down", ms: Date.now() - t0 }, db ? 200 : 503);
});

// Installable app (PWA) manifest, per website: a white-label site installs under its own name, color and logo.
app.get("/manifest.webmanifest", (c) => {
  const t = c.get("tenant");
  const cfg = JSON.parse(t.config) as TenantConfig;
  const dark = cfg.brand.theme === "dark";
  const bg = dark ? "#0B0D10" : "#FBFAF7";
  const platform = t.id === DEFAULT_TENANT;
  const icons = [
    ...(cfg.brand.logoUrl && !platform ? [{ src: cfg.brand.logoUrl, sizes: "any", purpose: "any" }] : []),
    { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ];
  const shortcuts = [
    { name: "Marketplace", short_name: "Offerings", url: "/market?src=pwa" },
    { name: "Your income", short_name: "Income", url: "/portfolio?src=pwa" },
    { name: platform ? "Issuer console" : "Console", short_name: "Console", url: "/app?src=pwa" },
  ];
  c.header("Content-Type", "application/manifest+json; charset=utf-8");
  c.header("Cache-Control", "public, max-age=3600");
  return c.body(JSON.stringify({
    id: "/", name: cfg.name, short_name: cfg.name.length > 12 ? cfg.name.split(/\s+/)[0]!.slice(0, 12) : cfg.name,
    description: platform ? "Tokenize real assets, verify investors and pay income on chain." : `Invest in ${cfg.name} offerings and receive income on chain.`,
    start_url: "/?src=pwa", scope: "/", display: "standalone", background_color: bg, theme_color: bg,
    categories: ["finance", "business"], icons, shortcuts,
  }));
});
app.get("/tenant", async (c) => c.json({ ...(await publicTenant(c.get("tenant"))), site: await whitelabel.siteInfo(c.get("tenant").id, hostOf(c)) }));
app.get("/auth/me", requireAdmin, (c) => c.json({ ...c.get("session"), role: c.get("member").role }));

app.post("/auth/google", async (c) => {
  const t = c.get("tenant");
  if (!sameOrigin(c)) return c.json({ error: "Cross-site request blocked" }, 403);
  if (!GOOGLE_CLIENT_ID) return c.json({ error: "Google sign-in is not configured" }, 503);
  const body = await c.req.json().catch(() => null);
  const credential = typeof body?.credential === "string" ? body.credential : "";
  if (!credential) return c.json({ error: "Missing Google credential" }, 400);

  let p: Record<string, unknown>;
  try {
    ({ payload: p } = await jwtVerify(credential, googleKeys, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: GOOGLE_CLIENT_ID,
    }));
  } catch {
    return c.json({ error: "Google sign-in could not be verified" }, 401);
  }
  const email = String(p.email ?? "").toLowerCase();
  const hd = String(p.hd ?? "").toLowerCase();
  const allowed = (JSON.parse(t.config) as TenantConfig).adminDomains;
  // `hd` is only set for Google Workspace accounts, so consumer Gmail never passes.
  if (p.email_verified !== true || !hd || !allowed.includes(hd) || !email.endsWith(`@${hd}`)) {
    return c.json({ error: `Use your ${allowed.map((d) => "@" + d).join(" or ")} Google Workspace account` }, 403);
  }

  const sid = randomBytes(32).toString("base64url");
  const expires = Date.now() + SESSION_TTL_MS;
  await store.purgeSessions(Date.now());
  await store.createSession({ id_hash: sha(sid), tenant_id: t.id, email, name: typeof p.name === "string" ? p.name.slice(0, 120) : null, expires_at: expires, account: null });
  setCookie(c, SESSION_COOKIE, sid, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
  return c.json({ email, name: p.name ?? null });
});

// ------------------------------------------------------------------ issuer accounts (thirdweb sign-in, platform site only)
// The browser logs in with thirdweb (Google / Apple / email code), then signs this one-time message with the login's
// account. We verify the signature (plain or ERC-1271 smart account) — no thirdweb secret needed. The email thirdweb
// reports is kept for display and contact only; it is not proof of anything.
export const loginMessage = (p: { host: string; address: string; nonce: string; issuedAt: string }) =>
  `Sign in to Diamondz Tokenize\nSite: ${p.host}\nAccount: ${p.address}\nNonce: ${p.nonce}\nIssued: ${p.issuedAt}`;
const NONCE_TTL_MS = 10 * 60_000;
const authHits = new Map<string, number[]>();
const tooMany = (key: string, max: number, windowMs: number) => {
  const now = Date.now();
  const recent = (authHits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) return true;
  authHits.set(key, [...recent, now]);
  return false;
};
const ipKey = (c: Context) => c.req.header("x-real-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
async function verifyAccountSig(chainId: number, address: Address, message: string, signature: `0x${string}`) {
  if (await viemVerifyMessage({ address, message, signature }).catch(() => false)) return true;
  const net = networkById(chainId);
  if (!net) return false;
  const client = createPublicClient({ transport: http(rpcUrl(net), { timeout: 10_000 }) });
  return client.verifyMessage({ address, message, signature }).catch(() => false);
}
const workspacesOf = async (address: string) => {
  const out = [];
  for (const m of await store.membershipsOf(address)) {
    const t = await store.getTenant(m.tenant_id);
    if (!t) continue;
    const cfg = JSON.parse(t.config) as TenantConfig;
    out.push({ id: t.id, name: cfg.name, role: m.role, plan: planById(cfg.plan).id, trialEndsAt: cfg.trialEndsAt ?? null });
  }
  return out;
};

app.get("/auth/nonce", async (c) => {
  if (c.get("tenant").id !== DEFAULT_TENANT) return c.json({ error: "Not found" }, 404);
  if (tooMany(`nonce:${ipKey(c)}`, 30, 10 * 60_000)) return c.json({ error: "Too many requests" }, 429);
  const nonce = randomBytes(16).toString("hex");
  const issuedAt = new Date().toISOString();
  await store.setKv(`nonce:${nonce}`, issuedAt, issuedAt);
  return c.json({ nonce, issuedAt, message: loginMessage({ host: hostOf(c), address: "{address}", nonce, issuedAt }) });
});

app.post("/auth/thirdweb", async (c) => {
  const t = c.get("tenant");
  if (t.id !== DEFAULT_TENANT) return c.json({ error: "Not found" }, 404);
  if (!sameOrigin(c)) return c.json({ error: "Cross-site request blocked" }, 403);
  if (tooMany(`login:${ipKey(c)}`, 20, 10 * 60_000)) return c.json({ error: "Too many attempts, try again in a few minutes" }, 429);
  const b = z.object({
    address: z.string(), chainId: z.number().int(), nonce: z.string().regex(/^[0-9a-f]{32}$/), issuedAt: z.string(),
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/), email: z.string().trim().toLowerCase().email().max(200).optional(), name: z.string().trim().max(120).optional(),
  }).safeParse(await c.req.json().catch(() => null));
  if (!b.success || !isAddress(b.data.address)) return c.json({ error: "Bad request" }, 400);
  const issued = await store.getKv(`nonce:${b.data.nonce}`);
  if (!issued || issued.value !== b.data.issuedAt || Date.now() - Date.parse(issued.value) > NONCE_TTL_MS) return c.json({ error: "Sign-in expired, try again" }, 400);
  if ((await store.bumpCounter(`nonce-used:${b.data.nonce}`)) !== 1) return c.json({ error: "Sign-in already used, try again" }, 400);
  const address = getAddress(b.data.address);
  const msg = loginMessage({ host: hostOf(c), address, nonce: b.data.nonce, issuedAt: b.data.issuedAt });
  if (!(await verifyAccountSig(b.data.chainId, address, msg, b.data.signature as `0x${string}`))) return c.json({ error: "Sign-in couldn't be verified" }, 401);

  const now = new Date().toISOString();
  await store.upsertAccount({ address, email: b.data.email ?? null, name: b.data.name ?? null, created_at: now, last_login_at: now });
  const acct = (await store.getAccount(address))!;
  const workspaces = await workspacesOf(address);
  const sid = randomBytes(32).toString("base64url");
  await store.purgeSessions(Date.now());
  // No workspace yet: the session points at the platform tenant but grants nothing until a membership exists.
  await store.createSession({ id_hash: sha(sid), tenant_id: workspaces[0]?.id ?? DEFAULT_TENANT, email: acct.email ?? address.toLowerCase(), name: acct.name, expires_at: Date.now() + SESSION_TTL_MS, account: address });
  setCookie(c, SESSION_COOKIE, sid, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "Lax", path: "/", maxAge: SESSION_TTL_MS / 1000 });
  return c.json({ account: { address, email: acct.email, name: acct.name }, workspaces, active: workspaces[0]?.id ?? null });
});

app.get("/account", requireAccount, async (c) => {
  const s = c.get("session");
  const acct = await store.getAccount(s.account!);
  const sid = getCookie(c, SESSION_COOKIE)!;
  const row = await store.getSession(sha(sid));
  const workspaces = await workspacesOf(s.account!);
  return c.json({ account: { address: getAddress(s.account!), email: acct?.email ?? null, name: acct?.name ?? null }, workspaces, active: workspaces.some((w) => w.id === row?.tenant_id) ? row!.tenant_id : null });
});

app.post("/workspaces", requireAccount, async (c) => {
  if (c.get("tenant").id !== DEFAULT_TENANT) return c.json({ error: "Not found" }, 404);
  const s = c.get("session");
  if (tooMany(`ws:${s.account}`, 5, 24 * 3_600_000)) return c.json({ error: "You've created several workspaces today. Try again tomorrow." }, 429);
  const b = z.object({ name: z.string().trim().min(2).max(60), role: z.string().trim().max(80).optional(), offerings: z.array(z.enum(ASSET_CLASSES)).max(ASSET_CLASSES.length).optional() })
    .safeParse(await c.req.json().catch(() => null));
  if (!b.success) return c.json({ error: "Enter your company name (2 to 60 characters)" }, 400);
  const id = `ws_${randomBytes(6).toString("hex")}`;
  const now = new Date();
  const config: TenantConfig = {
    adminDomains: [], name: b.data.name, brand: { primary: "#1E3A6B", theme: "light" },
    offerings: b.data.offerings?.length ? b.data.offerings : [...ASSET_CLASSES], poweredBy: true, onboarding: {},
    registries: {}, claimIssuers: {}, plan: "free", trialEndsAt: new Date(now.getTime() + TRIAL_DAYS * 86_400_000).toISOString(),
    payments: { methods: ["usdc"], payoutCurrency: "USDC on Base", distributionFeeBps: 25 }, notifyEmails: [],
  };
  const parsed = TenantConfig.safeParse(config);
  if (!parsed.success) return c.json({ error: issues(parsed.error) }, 500);
  await store.insertTenant({ id, config: JSON.stringify(parsed.data), admin_key_hash: "disabled" });
  await store.addMembership({ account: s.account!, tenant_id: id, role: "owner", created_at: now.toISOString() });
  await store.setSessionTenant(sha(getCookie(c, SESSION_COOKIE)!), id);
  return c.json({ workspace: { id, name: b.data.name, role: "owner", plan: "free", trialEndsAt: config.trialEndsAt } });
});

app.post("/workspaces/:id/switch", requireAccount, async (c) => {
  const s = c.get("session");
  const id = c.req.param("id") ?? "";
  if (!(await store.membershipsOf(s.account!)).some((m) => m.tenant_id === id)) return c.json({ error: "Not found" }, 404);
  await store.setSessionTenant(sha(getCookie(c, SESSION_COOKIE)!), id);
  return c.json({ ok: true });
});

/** The workspace the console is acting on (for account sign-ins this differs from the site's tenant). */
app.get("/workspace", requireAdmin, async (c) => c.json(await publicTenant(c.get("tenant"))));

app.post("/auth/logout", async (c) => {
  if (!sameOrigin(c)) return c.json({ error: "Cross-site request blocked" }, 403);
  const sid = getCookie(c, SESSION_COOKIE);
  if (sid) await store.deleteSession(sha(sid));
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

app.patch("/tenant", requireAdmin, async (c) => {
  const t = c.get("tenant");
  const current = JSON.parse(t.config) as TenantConfig;
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "JSON body required" }, 400);
  // Logo, colors and theme are Growth features: a Free workspace keeps them during its trial only.
  if (body.brand && planById(current.plan).testnetOnly && !(current.trialEndsAt && Date.parse(current.trialEndsAt) > Date.now())) {
    const b = body.brand as Record<string, unknown>;
    if (["primary", "theme", "logoUrl"].some((k) => k in b && b[k] !== (current.brand as Record<string, unknown>)[k])) {
      return c.json({ error: "Your Growth trial has ended. Choose Growth or White-label to change your logo, colors and theme." }, 403);
    }
  }
  const { adminDomains: _ignored, registries: _ignored2, plan: _ignored3, claimIssuers: _ignored4, notifyEmails: _ignored5, planRequest: _ignored6, trialEndsAt: _ignored7, ...safeBody } = body;
  const parsed = TenantConfig.safeParse({ ...current, ...safeBody, adminDomains: current.adminDomains, registries: current.registries ?? {}, claimIssuers: current.claimIssuers ?? {}, plan: current.plan ?? "launch", brand: { ...current.brand, ...(body.brand ?? {}) }, onboarding: { ...(current.onboarding ?? {}), ...(body.onboarding ?? {}) }, payments: { ...current.payments, ...(body.payments ?? {}), stripeAccount: current.payments?.stripeAccount } });
  if (!parsed.success) return c.json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
  await store.setTenantConfig(t.id, JSON.stringify(parsed.data));
  return c.json(await publicTenant({ ...t, config: JSON.stringify(parsed.data) }));
});

function rowToAsset(r: { id: string; tenant_id: string; data: string; created_at: string; updated_at: string }) {
  return { id: r.id, tenantId: r.tenant_id, ...upgradeAsset(JSON.parse(r.data)), createdAt: r.created_at, updatedAt: r.updated_at };
}
const getAssetRow = (id: string, tenantId: string) => store.getAsset(id, tenantId);

app.get("/assets", requireAdmin, async (c) => {
  const rows = await store.listAssets(c.get("tenant").id);
  return c.json(rows.map(rowToAsset));
});

app.get("/assets/:id", requireAdmin, async (c) => {
  const r = await getAssetRow(c.req.param("id") ?? "", c.get("tenant").id);
  return r ? c.json(rowToAsset(r)) : c.json({ error: "Not found" }, 404);
});

app.post("/assets", requireAdmin, async (c) => {
  const parsed = AssetCore.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: issues(parsed.error) }, 400);
  const mismatch = chainStandardError(parsed.data);
  if (mismatch) return c.json({ error: mismatch }, 400);
  if (parsed.data.standard === "story-ip") return c.json({ error: "Story IP is retired. Use the platform's IP registry: pick ERC-7943 or ERC-3643 for music and film." }, 400);
  const id = `ast_${randomBytes(8).toString("hex")}`;
  const now = new Date().toISOString();
  const data = JSON.stringify({ ...parsed.data, rules: withSanctions(parsed.data.rules), ...Listing.parse({}), status: "draft" });
  await store.insertAsset({ id, tenant_id: c.get("tenant").id, data, created_at: now, updated_at: now });
  return c.json(rowToAsset({ id, tenant_id: c.get("tenant").id, data, created_at: now, updated_at: now }), 201);
});

/** Drafts: terms and listing editable. Deployed: only listing fields (the terms are on chain). */
app.patch("/assets/:id", requireAdmin, async (c) => {
  const r = await getAssetRow(c.req.param("id") ?? "", c.get("tenant").id);
  if (!r) return c.json({ error: "Not found" }, 404);
  const current = upgradeAsset(JSON.parse(r.data));
  const body = (await c.req.json().catch(() => ({}))) ?? {};
  const deployed = current.status === "deployed";
  let next: any;
  if (deployed) {
    const changesTerms = Object.keys(body).some((k) => k in AssetCore.shape && JSON.stringify(body[k]) !== JSON.stringify(current[k]));
    if (changesTerms) return c.json({ error: "This asset is deployed: its terms are on chain and can't be edited here" }, 409);
    const listing = Listing.safeParse({ ...pick(current, LISTING_KEYS), ...pick(body, LISTING_KEYS) });
    if (!listing.success) return c.json({ error: issues(listing.error) }, 400);
    // Investors only see offerings from issuers whose company passed Stripe business verification.
    if (listing.data.listed && !current.listed && (await legal.companyOf(c.get("tenant").id)).status !== "verified") {
      return c.json({ error: "Verify your company before listing (Go live › Verify your company)." }, 409);
    }
    next = { ...current, ...listing.data };
  } else {
    if (current.trex) {
      const fixed = ["name", "symbol", "chainId", "standard", "rules"].filter((k) => k in body && JSON.stringify(body[k]) !== JSON.stringify(current[k]));
      if (fixed.length) return c.json({ error: `The ERC-3643 suite is already deployed, so ${fixed.join(", ")} can't change` }, 409);
    }
    if (current.stellar) {
      const fixed = ["name", "symbol", "chainId", "standard", "rules", "totalSupply", "assetClass"].filter((k) => k in body && JSON.stringify(body[k]) !== JSON.stringify(current[k]));
      if (fixed.length) return c.json({ error: `The Stellar deployment has started, so ${fixed.join(", ")} can't change` }, 409);
    }
    const core = AssetCore.safeParse({ ...current, ...body });
    const listing = Listing.safeParse({ ...pick(current, LISTING_KEYS), ...pick(body, LISTING_KEYS) });
    if (!core.success) return c.json({ error: issues(core.error) }, 400);
    const mismatch = chainStandardError(core.data);
    if (mismatch) return c.json({ error: mismatch }, 400);
    if (!listing.success) return c.json({ error: issues(listing.error) }, 400);
    if (listing.data.listed) return c.json({ error: "Deploy the asset before listing it on the marketplace" }, 409);
    // Sanctioned countries are always blocked; not re-applied once a deployment has started (its rules are fixed).
    const rules = current.trex || current.stellar ? core.data.rules : withSanctions(core.data.rules);
    next = { ...core.data, rules, ...listing.data, status: "draft", ...(current.trex ? { trex: current.trex } : {}), ...(current.stellar ? { stellar: current.stellar } : {}), ...(current.formD ? { formD: current.formD } : {}) };
  }
  const now = new Date().toISOString();
  const data = JSON.stringify(next);
  await store.updateAsset(r.id, r.tenant_id, data, now);
  return c.json(rowToAsset({ ...r, data, updated_at: now }));
});

function pick(o: any, keys: readonly string[]) {
  const out: any = {};
  for (const k of keys) if (o && k in o) out[k] = o[k];
  return out;
}

// ------------------------------------------------------------------ deployment verification
const ROLE_ADMIN = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
const ROLE_MINTER = keccak256(toHex("MINTER_ROLE"));
const tokenAbi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "maxSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "registry", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "hasRole", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "supportsInterface", stateMutability: "view", inputs: [{ type: "bytes4" }], outputs: [{ type: "bool" }] },
] as const;
const saleAbi = [
  ...["token", "payToken", "treasury", "feeRecipient"].map((name) => ({ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }) as const),
  ...["price", "cap", "minPurchase"].map((name) => ({ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }) as const),
  { type: "function", name: "feeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "oracle", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "hasRole", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "bool" }] },
] as const;
const vaultAbi = [
  ...["name", "symbol"].map((name) => ({ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }) as const),
  ...["asset", "registry", "oracle"].map((name) => ({ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }) as const),
  { type: "function", name: "depositCap", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;
// ERC-1155 offerings (PermissionedMultiToken + PrimarySale1155): one item, token id ITEM_ID.
const multiAbi = [
  ...["name", "symbol"].map((name) => ({ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }) as const),
  { type: "function", name: "registry", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "itemExists", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "maxSupply", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "hasRole", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "supportsInterface", stateMutability: "view", inputs: [{ type: "bytes4" }], outputs: [{ type: "bool" }] },
] as const;
// ERC-721 offerings (PermissionedNFT + PrimarySale721).
const nftAbi = [
  ...["name", "symbol"].map((name) => ({ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }) as const),
  { type: "function", name: "registry", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "maxSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "hasRole", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "supportsInterface", stateMutability: "view", inputs: [{ type: "bytes4" }], outputs: [{ type: "bool" }] },
] as const;
const saleWindowAbi = [
  { type: "function", name: "startsAt", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "endsAt", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "maxNavChangeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
] as const;
const sale1155Abi = [...saleAbi, { type: "function", name: "tokenId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const;
const erc20Abi = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

const Deployment = z.object({
  registry: z.string().refine(isAddress, "bad address"),
  token: z.string().refine(isAddress, "bad address"),
  sale: z.string().refine(isAddress, "bad address"),
  payToken: z.string().refine(isAddress, "bad address"),
  /** OfferingRules contract (ERC-20/721/1155/vault offerings with rules); omitted when the draft has none. */
  rules: z.string().refine(isAddress, "bad address").optional(),
  txs: z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/)).max(30).default([]),
  /** Mainnet only: the tx that paid the flat offering fee to the platform Safe. */
  feeTx: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
});
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const registryAbi = [
  { type: "function", name: "sanctionsOracle", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "hasRole", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "bool" }] },
] as const;
const feeTxUsed = async (tx: string) =>
  (await store.allAssets()).some((r) => JSON.parse(r.data)?.deployment?.feeTx?.toLowerCase() === tx.toLowerCase());

/** Reads the deployed contracts back from the chain and checks they match the draft and platform rules. */
async function verifyDeployment(asset: any, tenantCfg: TenantConfig, dep: z.infer<typeof Deployment>): Promise<string[]> {
  const net = networkById(asset.chainId);
  if (!net) return ["unsupported network"];
  // RPC_<chainId> overrides the public RPC (private endpoints, or a local fork in tests).
  const rpc = rpcUrl(net);
  const client = createPublicClient({ transport: http(rpc, { timeout: 20_000, retryCount: 2 }) });
  const token = getAddress(dep.token), sale = getAddress(dep.sale), registry = getAddress(dep.registry), pay = getAddress(dep.payToken);
  const errs: string[] = [];
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const read = <T,>(address: Address, abi: any, functionName: string, args: any[] = []) =>
    client.readContract({ address, abi, functionName, args }) as Promise<T>;

  for (const [label, a] of [["token", token], ["sale", sale], ["registry", registry]] as const) {
    const code = await client.getCode({ address: a });
    if (!code || code === "0x") errs.push(`${label} has no contract code on ${net.name}`);
  }
  if (errs.length) return errs;

  // Payment token: the network's stablecoin, or the platform's Test USD on testnets without one.
  if (net.stable) {
    if (!eq(pay, net.stable.address)) errs.push(`payment token must be ${net.stable.symbol} (${net.stable.address})`);
  } else if (!net.testnet) {
    errs.push("this mainnet has no supported stablecoin");
  } else {
    const sym = await read<string>(pay, erc20Abi, "symbol").catch(() => "");
    if (sym !== "tUSD") errs.push("testnet payment token must be the platform's Test USD");
  }
  const payDecimals = net.stable?.decimals ?? 6;
  const isVault = asset.standard === "erc4626";
  let sTreasury: string | null = null;
  if (asset.standard === "erc3643") {
    const tx = asset.trex;
    const core = trexFor(net);
    if (!core || !tx?.token) return ["deploy the ERC-3643 suite from the console first"];
    if (!net.testnet) return ["ERC-3643 is testnet-only for now"];
    const t3 = TREX_ARTIFACTS;
    const tread = <R,>(a: Address, n: string, f: string, args: unknown[] = []) => read<R>(a, t3[n].abi, f, args);
    if (!eq(token, tx.token)) errs.push("token isn't the suite the platform deployed for this offering");
    const fromFactory = await tread<string>(core.trexFactory, "TREXFactory", "getToken", [tx.salt]);
    if (!eq(fromFactory, token)) errs.push("token wasn't deployed by the platform's ERC-3643 factory");
    const [name, symbol, decimals, ir, topics] = await Promise.all([
      tread<string>(token, "Token", "name"), tread<string>(token, "Token", "symbol"), tread<number>(token, "Token", "decimals"),
      tread<string>(token, "Token", "identityRegistry"),
      tread<string>(token, "Token", "identityRegistry").then((a) => tread<string>(a as Address, "IdentityRegistry", "topicsRegistry")).then((ctr) => tread<bigint[]>(ctr as Address, "ClaimTopicsRegistry", "getClaimTopics")),
    ]);
    if (name !== asset.name) errs.push(`token name is "${name}", expected "${asset.name}"`);
    if (symbol !== asset.symbol) errs.push(`token symbol is ${symbol}, expected ${asset.symbol}`);
    if (Number(decimals) !== 18) errs.push("token must use 18 decimals");
    if (!eq(ir, registry)) errs.push("registry must be the token's identity registry");
    const wantTopics = asset.rules?.accreditedOnly ? [KYC_TOPIC, ACCREDITED_TOPIC] : [KYC_TOPIC];
    if (JSON.stringify([...topics].map(String).sort()) !== JSON.stringify(wantTopics.map(String).sort())) {
      errs.push(asset.rules?.accreditedOnly ? "the token must require the KYC and accreditation claims" : "the token must require exactly the KYC claim");
    }
    const tir = await tread<string>(ir as Address, "IdentityRegistry", "issuersRegistry");
    const issuers = await tread<string[]>(tir as Address, "TrustedIssuersRegistry", "getTrustedIssuers");
    if (issuers.length !== 1 || !eq(issuers[0]!, tx.claimIssuer)) errs.push("the only trusted claim issuer must be your own");
    const [sToken, sPay, saleTreasury, sFeeRecipient, sPrice, sCap, sMin, sFeeBps, agentOk] = await Promise.all([
      read<string>(sale, saleAbi, "token"), read<string>(sale, saleAbi, "payToken"), read<string>(sale, saleAbi, "treasury"),
      read<string>(sale, saleAbi, "feeRecipient"), read<bigint>(sale, saleAbi, "price"), read<bigint>(sale, saleAbi, "cap"),
      read<bigint>(sale, saleAbi, "minPurchase"), read<number>(sale, saleAbi, "feeBps"), tread<boolean>(token, "Token", "isAgent", [sale]),
    ]);
    if (!eq(sToken, token)) errs.push("sale sells a different token");
    if (!eq(sPay, pay)) errs.push("sale takes a different payment token");
    if (!asset.pricePerToken || sPrice !== parseUnits(asset.pricePerToken, payDecimals)) errs.push("sale price doesn't match the draft price");
    if (sCap !== BigInt(asset.totalSupply) * 10n ** 18n) errs.push("sale cap doesn't match total supply");
    if (sMin !== parseUnits(asset.minInvestment || "0", payDecimals)) errs.push("sale minimum doesn't match the draft minimum");
    const fee = saleFeeFor(net.id);
    if (Number(sFeeBps) !== fee.bps || !eq(sFeeRecipient, fee.recipient)) errs.push(`sale platform fee must be ${fee.bps / 100}% to ${fee.recipient}`);
    if (!agentOk) errs.push("sale isn't a token agent, so it can't issue tokens");
    sTreasury = saleTreasury;
  } else if (asset.standard === "erc721") {
    const supply = BigInt(asset.totalSupply || "0");
    const [name, symbol, tokReg, is7943, max] = await Promise.all([
      read<string>(token, nftAbi, "name"), read<string>(token, nftAbi, "symbol"), read<string>(token, nftAbi, "registry"),
      read<boolean>(token, nftAbi, "supportsInterface", ["0xbf1ef5fe"]), read<bigint>(token, nftAbi, "maxSupply"),
    ]);
    if (name !== asset.name) errs.push(`token name is "${name}", expected "${asset.name}"`);
    if (symbol !== asset.symbol) errs.push(`token symbol is ${symbol}, expected ${asset.symbol}`);
    if (!eq(tokReg, registry)) errs.push("token points at a different investor registry");
    if (!is7943) errs.push("token doesn't report the ERC-7943 non-fungible interface");
    if (max !== supply) errs.push("token max supply doesn't match the number of NFTs");
    const [sToken, sPay, saleTreasury, sFeeRecipient, sPrice, sCap, sMin, sFeeBps, minterOk] = await Promise.all([
      read<string>(sale, saleAbi, "token"), read<string>(sale, saleAbi, "payToken"), read<string>(sale, saleAbi, "treasury"),
      read<string>(sale, saleAbi, "feeRecipient"), read<bigint>(sale, saleAbi, "price"), read<bigint>(sale, saleAbi, "cap"),
      read<bigint>(sale, saleAbi, "minPurchase"), read<number>(sale, saleAbi, "feeBps"), read<boolean>(token, nftAbi, "hasRole", [ROLE_MINTER, sale]),
    ]);
    if (!eq(sToken, token)) errs.push("sale sells a different token");
    if (!eq(sPay, pay)) errs.push("sale takes a different payment token");
    if (!asset.pricePerToken || sPrice !== parseUnits(asset.pricePerToken, payDecimals)) errs.push("sale price doesn't match the draft price");
    if (sCap !== supply) errs.push("sale cap doesn't match the number of NFTs");
    if (sMin !== parseUnits(asset.minInvestment || "0", payDecimals)) errs.push("sale minimum doesn't match the draft minimum");
    const fee = saleFeeFor(net.id);
    if (Number(sFeeBps) !== fee.bps || !eq(sFeeRecipient, fee.recipient)) errs.push(`sale platform fee must be ${fee.bps / 100}% to ${fee.recipient}`);
    if (!minterOk) errs.push("sale isn't allowed to mint the token (MINTER_ROLE missing)");
    sTreasury = saleTreasury;
  } else if (asset.standard === "erc1155") {
    const supply = BigInt(asset.totalSupply || "0");
    const [name, symbol, tokReg, is7943, exists, itemMax] = await Promise.all([
      read<string>(token, multiAbi, "name"), read<string>(token, multiAbi, "symbol"), read<string>(token, multiAbi, "registry"),
      read<boolean>(token, multiAbi, "supportsInterface", ["0x41c4fbad"]), read<boolean>(token, multiAbi, "itemExists", [ITEM_ID]),
      read<bigint>(token, multiAbi, "maxSupply", [ITEM_ID]),
    ]);
    if (name !== asset.name) errs.push(`token name is "${name}", expected "${asset.name}"`);
    if (symbol !== asset.symbol) errs.push(`token symbol is ${symbol}, expected ${asset.symbol}`);
    if (!eq(tokReg, registry)) errs.push("token points at a different investor registry");
    if (!is7943) errs.push("token doesn't report the ERC-7943 multi-token interface");
    if (!exists) errs.push(`item ${ITEM_ID} hasn't been created on the token`);
    else if (itemMax !== supply) errs.push("item supply doesn't match total supply");
    const [sToken, sId, sPay, saleTreasury, sFeeRecipient, sPrice, sCap, sMin, sFeeBps, minterOk] = await Promise.all([
      read<string>(sale, sale1155Abi, "token"), read<bigint>(sale, sale1155Abi, "tokenId"), read<string>(sale, sale1155Abi, "payToken"),
      read<string>(sale, sale1155Abi, "treasury"), read<string>(sale, sale1155Abi, "feeRecipient"), read<bigint>(sale, sale1155Abi, "price"),
      read<bigint>(sale, sale1155Abi, "cap"), read<bigint>(sale, sale1155Abi, "minPurchase"), read<number>(sale, sale1155Abi, "feeBps"),
      read<boolean>(token, multiAbi, "hasRole", [ROLE_MINTER, sale]),
    ]);
    if (!eq(sToken, token)) errs.push("sale sells a different token");
    if (sId !== ITEM_ID) errs.push(`sale sells item ${sId}, expected ${ITEM_ID}`);
    if (!eq(sPay, pay)) errs.push("sale takes a different payment token");
    if (!asset.pricePerToken || sPrice !== parseUnits(asset.pricePerToken, payDecimals)) errs.push("sale price doesn't match the draft price");
    if (sCap !== supply) errs.push("sale cap doesn't match total supply");
    if (sMin !== parseUnits(asset.minInvestment || "0", payDecimals)) errs.push("sale minimum doesn't match the draft minimum");
    const fee = saleFeeFor(net.id);
    if (Number(sFeeBps) !== fee.bps || !eq(sFeeRecipient, fee.recipient)) errs.push(`sale platform fee must be ${fee.bps / 100}% to ${fee.recipient}`);
    if (!minterOk) errs.push("sale isn't allowed to mint the token (MINTER_ROLE missing)");
    sTreasury = saleTreasury;
  } else if (isVault) {
    const [vName, vSymbol, vAsset, vReg, vCap] = await Promise.all([
      read<string>(token, vaultAbi, "name"), read<string>(token, vaultAbi, "symbol"), read<string>(token, vaultAbi, "asset"),
      read<string>(token, vaultAbi, "registry"), read<bigint>(token, vaultAbi, "depositCap"),
    ]);
    if (!eq(token, sale)) errs.push("for a fund vault, the vault is also the sale");
    if (vName !== asset.name) errs.push(`vault name is "${vName}", expected "${asset.name}"`);
    if (vSymbol !== asset.symbol) errs.push(`vault symbol is ${vSymbol}, expected ${asset.symbol}`);
    if (!eq(vAsset, pay)) errs.push("vault takes a different deposit token");
    if (!eq(vReg, registry)) errs.push("vault points at a different investor registry");
    const cap = parseUnits(asset.pricePerToken || "0", payDecimals) * BigInt(asset.totalSupply || "0");
    if (vCap !== cap) errs.push("vault deposit cap doesn't match price × total supply");
  } else {
  const [name, symbol, decimals, maxSupply, tokReg, is7943] = await Promise.all([
    read<string>(token, tokenAbi, "name"), read<string>(token, tokenAbi, "symbol"), read<number>(token, tokenAbi, "decimals"),
    read<bigint>(token, tokenAbi, "maxSupply"), read<string>(token, tokenAbi, "registry"), read<boolean>(token, tokenAbi, "supportsInterface", ["0x3edbb4c4"]),
  ]);
  if (name !== asset.name) errs.push(`token name is "${name}", expected "${asset.name}"`);
  if (symbol !== asset.symbol) errs.push(`token symbol is ${symbol}, expected ${asset.symbol}`);
  if (Number(decimals) !== 18) errs.push("token must use 18 decimals");
  if (maxSupply !== BigInt(asset.totalSupply) * 10n ** 18n) errs.push("token max supply doesn't match total supply");
  if (!eq(tokReg, registry)) errs.push("token points at a different investor registry");
  if (!is7943) errs.push("token doesn't report the ERC-7943 interface");

  const [sToken, sPay, saleTreasury, sFeeRecipient, sPrice, sCap, sMin, sFeeBps, minterOk] = await Promise.all([
    read<string>(sale, saleAbi, "token"), read<string>(sale, saleAbi, "payToken"), read<string>(sale, saleAbi, "treasury"),
    read<string>(sale, saleAbi, "feeRecipient"), read<bigint>(sale, saleAbi, "price"), read<bigint>(sale, saleAbi, "cap"),
    read<bigint>(sale, saleAbi, "minPurchase"), read<number>(sale, saleAbi, "feeBps"), read<boolean>(token, tokenAbi, "hasRole", [ROLE_MINTER, sale]),
  ]);
  if (!eq(sToken, token)) errs.push("sale sells a different token");
  if (!eq(sPay, pay)) errs.push("sale takes a different payment token");
  if (!asset.pricePerToken || sPrice !== parseUnits(asset.pricePerToken, payDecimals)) errs.push("sale price doesn't match the draft price");
  if (sCap !== BigInt(asset.totalSupply) * 10n ** 18n) errs.push("sale cap doesn't match total supply");
  if (sMin !== parseUnits(asset.minInvestment || "0", payDecimals)) errs.push("sale minimum doesn't match the draft minimum");
  const fee = saleFeeFor(net.id);
  if (Number(sFeeBps) !== fee.bps || !eq(sFeeRecipient, fee.recipient)) errs.push(`sale platform fee must be ${fee.bps / 100}% to ${fee.recipient}`);
  if (!minterOk) errs.push("sale isn't allowed to mint the token (MINTER_ROLE missing)");
  sTreasury = saleTreasury;
  }

  // Offering rules (wizard step 5): read back from chain, setting by setting.
  if (asset.standard === "erc3643") {
    if (hasRules(asset.rules)) {
      const mod = asset.trex?.rulesModule as Address | undefined;
      const compliance = await read<string>(token, TREX_ARTIFACTS.Token!.abi, "compliance");
      const bound = mod ? await read<boolean>(compliance as Address, TREX_ARTIFACTS.ModularCompliance!.abi, "isModuleBound", [mod]) : false;
      if (!bound) errs.push("the offering-rules compliance module isn't on this token");
      else errs.push(...(await verifyModule(client as any, mod!, compliance as Address, asset)));
    }
  } else {
    errs.push(...(await verifyRules(client as any, token, asset, null)));
    if (dep.rules) {
      const onToken = await read<string>(token, [{ type: "function", name: "rules", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }], "rules");
      if (!eq(onToken, dep.rules)) errs.push("reported rules contract isn't the token's");
    }
  }
  // Offering documents: the token's documentURI must carry the manifest hash of the draft's fingerprints.
  const docs = (asset.documents ?? []) as { kind: string; sha256: string }[];
  if (docs.length && !isVault && asset.standard !== "erc3643") {
    const manifest = createHash("sha256").update(docs.map((d) => `${d.kind}:${d.sha256}`).sort().join("\n")).digest("hex");
    const uri = await read<string>(token, [{ type: "function", name: "documentURI", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }], "documentURI").catch(() => "");
    if (!uri.endsWith(`#sha256=${manifest}`)) errs.push("token's document fingerprint doesn't match the draft's documents");
  }
  if (!isVault) {
    const w = saleWindow(Rules.parse(asset.rules ?? {}));
    const [st, en] = await Promise.all([
      read<bigint>(sale, saleWindowAbi, "startsAt").catch(() => null), read<bigint>(sale, saleWindowAbi, "endsAt").catch(() => null),
    ]);
    if (w.startsAt && st !== w.startsAt) errs.push("sale opening date doesn't match the draft");
    if (en !== w.endsAt) errs.push("sale closing date doesn't match the draft");
  } else {
    const want = Math.round(Number(asset.details?.maxNavMovePct ?? 20) * 100);
    const bps = await read<number>(token, saleWindowAbi, "maxNavChangeBps");
    if (Number(bps) !== want) errs.push("vault's max NAV move per report doesn't match the draft");
  }

  // Proof of asset: where the platform runs an AssetOracle, the sale must be gated by it and the token registered
  // under this listing's asset class with at least the class's minimum checks.
  const oCfg = assetOracleFor(net);
  if (oCfg) {
    const o = oCfg.address;
    const sOracle = await read<string>(sale, saleAbi, "oracle").catch(() => ZERO);
    if (!eq(sOracle, o)) errs.push(`sale must be gated by the proof-of-asset oracle ${o}`);
    const [cls, kinds] = await read<[string, string[]]>(o, oracleAbi, "registration", [token]);
    if (!eq(cls, classHash(asset.assetClass))) errs.push("token isn't registered with the proof-of-asset oracle under this asset class");
    else {
      const have = new Set(kinds.map(kindByHash));
      const missing = (CLASS_CHECKS[asset.assetClass as keyof typeof CLASS_CHECKS] ?? []).filter((k) => !have.has(k));
      if (missing.length) errs.push(`oracle registration is missing required checks: ${missing.join(", ")}`);
    }
  }

  // Sanctions: where Chainalysis' oracle exists, the registry must use it. (ERC-3643: the T-REX identity registry
  // has no oracle hook, so the API screens every wallet before filing its KYC claim; see screenAddress.)
  if (net.sanctionsOracle && asset.standard !== "erc3643") {
    const o = await read<string>(registry, registryAbi, "sanctionsOracle").catch(() => ZERO);
    if (!eq(o, net.sanctionsOracle)) errs.push(`investor registry must use the sanctions oracle ${net.sanctionsOracle}`);
  }

  // Flat per-offering fee (mainnet): an on-chain stablecoin transfer to the platform Safe, used only once.
  if (!net.testnet && planById(tenantCfg.plan).testnetOnly) errs.push(`the Free plan runs on test networks only: choose a plan to go live on ${net.name}`);
  else if (!net.testnet) {
    const safe = PLATFORM_FEE_RECIPIENTS[String(net.id)];
    const plan = planById(tenantCfg.plan);
    if (!safe || !net.stable) errs.push(`${net.name} isn't open for mainnet offerings yet`);
    else if (!dep.feeTx) errs.push(`pay the $${plan.offeringFeeUsd.toLocaleString()} offering fee first`);
    else if (await feeTxUsed(dep.feeTx)) errs.push("that fee payment was already used for another offering");
    else {
      const rcpt = await client.getTransactionReceipt({ hash: dep.feeTx as `0x${string}` }).catch(() => null);
      const need = parseUnits(String(plan.offeringFeeUsd), net.stable.decimals);
      const paid = (rcpt?.status === "success" ? rcpt.logs : [])
        .filter((l) => eq(l.address, net.stable!.address))
        .map((l) => { try { return decodeEventLog({ abi: [transferEvent], data: l.data, topics: l.topics }); } catch { return null; } })
        .filter((e): e is NonNullable<typeof e> => !!e && eq(String(e.args.to), safe))
        .reduce((sum, e) => sum + (e.args.value as bigint), 0n);
      if (paid < need) errs.push(`offering fee not found: expected ${plan.offeringFeeUsd} ${net.stable.symbol} to ${safe} in ${dep.feeTx}`);
    }
  }

  const treasury = tenantCfg.payments.treasury;
  if (treasury && sTreasury && !eq(sTreasury, treasury)) errs.push("sale pays a different treasury than your Payments settings");
  if (!net.testnet) {
    // 2026-11-20: Stripe-verified company + lawyer-signed letter + Diamondz review (not a self-ticked box).
    for (const r of (await legal.clearance(asset)).reasons) errs.push(`mainnet needs: ${r}`);
    if (!treasury) errs.push("mainnet needs a treasury multisig in Payments");
    else {
      const [a1, a2, a3] = await Promise.all([
        read<boolean>(token, tokenAbi, "hasRole", [ROLE_ADMIN, treasury]),
        read<boolean>(sale, saleAbi, "hasRole", [ROLE_ADMIN, treasury]),
        read<boolean>(registry, tokenAbi, "hasRole", [ROLE_ADMIN, treasury]),
      ]);
      if (!a1 || !a2 || !a3) errs.push("on mainnet, admin control of the registry, token and sale must be handed to your treasury multisig");
      if (dep.rules && !(await read<boolean>(getAddress(dep.rules), tokenAbi, "hasRole", [ROLE_ADMIN, treasury]))) {
        errs.push("on mainnet, admin control of the offering rules must be handed to your treasury multisig");
      }
    }
  }
  return errs;
}

app.post("/assets/:id/deployment", requireAdmin, async (c) => {
  const t = c.get("tenant");
  const r = await getAssetRow(c.req.param("id") ?? "", t.id);
  if (!r) return c.json({ error: "Not found" }, 404);
  const asset = upgradeAsset(JSON.parse(r.data));
  if (asset.status === "deployed") return c.json({ error: "Already deployed" }, 409);
  if (!["erc7943", "erc4626", "erc1155", "erc721", "erc3643"].includes(asset.standard)) return c.json({ error: "This token type can't be deployed yet" }, 409);
  const parsed = Deployment.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: issues(parsed.error) }, 400);
  const cfg = JSON.parse(t.config) as TenantConfig;
  let errs: string[];
  try {
    errs = await verifyDeployment(asset, cfg, parsed.data);
  } catch (e) {
    console.error("[verify]", e);
    return c.json({ error: "Couldn't read the contracts from the network. Wait a few seconds and retry." }, 422);
  }
  if (errs.length) return c.json({ error: `Deployment check failed: ${errs.join("; ")}` }, 422);

  const d = parsed.data;
  const deployment = {
    chainId: asset.chainId, registry: getAddress(d.registry), token: getAddress(d.token), sale: getAddress(d.sale),
    payToken: getAddress(d.payToken), ...(d.rules ? { rules: getAddress(d.rules) } : {}), txs: d.txs, feeTx: d.feeTx, deployedAt: new Date().toISOString(),
  };
  const now = deployment.deployedAt;
  const data = JSON.stringify({ ...asset, status: "deployed", deployment });
  await store.updateAsset(r.id, t.id, data, now);
  const regs = { ...(cfg.registries ?? {}) };
  if (!regs[String(asset.chainId)] && asset.standard !== "erc3643") {
    regs[String(asset.chainId)] = deployment.registry;
    await store.setTenantConfig(t.id, JSON.stringify({ ...cfg, registries: regs }));
  }
  return c.json(rowToAsset({ ...r, data, updated_at: now }));
});

// ------------------------------------------------------------------ sanctions screening (all chains)
// OFAC SDN-listed Ethereum-format addresses, as extracted daily from OFAC's own data by
// github.com/0xB10C/ofac-sanctioned-digital-currency-addresses. Same address format on every EVM chain.
// Fails closed: if the list has never loaded, screening answers 503 and the UI blocks verify/buy.
const OFAC_URL = "https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_ETH.txt";
let ofac: { set: Set<string>; at: string } | null = null;
async function loadOfac() {
  try {
    const res = await fetch(OFAC_URL, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = (await res.text()).split(/\s+/).map((x) => x.trim().toLowerCase()).filter((x) => /^0x[0-9a-f]{40}$/.test(x));
    if (list.length < 50) throw new Error(`suspiciously short list (${list.length})`);
    ofac = { set: new Set(list), at: new Date().toISOString() };
    console.log(`[ofac] loaded ${list.length} addresses`);
  } catch (e) {
    console.error("[ofac] refresh failed, keeping previous list:", e);
  }
}
await loadOfac();
registerJob("ofac-refresh", async () => { await loadOfac(); return { addresses: ofac?.set.size ?? 0, at: ofac?.at ?? null }; }, 6 * 60 * 60 * 1000, 6 * 60 * 60 * 1000);
// Monthly security evidence for assessors (dependency scan + audit-log export); local timer is off: Temporal only.
registerJob("security-evidence", () => collectEvidence(store, DEFAULT_TENANT), 30 * 86_400_000, 60_000, false);

/** OFAC list (all chains) + Chainalysis' oracle where the chain has one. `oracle` is null when unreadable. */
async function screenAddress(a: string, chainId: number) {
  if (!ofac) return null;
  let sanctioned = ofac.set.has(a.toLowerCase());
  let oracle: boolean | null = null;
  const net = networkById(chainId);
  if (net?.sanctionsOracle) {
    const client = createPublicClient({ transport: http(rpcUrl(net), { timeout: 10_000 }) });
    oracle = await client.readContract({ address: net.sanctionsOracle, abi: [{ type: "function", name: "isSanctioned", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] }] as const, functionName: "isSanctioned", args: [getAddress(a)] }).catch(() => null);
    if (oracle) sanctioned = true;
  }
  return { sanctioned, ofacListUpdatedAt: ofac.at, oracle, oracleExpected: !!net?.sanctionsOracle };
}

app.get("/screen/:address", async (c) => {
  const a = c.req.param("address") ?? "";
  if (!isAddress(a)) return c.json({ error: "Not an address" }, 400);
  const r = await screenAddress(a, Number(c.req.query("chainId") ?? 0));
  if (!r) return c.json({ error: "Sanctions screening is unavailable right now. Try again shortly." }, 503);
  const { oracleExpected: _x, ...out } = r;
  return c.json(out);
});

// ------------------------------------------------------------------ public marketplace
const PUBLIC_KEYS = ["id", "name", "symbol", "assetClass", "standard", "chainId", "totalSupply", "pricePerToken", "minInvestment", "schedule", "lockup", "description", "imageUrl", "location", "deployment", "formD", "issuer", "details", "rules", "documents", "exemption"] as const;
const listedAssets = async (tenantId: string) =>
  (await store.listAssets(tenantId)).map(rowToAsset).filter((a: any) => a.status === "deployed" && a.listed);

// ---- which issuers a website shows (stage 2): a white-label domain shows its own offerings; the platform site shows
// its own plus every self-serve workspace (ws_…), which have no domain of their own.
const isWorkspaceId = (id: string) => /^ws_[0-9a-f]{12}$/.test(id);
const siteOf = (c: Context) => (c as Context<Env>).get("site") ?? (c as Context<Env>).get("tenant");
const siteHas = (c: Context, tenantId: string) => { const s = siteOf(c); return tenantId === s.id || (s.id === DEFAULT_TENANT && isWorkspaceId(tenantId)); };
const issuerNames = new Map<string, { at: number; name: string }>();
async function issuerName(tenantId: string) {
  const hit = issuerNames.get(tenantId);
  if (hit && Date.now() - hit.at < 60_000) return hit.name;
  const t = await store.getTenant(tenantId);
  const name = t ? (JSON.parse(t.config) as TenantConfig).name : "Issuer";
  issuerNames.set(tenantId, { at: Date.now(), name });
  return name;
}
/** Listed offerings on this website, each with its issuer. */
async function siteListed(c: Context) {
  const s = siteOf(c);
  const rows = s.id === DEFAULT_TENANT ? (await store.allAssets()).filter((r) => siteHas(c, r.tenant_id)) : await store.listAssets(s.id);
  const out = [];
  for (const a of rows.map(rowToAsset).filter((a: any) => a.status === "deployed" && a.listed)) out.push({ ...a, issuer: { id: a.tenantId, name: await issuerName(a.tenantId) } });
  return out.sort((x: any, y: any) => String(y.createdAt).localeCompare(String(x.createdAt)));
}
/** Every issuer id with offerings on this website (for investor-wide views such as "Your income"). */
async function siteTenantIds(c: Context) {
  const s = siteOf(c);
  if (s.id !== DEFAULT_TENANT) return [s.id];
  return [...new Set([s.id, ...(await store.allAssets()).map((r) => r.tenant_id).filter(isWorkspaceId)])];
}
const allDeployedAssets = async () =>
  (await store.allAssets()).map(rowToAsset).filter((a: any) => a.status === "deployed" && a.deployment);
const adminAssetOf = async (c: Context, id: string) => {
  const r = await getAssetRow(id, (c as Context<Env>).get("tenant").id);
  return r ? rowToAsset(r) : null;
};

app.get("/market", async (c) => c.json((await siteListed(c)).map((a: any) => pick(a, PUBLIC_KEYS))));
app.get("/market/:id", async (c) => {
  const a = (await siteListed(c)).find((x: any) => x.id === c.req.param("id"));
  return a ? c.json(pick(a, PUBLIC_KEYS)) : c.json({ error: "Not found" }, 404);
});

// Token metadata for wallets and explorers. ERC-1155 uri = `<origin>/api/meta/<assetId>/{id}` (the one item);
// ERC-721 tokenURI = `<origin>/api/meta/<assetId>/<n>` for NFTs 1..totalSupply.
// Deployed offerings only; only what a holder already sees on the listing.
app.get("/meta/:assetId/:id", async (c) => {
  // Token metadata for this site's offerings (any issuer it shows), listed or not: wallets read it once deployed.
  const found = (await store.allAssets()).find((x) => x.id === c.req.param("assetId") && siteHas(c, x.tenant_id));
  const a: any = found ? rowToAsset(found) : null;
  if (!a || a.status !== "deployed" || (a.standard !== "erc1155" && a.standard !== "erc721")) return c.json({ error: "Not found" }, 404);
  const idParam = c.req.param("id").replace(/\.json$/, "");
  const id = /^[0-9a-fA-F]{64}$/.test(idParam) ? BigInt(`0x${idParam}`) : /^\d{1,20}$/.test(idParam) ? BigInt(idParam) : -1n;
  const nft = a.standard === "erc721";
  if (nft ? id < 1n || id > BigInt(a.totalSupply || "0") : id !== ITEM_ID) return c.json({ error: "Not found" }, 404);
  c.header("Cache-Control", "public, max-age=300");
  return c.json({
    name: nft ? `${a.name} #${id}` : a.name,
    description: a.description ?? "",
    ...(a.imageUrl ? { image: a.imageUrl } : {}),
    ...(nft
      ? { attributes: [{ trait_type: "Asset class", value: a.assetClass }, { trait_type: "Unit", value: Number(id), max_value: Number(a.totalSupply) }] }
      : { properties: { symbol: a.symbol, assetClass: a.assetClass, fractions: a.totalSupply } }),
  });
});

// The token's documentURI points here: the offering's document fingerprints (names + sha256), never the files. The
// manifest hash in the URI's #sha256= fragment is sha256 over the sorted "kind:sha256" lines, so anyone holding a file
// can check it against the token (web/src/lib/rules.ts manifestHash).
app.get("/documents/:assetId", async (c) => {
  const found = (await store.allAssets()).find((x) => x.id === c.req.param("assetId") && siteHas(c, x.tenant_id));
  const a: any = found ? rowToAsset(found) : null;
  if (!a || a.status !== "deployed") return c.json({ error: "Not found" }, 404);
  const docs = (a.documents ?? []) as { kind: string; name: string; sha256: string }[];
  const manifest = createHash("sha256").update(docs.map((d) => `${d.kind}:${d.sha256}`).sort().join("\n")).digest("hex");
  c.header("Cache-Control", "public, max-age=300");
  return c.json({ asset: a.id, name: a.name, manifestSha256: manifest, documents: docs.map((d) => ({ kind: d.kind, name: d.name, sha256: d.sha256 })) });
});

// ------------------------------------------------------------------ proof of asset
mountProof(app, {
  // Public for listed assets; the tenant's signed-in admins can also see unlisted ones.
  findAsset: async (c, id) => {
    const listed = (await siteListed(c)).find((a: any) => a.id === id);
    if (listed) return listed;
    const s = await sessionFor(c, siteOf(c));
    const r = s?.tenant ? await getAssetRow(id, s.tenant.id) : null;
    return r ? rowToAsset(r) : null;
  },
  allDeployed: allDeployedAssets,
});

// ------------------------------------------------------------------ payouts
mountPayouts(app, {
  store,
  requireAdmin,
  adminAsset: adminAssetOf,
  tenantId: (c) => (c as Context<Env>).get("tenant").id,
  siteTenantIds,
  siteHas,
});

// ------------------------------------------------------------------ investor identity gate
// 2026-11-20: an issuer can no longer vouch for an investor on its own. On a real network the wallet must have an
// approved identity check with this issuer first (test networks stay open for practice with play money).
const NO_ID = "This investor hasn't passed an identity check with you yet. Send them to the offering page to verify first.";
async function identityOf(c: Context, wallet: string, chainId: number) {
  const k = await store.kycByWallet((c as Context<Env>).get("tenant").id, wallet).catch(() => null);
  const required = networkById(chainId)?.testnet === false && kycEnabled();
  const passed = k?.status === "approved";
  return { required, passed, status: k?.status ?? "none", blocked: required && !passed };
}
app.get("/identity/:wallet", requireAdmin, async (c) => {
  const w = c.req.param("wallet") ?? "";
  if (!isAddress(w)) return c.json({ error: "Not an address" }, 400);
  const { blocked: _b, ...out } = await identityOf(c, w, Number(c.req.query("chainId") ?? 0));
  return c.json(out);
});

// ------------------------------------------------------------------ ERC-3643 (platform T-REX relayer)
mountTrex(app, {
  requireAdmin,
  // 2026-11-20: an issuer can no longer vouch for an investor on its own. On a real network the wallet must have an
  // approved identity check with this issuer first (test networks stay open for practice with play money).
  identityGate: async (c, wallet, chainId) => ((await identityOf(c, wallet, chainId)).blocked ? NO_ID : null),
  getAsset: adminAssetOf,
  saveAsset: async (c, a) => {
    const { id, tenantId: _t, createdAt: _c, updatedAt: _u, ...data } = a;
    await store.updateAsset(id, (c as Context<Env>).get("tenant").id, JSON.stringify(data), new Date().toISOString());
  },
  getTenant: (c) => {
    const t = (c as Context<Env>).get("tenant");
    return { id: t.id, ...(JSON.parse(t.config) as TenantConfig) };
  },
  saveTenant: async (c, cfg) => {
    const t = (c as Context<Env>).get("tenant");
    const { id: _id, ...rest } = cfg;
    await store.setTenantConfig(t.id, JSON.stringify(rest));
    t.config = JSON.stringify(rest); // later reads in this request see it
  },
  // Fail closed: no list loaded, a hit, or an expected Chainalysis answer missing ⇒ no KYC claim is filed.
  screen: async (wallet, chainId) => {
    const r = await screenAddress(wallet, chainId);
    if (!r) return "Sanctions screening is unavailable right now. Try again shortly.";
    if (r.sanctioned) return "This wallet is on a sanctions list and can't be verified.";
    if (r.oracleExpected && r.oracle === null) return "Couldn't reach the on-chain sanctions check. Try again shortly.";
    return null;
  },
});

// ------------------------------------------------------------------ accredited investors (Mastercard Open Finance)
mountMastercard(app, {
  store,
  requireAdmin,
  tenant: (c) => {
    const t = (c as Context<Env>).get("tenant");
    return { id: t.id, name: (JSON.parse(t.config) as TenantConfig).name };
  },
  listedAsset: async (c, id) => (await siteListed(c)).find((a: any) => a.id === id) ?? null,
  issuerOf: async (tenantId) => ({ id: tenantId, name: await issuerName(tenantId) }),
  siteHas,
  adminAsset: adminAssetOf,
  adminEmail: (c) => (c as Context<Env>).get("session")?.email ?? "unknown",
});

// ------------------------------------------------------------------ IP registry + licensing (designs F1–F7)
const assetDataOf = (a: any) => { const { id: _i, tenantId: _t, createdAt: _c, updatedAt: _u, ...data } = a; return data; };
mountIp(app, {
  store,
  requireAdmin,
  adminAsset: adminAssetOf,
  saveAsset: async (c, a) => { await store.updateAsset(a.id, (c as Context<Env>).get("tenant").id, JSON.stringify(assetDataOf(a)), new Date().toISOString()); },
  publicAsset: async (c, id) => {
    const r = (await store.allAssets()).find((x) => x.id === id && siteHas(c, x.tenant_id));
    const a: any = r ? rowToAsset(r) : null;
    return a && a.status === "deployed" ? a : null;
  },
  savePublicAsset: async (a) => { await store.updateAsset(a.id, a.tenantId, JSON.stringify(assetDataOf(a)), new Date().toISOString()); },
  tooMany,
  ipKey,
});

// ------------------------------------------------------------------ read-only RPC proxy for the browser (Uniblock)
mountRpcProxy(app, { tooMany, ipKey });
mountStellar(app);
const stellarDeps: Parameters<typeof mountStellarOps>[1] = {
  requireAdmin,
  adminAsset: adminAssetOf,
  loadAsset: async (id, tenantId) => { const r = await getAssetRow(id, tenantId); return r ? rowToAsset(r) : null; },
  publicAsset: async (c, id) => {
    const r = (await store.allAssets()).find((x) => x.id === id && siteHas(c, x.tenant_id));
    const a: any = r ? rowToAsset(r) : null;
    return a && a.status === "deployed" ? a : null;
  },
  saveAsset: async (a) => { const { id, tenantId, createdAt: _c, updatedAt: _u, ...data } = a; await store.updateAsset(id, tenantId, JSON.stringify(data), new Date().toISOString()); },
  tooMany,
  ipKey,
  allAssets: async () => (await store.allAssets()).map(rowToAsset),
  // Same gates as EVM mainnet offerings (verifyDeployment): plan, legal sign-off, flat offering fee.
  legalReasons: async (a) => (await legal.clearance(a)).reasons,
  mainnetRules: (c) => {
    const cfg = JSON.parse((c as Context<Env>).get("tenant").config) as TenantConfig;
    const plan = planById(cfg.plan);
    return { testnetOnly: !!plan.testnetOnly, offeringFeeUsd: plan.offeringFeeUsd, counselReady: !!cfg.onboarding?.counselReady };
  },
};
mountStellarOps(app, stellarDeps);
// Stellar sales can't read the EVM oracle themselves, so this closes any whose offering stopped passing its checks.
registerJob("stellar-sale-proof", () => closeLapsedSales(stellarDeps), 10 * 60 * 1000, 2 * 60 * 1000);

// ------------------------------------------------------------------ card payments for licenses (issuer's own Stripe)
mountCards(app, {
  requireAdmin,
  tenantConfig: (c) => { const t = (c as Context<Env>).get("tenant"); return { id: t.id, ...(JSON.parse(t.config) as TenantConfig) }; },
  saveTenantConfig: async (c, cfg) => { const { id: _i, ...rest } = cfg; await store.setTenantConfig((c as Context<Env>).get("tenant").id, JSON.stringify(rest)); },
  issuerConfig: async (tenantId) => { const r = await store.getTenant(tenantId); return r ? JSON.parse(r.config) : null; },
  publicAsset: async (c, id) => {
    const r = (await store.allAssets()).find((x) => x.id === id && siteHas(c, x.tenant_id));
    const a: any = r ? rowToAsset(r) : null;
    return a && a.status === "deployed" ? a : null;
  },
  origin: (c) => `https://${c.req.header("host") ?? "tokenize.diamondz.one"}`,
  tooMany,
  ipKey,
});

// ------------------------------------------------------------------ two-step sign-in (TOTP)
mountMfa(app, {
  store,
  requireAccount,
  account: (c) => (c as Context<Env>).get("session").account!.toLowerCase(),
  sessionHash: (c) => sha(getCookie(c, SESSION_COOKIE)!),
  roleOf: async (c) => {
    const s = await sessionFor(c, (c as Context<Env>).get("site"));
    return s?.tenant ? s.role : null;
  },
  tooMany,
});

// ------------------------------------------------------------------ team members and roles (design 2)
mountTeam(app, {
  store,
  requireAdmin,
  requireAccount,
  member: (c) => (c as Context<Env>).get("member"),
  sessionAccount: (c) => (c as Context<Env>).get("session").account!,
  tenantId: (c) => (c as Context<Env>).get("tenant").id,
  tenantName: async (id) => { const t = await store.getTenant(id); return t ? (JSON.parse(t.config) as TenantConfig).name : null; },
  platformOrigin: (c) => `https://${hostOf(c)}`,
  switchTo: async (c, id) => { await store.setSessionTenant(sha(getCookie(c, SESSION_COOKIE)!), id); },
  tooMany,
});

// ------------------------------------------------------------------ investor identity checks (Sumsub KYC)
mountKyc(app, {
  store,
  origin: (c) => `https://${c.req.header("host") ?? "tokenize.diamondz.one"}`,
  requireAdmin,
  tenantId: (c) => (c as Context<Env>).get("tenant").id,
  siteHas,
  listedAsset: async (c, id) => (await siteListed(c)).find((a: any) => a.id === id) ?? null,
  ipAsset: async (c, id) => {
    const r = (await store.allAssets()).find((x) => x.id === id && siteHas(c, x.tenant_id));
    const a: any = r ? rowToAsset(r) : null;
    return a?.status === "deployed" && a.ip?.registered ? a : null;
  },
  verifySig: async (chainId, wallet, message, signature) => {
    const net = networkById(chainId);
    // ERC-1271 smart wallets (thirdweb in-app wallets) via the chain; plain EOAs offline as a fallback.
    const client = net ? createPublicClient({ transport: http(rpcUrl(net), { timeout: 10_000 }) }) : null;
    return !!(client && (await client.verifyMessage({ address: wallet, message, signature }).catch(() => false)))
      || (await viemVerifyMessage({ address: wallet, message, signature }).catch(() => false));
  },
});

// ------------------------------------------------------------------ investors approved without an identity check
mountApprovals(app, {
  store,
  requireAdmin,
  adminAsset: adminAssetOf,
  listedAsset: async (c, id) => (await siteListed(c)).find((a: any) => a.id === id) ?? null,
  allDeployed: allDeployedAssets,
  client: (chainId) => {
    const net = networkById(chainId);
    return net ? { pc: createPublicClient({ transport: http(rpcUrl(net), { timeout: 15_000 }) }) as any, testnet: !!net.testnet } : null;
  },
});

// ------------------------------------------------------------------ Content-Security-Policy reports
mountCsp(app, {
  store,
  requireAdmin,
  isPlatformAdmin: (c) => (c as Context<Env>).get("tenant").id === DEFAULT_TENANT && ["owner", "admin"].includes((c as Context<Env>).get("member").role),
  tooMany,
});

// ------------------------------------------------------------------ white-label site setup (W1–W6)
const whitelabel = mountWhitelabel(app, {
  store,
  requireAdmin,
  isPlatformAdmin: (c) => (c as Context<Env>).get("tenant").id === DEFAULT_TENANT && ["owner", "admin"].includes((c as Context<Env>).get("member").role),
  tenantId: (c) => (c as Context<Env>).get("tenant").id,
  siteId: (c) => (c as Context<Env>).get("site").id,
  member: (c) => ({ ...(c as Context<Env>).get("member"), email: (c as Context<Env>).get("session")?.email ?? null }),
  plan: async (id) => { const t = await store.getTenant(id); return t ? ((JSON.parse(t.config) as TenantConfig).plan ?? "launch") : "launch"; },
  tenantConfig: async (id) => { const t = await store.getTenant(id); return t ? JSON.parse(t.config) : null; },
  tenantName: async (id) => { const t = await store.getTenant(id); return t ? (JSON.parse(t.config) as TenantConfig).name : "Issuer"; },
  tooMany,
});

// ------------------------------------------------------------------ legal sign-off you can trust (L1–L4)
const legal = mountLegal(app, {
  store,
  requireAdmin,
  tenantId: (c) => (c as Context<Env>).get("tenant").id,
  member: (c) => ({ ...(c as Context<Env>).get("member"), email: (c as Context<Env>).get("session")?.email }),
  isPlatform: (c) => (c as Context<Env>).get("tenant").id === DEFAULT_TENANT,
  adminAsset: adminAssetOf,
  anyAsset: async (id) => { const r = (await store.allAssets()).find((x) => x.id === id); return r ? rowToAsset(r) : null; },
  tenantName: async (id) => { const t = await store.getTenant(id); return t ? (JSON.parse(t.config) as TenantConfig).name : "Issuer"; },
  issuerEmails: async (tid) => {
    const t = await store.getTenant(tid);
    const cfg = t ? (JSON.parse(t.config) as TenantConfig) : null;
    const members = await Promise.all((await store.membersOf(tid)).map(async (m) => (await store.getAccount(m.account))?.email ?? ""));
    return [...members, ...(cfg?.notifyEmails ?? [])].filter(Boolean);
  },
  origin: (c) => `https://${hostOf(c)}`,
  tooMany,
  senderFor: (tid) => whitelabel.senderFor(tid),
});
// ------------------------------------------------------------------ signed checks through Adobe Acrobat Sign (E1–E7)
mountEsign(app, {
  store,
  requireAdmin,
  isPlatformAdmin: (c) => (c as Context<Env>).get("tenant").id === DEFAULT_TENANT && ["owner", "admin"].includes((c as Context<Env>).get("member").role),
  member: (c) => (c as Context<Env>).get("member"),
  adminAsset: adminAssetOf,
  anyAsset: async (id) => { const r = (await store.allAssets()).find((x) => x.id === id); return r ? rowToAsset(r) : null; },
  listedAsset: async (c, id) => (await siteListed(c)).find((a: any) => a.id === id) ?? null,
  tenantName: async (id) => { const t = await store.getTenant(id); return t ? (JSON.parse(t.config) as TenantConfig).name : "Issuer"; },
  origin: (c) => `https://${hostOf(c)}`,
  tooMany,
  legal: { sync: (id, ev) => legal.adobeSync(id, ev), open: () => legal.adobeOpen() },
});

// Public: is the offering's issuer a verified company (Stripe business verification)? Name as Stripe has it.
app.get("/market/:id/issuer", async (c) => {
  const a = (await siteListed(c)).find((x: any) => x.id === c.req.param("id"));
  if (!a) return c.json({ error: "Not found" }, 404);
  const co = await legal.companyOf(a.tenantId, 10 * 60_000).catch(() => null);
  c.header("Cache-Control", "public, max-age=300");
  return c.json({ verified: co?.status === "verified", name: co?.status === "verified" ? co.name : null });
});


// ------------------------------------------------------------------ client accounts for advisors (design 4)
const ERC20_BAL = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;
mountClients(app, {
  store,
  senderFor: (tid) => whitelabel.senderFor(tid),
  requireAdmin,
  tenantId: (c) => (c as Context<Env>).get("tenant").id,
  tenantName: async (id) => { const t = await store.getTenant(id); return t ? (JSON.parse(t.config) as TenantConfig).name : "Your advisor"; },
  listed: (c) => siteListed(c),
  balanceOf: async (a, wallet) => {
    const net = networkById(a.chainId);
    if (!net || !a.deployment?.token || !["erc7943", "erc3643", "erc4626"].includes(a.standard)) return null;
    const pc = createPublicClient({ transport: http(rpcUrl(net), { timeout: 10_000 }) });
    const [bal, dec] = await Promise.all([
      pc.readContract({ address: a.deployment.token, abi: ERC20_BAL, functionName: "balanceOf", args: [wallet] }),
      pc.readContract({ address: a.deployment.token, abi: ERC20_BAL, functionName: "decimals" }).catch(() => 18),
    ]);
    return Number(bal) / 10 ** Number(dec);
  },
  verifySig: async (chainId, wallet, message, signature) => {
    const net = networkById(chainId);
    const client = net ? createPublicClient({ transport: http(rpcUrl(net), { timeout: 10_000 }) }) : null;
    return !!(client && (await client.verifyMessage({ address: wallet, message, signature }).catch(() => false)))
      || (await viemVerifyMessage({ address: wallet, message, signature }).catch(() => false));
  },
  origin: (c) => `https://${hostOf(c)}`,
  tooMany,
});

// ------------------------------------------------------------------ proof of asset from the SPV bank (Mastercard Open Finance)
mountBankProof(app, {
  store,
  requireAdmin,
  tenantId: (c) => (c as Context<Env>).get("tenant").id,
  adminAsset: adminAssetOf,
  allDeployed: allDeployedAssets,
});

// ------------------------------------------------------------------ SEC EDGAR: the issuer's Form D, attached to the offering
mountMarkets(app);
mountEdgar(app, {
  store,
  requireAdmin,
  tenantId: (c) => (c as Context<Env>).get("tenant").id,
  adminAsset: adminAssetOf,
  updateAssetData: async (c, id, fn) => {
    const r = await getAssetRow(id, (c as Context<Env>).get("tenant").id);
    if (!r) return null;
    const d = upgradeAsset(JSON.parse(r.data));
    fn(d);
    const now = new Date().toISOString();
    const data = JSON.stringify(d);
    await store.updateAsset(r.id, r.tenant_id, data, now);
    return rowToAsset({ ...r, data, updated_at: now });
  },
});

// ------------------------------------------------------------------ background jobs (Temporal in production)
mountJobs(app);

// Leads: public, simple per-IP rate limit (5 / 10 min).
const hits = new Map<string, number[]>();
const Lead = z.object({
  kind: z.string().max(80),
  name: z.string().trim().min(1).max(120),
  email: z.string().email().max(200),
  company: z.string().max(200).optional().default(""),
  message: z.string().max(2000).optional().default(""),
});
app.post("/leads", async (c) => {
  const ip = c.req.header("x-real-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 600_000);
  if (recent.length >= 5) return c.json({ error: "Too many requests, try again later" }, 429);
  hits.set(ip, [...recent, now]);
  const parsed = Lead.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Please enter your name and a valid email" }, 400);
  await recordLead(c.get("tenant"), parsed.data, ip, c.req.header("host") ?? "");
  return c.json({ ok: true });
});

/** Stores a message in a tenant's inbox and sends the heads-up email (the stored message is the source of truth,
 *  so the email never blocks or fails the request). */
async function recordLead(t: TenantRow, lead: { name: string; email: string; company?: string; message?: string; kind: string }, ip: string | null, fallbackHost: string) {
  const createdAt = new Date().toISOString();
  await store.insertLead({ tenant_id: t.id, data: JSON.stringify(lead), ip, created_at: createdAt });
  const cfg = JSON.parse(t.config) as TenantConfig;
  const recipients = cfg.notifyEmails?.length ? cfg.notifyEmails : t.id === DEFAULT_TENANT ? leadsNotifyEnv() : [];
  const host = (await store.hostsOf(t.id))[0] ?? fallbackHost;
  void sendLeadAlert({ tenantName: cfg.name, consoleUrl: `https://${host}/app/messages`, recipients, lead, receivedAt: createdAt });
}

// ----- Console › Plan & billing: ask the platform to switch plans (no self-serve billing yet) -----
// The request lands in the PLATFORM's Messages inbox (and its email alert); the tenant sees it as pending until the
// operator changes the plan, which clears it.
app.post("/billing/plan-request", requireAdmin, async (c) => {
  const body = z.object({ plan: z.enum(["launch", "growth", "whitelabel"]), annual: z.boolean() }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Choose a plan" }, 400);
  const t = c.get("tenant");
  const cfg = JSON.parse(t.config) as TenantConfig;
  const current = planById(cfg.plan);
  if (body.data.plan === current.id) return c.json({ error: "That's already your plan" }, 400);
  const prev = cfg.planRequest;
  if (prev && prev.plan === body.data.plan && prev.annual === body.data.annual) return c.json({ planRequest: prev });
  const want = planById(body.data.plan);
  const s = c.get("session");
  const at = new Date().toISOString();
  const platform = await store.getTenant(DEFAULT_TENANT);
  if (!platform) return c.json({ error: "Platform not configured" }, 500);
  await recordLead(platform, {
    kind: `plan-request:${t.id}`, name: s.name ?? s.email, email: s.email, company: cfg.name,
    message: `Plan change request from ${cfg.name} (tenant ${t.id}): ${current.name} → ${want.name}, billed ${body.data.annual ? "yearly" : "monthly"}.`,
  }, null, c.req.header("host") ?? "");
  const planRequest = { plan: body.data.plan, annual: body.data.annual, at };
  await store.setTenantConfig(t.id, JSON.stringify({ ...cfg, planRequest }));
  return c.json({ planRequest });
});
app.get("/billing/plan-request", requireAdmin, async (c) => {
  const cfg = JSON.parse(c.get("tenant").config) as TenantConfig;
  // Done once the operator has switched the plan to the requested one.
  const pending = cfg.planRequest && cfg.planRequest.plan !== (cfg.plan ?? "launch") ? cfg.planRequest : null;
  return c.json({ planRequest: pending });
});
app.delete("/billing/plan-request", requireAdmin, async (c) => {
  const t = c.get("tenant");
  const { planRequest: _gone, ...cfg } = JSON.parse(t.config) as TenantConfig;
  await store.setTenantConfig(t.id, JSON.stringify(cfg));
  return c.json({ ok: true });
});

const leadsNotifyEnv = () => (process.env.LEADS_NOTIFY_TO ?? "").split(",").map((e) => e.trim().toLowerCase()).filter((e) => z.string().email().safeParse(e).success);

// ----- Console › Messages: the contact-form inbox (each tenant sees only its own) -----
const leadOut = (r: LeadRow) => {
  const d = JSON.parse(r.data) as { name: string; email: string; company?: string; message?: string; kind?: string };
  return { id: r.id, name: d.name, email: d.email, company: d.company || null, message: d.message || null, createdAt: r.created_at, readAt: r.read_at, archivedAt: r.archived_at };
};
app.get("/messages", requireAdmin, async (c) => {
  const archived = c.req.query("archived") === "1";
  const t = c.get("tenant");
  const [rows, unread] = await Promise.all([store.listLeads(t.id, archived, 500), store.unreadLeads(t.id)]);
  return c.json({ messages: rows.map(leadOut), unread });
});
app.get("/messages/unread", requireAdmin, async (c) => c.json({ unread: await store.unreadLeads(c.get("tenant").id) }));
app.patch("/messages/:id", requireAdmin, async (c) => {
  const body = z.object({ read: z.boolean().optional(), archived: z.boolean().optional() }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Send {read} and/or {archived}" }, 400);
  const now = new Date().toISOString();
  const fields: { read_at?: string | null; archived_at?: string | null } = {};
  if (body.data.read !== undefined) fields.read_at = body.data.read ? now : null;
  if (body.data.archived !== undefined) fields.archived_at = body.data.archived ? now : null;
  const ok = await store.updateLead(c.req.param("id") ?? "", c.get("tenant").id, fields);
  return ok ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
});
app.get("/messages/settings", requireAdmin, async (c) => {
  const t = c.get("tenant");
  const cfg = JSON.parse(t.config) as TenantConfig;
  const fallback = !cfg.notifyEmails?.length && t.id === DEFAULT_TENANT && leadsNotifyEnv().length > 0;
  return c.json({ notifyEmails: cfg.notifyEmails ?? [], emailConfigured: emailConfigured(), platformFallback: fallback });
});
app.put("/messages/settings", requireAdmin, async (c) => {
  const t = c.get("tenant");
  const body = z.object({ notifyEmails: TenantConfig.shape.notifyEmails }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Enter up to 5 valid email addresses" }, 400);
  const cfg = JSON.parse(t.config) as TenantConfig;
  await store.setTenantConfig(t.id, JSON.stringify({ ...cfg, notifyEmails: [...new Set(body.data.notifyEmails)] }));
  return c.json({ notifyEmails: [...new Set(body.data.notifyEmails)], emailConfigured: emailConfigured() });
});

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Server error" }, 500);
});

// idleTimeout (seconds, Bun default 10): reads that scan chain history can take longer than 10s; Cloudflare waits 100s.
export default { port: PORT, hostname: "127.0.0.1", fetch: app.fetch, idleTimeout: 100 };
console.log(`[api] listening on 127.0.0.1:${PORT}, store=${store.kind === "mongo" ? `mongo (${process.env.MONGO_DB ?? "tokenize"})` : DB_PATH}`);
