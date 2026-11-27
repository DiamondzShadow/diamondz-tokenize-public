// Adobe Acrobat Sign REST v6 client (integration key). One Diamondz account sends every agreement.
//
// Env: ADOBE_SIGN_INTEGRATION_KEY (required to send), ADOBE_SIGN_API (default https://api.adobesign.com, where
// GET /baseUris is asked which regional access point the account lives on; tests point it at a local stand-in).
// Docs: github.com/AdobeDocs/acrobat-sign-developer-guide (baseUris → apiAccessPoint; transientDocuments → agreements;
// signingUrls; combinedDocument / auditTrail; webhooks).

export class AdobeError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

const key = () => process.env.ADOBE_SIGN_INTEGRATION_KEY ?? "";
const root = () => (process.env.ADOBE_SIGN_API ?? "https://api.adobesign.com").replace(/\/+$/, "");
export const adobeConfigured = () => !!key();

let accessPoint: string | null = null;

async function base(): Promise<string> {
  if (accessPoint) return accessPoint;
  const res = await fetch(`${root()}/api/rest/v6/baseUris`, { headers: { authorization: `Bearer ${key()}` }, signal: AbortSignal.timeout(15_000) });
  const j = (await res.json().catch(() => null)) as any;
  if (!res.ok || !j?.apiAccessPoint) throw new AdobeError(res.status >= 500 ? 502 : res.status, j?.code ?? "BASE_URI", `Adobe Sign: ${j?.message ?? `couldn't find the account's region (HTTP ${res.status})`}`);
  accessPoint = String(j.apiAccessPoint).replace(/\/+$/, "");
  return accessPoint;
}

type Body = Record<string, unknown> | FormData | undefined;

