// Per-offering rules (wizard step 5, design W11) and per-asset answers (step 2, designs W7–W10), as stored on the
// draft, converted to the on-chain OfferingRules config, and read back from chain when a deployment is checked.
// The web app has the same conversion in web/src/lib/rules.ts; keep the two in sync.
import { z } from "zod";
import { encodeFunctionData, type Address, type PublicClient } from "viem";

export const DAY = 86_400n;

/** ISO 3166-1 numeric codes, as stored in the investor registries. */
const Country = z.number().int().min(1).max(999);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date as YYYY-MM-DD");

export const Rules = z.object({
  accreditedOnly: z.boolean().default(false),
  /** Investor approvals lapse after this many days (registry expiresAt); 0 = never. */
  approvalDays: z.number().int().min(0).max(3650).default(365),
  countryMode: z.enum(["none", "allow", "block"]).default("none"),
  countries: z.array(Country).max(60).default([]),
  lockupDays: z.number().int().min(0).max(3650).default(0),
  /** Holding period also blocks holder-initiated burns (fund redemptions, carbon retirement). */
  lockBurns: z.boolean().default(false),
  maxHolders: z.number().int().min(0).max(1_000_000).default(0),
  /** Most one wallet may hold, in % of all tokens; 0 = no limit. */
  maxHolderPct: z.number().min(0).max(100).default(0),
  resaleApproval: z.boolean().default(false),
  maturity: z.union([z.literal(""), IsoDate]).default(""),
  saleStartsAt: z.union([z.literal(""), IsoDate]).default(""),
  saleEndsAt: z.union([z.literal(""), IsoDate]).default(""),
}).refine((r) => r.countryMode === "none" || r.countries.length > 0, { message: "pick at least one country", path: ["countries"] })
  .refine((r) => !r.saleStartsAt || !r.saleEndsAt || r.saleStartsAt < r.saleEndsAt, { message: "the sale must close after it opens", path: ["saleEndsAt"] });
export type Rules = z.infer<typeof Rules>;

/** Comprehensively sanctioned (OFAC: Cuba, Iran, North Korea, Syria; Russia, Belarus) and FATF call-for-action
 *  (Myanmar), ISO 3166-1 numeric. Every offering's rules block them (mirrors web/src/lib/rules.ts). */
export const SANCTIONED = [192, 364, 408, 760, 643, 112, 104];
export function withSanctions(r: Rules): Rules {
  if (r.countryMode === "allow") {
    const countries = r.countries.filter((c) => !SANCTIONED.includes(c));
    return countries.length ? { ...r, countries } : { ...r, countryMode: "block", countries: SANCTIONED };
  }
  return { ...r, countryMode: "block", countries: [...new Set([...SANCTIONED, ...(r.countryMode === "block" ? r.countries : [])])] };
}

/** Step-2 answers. Keys are short ids per asset class (web/src/lib/questions.ts); values are short text, numbers or
 *  yes/no. Never personal data: these show on the listing. */
export const Details = z.record(
  z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,39}$/),
  z.union([z.string().max(500), z.number().finite(), z.boolean()]),
).refine((d) => Object.keys(d).length <= 60, "too many answers");

/** Document fingerprints (sha256 of the file, computed in the issuer's browser; the file itself never leaves it). */
export const Documents = z.array(z.object({
  kind: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,39}$/),
  name: z.string().trim().min(1).max(120),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().min(0).max(10_000_000_000).optional(),
  addedAt: z.string().max(40).optional(),
})).max(20);

const ts = (d: string) => (d ? BigInt(Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000)) : 0n);
export const saleWindow = (r: Rules) => ({ startsAt: ts(r.saleStartsAt), endsAt: ts(r.saleEndsAt) });

/** 18-decimal ERC-20/3643 offerings count in wei-like units; NFTs and 1155 fractions count whole units. */
export function unitScale(standard: string) {
  return standard === "erc7943" || standard === "erc3643" ? 10n ** 18n : 1n;
}

const COUNTRY_MODE = { none: 0, allow: 1, block: 2 } as const;

