// Team members and roles (design 2, canvas 15R3n8ALvMUcS7iPxWEPTj, approved 2026-11-20).
//
// A workspace has one owner and any number of invited members, each with a role. Roles limit what someone can do in
// THIS console; anything a token's admin must sign still goes to the issuer's multisig, so no member acts alone on chain.
//
//   owner       everything, plus team, plan and billing
//   admin       everything except team, plan and billing
//   compliance  investors, accreditation, identity checks, Form D, legal sign-off, messages
//   operations  offerings (create/edit), listings, payouts, bank links, sales, IP, messages; no deploys, no approvals
//   viewer      read-only
//
// Invites: a random token goes in a link (emailed when Resend is configured, otherwise shown to the owner to copy).
// Only sha256(token) is stored. Accepting needs a signed-in account (thirdweb) AND the token, so having the link is
// what proves access to the invited email. Invites expire after 7 days and work once.
//
//   GET    /api/team                       members + pending invites (any member)
//   POST   /api/team/invites               {email, role}  owner only
//   DELETE /api/team/invites/:id           owner only
//   PATCH  /api/team/members/:account      {role}         owner only, never the owner
//   DELETE /api/team/members/:account      owner only, never the owner
//   GET    /api/invites/:token             public: workspace name + role, for the join page
//   POST   /api/invites/accept             {token}        signed-in account
import type { Context, Hono } from "hono";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Role, Store } from "./store";
import { escHtml, sendEmail, emailConfigured } from "./notify";

export const ROLES: Role[] = ["owner", "admin", "compliance", "operations", "viewer"];
const INVITABLE = ["admin", "compliance", "operations", "viewer"] as const;
const INVITE_TTL_MS = 7 * 86_400_000;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ------------------------------------------------------------------ permissions for console writes
const any = (path: string, res: RegExp[]) => res.some((r) => r.test(path));
const OWNER_ONLY = [/^\/team(\/|$)/, /^\/billing(\/|$)/, /^\/cards\/connect$/];
const COMPLIANCE = [
  /^\/accreditation\//, /^\/assets\/[^/]+\/formd(\/|$)/, /^\/assets\/[^/]+\/trex\/(kyc|identity)$/, /^\/assets\/[^/]+\/stellar\/(verify|freeze)$/,
  /^\/kyc(\/|$)/, /^\/messages(\/|$)/, /^\/entities(\/|$)/, /^\/assets\/[^/]+\/documents(\/|$)/, /^\/assets\/[^/]+\/legal(\/|$)/,
];
const OPERATIONS = [
  /^\/assets$/, /^\/assets\/[^/]+$/, /^\/assets\/[^/]+\/payouts(\/|$)/, /^\/payouts\//, /^\/assets\/[^/]+\/bank(\/|$)/,
  /^\/assets\/[^/]+\/stellar\/(sale\/[^/]+|issue)$/, /^\/assets\/[^/]+\/ip(\/|$)/, /^\/messages(\/|$)/, /^\/stellar-trustline\//, /^\/assets\/[^/]+\/documents(\/|$)/,
  /^\/clients(\/|$)/,
];

/** Can `role` make this console write? `path` is relative to /api; `body` is the parsed JSON (for PATCH /tenant). */
export function canWrite(role: Role, method: string, path: string, body?: unknown): boolean {
  if (method === "GET" || method === "HEAD") return true;
  if (role === "owner") return true;
  if (any(path, OWNER_ONLY)) return false;
  if (role === "admin") return true;
  if (role === "viewer") return false;
  if (path === "/tenant" && method === "PATCH") {
    // Legal sign-off (Go live) is the only workspace setting compliance changes.
    const keys = body && typeof body === "object" ? Object.keys(body) : [];
    return role === "compliance" && keys.length > 0 && keys.every((k) => k === "onboarding");
  }
  if (role === "compliance") return any(path, COMPLIANCE);
  if (role === "operations") return any(path, OPERATIONS);
  return false;
}

export const roleLabel = (r: Role) => r[0]!.toUpperCase() + r.slice(1);