/** One v6 call. JSON in, JSON out (or raw bytes with `raw`). Re-asks the access point once if Adobe says it moved. */
export async function adobe<T = any>(method: string, path: string, body?: Body, opts: { raw?: boolean } = {}): Promise<T> {
  if (!adobeConfigured()) throw new AdobeError(503, "NOT_CONFIGURED", "Adobe Acrobat Sign isn't connected on this server yet");
  for (let attempt = 0; ; attempt++) {
    const url = `${await base()}/api/rest/v6${path}`;
    const isForm = body instanceof FormData;
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${key()}`, ...(body && !isForm ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) {
      if (opts.raw) return new Uint8Array(await res.arrayBuffer()) as T;
      const t = await res.text();
      return (t ? JSON.parse(t) : {}) as T;
    }
    const j = (await res.json().catch(() => null)) as any;
    if (j?.code === "INVALID_API_ACCESS_POINT" && attempt === 0) { accessPoint = null; continue; }
    throw new AdobeError(res.status >= 500 ? 502 : res.status, j?.code ?? `HTTP_${res.status}`, `Adobe Sign: ${j?.message ?? `${method} ${path} failed (HTTP ${res.status})`}`);
  }
}

export async function uploadPdf(name: string, bytes: Uint8Array): Promise<string> {
  const fd = new FormData();
  fd.set("File-Name", name);
  fd.set("Mime-Type", "application/pdf");
  fd.set("File", new Blob([bytes], { type: "application/pdf" }), name);
  const r = await adobe<{ transientDocumentId: string }>("POST", "/transientDocuments", fd);
  return r.transientDocumentId;
}

export type IdMethod = "GOV_ID" | "PHONE";

export async function createAgreement(a: {
  name: string; message: string; transientDocumentId: string; externalId: string;
  signer: { email: string; idMethod: IdMethod; phone?: { countryCode: string; phone: string } };
  expiresAt: Date; reminderDays: number;
}): Promise<string> {
  const securityOption = a.signer.idMethod === "PHONE"
    ? { authenticationMethod: "PHONE", phoneInfo: { countryCode: a.signer.phone!.countryCode, phone: a.signer.phone!.phone } }
    : { authenticationMethod: "GOV_ID" };
  const r = await adobe<{ id: string }>("POST", "/agreements", {
    fileInfos: [{ transientDocumentId: a.transientDocumentId }],
    name: a.name,
    message: a.message,
    externalId: { id: a.externalId },
    participantSetsInfo: [{ memberInfos: [{ email: a.signer.email, securityOption }], order: 1, role: "SIGNER" }],
    signatureType: "ESIGN",
    state: "IN_PROCESS",
    expirationTime: a.expiresAt.toISOString(),
    reminderFrequency: a.reminderDays <= 1 ? "DAILY_UNTIL_SIGNED" : a.reminderDays <= 2 ? "EVERY_OTHER_DAY_UNTIL_SIGNED" : a.reminderDays <= 3 ? "EVERY_THIRD_DAY_UNTIL_SIGNED" : "WEEKLY_UNTIL_SIGNED",
  });
  return r.id;
}

/** Adobe's own view of the agreement: the only status we trust (webhook bodies are never trusted). */
export async function agreementStatus(id: string): Promise<string> {
  const r = await adobe<{ status: string }>("GET", `/agreements/${encodeURIComponent(id)}`);
  return String(r.status ?? "");
}

export async function signingUrl(id: string): Promise<string | null> {
  const r = await adobe<any>("GET", `/agreements/${encodeURIComponent(id)}/signingUrls`).catch((e) => {
    if (e instanceof AdobeError && (e.code === "AGREEMENT_NOT_SIGNABLE" || e.status === 404)) return null;
    throw e;
  });
  return r?.signingUrlSetInfos?.[0]?.signingUrls?.[0]?.esignUrl ?? null;
}

export async function cancelAgreement(id: string, comment: string) {
  await adobe("PUT", `/agreements/${encodeURIComponent(id)}/state`, { state: "CANCELLED", agreementCancellationInfo: { comment, notifyOthers: true } });
}

export async function remind(id: string, note: string) {
  const m = await adobe<any>("GET", `/agreements/${encodeURIComponent(id)}/members`);
  const ids: string[] = (m?.participantSets ?? []).filter((s: any) => s?.status === "WAITING_FOR_MY_SIGNATURE" || s?.status === "WAITING_FOR_OTHERS" || !s?.status)
    .flatMap((s: any) => (s?.memberInfos ?? []).map((x: any) => x?.id)).filter(Boolean);
  if (!ids.length) throw new AdobeError(409, "NOTHING_TO_REMIND", "There's no one left to remind on this request");
  await adobe("POST", `/agreements/${encodeURIComponent(id)}/reminders`, { recipientParticipantIds: ids, status: "ACTIVE", note });
}

export const signedPdf = (id: string) => adobe<Uint8Array>("GET", `/agreements/${encodeURIComponent(id)}/combinedDocument?attachAuditReport=false`, undefined, { raw: true });
export const auditPdf = (id: string) => adobe<Uint8Array>("GET", `/agreements/${encodeURIComponent(id)}/auditTrail`, undefined, { raw: true });

/** Account-level webhook for the events we follow. Idempotent: Adobe refuses a duplicate configuration. */
export async function registerWebhook(url: string): Promise<string | null> {
  try {
    const r = await adobe<{ id: string }>("POST", "/webhooks", {
      name: "Diamondz Tokenize signing",
      scope: "ACCOUNT",
      state: "ACTIVE",
      webhookSubscriptionEvents: WEBHOOK_EVENTS,
      webhookUrlInfo: { url },
      webhookConditionalParams: { webhookAgreementEvents: { includeDetailedInfo: false, includeDocumentsInfo: false, includeParticipantsInfo: false, includeSignedDocuments: false } },
    });
    return r.id;
  } catch (e) {
    if (e instanceof AdobeError && e.code === "DUPLICATE_WEBHOOK_CONFIGURATION") return null;
    throw e;
  }
}

export const WEBHOOK_EVENTS = [
  "AGREEMENT_EMAIL_VIEWED", "AGREEMENT_DOCUMENTS_VIEWED", "AGREEMENT_WEB_IDENTITY_AUTHENTICATED", "AGREEMENT_KBA_AUTHENTICATED",
  "AGREEMENT_ACTION_COMPLETED", "AGREEMENT_WORKFLOW_COMPLETED", "AGREEMENT_REJECTED", "AGREEMENT_RECALLED", "AGREEMENT_EXPIRED", "AGREEMENT_EMAIL_BOUNCED",
];

/** Adobe statuses → done/failed. Anything else is still in progress. */
export const isSigned = (s: string) => ["SIGNED", "APPROVED", "ACCEPTED", "FORM_FILLED", "DELIVERED"].includes(s);
export const isClosedUnsigned = (s: string) => ["CANCELLED", "EXPIRED", "ARCHIVED"].includes(s);
