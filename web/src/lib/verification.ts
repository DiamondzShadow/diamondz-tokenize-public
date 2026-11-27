// Proof-of-asset checklist: which independent checks each asset class needs, who is qualified to sign them, and how
// long a signed check stays valid. Single source of truth for the AssetOracle config script, the API and the UI.
// On chain, a kind is keccak256(kind id) and a class is keccak256(asset class id).
import { keccak256, toHex, type Hex } from "viem";
import type { AssetClassId } from "./catalog";

export type CheckKindId =
  | "TITLE" | "VALUATION" | "INSURANCE" | "RENT_INCOME"
  | "MINERAL_TITLE" | "RESERVES" | "PRODUCTION" | "ROYALTY_INCOME"
  | "CAP_TABLE" | "FINANCIALS"
  | "LOAN_TAPE" | "SERVICING"
  | "NAV" | "CUSTODY"
  | "IP_OWNERSHIP"
  | "AUTHENTICITY"
  | "REGISTRY";

export interface CheckKind {
  id: CheckKindId;
  name: string;
  /** What the verifier confirms, in plain words. */
  confirms: string;
  /** Who can sign it (examples; the platform vets each verifier before adding them). */
  verifiers: string;
  /** Longest one signed check stays valid. Enforced on chain. */
  maxDays: number;
  /** Unit of the optional `value` figure, if the check carries one. */
  valueUnit?: "usd-cents" | "units" | "bbl-per-day" | "tonnes";
}

const DAY = 86_400;

export const CHECK_KINDS: Record<CheckKindId, CheckKind> = {
  TITLE: { id: "TITLE", name: "Title & ownership", confirms: "The SPV holds clear title to the property, with no undisclosed liens.", verifiers: "Title insurers and title agents, or the county recorder's certified record", maxDays: 365 },
  VALUATION: { id: "VALUATION", name: "Independent valuation", confirms: "Current market value of the asset.", verifiers: "Licensed appraisers (MAI / RICS), valuation firms", maxDays: 365, valueUnit: "usd-cents" },
  INSURANCE: { id: "INSURANCE", name: "Insurance in force", confirms: "The asset is insured and the policy is current.", verifiers: "The insurer or broker of record", maxDays: 365, valueUnit: "usd-cents" },
  RENT_INCOME: { id: "RENT_INCOME", name: "Rent received", confirms: "Rent collected for the period, matching the bank statement.", verifiers: "Property manager, the SPV's accountant or bank", maxDays: 45, valueUnit: "usd-cents" },
  MINERAL_TITLE: { id: "MINERAL_TITLE", name: "Mineral / royalty title", confirms: "The SPV owns the mineral or royalty interest (division order / deed).", verifiers: "Title attorneys, landmen, the operator's division-order department", maxDays: 365 },
  RESERVES: { id: "RESERVES", name: "Reserve report", confirms: "Proved reserves and their value from an independent engineering report.", verifiers: "Independent petroleum engineers (e.g. Netherland Sewell, Ryder Scott)", maxDays: 365, valueUnit: "usd-cents" },
  PRODUCTION: { id: "PRODUCTION", name: "Production", confirms: "Production volume for the period, matching state regulator filings.", verifiers: "The operator, or a verifier reading the state regulator's records", maxDays: 45, valueUnit: "bbl-per-day" },
  ROYALTY_INCOME: { id: "ROYALTY_INCOME", name: "Royalty income", confirms: "Royalties paid for the period, matching statements.", verifiers: "The operator, distributor or the SPV's accountant", maxDays: 120, valueUnit: "usd-cents" },
  CAP_TABLE: { id: "CAP_TABLE", name: "Cap table", confirms: "The SPV's shareholding in the company, from the official cap table.", verifiers: "The company's transfer agent or cap-table provider (e.g. Carta), company counsel", maxDays: 120 },
  FINANCIALS: { id: "FINANCIALS", name: "Audited financials", confirms: "Latest financial statements, reviewed or audited.", verifiers: "Independent CPA / audit firm", maxDays: 400 },
  LOAN_TAPE: { id: "LOAN_TAPE", name: "Loan book", confirms: "Outstanding loan balances backing the token.", verifiers: "Loan servicer, fund administrator, or data agent (e.g. Accountable, Cardo)", maxDays: 45, valueUnit: "usd-cents" },
  SERVICING: { id: "SERVICING", name: "Payments current", confirms: "Borrowers are paying on schedule; delinquencies disclosed.", verifiers: "Loan servicer or backup servicer", maxDays: 45 },
  NAV: { id: "NAV", name: "Net asset value", confirms: "NAV per share as calculated by the fund administrator.", verifiers: "Fund administrator; can be delivered via Chainlink SmartData, RedStone or Chronicle", maxDays: 3, valueUnit: "usd-cents" },
  CUSTODY: { id: "CUSTODY", name: "In custody", confirms: "The assets are held by the custodian / vault in the SPV's name.", verifiers: "Qualified custodian, bonded warehouse or vault operator", maxDays: 120, valueUnit: "units" },
  IP_OWNERSHIP: { id: "IP_OWNERSHIP", name: "IP ownership", confirms: "The SPV owns or controls the masters / publishing / license.", verifiers: "Entertainment counsel, the label or publisher", maxDays: 365 },
  AUTHENTICITY: { id: "AUTHENTICITY", name: "Authenticity", confirms: "The item is genuine and matches its description.", verifiers: "Grading and authentication services, recognized experts", maxDays: 1825 },
  REGISTRY: { id: "REGISTRY", name: "Registry record", confirms: "The credits exist in the registry, in the SPV's account, and are not retired.", verifiers: "The registry (Verra, Gold Standard, Puro.earth) or a verifier reading its records", maxDays: 120, valueUnit: "tonnes" },
};

