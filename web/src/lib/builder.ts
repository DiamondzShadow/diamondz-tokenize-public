// Contract Builder (design "Contract Builder", approved 2026-11-20): the options, their legal locks, and what each
// combination deploys. Pure functions so the page, the share link and the console prefill all agree.
import { NETWORKS, STELLAR_NETWORKS, networkById, stellarById } from "./chains";
import type { StandardId } from "./catalog";
import { US, lockupLabel, suggestedRules, type Exemption, type Rules } from "./rules";

export type Route = "506c" | "cf" | "regs";
export type BuilderStd = Exclude<StandardId, "story-ip">;

export interface Build {
  name: string;
  symbol: string;
  route: Route;
  std: BuilderStd;
  chainId: number;
  lockupDays: number;
  maxHolders: number;
  resaleApproval: boolean;
  countryOn: boolean;
  maturity: string; // YYYY-MM-DD or ""
}

export const ROUTES: { id: Route; label: string; sub: string; note: string }[] = [
  { id: "506c", label: "Accredited only", sub: "Reg D 506(c)", note: "Only verified accredited investors can buy. No limit on how much you raise. Investors prove accreditation once and it is reused." },
  { id: "cf", label: "Fans and everyone (US)", sub: "Reg CF, portal checkout", note: "Anyone in the US can buy, with a yearly limit per person if they are not accredited. Up to $5M a year. A registered funding portal runs the whole sale: checkout, limits, escrow and the 48-hour cancel window. This token holds no sale; tokens are issued only after the portal closes the raise. Resale is locked for one year by law." },
  { id: "regs", label: "Outside the US", sub: "Reg S", note: "Only buyers outside the United States. US wallets are blocked on chain. Can run next to a US sale of the same offering." },
];

export const STDS: { id: BuilderStd; label: string; sub: string }[] = [
  { id: "erc3643", label: "ERC-3643", sub: "Regulated security (T-REX)" },
  { id: "erc7943", label: "ERC-7943", sub: "Permissioned ERC-20" },
  { id: "erc4626", label: "ERC-4626", sub: "Fund shares (vault)" },
  { id: "erc721", label: "ERC-721", sub: "One token per item" },
  { id: "erc1155", label: "ERC-1155", sub: "Fractions or editions" },
  { id: "stellar-rwa", label: "Stellar RWA", sub: "OpenZeppelin RWA on Soroban" },
];

export const LOCKUPS: number[] = [0, 40, 182, 365, 730];
export const HOLDER_CAPS: [number, string][] = [[0, "No limit"], [99, "99"], [500, "500"], [1_999, "1,999"], [10_000, "10,000"]];

/** Mainnets this builder targets: ERC-3643 needs the platform's T-REX core; the OpenZeppelin tokens deploy anywhere. */
export function networksFor(std: BuilderStd): { id: number; name: string }[] {
  if (std === "stellar-rwa") return STELLAR_NETWORKS.filter((n) => !n.testnet).map((n) => ({ id: n.id, name: n.name }));
  return NETWORKS.filter((n) => !n.testnet && (std !== "erc3643" || !!n.trex)).map((n) => ({ id: n.id, name: n.name }));
}
export const networkName = (id: number) => networkById(id)?.name ?? stellarById(id)?.name ?? "?";

/** What Stellar's OpenZeppelin compliance modules can enforce today (no holder cap, resale approval or maturity). */
export const STELLAR_LIMITS = { maxHolders: false, resaleApproval: false, maturity: false };

export const DEFAULT_BUILD: Build = {
  name: "Midnight Sessions Vol. 1", symbol: "MSV1", route: "cf", std: "erc3643", chainId: 42161,
  lockupDays: 365, maxHolders: 1_999, resaleApproval: true, countryOn: true, maturity: "",
};

/** The build with the law's locks and the standard's limits applied. Everything shown or deployed reads this. */
export function effective(b: Build): Build {
  const e = { ...b };
  const nets = networksFor(e.std);
  if (!nets.some((n) => n.id === e.chainId)) e.chainId = nets[0]?.id ?? e.chainId;
  if (e.route === "cf") { e.lockupDays = 365; e.resaleApproval = true; } // Reg CF: one-year resale restriction (Rule 501)
  if (e.std === "stellar-rwa") { e.maxHolders = 0; e.resaleApproval = false; e.maturity = ""; }
  return e;
}

export const locks = (b: Build) => ({
  lockup: b.route === "cf",
  resale: b.route === "cf" || b.std === "stellar-rwa",
  holders: b.std === "stellar-rwa",
  maturity: b.std === "stellar-rwa",
});