/** Constructor argument of OfferingRules.sol. Vaults never get a per-wallet cap (share price moves). */
export function rulesConfig(r: Rules, asset: { standard: string; totalSupply: string }, admin: Address) {
  const supply = BigInt(asset.totalSupply || "0");
  const maxBalance = r.maxHolderPct > 0 && asset.standard !== "erc4626"
    ? (supply * unitScale(asset.standard) * BigInt(Math.round(r.maxHolderPct * 100))) / 10_000n
    : 0n;
  return {
    admin,
    accreditedOnly: r.accreditedOnly,
    countryMode: COUNTRY_MODE[r.countryMode],
    countries: r.countryMode === "none" ? [] : r.countries,
    lockup: BigInt(r.lockupDays) * DAY,
    lockBurns: r.lockBurns,
    maxHolders: r.maxHolders,
    maxBalance,
    resaleApproval: r.resaleApproval,
    maturity: ts(r.maturity),
  };
}

/** True when the draft asks for any rule beyond "verified investors only". */
export const hasRules = (r: Rules | undefined) => !!r && (
  r.accreditedOnly || r.countryMode !== "none" || r.lockupDays > 0 || r.maxHolders > 0 || r.maxHolderPct > 0 ||
  r.resaleApproval || !!r.maturity
);

