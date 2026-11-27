// Client accounts for wealth managers and advisors (design 4, canvas 15R3n8ALvMUcS7iPxWEPTj, approved 2026-11-20).
//
// A workspace (the advisor firm) invites clients. Each client opens a private link, connects THEIR OWN wallet and
// signs a consent message ("let <firm> see my holdings and propose purchases"). The firm then sees, per client,
// identity and accreditation status with each issuer and on-chain holdings in listed offerings, and can propose an
// allocation to an offering. The client approves each proposal from their link and buys from their own wallet
// through the normal investor flow, so the issuer always sees the real holder and income goes straight to the client.
// The firm never holds client money or keys. An omnibus (nominee) wallet is NOT built: it needs the issuer's approval
// and counsel's sign-off, and the screen says so.
//
// Firm (console):
//   GET    /api/clients                     clients + status (identity/accreditation per issuer, holdings)
//   POST   /api/clients {name,email,kind}   → { client, link }  (link emailed when Resend is set; returned to copy otherwise)
//   DELETE /api/clients/:id
//   GET    /api/clients/proposals           all proposals
//   POST   /api/clients/proposals {assetId, items:[{clientId, amountUsd}]}  only eligible clients
// Client (private link, no account):
//   GET    /api/client-portal/:token
//   POST   /api/client-portal/:token/link {wallet, chainId, signature}
//   POST   /api/client-portal/:token/proposals/:id {decision: approve|decline}
import type { Context, Hono } from "hono";
import { createHash, randomBytes } from "node:crypto";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import type { Store } from "./store";
import { escHtml, sendEmail } from "./notify";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
type Kind = "individual" | "trust" | "company";
interface Client { name: string; email: string; kind: Kind; wallet: string | null; linkedAt: string | null; tokenHash: string; firm: string }
interface Proposal { clientId: string; assetId: string; assetName: string; amountUsd: number; status: "proposed" | "approved" | "declined"; decidedAt: string | null }

export const consentMessage = (firm: string, wallet: string, ref: string) =>
  `I allow ${firm} to see my holdings and identity-check status on Diamondz Tokenize and to propose investments to me.\nI keep my own wallet and approve every purchase myself.\n\nWallet: ${wallet}\nReference: ${ref}`;

export interface ClientDeps {
  store: Store;
  requireAdmin: (c: Context<any>, next: () => Promise<void>) => Promise<Response | void>;
  tenantId: (c: Context<any>) => string;
  tenantName: (id: string) => Promise<string>;
  /** Listed, deployed offerings on the platform site (with issuer id). */
  listed: (c: Context<any>) => Promise<any[]>;
  /** Token balance of `wallet` in a deployed EVM offering, in whole tokens; null when unreadable. */
  balanceOf: (asset: any, wallet: Address) => Promise<number | null>;
  verifySig: (chainId: number, wallet: Address, message: string, signature: Hex) => Promise<boolean>;
  origin: (c: Context<any>) => string;
  tooMany: (key: string, max: number, windowMs: number) => boolean;
}

