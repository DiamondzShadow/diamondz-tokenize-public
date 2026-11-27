// Offering rules (wizard step 5, design W11): the draft shape, the suggested presets per asset class and exemption,
// and the conversion to the on-chain OfferingRules config. The API validates and re-checks the same conversion in
// api/src/rules.ts; keep the two in sync.
import type { Address } from "viem";
import type { AssetClassId, StandardId } from "./catalog";

export interface Rules {
  accreditedOnly: boolean;
  /** Investor approvals lapse after this many days (the registry's expiresAt); 0 = never. */
  approvalDays: number;
  countryMode: "none" | "allow" | "block";
  countries: number[];
  lockupDays: number;
  /** The holding period also blocks holder-initiated burns (fund redemptions, carbon retirement). */
  lockBurns: boolean;
  maxHolders: number;
  /** Most one wallet may hold, in % of all tokens; 0 = no limit. */
  maxHolderPct: number;
  resaleApproval: boolean;
  /** YYYY-MM-DD or "" */
  maturity: string;
  saleStartsAt: string;
  saleEndsAt: string;
}

export const NO_RULES: Rules = {
  accreditedOnly: false, approvalDays: 365, countryMode: "none", countries: [], lockupDays: 0, lockBurns: false,
  maxHolders: 0, maxHolderPct: 0, resaleApproval: false, maturity: "", saleStartsAt: "", saleEndsAt: "",
};

export type Exemption = "506c" | "regs" | "unsure";
export const US = 840;

/** Holding periods offered in the wizard (days). */
export const LOCKUP_CHOICES: [number, string][] = [
  [0, "None"], [40, "40 days (Reg S)"], [182, "6 months"], [365, "12 months (Rule 144)"], [730, "2 years"],
];
export const lockupLabel = (d: number) => LOCKUP_CHOICES.find(([v]) => v === d)?.[1] ?? (d ? `${d} days` : "None");

/** Suggested rules for an asset class and exemption (design W11 "Reset to suggested"). The issuer's lawyer confirms. */
export function suggestedRules(cls: AssetClassId | undefined, exemption: Exemption | undefined, details: Record<string, unknown> = {}): Rules {
  const r: Rules = { ...NO_RULES };
  if (exemption === "506c") {
    r.accreditedOnly = true;
    r.lockupDays = 365;
    r.countryMode = "allow";
    r.countries = [US];
  } else if (exemption === "regs") {
    r.lockupDays = 365; // Reg S equity distribution compliance period for US issuers; 40 days for debt
    r.countryMode = "block";
    r.countries = [US];
  }
  switch (cls) {
    case "real-estate":
      r.maxHolders = 1_999;
      r.maxHolderPct = 10;
      if (details.unitsAre === "llc") r.resaleApproval = false;
      break;
    case "private-equity":
      r.maxHolders = 1_999;
      r.resaleApproval = true;
      break;
    case "private-credit":
      r.maxHolders = 1_999;
      if (typeof details.maturity === "string") r.maturity = details.maturity;
      if (exemption === "regs") r.lockupDays = 40;
      break;
    case "funds":
      r.maxHolders = 99; // 3(c)(1) funds; 3(c)(7) funds can go to 1,999 (counsel decides)
      r.lockBurns = true;
      r.lockupDays = Number(details.redemptionLockDays ?? 90) || 0;
      break;
    case "carbon":
      // Carbon credits are usually commodities, not securities: no holder caps by default.
      r.accreditedOnly = false;
      r.lockupDays = 0;
      r.countryMode = "none";
      r.countries = [];
      r.lockBurns = details.retireAfterLockup === true;
      break;
    case "film":
    case "music-ip":
      r.maxHolders = 1_999;
      break;
    case "sports":
      r.maxHolders = 1_999;
      r.resaleApproval = true;
      break;
    case "collectibles":
      r.maxHolders = 1_999;
      break;
    default:
      break;
  }
  return r;
}

export const hasRules = (r: Rules | undefined) => !!r && (
  r.accreditedOnly || r.countryMode !== "none" || r.lockupDays > 0 || r.maxHolders > 0 || r.maxHolderPct > 0 ||
  r.resaleApproval || !!r.maturity
);