/** The console's exemption for a route. Reg CF isn't a console exemption yet: the portal partner runs the sale. */
export const exemptionFor = (r: Route): Exemption => (r === "506c" ? "506c" : r === "regs" ? "regs" : "unsure");

/** The same Rules the console wizard saves (lib/rules.ts), so a builder setup opens there unchanged. */
export function toRules(b: Build): Rules {
  const e = effective(b);
  const base = suggestedRules(undefined, exemptionFor(e.route));
  return {
    ...base,
    accreditedOnly: e.route === "506c",
    lockupDays: e.lockupDays,
    maxHolders: e.maxHolders,
    resaleApproval: e.resaleApproval,
    countryMode: e.countryOn ? (e.route === "regs" ? "block" : "allow") : "none",
    countries: e.countryOn ? [US] : [],
    maturity: e.maturity,
  };
}

// ------------------------------------------------------------------ share link (URL ?b=…)

export function encodeBuild(b: Build): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(b)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function decodeBuild(s: string | null): Build | undefined {
  if (!s) return undefined;
  try {
    const raw = JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/")))));
    const b = { ...DEFAULT_BUILD, ...raw } as Build;
    if (!ROUTES.some((r) => r.id === b.route) || !STDS.some((x) => x.id === b.std)) return undefined;
    b.name = String(b.name).slice(0, 80);
    b.symbol = String(b.symbol).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 11);
    b.lockupDays = LOCKUPS.includes(Number(b.lockupDays)) ? Number(b.lockupDays) : 0;
    b.maxHolders = HOLDER_CAPS.some(([v]) => v === Number(b.maxHolders)) ? Number(b.maxHolders) : 0;
    b.resaleApproval = !!b.resaleApproval;
    b.countryOn = !!b.countryOn;
    b.maturity = /^\d{4}-\d{2}-\d{2}$/.test(String(b.maturity)) ? String(b.maturity) : "";
    b.chainId = Number(b.chainId) || DEFAULT_BUILD.chainId;
    return b;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ plain English

export function summary(b: Build): string[] {
  const e = effective(b);
  const std = STDS.find((s) => s.id === e.std)!;
  const who = { "506c": "verified accredited investors", cf: "anyone in the US (yearly limits for non-accredited buyers)", regs: "investors outside the US" }[e.route];
  return [
    `${std.label} token “${e.name || "Untitled"}” (${e.symbol || "?"}) on ${networkName(e.chainId)}.`,
    ...(e.route === "cf" ? ["Fans buy on the partner funding portal. Tokens are issued to them only after the raise closes and the money is released."] : []),
    `${e.route === "cf" ? "Anyone in the US (yearly limits for non-accredited buyers)" : `Only ${who}`} can hold it; every wallet is checked on chain before it receives tokens.`,
    e.lockupDays ? `Each purchase is locked for ${lockupLabel(e.lockupDays).replace(/ \(.*\)$/, "")} from the day it was bought.` : "No holding period: buyers can resell (within the other rules) right away.",
    e.maxHolders ? `At most ${e.maxHolders.toLocaleString("en-US")} holders at any time.` : "No cap on the number of holders.",
    e.resaleApproval ? "Every resale needs your approval first." : "Holders can resell to any other verified investor.",
    e.countryOn ? (e.route === "regs" ? "US wallets can never receive it." : "Only US-based investors can receive it.") : "No country restriction beyond the sale route.",
    e.maturity ? `Transfers stop on ${e.maturity}; you can still redeem.` : "No maturity date.",
    `Your treasury multisig controls the token${e.route === "cf" ? "" : ", the sale"} and the rules. The platform cannot mint or move tokens.`,
  ];
}

export function builtFrom(b: Build): string[] {
  if (b.std === "stellar-rwa") return ["OpenZeppelin Stellar RWA 0.8.0", "Issuer claim issuer", "Chainlink proof of asset"];
  if (b.std === "erc3643") return ["T-REX 4.1.6", "OnchainID 2.2.1", "OfferingRulesModule", "Chainlink proof of asset"];
  return ["OpenZeppelin 5", { erc7943: "PermissionedToken", erc4626: "PermissionedVault", erc721: "PermissionedNFT", erc1155: "PermissionedMultiToken" }[b.std as "erc7943"], "OfferingRules", "Chainlink proof of asset"];
}

export function holderNote(b: Build): string {
  if (b.std === "stellar-rwa") return "Stellar's compliance modules don't cap the number of holders yet. Use an EVM network if you need a cap.";
  if (b.route === "cf") return "Reg CF buyers don't count toward the SEC's 2,000-holder limit while a registered transfer agent keeps the records and the company has under $25M in assets. Set the cap to how many fans you expect, with room to spare: once it's full, new buyers are turned away on chain.";
  if (b.route === "506c") return "Above 2,000 holders (or 500 non-accredited) a company with over $10M in assets must register with the SEC. 1,999 keeps you under it.";
  return "Limits how many wallets can hold the token at once.";
}

export const CF_STEPS: [string, string][] = [
  ["Fan invests on the partner portal", "Portal: identity check, yearly limit, card or bank payment. Money goes to a third-party escrow, not to you or us."],
  ["48-hour window to cancel", "Portal: fans can back out until 48 hours before the close."],
  ["Raise closes", "Portal: releases the money to the company and sends us the confirmed investor list."],
  ["Fan links a wallet", "Fan signs once with their wallet. Your verification claim, based on the portal's identity check, is attached to it on chain."],
  ["Tokens are issued", "Your treasury multisig issues each fan's tokens, locked for one year."],
];

export function gates(b: Build): string[] {
  return [
    "Lawyer-signed letter for this offering (uploaded on your dashboard).",
    b.route === "cf" ? "Funding-portal listing approved and Form C filed (the portal handles both)." : b.route === "506c" ? "Form D filed within 15 days of the first sale." : "Reg S offering terms reviewed by your lawyer.",
    ...(b.route === "cf" ? ["Registered transfer agent appointed (keeps the official holder list the tokens mirror)."] : []),
    "Treasury multisig set in Payments, and the offering fee paid.",
  ];
}

// ------------------------------------------------------------------ code

const days = (d: number) => `${d * 86_400}`;
const date = (d: string) => (d ? `${Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000)} /* ${d} */` : "0");

export function code(b: Build): { fileName: string; text: string } {
  const e = effective(b);
  const net = networkName(e.chainId);
  const r = toRules(e);
  const cf = e.route === "cf";
  if (e.std === "stellar-rwa") {
    // Lockups are counted in ledgers on Stellar (about 5 seconds each).
    const ledgers = Math.round((e.lockupDays * 86_400) / 5);
    return {
      fileName: "deploy.stellar.sh",
      text: [
        `# What Diamondz Tokenize deploys on ${net}: OpenZeppelin Stellar RWA 0.8.0.`,
        "stellar contract deploy --wasm rwa_token.wasm --network mainnet -- \\",
        `  --name "${e.name}" --symbol ${e.symbol} --decimals 7 \\`,
        "  --admin $TREASURY_MULTISIG --operator $ISSUER_WALLET",
        "",
        "# Compliance modules bound to the token",
        ...(e.countryOn ? [e.route === "regs"
          ? "compliance_country_restrict  add_country_restriction --country 840"
          : "compliance_country_allow     add_allowed_country --country 840"] : []),
        ...(e.lockupDays ? [`compliance_initial_lockup_period  set_lockup_period --period ${ledgers}   # ${lockupLabel(e.lockupDays)}`] : []),
        "",
        "# Investor claims are signed by the issuer's own wallet",
        "claim_issuer  allow_eth_key --public-key $ISSUER_CLAIM_SIGNER --registry $CLAIM_TOPICS_AND_ISSUERS --claim-topic 1",
        ...(cf ? ["", "# No sale contract: the funding portal runs checkout and escrow.",
          "# After the close, the treasury multisig mints to each confirmed investor:",
          "token  mint --to <investor> --amount <amount>   # once per row of the portal's closing list"] : []),
      ].join("\n"),
    };
  }
  if (e.std === "erc3643") {
    const calls = [
      r.lockupDays ? `scheduleLockup(${days(r.lockupDays)})` : "",
      r.maxHolders ? `setMaxHolders(${r.maxHolders})` : "",
      r.resaleApproval ? "setResaleApproval(true)" : "",
      r.maturity ? `setMaturity(${date(r.maturity)})` : "",
      r.countryMode !== "none" ? `setCountries(${r.countryMode === "allow" ? 1 : 2} /* ${r.countryMode} */, [840])` : "",
    ].filter(Boolean);
    const topics = r.accreditedOnly ? "[KYC, ACCREDITED]" : "[KYC]";
    return {
      fileName: "OfferingSuite.sol",
      text: [
        "// What Diamondz Tokenize deploys through its TREXFactory (T-REX 4.1.6).",
        `// Rules live in the shared OfferingRulesModule on ${net}; each setting is one module call.`,
        `TREXFactory.deployTREXSuite("${e.symbol.toLowerCase()}", TokenDetails({`,
        "    owner: ISSUER_WALLET,                // handed to TREASURY_MULTISIG before going live",
        `    name: "${e.name}",`,
        `    symbol: "${e.symbol}",`,
        "    decimals: 18,",
        "    irs: address(0), ONCHAINID: address(0),",
        "    irAgents: [ISSUER_WALLET, PLATFORM_REGISTRAR],",
        "    tokenAgents: [ISSUER_WALLET],",
        `    complianceModules: [${calls.map(() => "OfferingRulesModule").join(", ") || "OfferingRulesModule"}],`,
        "    complianceSettings: [",
        ...calls.map((c, i) => `        abi.encodeCall(OfferingRulesModule.${c.replace(/\(.*/, "")}, ${c.slice(c.indexOf("("))})${i < calls.length - 1 ? "," : ""}`),
        "    ]",
        "}), ClaimDetails({",
        `    claimTopics: ${topics},`,
        "    issuers: [ISSUER_CLAIM_ISSUER],",
        `    issuerClaims: [${topics}]`,
        "}));",
        "",
        ...(cf
          ? ["// No sale contract: the funding portal runs checkout and escrow.",
            "// After the close, the treasury multisig (token agent) issues the confirmed list:",
            "token.batchMint(portalClose.wallets, portalClose.amounts);"]
          : ["new PrimarySale3643({ token, payToken: USDC, treasury: TREASURY_MULTISIG, ... });"]),
      ].join("\n"),
    };
  }
  const tok = { erc7943: "PermissionedToken", erc4626: "PermissionedVault", erc721: "PermissionedNFT", erc1155: "PermissionedMultiToken" }[e.std as "erc7943"];
  const tokenCfg: Record<string, string[]> = {
    PermissionedToken: [`name: "${e.name}", symbol: "${e.symbol}", decimals: 18,`, "maxSupply: TOTAL_SUPPLY,", "admin: TREASURY_MULTISIG, registry: INVESTOR_REGISTRY,", "documentURI: DOCUMENTS_URI, rules: address(rules)"],
    PermissionedVault: ["asset: USDC,", `name: "${e.name}", symbol: "${e.symbol}",`, "admin: TREASURY_MULTISIG, registry: INVESTOR_REGISTRY,", "maxNavChangeBps: 2000, oracle: ASSET_ORACLE, depositCap: DEPOSIT_CAP,", "rules: address(rules)"],
    PermissionedNFT: [`name: "${e.name}", symbol: "${e.symbol}",`, "baseURI: METADATA_URI, maxSupply: ITEMS,", "admin: TREASURY_MULTISIG, registry: INVESTOR_REGISTRY,", "documentURI: DOCUMENTS_URI, rules: address(rules)"],
    PermissionedMultiToken: [`name: "${e.name}", symbol: "${e.symbol}",`, "uri: METADATA_URI,", "admin: TREASURY_MULTISIG, registry: INVESTOR_REGISTRY,", "documentURI: DOCUMENTS_URI, rules: address(rules)"],
  };
  return {
    fileName: `${tok}.sol`,
    text: [
      "// What Diamondz Tokenize deploys: OpenZeppelin 5 building blocks.",
      "OfferingRules rules = new OfferingRules(OfferingRules.Config({",
      "    admin: TREASURY_MULTISIG,",
      `    accreditedOnly: ${r.accreditedOnly},`,
      `    countryMode: CountryMode.${{ none: "None", allow: "Allow", block: "Block" }[r.countryMode]},`,
      `    countries: ${r.countries.length ? "[840]" : "[]"},`,
      `    lockup: ${days(r.lockupDays)},`,
      `    lockBurns: ${e.std === "erc4626"},`,
      `    maxHolders: ${r.maxHolders},`,
      "    maxBalance: 0,",
      `    resaleApproval: ${r.resaleApproval},`,
      `    maturity: ${date(r.maturity)}`,
      "}));",
      "",
      `${tok} token = new ${tok}(${tok}.Config({`,
      ...tokenCfg[tok]!.map((l) => `    ${l}`),
      "}));",
      ...(cf ? ["", "// No sale contract: the funding portal runs checkout and escrow.", "// After the close, the treasury multisig issues each confirmed investor's tokens."] : []),
    ].join("\n"),
  };
}