/** Minimum checks per asset class. Issuers can add more; they can never drop these. */
export const CLASS_CHECKS: Record<AssetClassId, CheckKindId[]> = {
  "real-estate": ["TITLE", "VALUATION", "INSURANCE"],
  energy: ["MINERAL_TITLE", "RESERVES", "PRODUCTION"],
  "private-equity": ["CAP_TABLE", "FINANCIALS"],
  "private-credit": ["LOAN_TAPE", "SERVICING"],
  funds: ["NAV", "CUSTODY"],
  "music-ip": ["IP_OWNERSHIP", "ROYALTY_INCOME"],
  film: ["IP_OWNERSHIP", "INSURANCE"],
  sports: ["INSURANCE"],
  collectibles: ["CUSTODY", "AUTHENTICITY", "INSURANCE"],
  carbon: ["REGISTRY"],
};

/** Extra checks an issuer may add per class (optional). */
export const CLASS_OPTIONAL: Partial<Record<AssetClassId, CheckKindId[]>> = {
  "real-estate": ["RENT_INCOME"],
  energy: ["ROYALTY_INCOME"],
  "private-credit": ["FINANCIALS"],
  funds: ["FINANCIALS"],
};

export const kindHash = (k: CheckKindId): Hex => keccak256(toHex(k));
export const classHash = (c: AssetClassId): Hex => keccak256(toHex(c));
export const kindByHash = (h: string) => (Object.keys(CHECK_KINDS) as CheckKindId[]).find((k) => kindHash(k) === h.toLowerCase());
export const maxValiditySeconds = (k: CheckKindId) => CHECK_KINDS[k].maxDays * DAY;

export const AttestResult = { None: 0, Pass: 1, Fail: 2 } as const;
export type AttestResult = (typeof AttestResult)[keyof typeof AttestResult];

/** Live market feeds per asset class, written by the Chainlink CRE workflow (cre/asset-feeds) to CreAssetFeed. */
export const CLASS_FEEDS: Record<AssetClassId, { metric: string; label: string; unit: "usd" | "bps" | "index" | "tokens" }[]> = {
  "real-estate": [
    { metric: "HPI_ADJUSTED_VALUE_USD", label: "Value adjusted by house price index", unit: "usd" },
    { metric: "REIT_INDEX_VNQ_USD", label: "REIT index (VNQ)", unit: "usd" },
    { metric: "US_PCE_PRICE_INDEX", label: "US inflation (PCE index, Chainlink)", unit: "index" },
  ],
  energy: [
    { metric: "WTI_USD", label: "WTI crude (Chainlink)", unit: "usd" },
    { metric: "EST_MONTHLY_ROYALTY_USD", label: "Estimated monthly royalty", unit: "usd" },
  ],
  "private-equity": [{ metric: "PUBLIC_MARKET_SPY_USD", label: "Public market (SPY, Chainlink)", unit: "usd" }],
  "private-credit": [
    { metric: "SOFR_BPS", label: "SOFR", unit: "bps" },
    { metric: "FLOATING_RATE_BPS", label: "Current floating rate", unit: "bps" },
  ],
  funds: [{ metric: "NAV_PER_SHARE", label: "NAV per share (Chainlink NAVLink)", unit: "usd" }],
  // License income now shows on the asset's IP page (IP registry), not a Story royalty vault.
  "music-ip": [],
  film: [],
  sports: [],
  collectibles: [
    { metric: "XAU_USD", label: "Gold (Chainlink)", unit: "usd" },
    { metric: "XAG_USD", label: "Silver (Chainlink)", unit: "usd" },
    { metric: "METAL_HOLDING_VALUE_USD", label: "Metal holding value", unit: "usd" },
  ],
  carbon: [{ metric: "CARBON_CREDITS_HELD", label: "Credits held on chain", unit: "tokens" }],
};
export const metricHash = (m: string): Hex => keccak256(toHex(m));
