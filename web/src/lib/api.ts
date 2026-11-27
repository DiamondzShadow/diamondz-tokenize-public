import type { AssetClassId, PayMethodId, StandardId } from "./catalog";
import type { Plan } from "./pricing";
import type { Address, Hex } from "viem";
import type { Rules, DocFingerprint } from "./rules";
import type { Details } from "./questions";

export interface Tenant {
  id: string;
  name: string;
  hosts: string[];
  brand: { primary: string; theme: "dark" | "light"; logoUrl?: string };
  offerings: AssetClassId[];
  poweredBy: boolean;
  onboarding: { brandingDone?: boolean; paymentsDone?: boolean; counselReady?: boolean; counselName?: string; counselDate?: string };
  payments: { methods: PayMethodId[]; payoutCurrency: string; distributionFeeBps: number; treasury?: string };
  auth: { googleClientId: string | null; domains: string[]; thirdwebClientId: string | null; sponsoredChains: number[] };
  registries: Record<string, string>;
  platform: { saleFeeBps: number; feeRecipients: Record<string, string> };
  legal?: { contactEmail: string | null };
  plan: Plan;
  plans: Plan[];
  /** Growth trial end for self-serve workspaces (ISO). */
  trialEndsAt?: string;
}

export interface Deployment {
  chainId: number;
  registry: `0x${string}`;
  token: `0x${string}`;
  sale: `0x${string}`;
  payToken: `0x${string}`;
  /** OfferingRules contract, when the offering has rules (ERC-20/721/1155/vault). */
  rules?: `0x${string}`;
  txs: string[];
  feeTx?: string;
  deployedAt: string;
}

/** Stellar edition (designs X1–X5): deployment/operations state kept on the asset by the API. */
export interface StellarState {
  network: number;
  /** Admin: the issuer's wallet on testnet, its multisig on mainnet. */
  issuer: string;
  /** Day-to-day manager wallet (verify, issue, freeze). */
  operator?: string;
  /** Mainnet: the offering-fee payment's transaction hash. */
  feeTx?: string;
  /** Mainnet: the issuer's EVM wallet that signs every investor claim (the platform holds no claim key). */
  claimSigner?: { address: string; publicKey: string };
  status: "deploying" | "deployed" | "failed";
  steps: Record<string, string>;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  offChainRules: string[];
  investors: { account: string; country: number; identity: string; verifiedAt: string; frozen?: boolean }[];
  requests: { account: string; country: number; at: string }[];
}
export interface StellarDeployment {
  chainId: number;
  token: string;
  registry: string;
  compliance: string;
  verifier: string;
  claimTopicsAndIssuers: string;
  claimIssuer: string;
  modules: Record<string, string>;
  anchor: { chainId: number; address: `0x${string}` };
  deployedAt: string;
}
export interface StellarSaleTerms { price?: string; minimum?: string; treasury?: string; capTokens?: string; startsAt?: number; endsAt?: number }
export interface StellarAccountFacts { exists: boolean; signers: number; medThreshold: number; multisig: boolean; why: string; canReceive: boolean; payToken: string }
export interface StellarTerms {
  network: string; open: boolean; codeReady: boolean; feeAccount: string | null; feeUsd: number;
  payToken: { code: string; issuer: string }; testnetOnlyPlan: boolean; counselReady: boolean;
}
export interface StellarSale {
  address: string; open: boolean; canMint: boolean;
  /** pay-token base units per whole token / smallest purchase; token base units for cap and sold */
  price: string; minPurchase: string; cap: string; sold: string; startsAt: number; endsAt: number;
  payToken: { contract: string; code: string; issuer: string | null; decimals: number };
  closedByProof: string | null;
}
export interface StellarToken { network: string; contract: string; name: string; symbol: string; decimals: number; totalSupply: string; paused: boolean; ledger: number }

