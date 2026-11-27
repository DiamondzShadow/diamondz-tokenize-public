// IP registry + licensing on the web (designs F1–F7). Contracts: contracts/src/ip; API: api/src/ip.ts.
import type { AssetClassId } from "./catalog";

/** Industry identifiers recorded on each asset type's record (design F7). */
export const ID_FIELDS: Record<AssetClassId, [key: string, label: string, hint: string][]> = {
  sports: [],
  film: [["EIDR", "EIDR ID", "The film industry's registry ID, e.g. 10.5240/XXXX-XXXX"], ["US_COPYRIGHT", "US copyright registration", "e.g. PAu 1-234-567"]],
  "music-ip": [["ISRC", "ISRC (recording)", "e.g. USRC17607839"], ["ISWC", "ISWC (song)", "e.g. T-034.524.680-1"], ["US_COPYRIGHT", "US copyright registration", "e.g. SR 123-456"]],
  collectibles: [["COA", "Certificate of authenticity no.", ""], ["CUSTODIAN", "Custodian", "Warehouse, vault or gallery"]],
  "real-estate": [["APN", "Parcel number (APN)", "From the county assessor"]],
  energy: [["WELL_API", "Well API numbers", "Comma-separated"], ["LEASE", "Lease IDs", ""]],
  "private-equity": [["COMPANY_REG", "Company registration no.", "State file number"]],
  "private-credit": [["UCC", "UCC filing numbers", "Comma-separated"]],
  funds: [["FUND_REG", "Fund registration", "e.g. SEC file number or LEI"]],
  carbon: [["REGISTRY_PROJECT", "Registry project ID", "e.g. VCS-1234"], ["SERIALS", "Serial range", ""]],
};

export const LICENSABLE: AssetClassId[] = ["film", "music-ip", "collectibles"];
export const isLicensable = (c: string) => (LICENSABLE as string[]).includes(c);

export interface LicenseTypeDraft {
  key: string; name: string; scope: string; fee: string; revSharePct: number; durationDays: number; territory: string;
  byRequest: boolean; active: boolean; termsName: string; termsText: string; termsHash?: string;
}

/** Suggested license types per licensable class (design F1/F6). Text always comes from the issuer's counsel. */
export const SUGGESTED_TYPES: Partial<Record<AssetClassId, Omit<LicenseTypeDraft, "termsText" | "termsName" | "active">[]>> = {
  film: [
    { key: "clip", name: "Clip & promo", scope: "Up to 60 seconds of footage · social, press and advertising · no remixing", fee: "250", revSharePct: 0, durationDays: 365, territory: "Worldwide", byRequest: false },
    { key: "remix", name: "Commercial remix", scope: "Make and sell derivative works (shorts, games, merch) · credit required · quarterly revenue reports", fee: "1000", revSharePct: 10, durationDays: 1095, territory: "Worldwide", byRequest: false },
    { key: "distribution", name: "Distribution", scope: "Theatrical, streaming or TV rights · exclusive or not, by territory · terms agreed, then signed on chain", fee: "0", revSharePct: 0, durationDays: 730, territory: "By agreement", byRequest: true },
  ],
  "music-ip": [
    { key: "social", name: "Social and creator use", scope: "Background music in videos and streams", fee: "50", revSharePct: 0, durationDays: 365, territory: "Worldwide", byRequest: false },
    { key: "sync", name: "Sync (film, TV, ads)", scope: "Placement in one production · scope and territory set per request", fee: "0", revSharePct: 0, durationDays: 0, territory: "By agreement", byRequest: true },
    { key: "remix", name: "Remix and sampling", scope: "Release a remix or sample it · credit required · quarterly revenue reports", fee: "200", revSharePct: 10, durationDays: 1095, territory: "Worldwide", byRequest: false },
  ],
  collectibles: [
    { key: "image", name: "Image rights", scope: "Use photos of the item in print, web and merchandise", fee: "250", revSharePct: 0, durationDays: 365, territory: "Worldwide", byRequest: false },
    { key: "display", name: "Display or exhibition", scope: "Exhibit the item · terms agreed per show", fee: "0", revSharePct: 0, durationDays: 90, territory: "By agreement", byRequest: true },
  ],
};