interface Invite { email: string; role: Role; invitedBy: string; expiresAt: string; acceptedAt?: string; acceptedBy?: string }

export interface TeamDeps {
  store: Store;
  requireAdmin: (c: Context<any>, next: () => Promise<void>) => Promise<Response | void>;
  requireAccount: (c: Context<any>, next: () => Promise<void>) => Promise<Response | void>;
  /** The signed-in thirdweb account (after requireAccount). */
  sessionAccount: (c: Context<any>) => string;
  /** Signed-in account (lower-case) and role in the active workspace; set by requireAdmin. */
  member: (c: Context<any>) => { account: string | null; role: Role };
  tenantId: (c: Context<any>) => string;
  tenantName: (tenantId: string) => Promise<string | null>;
  platformOrigin: (c: Context<any>) => string;
  switchTo: (c: Context<any>, tenantId: string) => Promise<void>;
  tooMany: (key: string, max: number, windowMs: number) => boolean;
}

export function mountTeam(app: Hono<any>, deps: TeamDeps) {
  const { store } = deps;

  app.get("/team", deps.requireAdmin, async (c) => {
    const tid = deps.tenantId(c);
    const me = deps.member(c);
    const members = await Promise.all((await store.membersOf(tid)).map(async (m) => {
      const a = await store.getAccount(m.account);
      return { account: m.account, email: a?.email ?? null, name: a?.name ?? null, role: m.role, since: m.created_at, you: m.account === me.account };
    }));
    const now = Date.now();
    const invites = (await store.listDocs("invites", tid))
      .map((d) => ({ id: d.id, ...(JSON.parse(d.data) as Invite), createdAt: d.created_at }))
      .filter((i) => !i.acceptedAt)
      .map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt, expired: Date.parse(i.expiresAt) < now, createdAt: i.createdAt }));
    return c.json({ me, members, invites, emailOn: emailConfigured() });
  });

  app.post("/team/invites", deps.requireAdmin, async (c) => {
    const tid = deps.tenantId(c);
    const me = deps.member(c);
    if (me.role !== "owner") return c.json({ error: "Only the workspace owner can invite people" }, 403);
    if (deps.tooMany(`invite:${tid}`, 30, 86_400_000)) return c.json({ error: "Too many invites today. Try again tomorrow." }, 429);
    const b = z.object({ email: z.string().trim().toLowerCase().email().max(200), role: z.enum(INVITABLE) }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "Enter a valid email and pick a role" }, 400);
    for (const m of await store.membersOf(tid)) {
      if ((await store.getAccount(m.account))?.email?.toLowerCase() === b.data.email) return c.json({ error: "That person is already on the team" }, 409);
    }
    const token = randomBytes(24).toString("base64url");
    const id = sha(token).slice(0, 32);
    const now = new Date();
    const inv: Invite = { email: b.data.email, role: b.data.role, invitedBy: me.account ?? "owner", expiresAt: new Date(now.getTime() + INVITE_TTL_MS).toISOString() };
    await store.putDoc({ coll: "invites", id, tenant_id: tid, data: JSON.stringify(inv), created_at: now.toISOString(), updated_at: now.toISOString() });
    const link = `${deps.platformOrigin(c)}/start/join?t=${token}`;
    const ws = (await deps.tenantName(tid)) ?? "a workspace";
    const sent = await sendEmail({
      to: [b.data.email],
      subject: `You're invited to ${ws} on Diamondz Tokenize`,
      html: `<div style="font:14px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:560px"><p>You've been invited to join <b>${escHtml(ws)}</b> on Diamondz Tokenize as <b>${roleLabel(b.data.role)}</b>.</p><p><a href="${escHtml(link)}">Accept the invite</a></p><p style="color:#666">Sign in with Google, Apple or an email code. The link works once and expires in 7 days.</p></div>`,
      text: `You've been invited to join ${ws} on Diamondz Tokenize as ${roleLabel(b.data.role)}.\n\nAccept: ${link}\n\nThe link works once and expires in 7 days.`,
    });
    // The link is returned to the owner only when no email went out, so they can send it themselves.
    return c.json({ invite: { id, email: inv.email, role: inv.role, expiresAt: inv.expiresAt }, emailed: sent === "sent", link: sent === "sent" ? null : link });
  });

  app.delete("/team/invites/:id", deps.requireAdmin, async (c) => {
    if (deps.member(c).role !== "owner") return c.json({ error: "Only the workspace owner can cancel invites" }, 403);
    const d = await store.getDoc("invites", c.req.param("id") ?? "");
    if (!d || d.tenant_id !== deps.tenantId(c)) return c.json({ error: "Not found" }, 404);
    await store.deleteDoc("invites", d.id);
    return c.json({ ok: true });
  });

  const memberTarget = async (c: Context<any>) => {
    const tid = deps.tenantId(c);
    const acct = (c.req.param("account") ?? "").toLowerCase();
    const m = (await store.membersOf(tid)).find((x) => x.account === acct);
    return { tid, m };
  };
  app.patch("/team/members/:account", deps.requireAdmin, async (c) => {
    if (deps.member(c).role !== "owner") return c.json({ error: "Only the workspace owner can change roles" }, 403);
    const { tid, m } = await memberTarget(c);
    if (!m) return c.json({ error: "Not found" }, 404);
    if (m.role === "owner") return c.json({ error: "The owner's role can't change" }, 400);
    const b = z.object({ role: z.enum(INVITABLE) }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "Pick a role" }, 400);
    await store.setMemberRole(m.account, tid, b.data.role);
    return c.json({ ok: true });
  });
  app.delete("/team/members/:account", deps.requireAdmin, async (c) => {
    if (deps.member(c).role !== "owner") return c.json({ error: "Only the workspace owner can remove people" }, 403);
    const { tid, m } = await memberTarget(c);
    if (!m) return c.json({ error: "Not found" }, 404);
    if (m.role === "owner") return c.json({ error: "The owner can't be removed" }, 400);
    await store.removeMember(m.account, tid);
    return c.json({ ok: true });
  });

  const findInvite = async (token: string) => {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
    const d = await store.getDoc("invites", sha(token).slice(0, 32));
    if (!d) return null;
    const inv = JSON.parse(d.data) as Invite;
    return { d, inv };
  };
  app.get("/invites/:token", async (c) => {
    if (deps.tooMany(`invite-look:${c.req.header("x-real-ip") ?? "local"}`, 60, 600_000)) return c.json({ error: "Too many requests" }, 429);
    const f = await findInvite(c.req.param("token") ?? "");
    if (!f) return c.json({ error: "This invite link isn't valid" }, 404);
    const state = f.inv.acceptedAt ? "used" : Date.parse(f.inv.expiresAt) < Date.now() ? "expired" : "open";
    return c.json({ workspace: (await deps.tenantName(f.d.tenant_id)) ?? "A workspace", role: f.inv.role, email: f.inv.email, state });
  });
  app.post("/invites/accept", deps.requireAccount, async (c) => {
    const b = z.object({ token: z.string() }).safeParse(await c.req.json().catch(() => null));
    const f = b.success ? await findInvite(b.data.token) : null;
    if (!f) return c.json({ error: "This invite link isn't valid" }, 404);
    if (f.inv.acceptedAt) return c.json({ error: "This invite was already used" }, 410);
    if (Date.parse(f.inv.expiresAt) < Date.now()) return c.json({ error: "This invite expired. Ask the owner for a new one." }, 410);
    const account = deps.sessionAccount(c).toLowerCase();
    const now = new Date().toISOString();
    if (!(await store.membersOf(f.d.tenant_id)).some((m) => m.account === account)) {
      await store.addMembership({ account, tenant_id: f.d.tenant_id, role: f.inv.role, created_at: now });
    }
    await store.putDoc({ ...f.d, data: JSON.stringify({ ...f.inv, acceptedAt: now, acceptedBy: account }), updated_at: now });
    await deps.switchTo(c, f.d.tenant_id);
    return c.json({ ok: true, workspace: f.d.tenant_id });
  });
}