export type TeamRole = "owner" | "admin" | "compliance" | "operations" | "viewer";
export interface TeamMember { account: string; email: string | null; name: string | null; role: TeamRole; since: string; you: boolean }
export interface TeamInvite { id: string; email: string; role: TeamRole; expiresAt: string; expired?: boolean; createdAt?: string }
export interface MfaState { enabled: boolean; verified: boolean; required: boolean; available: boolean; recoveryLeft: number | null }
export interface AdvisorClient { id: string; name: string; email: string; kind: string; wallet: string | null; linkedAt: string | null; createdAt: string; verifiedWith: number; holdings: { assetId: string; name: string; tokens: number; valueUsd: number }[] }
export interface ClientProposal { id: string; clientId: string; assetId: string; assetName: string; amountUsd: number; status: "proposed" | "approved" | "declined"; decidedAt: string | null; createdAt?: string }
export interface CompanyCheck { status: "not started" | "started" | "in review" | "verified"; name: string | null; due?: number }
export interface LegalState {
  company: CompanyCheck; emailOn: boolean; stage: "none" | "invited" | "opened" | "comments" | "signed" | "changed" | "returned" | "approved"; cleared: boolean; reasons: string[];
  counsel: { name: string; firm: string; email: string; barState: string; barNumber: string; invitedAt: string; openedAt: string | null; signedAt: string | null; comments: { at: string; text: string } | null } | null;
  review: { decision: "approved" | "returned"; at: string; note: string } | null;
}
export interface CounselView {
  needsCode: boolean; email?: string; issuer: string; company?: CompanyCheck;
  counsel?: { name: string; firm: string; email: string; barState: string; barNumber: string };
  letter?: { sha256: string; bytes: number; at: string } | null; signed?: { at: string; name: string } | null;
  offering?: { id: string; name: string; symbol: string; chainId: number; standard: string; exemption: string | null; totalSupply: string; pricePerToken: string; minInvestment: string; lockup: string; rules: Record<string, unknown> | null; documents: { kind: string; name: string; url: string | null; sha256: string }[] };
}
export interface PlatformReview {
  assetId: string; name: string; issuer: string; chainId: number; exemption: string | null; stage: string; company: CompanyCheck;
  counsel: { name: string; firm: string; email: string; barState: string; barNumber: string }; signed: { at: string; name: string; barState: string; barNumber: string };
  letter: { sha256: string; bytes: number } | null; emailDomainOk: boolean; termsMatch: boolean; review: { decision: string; by: string; at: string; note: string } | null;
}
export interface ApprovalAudit {
  covered: boolean; total: number; checked: number; manual: number; testnet: boolean; note?: string | null;
  wallets: { wallet: string; checked: boolean; identity: string; accredited: boolean; country: number; system: boolean }[];
}
export interface AuditEntry { at: string; who: string; role: TeamRole; method: string; path: string; status: number }
export interface TeamState { me: { account: string | null; role: TeamRole }; members: TeamMember[]; invites: TeamInvite[]; emailOn: boolean }
export interface Me {
  email: string;
  name: string | null;
  /** The signed-in person's role in the active workspace (team members, 2026-11-20). */
  role?: TeamRole;
  /** Set for thirdweb account sign-ins (self-serve issuers); null for Google Workspace sign-ins. */
  account?: string | null;
}

export interface Asset {
  id: string;
  tenantId: string;
  name: string;
  symbol: string;
  assetClass: AssetClassId;
  standard: StandardId;
  chainId: number;
  totalSupply: string;
  pricePerToken: string;
  minInvestment: string;
  schedule: string;
  lockup: string;
  /** Expected offering exemption (wizard step 4): Reg D 506(c), Reg S, or not decided yet. */
  exemption?: "506c" | "regs" | "unsure";
  /** Wizard step 2: answers for this asset class (lib/questions.ts). */
  details?: Details;
  /** Wizard step 5: rules the token enforces (lib/rules.ts). */
  rules?: Rules;
  /** Offering document fingerprints; the files stay with the issuer. */
  documents?: DocFingerprint[];
  status: "draft" | "deployed";
  description: string;
  imageUrl: string;
  location: string;
  listed: boolean;
  deployment?: Deployment;
  /** ERC-3643: the suite the platform deployed for this offering (see api/src/trex.ts). */
  trex?: TrexSuite;
  /** Stellar offerings only (standard "stellar-rwa"). */
  stellar?: StellarState;
  /** The issuer's Form D, as returned by the SEC search and attached by the issuer (api/src/edgar.ts). */
  formD?: FormDFiling;
  createdAt: string;
  updatedAt: string;
}

// ---- accredited investors (Mastercard Open Finance; see api/src/mastercard.ts)
export interface AccreditationStart {
  assetId: string; wallet: string; route: "income" | "assets"; firstName: string; lastName: string; birthday: string;
  state: string; email: string; consent: true; ts: number; signature: string;
}
export interface AccreditationPublic { id: string; assetId: string; wallet: Address; route: "income" | "assets"; status: "linking" | "reporting" | "ready" | "failed"; decision: "approved" | "declined" | "more" | null; preparedAt: string | null; consentAt: string }
export interface AccreditationSummary {
  route: "income" | "assets"; reportType: string; preparedAt: string | null; institutions: number; accounts: number;
  incomeLast12?: number; incomePrior12?: number; monthsObserved?: number; incomeStreams?: number;
  assetsCurrent?: number; assetsTwoMonthAvg?: number; reading: "meets" | "short" | "insufficient-history";
}
export interface AccreditationAdmin extends AccreditationPublic { summary: AccreditationSummary | null; decidedAt: string | null; decidedBy: string | null; error: string | null; createdAt: string; consentText: string }

