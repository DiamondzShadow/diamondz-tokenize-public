// Signed checks through Adobe Acrobat Sign (designs E1–E7, canvas 64RrhpPn58Y2JfHVqwmHZ1, approved 2026-11-27).
//
// The issuer picks a check and an approved verifier firm; Diamondz sends the attestation letter from its ONE Adobe
// account. The signer proves who they are in Adobe (government ID or a phone code) and signs. When Adobe reports the
// agreement signed (webhook, re-read from Adobe's API; a 10-minute poll catches anything missed), we download the
// signed letter and Adobe's audit report, keep both, and record the check on the offering's oracle:
//   evidenceHash = sha256('{"letter":"<sha256 of signed PDF>","audit":"<sha256 of audit report>"}')
//   evidenceURI  = <origin>/api/esign/<id>/evidence   (JSON naming both files, so anyone can recompute the hash)
// The on-chain verifier is the platform's e-sign attester key (ESIGN_ATTESTER_KEY, approved on each oracle by the
// platform admin); the person and firm who signed are in the signed letter and audit report. The T-REX relayer pays gas.
//
// Issuer (console):  GET/POST /api/assets/:id/esign · POST /api/assets/:id/esign/:rid/remind|cancel
// Signer (link):     GET /api/esign/sign/:token · POST …/url · POST …/decline
// Public:            GET /api/market/:id/esign · GET /api/esign/:rid/evidence|letter.pdf|audit.pdf
// Adobe:             GET|POST /api/esign/adobe/webhook
// Platform admin:    GET /api/platform/esign · POST /api/platform/esign/setup · firms · POST …/:rid/record
import type { Context, Hono } from "hono";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { getAddress, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import artifacts from "../../web/src/contracts/artifacts.json";
import { CHECK_KINDS, CLASS_CHECKS, kindHash, type CheckKindId } from "../../web/src/lib/verification";
import { AdobeError, adobeConfigured, agreementStatus, auditPdf, cancelAgreement, createAgreement, isClosedUnsigned, isSigned, registerWebhook, remind, signedPdf, signingUrl, uploadPdf, type IdMethod } from "./adobesign";
import { networkById, oracleForSale } from "./chains";
import { registerJob } from "./jobs";
import { letterPdf } from "./pdf";
import type { Store } from "./store";
import { publicFor, walletFor } from "./trex";

const ORACLE = (artifacts as any).AssetOracle.abi as Abi;
const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const EVIDENCE_DIR = process.env.EVIDENCE_DIR ?? `${import.meta.dir}/../data/evidence`;
const COLL = "esign", FIRMS = "esign_firms", PLATFORM = "_platform";
const EXPIRES_DAYS = 30, REMIND_DAYS = 3;
const now = () => new Date().toISOString();

export type EsignStatus = "sent" | "opened" | "identity" | "signed" | "recorded" | "declined" | "expired" | "canceled";
export interface EsignReq {
  assetId: string; tenantId: string; chainId: number; kind: CheckKindId;
  firmId: string; firmName: string; signerName: string; signerEmail: string; idMethod: IdMethod; phoneLast4?: string; note: string;
  agreementId: string; tokenHash: string; status: EsignStatus; expiresAt: string; createdBy: string;
  sentAt: string; openedAt?: string; identityAt?: string; signedAt?: string; recordedAt?: string; closedAt?: string;
  letterSha?: string; auditSha?: string; evidenceHash?: string; tx?: string; recordError?: string; declineReason?: string; lastReminderAt?: string;
}
export interface Firm { name: string; domain: string; kinds: CheckKindId[]; addedBy: string }

export interface EsignDeps {
  store: Store;
  requireAdmin: (c: Context<any>, next: () => Promise<void>) => Promise<Response | void>;
  isPlatformAdmin: (c: Context<any>) => boolean;
  member: (c: Context<any>) => { account: string | null; role: string };
  adminAsset: (c: Context<any>, id: string) => Promise<any | null>;
  anyAsset: (id: string) => Promise<any | null>;
  listedAsset: (c: Context<any>, id: string) => Promise<any | null>;
  tenantName: (id: string) => Promise<string>;
  origin: (c: Context<any>) => string;
  tooMany: (key: string, max: number, windowMs: number) => boolean;
  /** Other Adobe agreements routed through the same webhook + poll (the lawyer sign-off, `legal:<assetId>`). */
  legal?: { sync: (assetId: string, event?: string) => Promise<void>; open: () => Promise<string[]> };
}

// ------------------------------------------------------------------ the letter
export function attestationLetter(r: { kind: CheckKindId; offering: string; assetClass: string; token: string; network: string; issuer: string; firm: string; signer: string; note: string }) {
  const k = CHECK_KINDS[r.kind];
  return letterPdf([
    { text: `${k.name}: attestation`, bold: true, size: 17, gapBefore: 0 },
    { text: `Requested through Diamondz Tokenize on behalf of ${r.issuer}`, size: 10 },
    { text: "The asset", bold: true, size: 12, gapBefore: 18 },
    { text: `Offering: ${r.offering} (${r.assetClass})\nToken: ${r.token}\nNetwork: ${r.network}` },
    { text: "What I confirm", bold: true, size: 12, gapBefore: 18 },
    { text: `${k.confirms}` },
    { text: "Reference (policy, title, report or registration number): {{*Ref_es_:signer1}}", gapBefore: 10 },
    { text: "Details or limits of this confirmation: {{Details_es_:signer1}}", gapBefore: 10 },
    ...(r.note ? [{ text: `Note from the issuer: ${r.note}`, size: 10, gapBefore: 10 }] : []),
    { text: "Authority", bold: true, size: 12, gapBefore: 18 },
    { text: `I am authorized by ${r.firm} to give this confirmation. I understand it will be shown to investors in this offering together with this signed letter and its audit report, and that a fingerprint of both is recorded on a public blockchain.` },
    { text: `Signer: ${r.signer}`, gapBefore: 18 },
    { text: "Title: {{*SignerTitle_es_:signer1}}", gapBefore: 10 },
    { text: "Signature: {{Sig_es_:signer1:signature}}", gapBefore: 22 },
    { text: "Date: {{Dte_es_:signer1:date}}", gapBefore: 16 },
  ]);
}

// ------------------------------------------------------------------ on chain
function attester() {
  const k = process.env.ESIGN_ATTESTER_KEY;
  return k ? privateKeyToAccount((k.startsWith("0x") ? k : `0x${k}`) as Hex) : null;
}
export const attesterAddress = () => attester()?.address ?? null;

async function recordOnChain(asset: any, kind: CheckKindId, evidenceHash: Hex, evidenceURI: string) {
  const signer = attester();
  const relayKey = process.env.TREX_RELAYER_KEY;
  if (!signer || !relayKey) throw new Error("The e-sign attester isn't configured on this server");
  const net = networkById(asset.chainId)!;
  const pc = publicFor(net);
  const saleOracle = await pc.readContract({ address: asset.deployment.sale, abi: [{ type: "function", name: "oracle", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const, functionName: "oracle" }).catch(() => null);
  const oracle = oracleForSale(net, saleOracle as string | null)?.address;
  if (!oracle) throw new Error(`Proof of asset isn't live on ${net.name}`);
  const allowed = await pc.readContract({ address: oracle, abi: ORACLE, functionName: "canAttest", args: [signer.address, kindHash(kind)] });
  if (!allowed) throw new Error(`The e-sign attester ${signer.address} isn't approved for ${CHECK_KINDS[kind].name} on ${net.name}'s oracle yet`);
  const input = {
    token: getAddress(asset.deployment.token), kind: kindHash(kind), result: 1,
    validUntil: BigInt(Math.floor(Date.now() / 1000) + CHECK_KINDS[kind].maxDays * 86_400 - 600), value: 0n, evidenceHash, evidenceURI,
  };
  const nonce = (await pc.readContract({ address: oracle, abi: ORACLE, functionName: "nonces", args: [signer.address] })) as bigint;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const digest = (await pc.readContract({ address: oracle, abi: ORACLE, functionName: "attestDigest", args: [input, nonce, deadline] })) as Hex;
  const signature = await signer.sign({ hash: digest });
  const wc = walletFor(net, relayKey);
  const { request } = await pc.simulateContract({ address: oracle, abi: ORACLE, functionName: "attestBySig", args: [signer.address, input, deadline, signature], account: wc.account! });
  const hash = await wc.writeContract(request as any);
  const rc = await pc.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`The on-chain record failed: ${hash}`);
  return hash;
}

// ------------------------------------------------------------------ routes
const NewReq = z.object({
  kind: z.string(), firmId: z.string().min(4).max(40),
  signerName: z.string().trim().min(2).max(120), signerEmail: z.string().trim().toLowerCase().email().max(200),
  idMethod: z.enum(["GOV_ID", "PHONE"]),
  phone: z.object({ countryCode: z.string().regex(/^\+?\d{1,4}$/), phone: z.string().regex(/^\d{6,15}$/) }).optional(),
  note: z.string().trim().max(600).default(""),
});
const FirmBody = z.object({ name: z.string().trim().min(2).max(120), domain: z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/), kinds: z.array(z.string()).min(1).max(20) });

const domainOf = (email: string) => email.split("@")[1]?.toLowerCase() ?? "";
const atDomain = (email: string, domain: string) => { const d = domainOf(email); return d === domain || d.endsWith(`.${domain}`); };

export function mountEsign(app: Hono<any>, deps: EsignDeps) {
  const { store } = deps;
  mkdirSync(`${EVIDENCE_DIR}/esign`, { recursive: true });
  const busy = new Set<string>();

  const getReq = async (rid: string) => { const d = await store.getDoc(COLL, rid); return d ? { id: d.id, created: d.created_at, r: JSON.parse(d.data) as EsignReq } : null; };
  const putReq = async (rid: string, r: EsignReq, created?: string) => store.putDoc({ coll: COLL, id: rid, tenant_id: r.tenantId, data: JSON.stringify(r), created_at: created ?? now(), updated_at: now() });
  const firms = async () => (await store.listDocs(FIRMS, PLATFORM)).map((d) => ({ id: d.id, ...(JSON.parse(d.data) as Firm) }));

  /** What the issuer console, admin log and public page show. Never the signer's private link or the phone number. */
  const view = (id: string, r: EsignReq) => ({
    id, assetId: r.assetId, kind: r.kind, kindName: CHECK_KINDS[r.kind]?.name ?? r.kind, firmName: r.firmName, signerName: r.signerName, signerEmail: r.signerEmail,
    idMethod: r.idMethod, status: r.status, sentAt: r.sentAt, openedAt: r.openedAt ?? null, identityAt: r.identityAt ?? null, signedAt: r.signedAt ?? null,
    recordedAt: r.recordedAt ?? null, closedAt: r.closedAt ?? null, expiresAt: r.expiresAt, tx: r.tx ?? null, recordError: r.recordError ?? null,
    declineReason: r.declineReason ?? null, chainId: r.chainId, hasFiles: !!r.letterSha,
  });

  /** Signed in Adobe → keep the files → record on chain. Safe to call repeatedly (webhook + poll). */
  async function finalize(rid: string, origin: string | null) {
    if (busy.has(rid)) return;
    busy.add(rid);
    try {
      const cur = await getReq(rid);
      if (!cur) return;
      const r = cur.r;
      if (r.status === "recorded" || ["declined", "expired", "canceled"].includes(r.status)) return;
      if (!r.letterSha) {
        const [letter, audit] = await Promise.all([signedPdf(r.agreementId), auditPdf(r.agreementId)]);
        r.letterSha = sha(letter); r.auditSha = sha(audit);
        await Bun.write(`${EVIDENCE_DIR}/esign/${r.letterSha}.pdf`, letter);
        await Bun.write(`${EVIDENCE_DIR}/esign/${r.auditSha}.pdf`, audit);
        r.evidenceHash = sha(JSON.stringify({ letter: r.letterSha, audit: r.auditSha }));
        r.status = "signed"; r.signedAt ??= now(); r.identityAt ??= r.signedAt; r.openedAt ??= r.signedAt;
        await putReq(rid, r, cur.created);
      }
      const asset = await deps.anyAsset(r.assetId);
      if (!asset?.deployment) { r.recordError = "The offering isn't deployed"; await putReq(rid, r, cur.created); return; }
      try {
        const base = origin ?? process.env.PUBLIC_ORIGIN ?? "https://tokenize.diamondz.one";
        r.tx = await recordOnChain(asset, r.kind, `0x${r.evidenceHash}` as Hex, `${base}/api/esign/${rid}/evidence`);
        r.status = "recorded"; r.recordedAt = now(); delete r.recordError;
      } catch (e: any) {
        r.recordError = e?.shortMessage ?? e?.message ?? String(e);
        console.error("[esign] record", rid, r.recordError);
      }
      await putReq(rid, r, cur.created);
    } finally { busy.delete(rid); }
  }

  /** Re-read one agreement from Adobe and move our record forward. */
  async function sync(rid: string, origin: string | null, hint?: string) {
    if (rid.startsWith("legal:")) return deps.legal?.sync(rid.slice(6), hint);
    const cur = await getReq(rid);
    if (!cur || ["recorded", "declined", "expired", "canceled"].includes(cur.r.status)) return;
    const r = cur.r;
    if (r.status === "signed") return finalize(rid, origin);
    const s = await agreementStatus(r.agreementId);
    if (isSigned(s)) return finalize(rid, origin);
    if (isClosedUnsigned(s)) {
      r.status = s === "EXPIRED" ? "expired" : hint === "AGREEMENT_REJECTED" ? "declined" : r.status === "declined" ? "declined" : "canceled";
      r.closedAt = now();
      return void (await putReq(rid, r, cur.created));
    }
    // Still out for signature: the webhook's event moves the timeline (cosmetic; signing state always comes from Adobe).
    let changed = false;
    if (hint && ["AGREEMENT_EMAIL_VIEWED", "AGREEMENT_DOCUMENTS_VIEWED"].includes(hint) && !r.openedAt) { r.openedAt = now(); if (r.status === "sent") r.status = "opened"; changed = true; }
    if (hint && ["AGREEMENT_WEB_IDENTITY_AUTHENTICATED", "AGREEMENT_KBA_AUTHENTICATED"].includes(hint) && !r.identityAt) { r.identityAt = now(); r.openedAt ??= r.identityAt; r.status = "identity"; changed = true; }
    if (changed) await putReq(rid, r, cur.created);
  }

  registerJob("esign-poll", async () => {
    if (!adobeConfigured()) return { skipped: "not configured" };
    const open = (await store.docsSince(COLL, new Date(Date.now() - 90 * 86_400_000).toISOString()))
      .map((d) => ({ id: d.id, r: JSON.parse(d.data) as EsignReq })).filter((x) => !["recorded", "declined", "expired", "canceled"].includes(x.r.status));
    let synced = 0, failed = 0;
    for (const x of open) await sync(x.id, null).then(() => synced++, (e) => { failed++; console.error("[esign] poll", x.id, e?.message ?? e); });
    const legalOpen = (await deps.legal?.open()) ?? [];
    for (const id of legalOpen) await deps.legal!.sync(id).then(() => synced++, (e) => { failed++; console.error("[esign] poll legal", id, e?.message ?? e); });
    return { open: open.length + legalOpen.length, synced, failed };
  }, 10 * 60_000, 60_000);

  // ---- issuer
  async function issuerCtx(c: any): Promise<{ err: Response; asset?: undefined; kinds?: undefined } | { err?: undefined; asset: any; kinds: CheckKindId[] }> {
    const asset = await deps.adminAsset(c, c.req.param("id"));
    if (!asset) return { err: c.json({ error: "Not found" }, 404) };
    return { asset, kinds: ((CLASS_CHECKS as any)[asset.assetClass] as CheckKindId[] | undefined) ?? [] };
  }

  app.get("/assets/:id/esign", deps.requireAdmin, async (c) => {
    const x = await issuerCtx(c);
    if (x.err) return x.err;
    const all = (await store.listDocs(COLL, x.asset.tenantId ?? (c as any).get("tenant").id)).filter((d) => (JSON.parse(d.data) as EsignReq).assetId === x.asset.id);
    const fs = (await firms()).filter((f) => f.kinds.some((k) => x.kinds.includes(k)));
    return c.json({
      configured: adobeConfigured(), deployed: x.asset.status === "deployed",
      kinds: x.kinds.map((k) => ({ id: k, name: CHECK_KINDS[k].name, confirms: CHECK_KINDS[k].confirms })),
      firms: fs.map((f) => ({ id: f.id, name: f.name, domain: f.domain, kinds: f.kinds.filter((k) => x.kinds.includes(k)) })),
      requests: all.map((d) => view(d.id, JSON.parse(d.data))),
    });
  });

  app.post("/assets/:id/esign", deps.requireAdmin, async (c) => {
    const x = await issuerCtx(c);
    if (x.err) return x.err;
    const a = x.asset;
    if (a.status !== "deployed" || !a.deployment?.token) return c.json({ error: "Deploy the offering first" }, 409);
    if (!adobeConfigured()) return c.json({ error: "Adobe Acrobat Sign isn't connected yet. Diamondz is setting it up." }, 503);
    const b = NewReq.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "Fill in the check, verifier, signer's name and work email" }, 400);
    const d = b.data;
    const kind = d.kind as CheckKindId;
    if (!x.kinds.includes(kind)) return c.json({ error: "That check doesn't apply to this offering" }, 400);
    const firm = (await firms()).find((f) => f.id === d.firmId);
    if (!firm || !firm.kinds.includes(kind)) return c.json({ error: `That firm isn't approved for ${CHECK_KINDS[kind].name}` }, 400);
    if (!atDomain(d.signerEmail, firm.domain)) return c.json({ error: `Use the signer's work email at ${firm.domain}` }, 400);
    if (d.idMethod === "PHONE" && !d.phone) return c.json({ error: "Enter the signer's mobile number for the phone code" }, 400);
    if (deps.tooMany(`esign:${a.id}`, 20, 86_400_000)) return c.json({ error: "Too many signing requests today for this offering" }, 429);
    const open = (await store.listDocs(COLL, a.tenantId ?? (c as any).get("tenant").id)).map((r) => JSON.parse(r.data) as EsignReq)
      .find((r) => r.assetId === a.id && r.kind === kind && ["sent", "opened", "identity", "signed"].includes(r.status));
    if (open) return c.json({ error: `A ${CHECK_KINDS[kind].name} request is already out for signature. Cancel it first to send a new one.` }, 409);

    const net = networkById(a.chainId)!;
    const issuer = await deps.tenantName(a.tenantId ?? (c as any).get("tenant").id);
    const rid = `es_${randomBytes(9).toString("hex")}`;
    const token = randomBytes(24).toString("base64url");
    const origin = deps.origin(c);
    try {
      const pdf = attestationLetter({ kind, offering: a.name, assetClass: a.assetClass, token: a.deployment.token, network: net.name, issuer, firm: firm.name, signer: d.signerName, note: d.note });
      const doc = await uploadPdf(`${a.symbol}-${kind}-attestation.pdf`, pdf);
      const expires = new Date(Date.now() + EXPIRES_DAYS * 86_400_000);
      const agreementId = await createAgreement({
        name: `${a.name}: ${CHECK_KINDS[kind].name} attestation`,
        message: `${issuer} asks ${firm.name} to confirm: ${CHECK_KINDS[kind].confirms} Request details: ${origin}/sign/${token}`,
        transientDocumentId: doc, externalId: rid,
        signer: { email: d.signerEmail, idMethod: d.idMethod, phone: d.phone },
        expiresAt: expires, reminderDays: REMIND_DAYS,
      });
      const r: EsignReq = {
        assetId: a.id, tenantId: a.tenantId ?? (c as any).get("tenant").id, chainId: a.chainId, kind, firmId: firm.id, firmName: firm.name,
        signerName: d.signerName, signerEmail: d.signerEmail, idMethod: d.idMethod, phoneLast4: d.phone?.phone.slice(-4), note: d.note,
        agreementId, tokenHash: sha(token), status: "sent", expiresAt: expires.toISOString(), createdBy: deps.member(c).account ?? "admin", sentAt: now(),
      };
      await putReq(rid, r);
      await store.setKv(`esign:agr:${agreementId}`, rid, now());
      await store.setKv(`esign:tok:${r.tokenHash}`, rid, now());
      return c.json({ request: view(rid, r) });
    } catch (e: any) {
      console.error("[esign] send", a.id, e?.message ?? e);
      return c.json({ error: e instanceof AdobeError ? e.message : "Couldn't send the request. Try again shortly." }, (e instanceof AdobeError && e.status >= 400 && e.status < 600 ? e.status : 502) as any);
    }
  });

  async function ownReq(c: any) {
    const x = await issuerCtx(c);
    if (x.err) return { err: x.err };
    const cur = await getReq(c.req.param("rid"));
    if (!cur || cur.r.assetId !== x.asset.id) return { err: c.json({ error: "Not found" }, 404) };
    return { cur };
  }

  app.post("/assets/:id/esign/:rid/remind", deps.requireAdmin, async (c) => {
    const o = await ownReq(c);
    if (o.err) return o.err;
    const { r } = o.cur!;
    if (!["sent", "opened", "identity"].includes(r.status)) return c.json({ error: "This request isn't waiting for a signature" }, 409);
    if (r.lastReminderAt && Date.now() - Date.parse(r.lastReminderAt) < 86_400_000) return c.json({ error: "A reminder already went out in the last 24 hours" }, 429);
    try { await remind(r.agreementId, "A reminder from Diamondz Tokenize: this attestation is waiting for your signature."); }
    catch (e: any) { return c.json({ error: e?.message ?? "Couldn't send the reminder" }, (e instanceof AdobeError && e.status >= 400 && e.status < 600 ? e.status : 502) as any); }
    r.lastReminderAt = now();
    await putReq(o.cur!.id, r, o.cur!.created);
    return c.json({ request: view(o.cur!.id, r) });
  });

  app.post("/assets/:id/esign/:rid/cancel", deps.requireAdmin, async (c) => {
    const o = await ownReq(c);
    if (o.err) return o.err;
    const { r } = o.cur!;
    if (!["sent", "opened", "identity"].includes(r.status)) return c.json({ error: "Only a request still waiting for a signature can be canceled" }, 409);
    try { await cancelAgreement(r.agreementId, "Canceled by the issuer."); }
    catch (e: any) { return c.json({ error: e?.message ?? "Couldn't cancel the request" }, (e instanceof AdobeError && e.status >= 400 && e.status < 600 ? e.status : 502) as any); }
    r.status = "canceled"; r.closedAt = now();
    await putReq(o.cur!.id, r, o.cur!.created);
    return c.json({ request: view(o.cur!.id, r) });
  });

  // ---- signer's private link (E3)
  async function byToken(c: any) {
    const t = c.req.param("token");
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(t)) return null;
    const kv = await store.getKv(`esign:tok:${sha(t)}`);
    return kv ? getReq(kv.value) : null;
  }

  app.get("/esign/sign/:token", async (c) => {
    const cur = await byToken(c);
    if (!cur) return c.json({ error: "This link isn't valid. Use the latest email from Adobe Acrobat Sign." }, 404);
    const { r } = cur;
    const a = await deps.anyAsset(r.assetId);
    const net = networkById(r.chainId);
    return c.json({
      offering: a?.name ?? "", assetClass: a?.assetClass ?? "", issuer: await deps.tenantName(r.tenantId), network: net?.name ?? "", testnet: !!net?.testnet,
      kindName: CHECK_KINDS[r.kind].name, confirms: CHECK_KINDS[r.kind].confirms, firmName: r.firmName, signerName: r.signerName,
      idMethod: r.idMethod, status: r.status, expiresAt: r.expiresAt, note: r.note, signedAt: r.signedAt ?? null,
    });
  });

  app.post("/esign/sign/:token/url", async (c) => {
    const cur = await byToken(c);
    if (!cur) return c.json({ error: "Not found" }, 404);
    if (!["sent", "opened", "identity"].includes(cur.r.status)) return c.json({ error: "This request isn't waiting for a signature" }, 409);
    try {
      const url = await signingUrl(cur.r.agreementId);
      return url ? c.json({ url }) : c.json({ error: "Adobe hasn't made the signing page ready yet. Use the link in Adobe's email, or try again in a minute." }, 409);
    } catch (e: any) { return c.json({ error: e?.message ?? "Couldn't reach Adobe" }, 502); }
  });

  app.post("/esign/sign/:token/decline", async (c) => {
    const cur = await byToken(c);
    if (!cur) return c.json({ error: "Not found" }, 404);
    const b = z.object({ reason: z.string().trim().min(3).max(500) }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "Tell the issuer why, in a sentence" }, 400);
    const { r } = cur;
    if (!["sent", "opened", "identity"].includes(r.status)) return c.json({ error: "This request isn't waiting for a signature" }, 409);
    try { await cancelAgreement(r.agreementId, `Declined by the signer: ${b.data.reason}`); }
    catch (e: any) { return c.json({ error: e?.message ?? "Couldn't reach Adobe" }, 502); }
    r.status = "declined"; r.declineReason = b.data.reason; r.closedAt = now();
    await putReq(cur.id, r, cur.created);
    return c.json({ ok: true });
  });

  // ---- public (E4/E5): signed checks for a listed offering. Lawyer opinions never appear here.
  app.get("/market/:id/esign", async (c) => {
    const a = await deps.listedAsset(c, c.req.param("id"));
    if (!a) return c.json({ error: "Not found" }, 404);
    const rows = (await store.listDocs(COLL, a.tenantId)).map((d) => ({ id: d.id, r: JSON.parse(d.data) as EsignReq }))
      .filter((x) => x.r.assetId === a.id && ["signed", "recorded"].includes(x.r.status));
    const latest = new Map<string, (typeof rows)[number]>();
    for (const x of rows) { const p = latest.get(x.r.kind); if (!p || (x.r.signedAt ?? "") > (p.r.signedAt ?? "")) latest.set(x.r.kind, x); }
    c.header("Cache-Control", "public, max-age=60");
    return c.json({
      checks: [...latest.values()].map(({ id, r }) => ({
        kind: r.kind, signerName: r.signerName, firmName: r.firmName, idMethod: r.idMethod, signedAt: r.signedAt, recordedAt: r.recordedAt ?? null, tx: r.tx ?? null,
        evidenceHash: r.evidenceHash ? `0x${r.evidenceHash}` : null, letter: `/api/esign/${id}/letter.pdf`, audit: `/api/esign/${id}/audit.pdf`, evidence: `/api/esign/${id}/evidence`,
      })),
    });
  });

  const signedReq = async (rid: string) => { const cur = await getReq(rid); return cur && cur.r.letterSha && ["signed", "recorded"].includes(cur.r.status) ? cur : null; };
  app.get("/esign/:rid/evidence", async (c) => {
    const cur = await signedReq(c.req.param("rid"));
    if (!cur) return c.json({ error: "Not found" }, 404);
    const r = cur.r;
    c.header("Cache-Control", "public, max-age=3600");
    return c.json({
      scheme: "sha256 of the JSON {\"letter\":<sha256 of letter.pdf>,\"audit\":<sha256 of audit.pdf>}, as written below",
      letter: { sha256: r.letterSha, url: `/api/esign/${cur.id}/letter.pdf` }, audit: { sha256: r.auditSha, url: `/api/esign/${cur.id}/audit.pdf` },
      evidenceHash: `0x${r.evidenceHash}`, signedVia: "Adobe Acrobat Sign", signer: r.signerName, firm: r.firmName, signedAt: r.signedAt,
      check: CHECK_KINDS[r.kind].name, tx: r.tx ?? null, chainId: r.chainId,
    });
  });
  for (const [path, field] of [["letter.pdf", "letterSha"], ["audit.pdf", "auditSha"]] as const) {
    app.get(`/esign/:rid/${path}`, async (c) => {
      const cur = await signedReq(c.req.param("rid"));
      const h = cur?.r[field];
      if (!h) return c.json({ error: "Not found" }, 404);
      const f = Bun.file(`${EVIDENCE_DIR}/esign/${h}.pdf`);
      if (!(await f.exists())) return c.json({ error: "Not found" }, 404);
      return new Response(f, { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${cur!.r.kind.toLowerCase()}-${path}"`, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
    });
  }

  // ---- Adobe webhook: echo the client id (Adobe's ownership check), answer at once, work afterwards.
  const echo = (c: any) => { const id = c.req.header("x-adobesign-clientid"); if (id) c.header("X-AdobeSign-ClientId", id); };
  app.get("/esign/adobe/webhook", (c) => { echo(c); return c.json({ xAdobeSignClientId: c.req.header("x-adobesign-clientid") ?? null }); });
  app.post("/esign/adobe/webhook", async (c) => {
    echo(c);
    const body = (await c.req.json().catch(() => null)) as any;
    const agr = typeof body?.agreement?.id === "string" ? body.agreement.id : null;
    const event = typeof body?.event === "string" ? body.event : undefined;
    const origin = deps.origin(c);
    if (agr && /^[A-Za-z0-9_*-]{8,120}$/.test(agr)) {
      queueMicrotask(async () => {
        try {
          const kv = await store.getKv(`esign:agr:${agr}`);
          if (kv) await sync(kv.value, origin, event);
        } catch (e: any) { console.error("[esign] webhook", agr, event, e?.message ?? e); }
      });
    }
    return c.json({ xAdobeSignClientId: c.req.header("x-adobesign-clientid") ?? null });
  });

  // ---- platform admin (E7)
  const platformOnly = async (c: any, next: () => Promise<void>) => (deps.isPlatformAdmin(c) ? next() : c.json({ error: "Platform admins only" }, 403));

  app.get("/platform/esign", deps.requireAdmin, platformOnly, async (c) => {
    const rows = await store.docsSince(COLL, "1970-01-01T00:00:00Z");
    const names = new Map<string, string>();
    const list = await Promise.all(rows.reverse().map(async (d) => {
      const r = JSON.parse(d.data) as EsignReq;
      if (!names.has(r.assetId)) names.set(r.assetId, (await deps.anyAsset(r.assetId))?.name ?? r.assetId);
      return { ...view(d.id, r), offering: names.get(r.assetId) };
    }));
    const wh = await store.getKv("esign:webhook");
    return c.json({ configured: adobeConfigured(), webhook: wh ? JSON.parse(wh.value) : null, attester: attesterAddress(), firms: await firms(), requests: list, kinds: Object.values(CHECK_KINDS).map((k) => ({ id: k.id, name: k.name })) });
  });

  app.post("/platform/esign/setup", deps.requireAdmin, platformOnly, async (c) => {
    if (!adobeConfigured()) return c.json({ error: "Add ADOBE_SIGN_INTEGRATION_KEY to the server first" }, 503);
    const url = `${deps.origin(c)}/api/esign/adobe/webhook`;
    try {
      const id = await registerWebhook(url);
      const v = { url, id, at: now() };
      await store.setKv("esign:webhook", JSON.stringify(v), now());
      return c.json({ webhook: v });
    } catch (e: any) { return c.json({ error: e?.message ?? "Couldn't register the webhook" }, 502); }
  });

  app.post("/platform/esign/firms", deps.requireAdmin, platformOnly, async (c) => {
    const b = FirmBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "Enter the firm's name, email domain and at least one check" }, 400);
    const kinds = b.data.kinds.filter((k): k is CheckKindId => k in CHECK_KINDS);
    if (!kinds.length) return c.json({ error: "Pick at least one check" }, 400);
    const id = `fm_${randomBytes(6).toString("hex")}`;
    const f: Firm = { name: b.data.name, domain: b.data.domain, kinds, addedBy: deps.member(c).account ?? "admin" };
    await store.putDoc({ coll: FIRMS, id, tenant_id: PLATFORM, data: JSON.stringify(f), created_at: now(), updated_at: now() });
    return c.json({ firm: { id, ...f } });
  });

  app.delete("/platform/esign/firms/:fid", deps.requireAdmin, platformOnly, async (c) => {
    await store.deleteDoc(FIRMS, c.req.param("fid")!);
    return c.json({ ok: true });
  });

  app.post("/platform/esign/:rid/record", deps.requireAdmin, platformOnly, async (c) => {
    const cur = await getReq(c.req.param("rid")!);
    if (!cur) return c.json({ error: "Not found" }, 404);
    try { await sync(cur.id, deps.origin(c)); } catch (e: any) { return c.json({ error: e?.message ?? "Couldn't reach Adobe" }, 502); }
    const after = await getReq(cur.id);
    return c.json({ request: view(cur.id, after!.r) });
  });

  return { sync, finalize };
}
