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

/** Every ISO 3166-1 country (249, from the iso-codes dataset), United States first, then A–Z. */
export const COUNTRIES: [number, string][] = [
  [840, "United States"], [4, "Afghanistan"], [8, "Albania"], [12, "Algeria"], [16, "American Samoa"],
  [20, "Andorra"], [24, "Angola"], [660, "Anguilla"], [10, "Antarctica"], [28, "Antigua and Barbuda"],
  [32, "Argentina"], [51, "Armenia"], [533, "Aruba"], [36, "Australia"], [40, "Austria"], [31, "Azerbaijan"],
  [44, "Bahamas"], [48, "Bahrain"], [50, "Bangladesh"], [52, "Barbados"], [112, "Belarus"], [56, "Belgium"],
  [84, "Belize"], [204, "Benin"], [60, "Bermuda"], [64, "Bhutan"], [68, "Bolivia"],
  [535, "Bonaire, Sint Eustatius and Saba"], [70, "Bosnia and Herzegovina"], [72, "Botswana"], [74, "Bouvet Island"],
  [76, "Brazil"], [86, "British Indian Ocean Territory"], [92, "British Virgin Islands"], [96, "Brunei Darussalam"],
  [100, "Bulgaria"], [854, "Burkina Faso"], [108, "Burundi"], [132, "Cabo Verde"], [116, "Cambodia"],
  [120, "Cameroon"], [124, "Canada"], [136, "Cayman Islands"], [140, "Central African Republic"], [148, "Chad"],
  [152, "Chile"], [156, "China"], [162, "Christmas Island"], [166, "Cocos (Keeling) Islands"], [170, "Colombia"],
  [174, "Comoros"], [180, "Congo (DRC)"], [178, "Congo (Republic)"], [184, "Cook Islands"], [188, "Costa Rica"],
  [191, "Croatia"], [192, "Cuba"], [531, "Curaçao"], [196, "Cyprus"], [203, "Czechia"], [384, "Côte d'Ivoire"],
  [208, "Denmark"], [262, "Djibouti"], [212, "Dominica"], [214, "Dominican Republic"], [218, "Ecuador"],
  [818, "Egypt"], [222, "El Salvador"], [226, "Equatorial Guinea"], [232, "Eritrea"], [233, "Estonia"],
  [748, "Eswatini"], [231, "Ethiopia"], [238, "Falkland Islands (Malvinas)"], [234, "Faroe Islands"], [242, "Fiji"],
  [246, "Finland"], [250, "France"], [254, "French Guiana"], [258, "French Polynesia"],
  [260, "French Southern Territories"], [266, "Gabon"], [270, "Gambia"], [268, "Georgia"], [276, "Germany"],
  [288, "Ghana"], [292, "Gibraltar"], [300, "Greece"], [304, "Greenland"], [308, "Grenada"], [312, "Guadeloupe"],
  [316, "Guam"], [320, "Guatemala"], [831, "Guernsey"], [324, "Guinea"], [624, "Guinea-Bissau"], [328, "Guyana"],
  [332, "Haiti"], [334, "Heard Island and McDonald Islands"], [340, "Honduras"], [344, "Hong Kong"],
  [348, "Hungary"], [352, "Iceland"], [356, "India"], [360, "Indonesia"], [364, "Iran"], [368, "Iraq"],
  [372, "Ireland"], [833, "Isle of Man"], [376, "Israel"], [380, "Italy"], [388, "Jamaica"], [392, "Japan"],
  [832, "Jersey"], [400, "Jordan"], [398, "Kazakhstan"], [404, "Kenya"], [296, "Kiribati"], [414, "Kuwait"],
  [417, "Kyrgyzstan"], [418, "Laos"], [428, "Latvia"], [422, "Lebanon"], [426, "Lesotho"], [430, "Liberia"],
  [434, "Libya"], [438, "Liechtenstein"], [440, "Lithuania"], [442, "Luxembourg"], [446, "Macao"],
  [450, "Madagascar"], [454, "Malawi"], [458, "Malaysia"], [462, "Maldives"], [466, "Mali"], [470, "Malta"],
  [584, "Marshall Islands"], [474, "Martinique"], [478, "Mauritania"], [480, "Mauritius"], [175, "Mayotte"],
  [484, "Mexico"], [583, "Micronesia"], [498, "Moldova"], [492, "Monaco"], [496, "Mongolia"], [499, "Montenegro"],
  [500, "Montserrat"], [504, "Morocco"], [508, "Mozambique"], [104, "Myanmar"], [516, "Namibia"], [520, "Nauru"],
  [524, "Nepal"], [528, "Netherlands"], [540, "New Caledonia"], [554, "New Zealand"], [558, "Nicaragua"],
  [562, "Niger"], [566, "Nigeria"], [570, "Niue"], [574, "Norfolk Island"], [408, "North Korea"],
  [807, "North Macedonia"], [580, "Northern Mariana Islands"], [578, "Norway"], [512, "Oman"], [586, "Pakistan"],
  [585, "Palau"], [275, "Palestine"], [591, "Panama"], [598, "Papua New Guinea"], [600, "Paraguay"], [604, "Peru"],
  [608, "Philippines"], [612, "Pitcairn"], [616, "Poland"], [620, "Portugal"], [630, "Puerto Rico"], [634, "Qatar"],
  [642, "Romania"], [643, "Russia"], [646, "Rwanda"], [638, "Réunion"], [652, "Saint Barthélemy"],
  [654, "Saint Helena, Ascension and Tristan da Cunha"], [659, "Saint Kitts and Nevis"], [662, "Saint Lucia"],
  [663, "Saint Martin (French part)"], [666, "Saint Pierre and Miquelon"], [670, "Saint Vincent and the Grenadines"],
  [882, "Samoa"], [674, "San Marino"], [678, "Sao Tome and Principe"], [682, "Saudi Arabia"], [686, "Senegal"],
  [688, "Serbia"], [690, "Seychelles"], [694, "Sierra Leone"], [702, "Singapore"],
  [534, "Sint Maarten (Dutch part)"], [703, "Slovakia"], [705, "Slovenia"], [90, "Solomon Islands"],
  [706, "Somalia"], [710, "South Africa"], [239, "South Georgia and the South Sandwich Islands"],
  [410, "South Korea"], [728, "South Sudan"], [724, "Spain"], [144, "Sri Lanka"], [729, "Sudan"], [740, "Suriname"],
  [744, "Svalbard and Jan Mayen"], [752, "Sweden"], [756, "Switzerland"], [760, "Syria"], [158, "Taiwan"],
  [762, "Tajikistan"], [834, "Tanzania"], [764, "Thailand"], [626, "Timor-Leste"], [768, "Togo"], [772, "Tokelau"],
  [776, "Tonga"], [780, "Trinidad and Tobago"], [788, "Tunisia"], [795, "Turkmenistan"],
  [796, "Turks and Caicos Islands"], [798, "Tuvalu"], [792, "Türkiye"], [850, "U.S. Virgin Islands"],
  [800, "Uganda"], [804, "Ukraine"], [784, "United Arab Emirates"], [826, "United Kingdom"],
  [581, "United States Minor Outlying Islands"], [858, "Uruguay"], [860, "Uzbekistan"], [548, "Vanuatu"],
  [336, "Vatican City"], [862, "Venezuela"], [704, "Vietnam"], [876, "Wallis and Futuna"], [732, "Western Sahara"],
  [887, "Yemen"], [894, "Zambia"], [716, "Zimbabwe"], [248, "Åland Islands"],
];
/** Comprehensively sanctioned (OFAC: Cuba, Iran, North Korea, Syria; Russia, Belarus) and FATF call-for-action
 *  (Myanmar). Always blocked: the site refuses visitors from them (api/src/geo.ts) and every offering's rules block them. */
export const SANCTIONED = [192, 364, 408, 760, 643, 112, 104];
export const isSanctioned = (n: number) => SANCTIONED.includes(n);
/** Countries an investor may pick (sanctioned ones removed). */
export const OPEN_COUNTRIES = COUNTRIES.filter(([c]) => !isSanctioned(c));
/** Apply the sanctions block to an offering's country rule (mirrors api/src/rules.ts withSanctions). */
export function withSanctions<R extends { countryMode: "none" | "allow" | "block"; countries: number[] }>(r: R): R {
  if (r.countryMode === "allow") return { ...r, countries: r.countries.filter((c) => !isSanctioned(c)) };
  return { ...r, countryMode: "block", countries: [...new Set([...SANCTIONED, ...(r.countryMode === "block" ? r.countries : [])])] };
}
export const countryName = (n: number) => COUNTRIES.find(([c]) => c === n)?.[1] ?? `Country ${n}`;