export interface BankProof {
  kind: string; kindName: string; maxDays: number; dataSource: Address | null; lastCompleteMonth: string; linked: boolean;
  accountId?: string | null; accountLabel?: string | null; expectedMonthly?: number | null; payers?: string[];
  lastMonthSigned?: string | null; lastTx?: string | null; lastResult?: { month: string; met: boolean; cents: number } | null;
  months?: { month: string; cents: number; deposits: number }[] | null; readError?: string | null;
  /** 2026-11-20: Stripe Financial Connections as a second provider. */
  stripeAvailable?: boolean; provider?: "stripe" | "mastercard";
  holder?: { names: string[]; expected: string | null; match: boolean | null } | null;
  /** Who deposits into the account; "regular" payers (2+ months) count automatically when none are named. */
  depositors?: { name: string; months: number; cents: number; regular: boolean }[] | null;
}

// ---- SEC Form D (api/src/edgar.ts). Figures are as filed; they don't track sales.
export interface FormDFiling {
  accessionNo: string; form: string; filedAt: string; cik: string; entityName: string; entityType: string | null;
  jurisdiction: string | null; yearOfInc: string | null; city: string | null; state: string | null; industry: string | null;
  exemptions: { code: string; label: string }[]; dateOfFirstSale: string | null; moreThanOneYear: boolean | null;
  minimumInvestment: number | null; totalOfferingAmount: number | null; totalAmountSold: number | null; totalRemaining: number | null;
  investors: number | null; hasNonAccredited: boolean | null; url: string; source: string; checkedAt?: string; attachedAt?: string;
}
export interface EdgarStatus { enabled: boolean; provider: string | null; fallback: string | null; searchesLeftToday: number | null; tenantDaily: number; budgetLeft: number; cacheDays: number }

export interface TrexSuite {
  token: Address;
  identityRegistry: Address;
  identityStorage: Address;
  claimIssuer: Address;
  owner: Address;
  salt: string;
  referenceAuthority: Address;
  deployBlock: number | null;
  /** OfferingRulesModule this suite was deployed with (offerings with rules). */
  rulesModule?: Address;
  /** Accreditation is a required claim on this suite. */
  accreditedOnly?: boolean;
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  const res = await fetch(`/api${path}`, { ...init, headers, credentials: "same-origin" });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  // status + body ride along so callers can tell "sign in" (401) from "create your workspace first" (403 needsWorkspace).
  if (!res.ok) throw Object.assign(new Error(data?.error ?? `${res.status} ${res.statusText}`), { status: res.status, data });
  return data as T;
}

/** A message sent through the site's contact form (console › Messages). */
export interface Message { id: string; name: string; email: string; company: string | null; message: string | null; createdAt: string; readAt: string | null; archivedAt: string | null }
/** Investor identity check (Sumsub). `message` is Sumsub's note when they ask for another photo. */
export interface KycStatus { id: string; wallet: string; status: "init" | "pending" | "approved" | "retry" | "rejected"; message: string | null; updatedAt: string }
export interface KycCheck { id: string; wallet: Address; status: KycStatus["status"]; applicantId: string | null; rejectLabels: string[]; name: string | null; country: string | null; createdAt: string; updatedAt: string }
/** A self-serve issuer workspace the signed-in account belongs to. */
export interface WorkspaceSummary { id: string; name: string; role: string; plan: string; trialEndsAt: string | null }
export interface AccountState { account: { address: string; email: string | null; name: string | null }; workspaces: WorkspaceSummary[]; active: string | null }
export interface PlanRequest { plan: string; annual: boolean; at: string }
export interface MessageSettings { notifyEmails: string[]; emailConfigured: boolean; platformFallback?: boolean }

