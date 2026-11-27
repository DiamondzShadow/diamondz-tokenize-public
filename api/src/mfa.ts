// Two-step sign-in for the issuer console (2026-11-20; ISO 27001 A.8.5, SOC 2 CC6.1, NIST CSF PR.AA).
//
// Authenticator-app codes (TOTP, RFC 6238: HMAC-SHA1, 30-second steps, 6 digits, ±1 step for clock drift) on top of
// the thirdweb sign-in. Secrets are encrypted at rest with AES-256-GCM under MFA_ENC_KEY (server env). Ten one-time
// recovery codes, stored only as hashes. A code can't be replayed: the last used step is remembered.
//
// Enforcement (requireAdmin calls `mfaGate`):
//   - anyone who turned it on must enter a code once per session, for every console request;
//   - owners and admins who haven't turned it on can read, but can't change anything until they set it up.
// Google Workspace sign-ins (white-label admins, no thirdweb account) rely on their identity provider's MFA.
//
//   GET  /api/mfa                 { enabled, verified, required }
//   POST /api/mfa/setup           → { secret, uri }   (new pending secret; replaces an unfinished one)
//   POST /api/mfa/enable {code}   → { recoveryCodes } (shown once)
//   POST /api/mfa/verify {code}   code or recovery code → marks this session
//   POST /api/mfa/disable {code}  needs a current code
import type { Context, Hono } from "hono";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Role, Store } from "./store";