const ts = (d: string) => (d ? BigInt(Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000)) : 0n);
export const saleWindow = (r: Rules | undefined) => ({ startsAt: ts(r?.saleStartsAt ?? ""), endsAt: ts(r?.saleEndsAt ?? "") });
export const unitScale = (standard: StandardId) => (standard === "erc7943" || standard === "erc3643" ? 10n ** 18n : 1n);
const COUNTRY_MODE = { none: 0, allow: 1, block: 2 } as const;

/** OfferingRules constructor argument (same as api/src/rules.ts rulesConfig). */
export function rulesConfig(r: Rules, asset: { standard: StandardId; totalSupply: string }, admin: Address) {
  const supply = BigInt(asset.totalSupply || "0");
  const maxBalance = r.maxHolderPct > 0 && asset.standard !== "erc4626"
    ? (supply * unitScale(asset.standard) * BigInt(Math.round(r.maxHolderPct * 100))) / 10_000n
    : 0n;
  return {
    admin,
    accreditedOnly: r.accreditedOnly,
    countryMode: COUNTRY_MODE[r.countryMode],
    countries: r.countryMode === "none" ? [] : r.countries,
    lockup: BigInt(r.lockupDays) * 86_400n,
    lockBurns: r.lockBurns,
    maxHolders: r.maxHolders,
    maxBalance,
    resaleApproval: r.resaleApproval,
    maturity: ts(r.maturity),
  };
}

// ------------------------------------------------------------------ documents

export interface DocFingerprint { kind: string; name: string; sha256: string; size?: number; addedAt?: string }

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** sha256 of a file, computed in the browser. The file never leaves the issuer's computer. */
export async function fingerprint(file: File): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
}

/** One hash for the whole document set (order-independent), recorded in the token's documentURI. */
export async function manifestHash(docs: DocFingerprint[]): Promise<string> {
  const canon = docs.map((d) => `${d.kind}:${d.sha256}`).sort().join("\n");
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canon)));
}

export async function documentURI(assetId: string, docs: DocFingerprint[]): Promise<string> {
  if (!docs.length) return "";
  return `${location.origin}/api/documents/${assetId}#sha256=${await manifestHash(docs)}`;
}

// ------------------------------------------------------------------ countries (ISO 3166-1 numeric)

export const COUNTRIES: [number, string][] = [
  [840, "United States"], [124, "Canada"], [484, "Mexico"], [76, "Brazil"], [32, "Argentina"], [152, "Chile"], [170, "Colombia"],
  [826, "United Kingdom"], [372, "Ireland"], [276, "Germany"], [250, "France"], [380, "Italy"], [724, "Spain"], [620, "Portugal"],
  [528, "Netherlands"], [56, "Belgium"], [442, "Luxembourg"], [756, "Switzerland"], [40, "Austria"], [752, "Sweden"],
  [578, "Norway"], [208, "Denmark"], [246, "Finland"], [616, "Poland"], [300, "Greece"], [792, "Türkiye"], [376, "Israel"],
  [784, "United Arab Emirates"], [682, "Saudi Arabia"], [634, "Qatar"], [48, "Bahrain"], [414, "Kuwait"], [512, "Oman"],
  [710, "South Africa"], [566, "Nigeria"], [404, "Kenya"], [818, "Egypt"], [356, "India"], [702, "Singapore"],
  [344, "Hong Kong"], [392, "Japan"], [410, "South Korea"], [158, "Taiwan"], [764, "Thailand"], [458, "Malaysia"],
  [360, "Indonesia"], [608, "Philippines"], [704, "Vietnam"], [36, "Australia"], [554, "New Zealand"], [136, "Cayman Islands"],
  [92, "British Virgin Islands"], [44, "Bahamas"], [60, "Bermuda"], [388, "Jamaica"], [780, "Trinidad and Tobago"],
];
export const countryName = (n: number) => COUNTRIES.find(([c]) => c === n)?.[1] ?? `Country ${n}`;