export function mountClients(app: Hono<any>, deps: ClientDeps) {
  const { store } = deps;
  const now = () => new Date().toISOString();
  const clientsOf = async (tid: string) => (await store.listDocs("clients", tid)).map((d) => ({ id: d.id, createdAt: d.created_at, ...(JSON.parse(d.data) as Client) }));
  const proposalsOf = async (tid: string) => (await store.listDocs("proposals", tid)).map((d) => ({ id: d.id, createdAt: d.created_at, ...(JSON.parse(d.data) as Proposal) }));

  /** Identity + accreditation for one wallet with one issuer/offering. */
  async function checksFor(wallet: string, a: any) {
    const kyc = await store.kycByWallet(a.issuer?.id ?? a.tenantId, wallet).catch(() => null);
    const acc = (await store.accreditationsForAsset(a.issuer?.id ?? a.tenantId, a.id).catch(() => []))
      .filter((r) => r.wallet.toLowerCase() === wallet.toLowerCase()).sort((x, y) => y.updated_at.localeCompare(x.updated_at))[0];
    const needsAccreditation = a.exemption === "506c" || !!a.rules?.accreditedOnly;
    return {
      identity: kyc?.status === "approved" ? "verified" : kyc ? (kyc.status === "rejected" ? "rejected" : "in progress") : "not started",
      accredited: !needsAccreditation ? "not required" : acc?.decision === "approved" ? "approved" : acc ? "in progress" : "not started",
      eligible: kyc?.status === "approved" && (!needsAccreditation || acc?.decision === "approved"),
    };
  }

  app.get("/clients", deps.requireAdmin, async (c) => {
    const tid = deps.tenantId(c);
    const listed = await deps.listed(c);
    const out = [];
    for (const cl of await clientsOf(tid)) {
      const holdings: { assetId: string; name: string; tokens: number; valueUsd: number }[] = [];
      let verifiedWith = 0;
      if (cl.wallet) {
        for (const a of listed) {
          const ch = await checksFor(cl.wallet, a);
          if (ch.identity === "verified") verifiedWith++;
          const bal = await deps.balanceOf(a, cl.wallet as Address).catch(() => null);
          if (bal && bal > 0) holdings.push({ assetId: a.id, name: a.name, tokens: bal, valueUsd: bal * Number(a.pricePerToken || 0) });
        }
      }
      out.push({ id: cl.id, name: cl.name, email: cl.email, kind: cl.kind, wallet: cl.wallet, linkedAt: cl.linkedAt, createdAt: cl.createdAt, verifiedWith, holdings });
    }
    return c.json({ clients: out, offerings: listed.map((a) => ({ id: a.id, name: a.name, issuer: a.issuer?.name ?? "", pricePerToken: a.pricePerToken, minInvestment: a.minInvestment, exemption: a.exemption ?? null })) });
  });

  app.post("/clients", deps.requireAdmin, async (c) => {
    const tid = deps.tenantId(c);
    if (deps.tooMany(`client-invite:${tid}`, 50, 86_400_000)) return c.json({ error: "Too many invites today. Try again tomorrow." }, 429);
    const b = z.object({ name: z.string().trim().min(2).max(120), email: z.string().trim().toLowerCase().email().max(200), kind: z.enum(["individual", "trust", "company"]) }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "Enter the client's name and email" }, 400);
    if ((await clientsOf(tid)).some((x) => x.email === b.data.email)) return c.json({ error: "That client is already on your list" }, 409);
    const token = randomBytes(24).toString("base64url");
    const id = `cl_${randomBytes(6).toString("hex")}`;
    const firm = await deps.tenantName(tid);
    const cl: Client = { ...b.data, wallet: null, linkedAt: null, tokenHash: sha(token), firm };
    await store.putDoc({ coll: "clients", id, tenant_id: tid, data: JSON.stringify(cl), created_at: now(), updated_at: now() });
    await store.putDoc({ coll: "client-links", id: sha(token), tenant_id: tid, data: JSON.stringify({ clientId: id }), created_at: now(), updated_at: now() });
    const link = `${deps.origin(c)}/client/${token}`;
    const sent = await sendEmail({
      to: [b.data.email], subject: `${firm} invited you to Diamondz Tokenize`,
      html: `<div style="font:14px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:560px"><p>${escHtml(firm)} would like to manage your tokenized investments with you.</p><p><a href="${escHtml(link)}">Open your client page</a></p><p style="color:#666">You keep your own wallet and approve every purchase yourself.</p></div>`,
      text: `${firm} would like to manage your tokenized investments with you.\n\nYour client page: ${link}\n\nYou keep your own wallet and approve every purchase yourself.`,
    });
    return c.json({ client: { id, name: cl.name, email: cl.email, kind: cl.kind }, emailed: sent === "sent", link: sent === "sent" ? null : link });
  });

  app.delete("/clients/:id", deps.requireAdmin, async (c) => {
    const d = await store.getDoc("clients", c.req.param("id") ?? "");
    if (!d || d.tenant_id !== deps.tenantId(c)) return c.json({ error: "Not found" }, 404);
    const cl = JSON.parse(d.data) as Client;
    await store.deleteDoc("client-links", cl.tokenHash);
    await store.deleteDoc("clients", d.id);
    return c.json({ ok: true });
  });

  app.get("/clients/eligibility/:assetId", deps.requireAdmin, async (c) => {
    const a = (await deps.listed(c)).find((x) => x.id === c.req.param("assetId"));
    if (!a) return c.json({ error: "Not found" }, 404);
    const out: Record<string, { identity: string; accredited: string; eligible: boolean; wallet: boolean }> = {};
    for (const cl of await clientsOf(deps.tenantId(c))) out[cl.id] = cl.wallet ? { ...(await checksFor(cl.wallet, a)), wallet: true } : { identity: "no wallet", accredited: "no wallet", eligible: false, wallet: false };
    return c.json({ assetId: a.id, minInvestment: Number(a.minInvestment || 0), clients: out });
  });

  app.get("/clients/proposals", deps.requireAdmin, async (c) => c.json({ proposals: await proposalsOf(deps.tenantId(c)) }));

  app.post("/clients/proposals", deps.requireAdmin, async (c) => {
    const tid = deps.tenantId(c);
    const b = z.object({ assetId: z.string().max(40), items: z.array(z.object({ clientId: z.string().max(40), amountUsd: z.number().positive().max(1e9) })).min(1).max(200) }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "Pick an offering and enter amounts" }, 400);
    const a = (await deps.listed(c)).find((x) => x.id === b.data.assetId);
    if (!a) return c.json({ error: "That offering isn't open on the marketplace" }, 404);
    const clients = await clientsOf(tid);
    const min = Number(a.minInvestment || 0);
    const created = [];
    for (const it of b.data.items) {
      const cl = clients.find((x) => x.id === it.clientId);
      if (!cl) return c.json({ error: "Unknown client" }, 400);
      if (!cl.wallet) return c.json({ error: `${cl.name} hasn't connected a wallet yet` }, 400);
      if (min && it.amountUsd < min) return c.json({ error: `${cl.name}: the minimum for this offering is $${min.toLocaleString("en-US")}` }, 400);
      if (!(await checksFor(cl.wallet, a)).eligible) return c.json({ error: `${cl.name} hasn't passed this offering's checks yet` }, 400);
    }
    for (const it of b.data.items) {
      const id = `pr_${randomBytes(6).toString("hex")}`;
      const p: Proposal = { clientId: it.clientId, assetId: a.id, assetName: a.name, amountUsd: it.amountUsd, status: "proposed", decidedAt: null };
      await store.putDoc({ coll: "proposals", id, tenant_id: tid, data: JSON.stringify(p), created_at: now(), updated_at: now() });
      created.push({ id, ...p });
    }
    return c.json({ proposals: created });
  });

  // ---- the client's private page
  async function portal(token: string) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
    const l = await store.getDoc("client-links", sha(token));
    if (!l) return null;
    const { clientId } = JSON.parse(l.data) as { clientId: string };
    const d = await store.getDoc("clients", clientId);
    if (!d) return null;
    return { tid: d.tenant_id, id: d.id, doc: d, cl: JSON.parse(d.data) as Client };
  }
  const limited = (c: Context<any>) => deps.tooMany(`portal:${c.req.header("x-real-ip") ?? "local"}`, 60, 600_000);

  app.get("/client-portal/:token", async (c) => {
    if (limited(c)) return c.json({ error: "Too many requests" }, 429);
    const p = await portal(c.req.param("token") ?? "");
    if (!p) return c.json({ error: "This link isn't valid" }, 404);
    const props = (await proposalsOf(p.tid)).filter((x) => x.clientId === p.id).map(({ clientId, ...rest }) => rest);
    return c.json({ firm: p.cl.firm, name: p.cl.name, wallet: p.cl.wallet, message: consentMessage(p.cl.firm, "{wallet}", p.cl.tokenHash.slice(0, 12)), proposals: props });
  });

  app.post("/client-portal/:token/link", async (c) => {
    if (limited(c)) return c.json({ error: "Too many requests" }, 429);
    const p = await portal(c.req.param("token") ?? "");
    if (!p) return c.json({ error: "This link isn't valid" }, 404);
    const b = z.object({ wallet: z.string(), chainId: z.number().int(), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }).safeParse(await c.req.json().catch(() => null));
    if (!b.success || !isAddress(b.data.wallet)) return c.json({ error: "Bad request" }, 400);
    const wallet = getAddress(b.data.wallet);
    const ok = await deps.verifySig(b.data.chainId, wallet, consentMessage(p.cl.firm, wallet, p.cl.tokenHash.slice(0, 12)), b.data.signature as Hex);
    if (!ok) return c.json({ error: "The signature didn't match this wallet" }, 401);
    await store.putDoc({ ...p.doc, data: JSON.stringify({ ...p.cl, wallet, linkedAt: now() }), updated_at: now() });
    return c.json({ ok: true, wallet });
  });

  app.post("/client-portal/:token/proposals/:id", async (c) => {
    if (limited(c)) return c.json({ error: "Too many requests" }, 429);
    const p = await portal(c.req.param("token") ?? "");
    if (!p) return c.json({ error: "This link isn't valid" }, 404);
    const d = await store.getDoc("proposals", c.req.param("id") ?? "");
    const pr = d ? (JSON.parse(d.data) as Proposal) : null;
    if (!d || !pr || d.tenant_id !== p.tid || pr.clientId !== p.id) return c.json({ error: "Not found" }, 404);
    if (pr.status !== "proposed") return c.json({ error: "Already decided" }, 409);
    const b = z.object({ decision: z.enum(["approve", "decline"]) }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "Bad request" }, 400);
    const next: Proposal = { ...pr, status: b.data.decision === "approve" ? "approved" : "declined", decidedAt: now() };
    await store.putDoc({ ...d, data: JSON.stringify(next), updated_at: now() });
    return c.json({ ok: true, status: next.status, investUrl: next.status === "approved" ? `/invest/${pr.assetId}?amount=${pr.amountUsd}` : null });
  });
}