const STEP = 30;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function b32encode(buf: Buffer) {
  let bits = 0, val = 0, out = "";
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function b32decode(s: string) {
  const clean = s.replace(/=+$/, "").toUpperCase();
  let bits = 0, val = 0; const out: number[] = [];
  for (const ch of clean) { const i = B32.indexOf(ch); if (i < 0) throw new Error("bad base32"); val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
export function totp(secretB32: string, step: number) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", b32decode(secretB32)).update(msg).digest();
  const o = h[h.length - 1]! & 15;
  const n = ((h[o]! & 127) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 1_000_000).padStart(6, "0");
}
/** The matching step within ±1 of now, or null. */
function matchStep(secretB32: string, code: string, now = Date.now()) {
  if (!/^\d{6}$/.test(code)) return null;
  const cur = Math.floor(now / 1000 / STEP);
  for (const s of [cur, cur - 1, cur + 1]) {
    const a = Buffer.from(totp(secretB32, s)), b = Buffer.from(code);
    if (timingSafeEqual(a, b)) return s;
  }
  return null;
}

function encKey() {
  const k = process.env.MFA_ENC_KEY;
  if (!k || !/^[0-9a-f]{64}$/i.test(k)) throw new Error("MFA_ENC_KEY is not set");
  return Buffer.from(k, "hex");
}
const seal = (plain: string) => {
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", encKey(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), ct].map((x) => x.toString("base64")).join(".");
};
const open = (box: string) => {
  const [iv, tag, ct] = box.split(".").map((x) => Buffer.from(x, "base64"));
  const d = createDecipheriv("aes-256-gcm", encKey(), iv!);
  d.setAuthTag(tag!);
  return Buffer.concat([d.update(ct!), d.final()]).toString("utf8");
};

interface MfaDoc { secret: string; enabled: boolean; lastStep: number; recovery: string[]; enabledAt?: string }
export const mfaConfigured = () => { try { encKey(); return true; } catch { return false; } };

export interface MfaDeps {
  store: Store;
  requireAccount: (c: Context<any>, next: () => Promise<void>) => Promise<Response | void>;
  account: (c: Context<any>) => string;
  sessionHash: (c: Context<any>) => string;
  roleOf: (c: Context<any>) => Promise<Role | null>;
  tooMany: (key: string, max: number, windowMs: number) => boolean;
}

const getDoc = async (store: Store, account: string) => {
  const d = await store.getDoc("mfa", account.toLowerCase());
  return d ? (JSON.parse(d.data) as MfaDoc) : null;
};
const putDoc = (store: Store, account: string, doc: MfaDoc) => {
  const now = new Date().toISOString();
  return store.putDoc({ coll: "mfa", id: account.toLowerCase(), tenant_id: "_accounts", data: JSON.stringify(doc), created_at: now, updated_at: now });
};
const sessionVerified = async (store: Store, sessionHash: string) => !!(await store.getKv(`mfa-ok:${sessionHash}`));

/** Called by requireAdmin for thirdweb account sessions. Returns an error response body, or null to continue. */
export async function mfaGate(store: Store, account: string, sessionHash: string, role: Role, method: string) {
  const doc = await getDoc(store, account);
  if (doc?.enabled) return (await sessionVerified(store, sessionHash)) ? null : { status: 401, body: { error: "Enter the code from your authenticator app", needsMfa: true } };
  const write = method !== "GET" && method !== "HEAD";
  if (write && (role === "owner" || role === "admin") && mfaConfigured()) return { status: 403, body: { error: "Owners and admins must turn on two-step sign-in before making changes. Go to Security in the console.", mfaSetupRequired: true } };
  return null;
}

export function mountMfa(app: Hono<any>, deps: MfaDeps) {
  const { store } = deps;
  const limited = (c: Context<any>) => deps.tooMany(`mfa:${deps.account(c)}`, 10, 10 * 60_000);

  app.get("/mfa", deps.requireAccount, async (c) => {
    const doc = await getDoc(store, deps.account(c));
    const role = await deps.roleOf(c);
    return c.json({ enabled: !!doc?.enabled, verified: doc?.enabled ? await sessionVerified(store, deps.sessionHash(c)) : false, required: role === "owner" || role === "admin", available: mfaConfigured(), recoveryLeft: doc?.enabled ? doc.recovery.length : null });
  });

  app.post("/mfa/setup", deps.requireAccount, async (c) => {
    if (!mfaConfigured()) return c.json({ error: "Two-step sign-in isn't configured on this server" }, 503);
    const acct = deps.account(c);
    const cur = await getDoc(store, acct);
    if (cur?.enabled) return c.json({ error: "Two-step sign-in is already on" }, 409);
    const secret = b32encode(randomBytes(20));
    await putDoc(store, acct, { secret: seal(secret), enabled: false, lastStep: 0, recovery: [] });
    const label = encodeURIComponent(`Diamondz Tokenize:${(await store.getAccount(acct))?.email ?? acct.slice(0, 10)}`);
    return c.json({ secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=Diamondz%20Tokenize&algorithm=SHA1&digits=6&period=30` });
  });

  app.post("/mfa/enable", deps.requireAccount, async (c) => {
    if (limited(c)) return c.json({ error: "Too many tries. Wait a few minutes." }, 429);
    const acct = deps.account(c);
    const doc = await getDoc(store, acct);
    if (!doc || doc.enabled) return c.json({ error: "Start setup first" }, 409);
    const b = z.object({ code: z.string().trim() }).safeParse(await c.req.json().catch(() => null));
    const step = b.success ? matchStep(open(doc.secret), b.data.code) : null;
    if (step === null) return c.json({ error: "That code didn't match. Check the time on your phone and try the newest code." }, 400);
    const codes = Array.from({ length: 10 }, () => randomBytes(5).toString("hex").replace(/(.{5})/, "$1-"));
    await putDoc(store, acct, { ...doc, enabled: true, lastStep: step, recovery: codes.map((x) => sha(x)), enabledAt: new Date().toISOString() });
    await store.setKv(`mfa-ok:${deps.sessionHash(c)}`, new Date().toISOString(), new Date().toISOString());
    return c.json({ recoveryCodes: codes });
  });

  app.post("/mfa/verify", deps.requireAccount, async (c) => {
    if (limited(c)) return c.json({ error: "Too many tries. Wait a few minutes." }, 429);
    const acct = deps.account(c);
    const doc = await getDoc(store, acct);
    if (!doc?.enabled) return c.json({ error: "Two-step sign-in isn't on" }, 409);
    const b = z.object({ code: z.string().trim().max(20) }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "Enter a code" }, 400);
    const code = b.data.code;
    let next = doc;
    if (/^\d{6}$/.test(code)) {
      const step = matchStep(open(doc.secret), code);
      if (step === null || step <= doc.lastStep) return c.json({ error: "That code didn't match, or was already used. Try the next one." }, 400);
      next = { ...doc, lastStep: step };
    } else {
      const h = sha(code.toLowerCase());
      if (!doc.recovery.includes(h)) return c.json({ error: "That recovery code isn't valid" }, 400);
      next = { ...doc, recovery: doc.recovery.filter((x) => x !== h) };
    }
    await putDoc(store, acct, next);
    await store.setKv(`mfa-ok:${deps.sessionHash(c)}`, new Date().toISOString(), new Date().toISOString());
    return c.json({ ok: true, recoveryLeft: next.recovery.length });
  });

  app.post("/mfa/disable", deps.requireAccount, async (c) => {
    if (limited(c)) return c.json({ error: "Too many tries. Wait a few minutes." }, 429);
    const acct = deps.account(c);
    const doc = await getDoc(store, acct);
    if (!doc?.enabled) return c.json({ error: "Two-step sign-in isn't on" }, 409);
    const b = z.object({ code: z.string().trim() }).safeParse(await c.req.json().catch(() => null));
    const step = b.success ? matchStep(open(doc.secret), b.data.code) : null;
    if (step === null || step <= doc.lastStep) return c.json({ error: "Enter a current code from your app to turn it off" }, 400);
    await store.deleteDoc("mfa", acct.toLowerCase());
    return c.json({ ok: true });
  });
}