export const api = {
  // ---- Stellar edition
  stellarDeploy: (id: string, issuer: string) => req<Asset>(`/assets/${id}/stellar/deploy`, { method: "POST", body: JSON.stringify({ issuer }) }),
  /** Mainnet: the issuer's multisig is admin, its own wallet is the day-to-day manager, the fee is paid first. */
  stellarDeployMainnet: (id: string, admin: string, operator: string, feeTx: string, claimSigner: { address: string; signature: string }) => req<Asset>(`/assets/${id}/stellar/deploy`, { method: "POST", body: JSON.stringify({ admin, operator, feeTx, claimSigner }) }),
  stellarTerms: (network: string) => req<StellarTerms>(`/stellar-terms/${network}`),
  // Verify / issue / freeze: on mainnet the first call returns { xdr } for the operator wallet to sign; resend with signedXdr.
  // Mainnet verify: { claims, claimSigner } first (the issuer's claim wallet signs each digest), then { xdr }.
  stellarVerify: (id: string, account: string, country: number, signedXdr?: string, claimSignatures?: { topic: number; signature: string }[]) =>
    req<Asset & { xdr?: string; claims?: { topic: number; digest: `0x${string}` }[]; claimSigner?: string }>(`/assets/${id}/stellar/verify`, { method: "POST", body: JSON.stringify({ account, country, ...(signedXdr ? { signedXdr } : {}), ...(claimSignatures ? { claimSignatures } : {}) }) }),
  stellarIssue: (id: string, account: string, amount: string, signedXdr?: string) => req<{ ok?: true; tx?: string; xdr?: string }>(`/assets/${id}/stellar/issue`, { method: "POST", body: JSON.stringify({ account, amount, ...(signedXdr ? { signedXdr } : {}) }) }),
  stellarFreeze: (id: string, account: string, freeze: boolean, signedXdr?: string) => req<{ ok?: true; tx?: string; xdr?: string }>(`/assets/${id}/stellar/freeze`, { method: "POST", body: JSON.stringify({ account, freeze, ...(signedXdr ? { signedXdr } : {}) }) }),
  stellarPausePrepare: (id: string, paused: boolean) => req<{ xdr: string }>(`/assets/${id}/stellar/pause`, { method: "POST", body: JSON.stringify({ paused }) }),
  stellarPauseSubmit: (id: string, paused: boolean, signedXdr: string) => req<{ ok: true; tx: string }>(`/assets/${id}/stellar/pause`, { method: "POST", body: JSON.stringify({ paused, signedXdr }) }),
  stellarRequest: (id: string, account: string, country: number) => req<{ status: string }>(`/stellar/assets/${id}/requests`, { method: "POST", body: JSON.stringify({ account, country }) }),
  stellarStatus: (id: string, account: string) => req<{ status: "none" | "requested" | "verified" | "frozen" }>(`/stellar/assets/${id}/status/${account}`),
  stellarSale: (id: string) => req<{ sale: StellarSale | null }>(`/stellar/assets/${id}/sale`),
  stellarSaleSetup: (id: string, terms: StellarSaleTerms = {}) => req<Asset>(`/assets/${id}/stellar/sale/setup`, { method: "POST", body: JSON.stringify(terms) }),
  stellarAccount: (network: string, account: string) => req<StellarAccountFacts>(`/stellar-account/${network}/${account}`),
  stellarTrustline: (network: string, account: string, signedXdr?: string) => req<{ xdr?: string; ok?: true; tx?: string }>(`/stellar-trustline/${network}`, { method: "POST", body: JSON.stringify({ account, ...(signedXdr ? { signedXdr } : {}) }) }),
  stellarFeeCheck: (network: string, feeTx: string, assetId: string) => req<{ ok: boolean; error?: string }>(`/stellar-fee-check/${network}`, { method: "POST", body: JSON.stringify({ feeTx, assetId }) }),
  stellarSaleGrant: (id: string, signedXdr?: string) => req<{ xdr?: string; ok?: true; tx?: string; already?: boolean }>(`/assets/${id}/stellar/sale/grant`, { method: "POST", body: JSON.stringify(signedXdr ? { signedXdr } : {}) }),
  stellarSaleOpen: (id: string, open: boolean) => req<{ ok: true; tx: string }>(`/assets/${id}/stellar/sale/open`, { method: "POST", body: JSON.stringify({ open }) }),
  stellarBuy: (id: string, buyer: string, amount: string, signedXdr?: string) => req<{ xdr?: string; ok?: true; tx?: string }>(`/stellar/assets/${id}/buy`, { method: "POST", body: JSON.stringify({ buyer, amount, ...(signedXdr ? { signedXdr } : {}) }) }),
  stellarToken: (network: string, contract: string) => req<StellarToken>(`/stellar/${network}/${contract}`),
  stellarBalance: (network: string, contract: string, account: string) => req<{ balance: string; frozen: boolean | null }>(`/stellar/${network}/${contract}/balance/${account}`),
  edgarStatus: () => req<EdgarStatus>("/edgar/status"),
  formDSearch: (assetId: string, query: string, fresh = false) =>
    req<{ results: FormDFiling[]; cached: boolean; fetchedAt: string; searchesLeftToday: number | null }>(`/assets/${assetId}/formd/search`, { method: "POST", body: JSON.stringify({ query, fresh }) }),
  formDAttach: (assetId: string, accessionNo: string) => req<Asset>(`/assets/${assetId}/formd`, { method: "POST", body: JSON.stringify({ accessionNo }) }),
  formDRemove: (assetId: string) => req<Asset>(`/assets/${assetId}/formd`, { method: "DELETE" }),
  tenant: () => req<Tenant>("/tenant"),
  updateTenant: (patch: Partial<Tenant>) => req<Tenant>("/tenant", { method: "PATCH", body: JSON.stringify(patch) }),
  assets: () => req<Asset[]>("/assets"),
  asset: (id: string) => req<Asset>(`/assets/${id}`),
  createAsset: (a: Partial<Asset>) => req<Asset>("/assets", { method: "POST", body: JSON.stringify(a) }),
  updateAsset: (id: string, a: Partial<Asset>) =>
    req<Asset>(`/assets/${id}`, { method: "PATCH", body: JSON.stringify(a) }),
  identity: (wallet: string, chainId: number) => req<{ required: boolean; passed: boolean; status: string }>(`/identity/${wallet}?chainId=${chainId}`),
  screen: (address: string, chainId: number) => req<{ sanctioned: boolean; ofacListUpdatedAt: string; oracle: boolean | null }>(`/screen/${address}?chainId=${chainId}`),
  recordDeployment: (id: string, d: { registry: string; token: string; sale: string; payToken: string; rules?: string; txs: string[]; feeTx?: string }) =>
    req<Asset>(`/assets/${id}/deployment`, { method: "POST", body: JSON.stringify(d) }),
  trexPrepare: (id: string, wallet: string) => req<TrexSuite>(`/assets/${id}/trex/prepare`, { method: "POST", body: JSON.stringify({ wallet }) }),
  trexIdentity: (id: string, wallet: string) =>
    req<{ identity: Address; data: Hex; digest: Hex; claimIssuer: Address; signer: Address; statement: string; accredited?: { data: Hex; digest: Hex; statement: string } }>(`/assets/${id}/trex/identity`, { method: "POST", body: JSON.stringify({ wallet }) }),
  trexKyc: (id: string, body: { wallet: string; data: string; signature: string; country: number; accredited?: { data: string; signature: string } }) =>
    req<{ wallet: Address; verified: boolean }>(`/assets/${id}/trex/kyc`, { method: "POST", body: JSON.stringify(body) }),
  accreditationConsent: (assetId: string) => req<{ text: string; version: string }>(`/accreditation/consent/${assetId}`),
  accreditationStart: (body: AccreditationStart) => req<{ id: string; link: string; consentText: string }>("/accreditation/start", { method: "POST", body: JSON.stringify(body) }),
  accreditationLinked: (id: string, wallet: string) => req<AccreditationPublic>(`/accreditation/${id}/linked`, { method: "POST", body: JSON.stringify({ wallet }) }),
  accreditationStatus: (id: string, wallet: string) => req<AccreditationPublic>(`/accreditation/${id}?wallet=${wallet}`),
  accreditations: (assetId: string) => req<AccreditationAdmin[]>(`/assets/${assetId}/accreditation`),
  accreditationReport: (id: string) => req<AccreditationAdmin & { owners: string[]; institutions: { name: string; accounts: { type: string; ownerName: string | null; last4: string | null }[] }[] }>(`/accreditation/${id}/report`),
  accreditationDecision: (id: string, decision: "approve" | "decline" | "more") => req<AccreditationAdmin>(`/accreditation/${id}/decision`, { method: "POST", body: JSON.stringify({ decision }) }),
  bank: (assetId: string) => req<BankProof>(`/assets/${assetId}/bank`),
  stripeFcConfig: () => req<{ enabled: boolean; publishableKey: string | null }>("/stripe/fc-config"),
  bankStripeSession: (assetId: string) => req<{ clientSecret: string; sessionId: string }>(`/assets/${assetId}/bank/stripe/session`, { method: "POST", body: "{}" }),
  bankStripeLinked: (assetId: string, sessionId: string) => req<{ accounts: { id: string; name: string; type: string; last4: string }[] }>(`/assets/${assetId}/bank/stripe/linked`, { method: "POST", body: JSON.stringify({ sessionId }) }),
  bankConnect: (assetId: string) => req<{ link: string }>(`/assets/${assetId}/bank/connect`, { method: "POST", body: "{}" }),
  bankLinked: (assetId: string) => req<{ accounts: { id: string; name: string; type: string; last4: string }[] }>(`/assets/${assetId}/bank/linked`, { method: "POST", body: "{}" }),
  bankSettings: (assetId: string, body: { accountId: string; expectedMonthly: number; payers: string[] }) => req<{ ok: true }>(`/assets/${assetId}/bank/settings`, { method: "POST", body: JSON.stringify(body) }),
  bankCheck: (assetId: string) => req<{ signed: boolean; reason?: string; month?: string; tx?: string; income?: { cents: number } }>(`/assets/${assetId}/bank/check`, { method: "POST", body: "{}" }),
  market: () => req<MarketAsset[]>("/market"),
  proof: (id: string) => req<Proof>(`/proof/${id}`),
  payouts: (assetId: string) => req<{ distributor: string | null; payouts: PayoutRow[] }>(`/assets/${assetId}/payouts`),
  previewPayout: (assetId: string, body: { amount: string; memo: string; snapshot: { mode: "now" } | { mode: "date"; at: string }; claimMonths: number; holdFrozen: boolean }) =>
    req<PayoutPreview>(`/assets/${assetId}/payouts/preview`, { method: "POST", body: JSON.stringify(body) }),
  payoutSent: (pid: string, tx: string) => req<{ ok: true; distributionId: string }>(`/payouts/${pid}/sent`, { method: "POST", body: JSON.stringify({ tx }) }),
  portfolio: (address: string) => req<{ claimable: Income[]; paid: (Income & { tx: string })[] }>(`/portfolio/${address}`),
  claim: (pid: string, account: string) => req<{ tx: string; amount: string }>(`/payouts/${pid}/claim`, { method: "POST", body: JSON.stringify({ account }) }),
  marketAsset: (id: string) => req<MarketAsset>(`/market/${id}`),
  me: () => req<Me>("/auth/me"),
  signInWithGoogle: (credential: string) => req<Me>("/auth/google", { method: "POST", body: JSON.stringify({ credential }) }),
  signOut: () => req<{ ok: true }>("/auth/logout", { method: "POST" }),
  kycConfig: () => req<{ enabled: boolean; provider?: "sumsub" | "stripe" | null; testMode?: boolean }>("/kyc/config"),
  kycStart: (body: { wallet: string; chainId: number; ts: number; signature: string; assetId?: string; licensee?: { assetId: string; kind: "company" | "individual" } }) => req<{ id: string; token: string | null; url?: string | null; provider?: "sumsub" | "stripe"; status: KycStatus }>("/kyc/start", { method: "POST", body: JSON.stringify(body) }),
  kycToken: (id: string, wallet: string) => req<{ token: string }>(`/kyc/${encodeURIComponent(id)}/token`, { method: "POST", body: JSON.stringify({ wallet }) }),
  kycStatus: (id: string, wallet: string) => req<KycStatus>(`/kyc/${encodeURIComponent(id)}?wallet=${wallet}`),
  kycList: () => req<{ enabled: boolean; provider?: "sumsub" | "stripe" | null; sandbox: boolean; clientId: string | null; checks: KycCheck[] }>("/kyc"),
  authNonce: () => req<{ nonce: string; issuedAt: string; message: string }>("/auth/nonce"),
  authThirdweb: (body: { address: string; chainId: number; nonce: string; issuedAt: string; signature: string; email?: string; name?: string }) =>
    req<AccountState>("/auth/thirdweb", { method: "POST", body: JSON.stringify(body) }),
  account: () => req<AccountState>("/account"),
  // ---- team members and roles (design 2)
  team: () => req<TeamState>("/team"),
  // ---- investors approved without an identity check (2026-11-20)
  assetApprovals: (id: string) => req<ApprovalAudit>(`/assets/${id}/approvals`),
  marketIssuer: (id: string) => req<{ verified: boolean; name: string | null }>(`/market/${id}/issuer`),
  marketApprovals: (id: string) => req<Omit<ApprovalAudit, "wallets">>(`/market/${id}/approvals`),
  // ---- legal sign-off (L1–L4)
  legal: (assetId: string) => req<LegalState>(`/assets/${assetId}/legal`),
  legalCompany: (back: string) => req<{ url: string }>(`/legal/company?back=${encodeURIComponent(back)}`, { method: "POST", body: "{}" }),
  legalInvite: (assetId: string, b: { name: string; firm: string; email: string; barState: string; barNumber: string }) => req<{ ok: true }>(`/assets/${assetId}/legal/invite`, { method: "POST", body: JSON.stringify(b) }),
  counsel: (t: string) => req<CounselView>(`/counsel/${encodeURIComponent(t)}`),
  counselCode: (t: string) => req<{ ok: true; email: string }>(`/counsel/${encodeURIComponent(t)}/code`, { method: "POST", body: "{}" }),
  counselVerify: (t: string, code: string) => req<{ ok: true }>(`/counsel/${encodeURIComponent(t)}/verify`, { method: "POST", body: JSON.stringify({ code }) }),
  counselLetter: async (t: string, file: File) => {
    const res = await fetch(`/api/counsel/${encodeURIComponent(t)}/letter`, { method: "POST", body: file, headers: { "content-type": "application/pdf" }, credentials: "same-origin" });
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error(j?.error ?? `Upload failed (${res.status})`);
    return j as { ok: true; sha256: string };
  },
  counselSign: (t: string, b: { barState: string; barNumber: string; statements: [true, true, true]; name: string }) => req<{ ok: true; signedAt: string }>(`/counsel/${encodeURIComponent(t)}/sign`, { method: "POST", body: JSON.stringify(b) }),
  counselComments: (t: string, text: string) => req<{ ok: true }>(`/counsel/${encodeURIComponent(t)}/comments`, { method: "POST", body: JSON.stringify({ text }) }),
  reviews: () => req<{ reviews: PlatformReview[] }>("/platform/reviews"),
  decideReview: (assetId: string, b: { decision: "approve" | "return"; licenseFound: boolean; note: string }) => req<{ ok: true }>(`/platform/reviews/${assetId}`, { method: "POST", body: JSON.stringify(b) }),
  // ---- client accounts for advisors (design 4)
  clients: () => req<{ clients: AdvisorClient[]; offerings: { id: string; name: string; issuer: string; pricePerToken: string; minInvestment: string; exemption: string | null }[] }>("/clients"),
  addClient: (b: { name: string; email: string; kind: "individual" | "trust" | "company" }) => req<{ client: { id: string }; emailed: boolean; link: string | null }>("/clients", { method: "POST", body: JSON.stringify(b) }),
  removeClient: (id: string) => req<{ ok: true }>(`/clients/${id}`, { method: "DELETE" }),
  clientEligibility: (assetId: string) => req<{ minInvestment: number; clients: Record<string, { identity: string; accredited: string; eligible: boolean; wallet: boolean }> }>(`/clients/eligibility/${assetId}`),
  proposals: () => req<{ proposals: ClientProposal[] }>("/clients/proposals"),
  propose: (assetId: string, items: { clientId: string; amountUsd: number }[]) => req<{ proposals: ClientProposal[] }>("/clients/proposals", { method: "POST", body: JSON.stringify({ assetId, items }) }),
  portal: (token: string) => req<{ firm: string; name: string; wallet: string | null; message: string; proposals: Omit<ClientProposal, "clientId">[] }>(`/client-portal/${encodeURIComponent(token)}`),
  portalLink: (token: string, b: { wallet: string; chainId: number; signature: string }) => req<{ ok: true; wallet: string }>(`/client-portal/${encodeURIComponent(token)}/link`, { method: "POST", body: JSON.stringify(b) }),
  portalDecide: (token: string, id: string, decision: "approve" | "decline") => req<{ ok: true; status: string; investUrl: string | null }>(`/client-portal/${encodeURIComponent(token)}/proposals/${id}`, { method: "POST", body: JSON.stringify({ decision }) }),
  // ---- two-step sign-in (TOTP)
  mfa: () => req<MfaState>("/mfa"),
  mfaSetup: () => req<{ secret: string; uri: string }>("/mfa/setup", { method: "POST" }),
  mfaEnable: (code: string) => req<{ recoveryCodes: string[] }>("/mfa/enable", { method: "POST", body: JSON.stringify({ code }) }),
  mfaVerify: (code: string) => req<{ ok: true; recoveryLeft: number }>("/mfa/verify", { method: "POST", body: JSON.stringify({ code }) }),
  mfaDisable: (code: string) => req<{ ok: true }>("/mfa/disable", { method: "POST", body: JSON.stringify({ code }) }),
  audit: (limit = 25) => req<{ entries: AuditEntry[] }>(`/audit?limit=${limit}`),
  inviteMember: (email: string, role: TeamRole) => req<{ invite: TeamInvite; emailed: boolean; link: string | null }>("/team/invites", { method: "POST", body: JSON.stringify({ email, role }) }),
  cancelInvite: (id: string) => req<{ ok: true }>(`/team/invites/${id}`, { method: "DELETE" }),
  setMemberRole: (account: string, role: TeamRole) => req<{ ok: true }>(`/team/members/${account}`, { method: "PATCH", body: JSON.stringify({ role }) }),
  removeMember: (account: string) => req<{ ok: true }>(`/team/members/${account}`, { method: "DELETE" }),
  invite: (token: string) => req<{ workspace: string; role: string; email: string; state: "open" | "used" | "expired" }>(`/invites/${encodeURIComponent(token)}`),
  acceptInvite: (token: string) => req<{ ok: true; workspace: string }>("/invites/accept", { method: "POST", body: JSON.stringify({ token }) }),
  createWorkspace: (body: { name: string; role?: string; offerings?: string[] }) => req<{ workspace: WorkspaceSummary }>("/workspaces", { method: "POST", body: JSON.stringify(body) }),
  switchWorkspace: (id: string) => req<{ ok: true }>(`/workspaces/${encodeURIComponent(id)}/switch`, { method: "POST" }),
  workspace: () => req<Tenant>("/workspace"),
  planRequest: () => req<{ planRequest: PlanRequest | null }>("/billing/plan-request"),
  requestPlan: (plan: string, annual: boolean) => req<{ planRequest: PlanRequest }>("/billing/plan-request", { method: "POST", body: JSON.stringify({ plan, annual }) }),
  cancelPlanRequest: () => req<{ ok: true }>("/billing/plan-request", { method: "DELETE" }),
  messages: (archived = false) => req<{ messages: Message[]; unread: number }>(`/messages${archived ? "?archived=1" : ""}`),
  unreadMessages: () => req<{ unread: number }>("/messages/unread"),
  updateMessage: (id: string, body: { read?: boolean; archived?: boolean }) => req<{ ok: true }>(`/messages/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
  messageSettings: () => req<MessageSettings>("/messages/settings"),
  saveMessageSettings: (notifyEmails: string[]) => req<MessageSettings>("/messages/settings", { method: "PUT", body: JSON.stringify({ notifyEmails }) }),
  demoRequest: (body: { name: string; email: string; company?: string; message?: string; kind: string }) =>
    req<{ ok: true }>("/leads", { method: "POST", body: JSON.stringify(body) }),
};

export type MarketAsset = Pick<Asset, "id" | "name" | "symbol" | "assetClass" | "standard" | "chainId" | "totalSupply" | "pricePerToken" | "minInvestment" | "schedule" | "lockup" | "description" | "imageUrl" | "location" | "formD" | "details" | "rules" | "documents" | "exemption"> & {
  deployment: Deployment;
  /** The offering's issuer (several issuers share the platform site). */
  issuer?: { id: string; name: string };
};

// ---- proof of asset (see api/src/proof.ts)
export type CheckStatus = "current" | "expiring" | "expired" | "failed" | "missing" | "verifier-removed";
export interface ProofCheck {
  kind: string;
  name: string;
  confirms: string;
  status: CheckStatus;
  verifier?: { address: string; name: string };
  attestedAt?: string;
  validUntil?: string;
  value?: string;
  valueUnit?: string;
  evidenceURI?: string;
  evidenceHash?: string;
  tx?: string;
}
export interface ProofFeed { metric: string; label: string; unit: string; value: string; decimals: number; observedAt: string; source: string }
export interface ProofLive { id: string; label: string; ok: boolean | null; detail: string }
export interface Proof {
  assetId: string;
  chainId: number;
  oracle: string | null;
  gated: boolean;
  registered: boolean;
  verified: boolean;
  checks: ProofCheck[];
  live: ProofLive[];
  feeds: ProofFeed[];
  checkedAt: string;
  error?: string;
}

// ---- payouts (see api/src/payouts.ts)
export interface PayoutRow {
  id: string; memo: string; amount: string; decimals: number; symbol: string; fee: string;
  snapshotTime: string; snapshotBlock: string; sentAt: string; tx: string; claimDeadline: string;
  holders: number; claimedCount: number | null; claimedAmount: string | null; frozenHeld: number;
}
export interface PayoutPreview {
  id: string; status: "draft"; chainId: number; token: string; tokenDecimals: number; payout: string; payoutSymbol: string; payoutDecimals: number;
  amount: string; memo: string; snapshotBlock: string; snapshotTime: string; claimDeadline: string; root: string; fee: string; distributor: string;
  holders: { account: string; tokens: string; amount: string }[];
  frozen: { account: string; tokens: string; frozenTokens: string; amount: string; held: boolean }[];
  call: { distributor: string; args: string[] };
}
export interface Income {
  payoutId: string; assetId: string; assetName: string; symbol: string; memo: string; chainId: number;
  amount: string; decimals: number; payoutSymbol: string; tokens: string; tokenDecimals: number; snapshotTime: string; claimDeadline: string;
}