export const rulesAbi = [
  ...["accreditedOnly", "lockBurns", "resaleApproval"].map((name) => ({ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] }) as const),
  ...["lockup", "maturity"].map((name) => ({ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] }) as const),
  { type: "function", name: "maxHolders", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  { type: "function", name: "maxBalance", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "countryMode", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "countries", stateMutability: "view", inputs: [], outputs: [{ type: "uint16[]" }] },
  { type: "function", name: "token", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "holderCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  { type: "function", name: "rules", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

/** Reads a deployed OfferingRules back and lists every setting that differs from the draft. */
export async function verifyRules(client: PublicClient, token: Address, asset: any, admin: Address | null): Promise<string[]> {
  const want = Rules.parse(asset.rules ?? {});
  const rulesAddr = (await client.readContract({ address: token, abi: rulesAbi, functionName: "rules" }).catch(() => null)) as Address | null;
  if (!rulesAddr) return ["token has no offering-rules hook (deploy with the current contracts)"];
  const zero = /^0x0{40}$/i.test(rulesAddr);
  if (!hasRules(want)) return zero ? [] : verifyAgainst(client, rulesAddr, token, want, asset, admin);
  if (zero) return ["the draft has rules but the token was deployed without them"];
  return verifyAgainst(client, rulesAddr, token, want, asset, admin);
}

async function verifyAgainst(client: PublicClient, rules: Address, token: Address, want: Rules, asset: any, admin: Address | null) {
  const errs: string[] = [];
  const r = <T,>(fn: string) => client.readContract({ address: rules, abi: rulesAbi, functionName: fn as any }) as Promise<T>;
  const exp = rulesConfig(want, asset, admin ?? "0x0000000000000000000000000000000000000000");
  const [bound, acc, lockBurns, resale, lockup, maturity, maxHolders, maxBalance, mode, countries] = await Promise.all([
    r<Address>("token"), r<boolean>("accreditedOnly"), r<boolean>("lockBurns"), r<boolean>("resaleApproval"), r<bigint>("lockup"),
    r<bigint>("maturity"), r<number>("maxHolders"), r<bigint>("maxBalance"), r<number>("countryMode"), r<number[]>("countries"),
  ]);
  if (bound.toLowerCase() !== token.toLowerCase()) errs.push("offering rules aren't bound to this token");
  if (acc !== exp.accreditedOnly) errs.push("accredited-only rule doesn't match the draft");
  if (lockBurns !== exp.lockBurns) errs.push("redemption lock doesn't match the draft");
  if (resale !== exp.resaleApproval) errs.push("resale approval rule doesn't match the draft");
  if (lockup !== exp.lockup) errs.push("holding period doesn't match the draft");
  if (maturity !== exp.maturity) errs.push("maturity date doesn't match the draft");
  if (Number(maxHolders) !== exp.maxHolders) errs.push("holder limit doesn't match the draft");
  if (maxBalance !== exp.maxBalance) errs.push("per-investor limit doesn't match the draft");
  if (Number(mode) !== exp.countryMode) errs.push("country rule doesn't match the draft");
  const a = [...countries].map(Number).sort(), b = [...exp.countries].sort();
  if (JSON.stringify(a) !== JSON.stringify(b)) errs.push("country list doesn't match the draft");
  return errs;
}

// ------------------------------------------------------------------ ERC-3643 module settings (callModuleFunction)
const moduleAbi = [
  { type: "function", name: "scheduleLockup", stateMutability: "nonpayable", inputs: [{ type: "uint64" }], outputs: [] },
  { type: "function", name: "setMaxHolders", stateMutability: "nonpayable", inputs: [{ type: "uint32" }], outputs: [] },
  { type: "function", name: "setMaxBalance", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "setResaleApproval", stateMutability: "nonpayable", inputs: [{ type: "bool" }], outputs: [] },
  { type: "function", name: "setMaturity", stateMutability: "nonpayable", inputs: [{ type: "uint64" }], outputs: [] },
  { type: "function", name: "setCountries", stateMutability: "nonpayable", inputs: [{ type: "uint8" }, { type: "uint16[]" }], outputs: [] },
] as const;

/** The setting calls the T-REX factory makes on OfferingRulesModule while deploying the suite (one per rule that is
 *  on). Accreditation is not here: on ERC-3643 it's a required claim topic. */
export function moduleSettings(r: Rules, asset: { standard: string; totalSupply: string }) {
  const c = rulesConfig(r, asset, "0x0000000000000000000000000000000000000000");
  const calls: `0x${string}`[] = [];
  if (c.lockup > 0n) calls.push(encodeFunctionData({ abi: moduleAbi, functionName: "scheduleLockup", args: [c.lockup] }));
  if (c.maxHolders > 0) calls.push(encodeFunctionData({ abi: moduleAbi, functionName: "setMaxHolders", args: [c.maxHolders] }));
  if (c.maxBalance > 0n) calls.push(encodeFunctionData({ abi: moduleAbi, functionName: "setMaxBalance", args: [c.maxBalance] }));
  if (c.resaleApproval) calls.push(encodeFunctionData({ abi: moduleAbi, functionName: "setResaleApproval", args: [true] }));
  if (c.maturity > 0n) calls.push(encodeFunctionData({ abi: moduleAbi, functionName: "setMaturity", args: [c.maturity] }));
  if (c.countryMode !== 0) calls.push(encodeFunctionData({ abi: moduleAbi, functionName: "setCountries", args: [c.countryMode, c.countries] }));
  return calls;
}

const moduleViewAbi = [{
  type: "function", name: "settings", stateMutability: "view", inputs: [{ type: "address" }],
  outputs: [{ type: "tuple", components: [
    { name: "lockup", type: "uint64" }, { name: "pendingLockup", type: "uint64" }, { name: "pendingLockupAt", type: "uint64" },
    { name: "maturity", type: "uint64" }, { name: "maxHolders", type: "uint32" }, { name: "holderCount", type: "uint32" },
    { name: "countryMode", type: "uint8" }, { name: "resaleApproval", type: "bool" }, { name: "maxBalance", type: "uint256" },
  ] }],
}, {
  type: "function", name: "countries", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint16[]" }],
}] as const;

/** ERC-3643: reads OfferingRulesModule's settings for this offering's compliance and compares them with the draft. */
export async function verifyModule(client: PublicClient, module: Address, compliance: Address, asset: any): Promise<string[]> {
  const want = rulesConfig(Rules.parse(asset.rules ?? {}), asset, "0x0000000000000000000000000000000000000000");
  const [s, countries] = await Promise.all([
    client.readContract({ address: module, abi: moduleViewAbi, functionName: "settings", args: [compliance] }),
    client.readContract({ address: module, abi: moduleViewAbi, functionName: "countries", args: [compliance] }),
  ]);
  const errs: string[] = [];
  if (s.lockup !== want.lockup) errs.push("holding period doesn't match the draft");
  if (s.maturity !== want.maturity) errs.push("maturity date doesn't match the draft");
  if (Number(s.maxHolders) !== want.maxHolders) errs.push("holder limit doesn't match the draft");
  if (s.maxBalance !== want.maxBalance) errs.push("per-investor limit doesn't match the draft");
  if (s.resaleApproval !== want.resaleApproval) errs.push("resale approval rule doesn't match the draft");
  if (Number(s.countryMode) !== want.countryMode) errs.push("country rule doesn't match the draft");
  const a = [...countries].map(Number).sort(), b = [...want.countries].sort();
  if (JSON.stringify(a) !== JSON.stringify(b)) errs.push("country list doesn't match the draft");
  return errs;
}