export interface IpPage {
  offering: string; issuer: string; name: string; symbol: string; assetClass: AssetClassId; chainId: number; assetId: string;
  registry: `0x${string}`; licenseRegistry: `0x${string}`; owner: `0x${string}`; payee: `0x${string}`; holdersBps: number;
  docsManifest: string; registeredAt: number; identifiers: Record<string, string>; imageUrl: string; summary: string;
  documents: { kind: string; name: string; sha256: string }[]; details: Record<string, unknown>; stage: string | null;
  licenseTypes: { key: string; typeId: string; name: string; scope: string; termsHash: `0x${string}`; termsName: string; fee: string; feeToken: `0x${string}`; revShareBps: number; durationDays: number; territory: string; byRequest: boolean; active: boolean }[];
  licenses: { licenseId: string; typeId: string; licensee: `0x${string}`; work: string; territory: string; feePaid: string; revShareBps: number; start: number; end: number; revenueReported: string; status: "none" | "active" | "expired" | "revoked"; tx: string }[];
  royalties: { fees: string; revenueShares: string; holdersOwed: string };
  history: { at: number; tx: string; text: string }[];
}
export interface LicenseInfo {
  name: string; licenseId: string; chainId: number; status: "none" | "active" | "expired" | "revoked"; assetId: string; offering: `0x${string}`;
  licensee: `0x${string}`; typeName: string; termsHash: `0x${string}`; termsURI: string; feeToken: `0x${string}`; feePaid: string;
  revShareBps: number; start: number; end: number; work: string; territory: string; revenueReported: string; registry: `0x${string}`;
}
export interface LicenseRequest {
  id: string; wallet: `0x${string}`; company: string; kind: "company" | "individual"; jurisdiction: string; email: string;
  typeKey?: string; work: string; message: string; at: string; status: string;
  /** The licensee's Sumsub check with this issuer, if any. */
  check?: "init" | "pending" | "approved" | "retry" | "rejected" | null;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`/api${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) }, credentials: "include" });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as any).error ?? `HTTP ${r.status}`);
  return body as T;
}
export const ipApi = {
  page: (id: string) => call<IpPage>(`/ip/${id}`),
  terms: async (id: string, key: string) => { const r = await fetch(`/api/ip/${id}/terms/${key}`); if (!r.ok) throw new Error("terms not found"); return r.text(); },
  request: (id: string, body: Omit<LicenseRequest, "id" | "at" | "status">) => call<{ ok: true; id: string }>(`/ip/${id}/requests`, { method: "POST", body: JSON.stringify(body) }),
  license: (chainId: number | string, id: string) => call<LicenseInfo>(`/licenses/${chainId}/${id}`),
  save: (assetId: string, draft: unknown) => call<{ ok: true; licenseTypes: (Omit<LicenseTypeDraft, "termsText"> & { termsHash: string })[] }>(`/assets/${assetId}/ip`, { method: "PUT", body: JSON.stringify(draft) }),
  registered: (assetId: string, body: { assetId: string; types: Record<string, string> }) => call<{ ok: true }>(`/assets/${assetId}/ip/registered`, { method: "POST", body: JSON.stringify(body) }),
  config: () => call<{ kyb: boolean; verifier: `0x${string}` | null }>("/ip/config"),
  verifyMe: (id: string, wallet: string) => call<{ approved: boolean; onChain?: boolean; status?: string; reason?: string; until?: number; tx?: string }>(`/ip/${id}/verify-me`, { method: "POST", body: JSON.stringify({ wallet }) }),
  requests: (assetId: string) => call<LicenseRequest[]>(`/assets/${assetId}/ip/requests`),
};

/** sha256 of the template text, as the API and the contract see it ("0x" + hex). */
export async function termsHash(text: string): Promise<`0x${string}`> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `0x${[...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
