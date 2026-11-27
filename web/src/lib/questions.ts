// Wizard step 2 "About your …" (designs W7–W10, approved 2026-11-19): the questions that change with the asset class.
// Pure data, rendered by app/NewIssuance.tsx. Answers are stored on the draft as `details` (short strings, numbers,
// yes/no; never personal data, they appear on the listing). Tags say where an answer goes:
//   listing  shown to investors        onchain  written into the contract at deploy
//   rule     pre-sets a rule in step 5 document fingerprint (sha256) recorded on chain; the file stays with the issuer
import type { AssetClassId } from "./catalog";

export type Tag = "listing" | "onchain" | "rule" | "document";
export type FieldType = "text" | "number" | "money" | "percent" | "date" | "select" | "chips" | "yesno";

export interface Field {
  id: string;
  label: string;
  type: FieldType;
  options?: [string, string][]; // [value, label]
  placeholder?: string;
  hint?: string;
  what?: string; // one-sentence "What's this?"
  tag?: Tag; // a field-level tag shown next to the label (sections carry their own)
}
export interface Section {
  title: string;
  tag: Tag;
  intro?: string;
  fields: Field[];
  /** Computed figures shown under the section, from the answers. Return [] to hide. */
  calc?: (d: Details) => [string, string][];
}
export interface DocSlot { kind: string; label: string; hint: string }
export interface ClassQuestions {
  title: string; // "About your property"
  noun: string; // used in step chips: "About your property"
  intro: string;
  sections: Section[];
  documents: DocSlot[];
  help: { title: string; body: string | string[] }[];
  askLawyer: string;
}
export type Details = Record<string, string | number | boolean>;

const num = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const usd = (n: number) => `$${Math.round(n).toLocaleString()}`;
const pct = (n: number) => `${(Math.round(n * 10) / 10).toLocaleString()}%`;

export const QUESTIONS: Record<AssetClassId, ClassQuestions> = {
  "real-estate": {
    title: "About your property", noun: "property",
    intro: "These answers fill in your listing, set up your rent payouts and pre-set the rules in step 5. Skip anything you don't have yet.",
    sections: [
      {
        title: "The building", tag: "listing",
        fields: [
          { id: "address", label: "Property address", type: "text", placeholder: "Street, city, state", hint: "Investors see the city and neighborhood on the listing." },
          { id: "propertyType", label: "Property type", type: "chips", options: [["multifamily", "Apartments (5+ units)"], ["single", "Single-family homes"], ["office", "Office or retail"], ["industrial", "Industrial"], ["land", "Land"], ["mixed", "Mixed use"]] },
          { id: "units", label: "Units", type: "number", placeholder: "e.g. 12" },
          { id: "occupancy", label: "Occupancy today", type: "percent", placeholder: "e.g. 92" },
        ],
      },
      {
        title: "Value and debt", tag: "listing",
        fields: [
          { id: "appraisedValue", label: "Appraised value (USD)", type: "money", what: "What an independent appraiser says the property is worth." },
          { id: "appraisalDate", label: "Appraisal date", type: "date", hint: "Older than 12 months? Investors see a \"stale appraisal\" note." },
          { id: "mortgage", label: "Mortgage balance (USD)", type: "money", placeholder: "0 if none" },
          { id: "noi", label: "Yearly net operating income (USD)", type: "money", what: "Rent minus operating costs, before mortgage payments." },
        ],
        calc: (d) => {
          const v = num(d.appraisedValue), m = num(d.mortgage), noi = num(d.noi);
          if (!v) return [];
          return [["Loan-to-value", pct((m / v) * 100)], ["Cap rate", noi ? pct((noi / v) * 100) : "—"], ["Equity", usd(v - m)]];
        },
      },
      {
        title: "Who owns it", tag: "onchain",
        fields: [
          { id: "owner", label: "Owning company (SPV or LLC)", type: "text", what: "The company that holds the title. Investors own a share of this company, not the building directly." },
          { id: "ownerState", label: "State of formation", type: "text", placeholder: "e.g. Delaware" },
          { id: "unitsAre", label: "What each token represents", type: "chips", tag: "rule", options: [["llc", "LLC membership units"], ["preferred", "Preferred equity"], ["rent", "Share of rent only (no ownership)"]], hint: "Membership units pre-set a 1,999-holder limit in step 5. Your operating agreement decides; your lawyer confirms." },
        ],
      },
    ],
    documents: [
      { kind: "title", label: "Title report", hint: "Shows the owning company holds clean title." },
      { kind: "appraisal", label: "Appraisal", hint: "The independent valuation." },
      { kind: "rentRoll", label: "Rent roll", hint: "Current tenants and rents." },
      { kind: "operatingAgreement", label: "Operating agreement", hint: "From your lawyer." },
    ],
    help: [
      { title: "Why these questions?", body: "Every asset is different. A building has an address, a mortgage and tenants; a loan has a rate and a maturity date. We ask only what matters for yours." },
      { title: "Have these ready", body: ["Latest appraisal", "Title report", "Rent roll", "Operating agreement of the LLC"] },
    ],
    askLawyer: "Do the tokens represent LLC units directly, or a share of rent? It changes which rules step 5 turns on.",
  },

  energy: {
    title: "About your energy asset", noun: "energy asset",
    intro: "Royalty and working interests pay from production. These answers fill your listing and the reserve facts investors look for.",
    sections: [
      {
        title: "The interest", tag: "listing",
        fields: [
          { id: "interestType", label: "What you're selling a share of", type: "chips", options: [["royalty", "Royalty interest"], ["overriding", "Overriding royalty"], ["working", "Working interest"], ["minerals", "Mineral rights"], ["commodity", "Stored commodity"]], what: "A royalty gets paid from production without paying operating costs; a working interest pays its share of costs too." },
          { id: "basin", label: "Basin and state", type: "text", placeholder: "e.g. Permian Basin, TX" },
          { id: "wells", label: "Wells or leases", type: "number", placeholder: "e.g. 3" },
          { id: "operator", label: "Operator", type: "text", placeholder: "The company running the wells" },
          { id: "nri", label: "Net revenue interest offered", type: "percent", what: "The share of production revenue that comes to token holders, after the landowner's royalty." },
        ],
      },
      {
        title: "Reserves and production", tag: "listing",
        fields: [
          { id: "pv10", label: "Reserve value (PV-10, USD)", type: "money", what: "Engineers' value of future production, discounted at 10% a year. The standard way to value oil and gas reserves." },
          { id: "reserveDate", label: "Reserve report date", type: "date" },
          { id: "engineer", label: "Reserve engineer", type: "text", placeholder: "Independent firm" },
          { id: "monthlyRevenue", label: "Average monthly revenue, last 12 months (USD)", type: "money" },
          { id: "payoutFrequency", label: "How often holders are paid", type: "chips", options: [["monthly", "Monthly"], ["quarterly", "Quarterly"]], tag: "onchain", what: "Operators pay royalty owners monthly; you pass the holders' share on from Payouts on this schedule." },
        ],
        calc: (d) => {
          const m = num(d.monthlyRevenue), n = num(d.nri);
          return m && n ? [["Holders' share per year, at today's production", usd(m * 12 * (n / 100))]] : [];
        },
      },
    ],
    documents: [
      { kind: "reserveReport", label: "Reserve report", hint: "From an independent petroleum engineer." },
      { kind: "divisionOrder", label: "Division orders or lease", hint: "Proves the interest." },
      { kind: "production", label: "Production history", hint: "State or operator statements." },
    ],
    help: [
      { title: "In plain English", body: "Investors buy a share of what the wells produce. Production goes down over time, so the reserve report matters more than today's revenue." },
      { title: "Have these ready", body: ["Reserve report", "Division orders", "12 months of production statements"] },
    ],
    askLawyer: "Is a royalty interest a security in your offering, and do any state oil-and-gas rules apply?",
  },

  "private-equity": {
    title: "About your company", noun: "company",
    intro: "Investors buy shares in a company or a deal SPV. These answers fill your listing and pre-set resale approval in step 5.",
    sections: [
      {
        title: "The company", tag: "listing",
        fields: [
          { id: "company", label: "Company name", type: "text" },
          { id: "industry", label: "Industry", type: "text" },
          { id: "stage", label: "Stage", type: "chips", options: [["early", "Early stage"], ["growth", "Growth"], ["profitable", "Profitable"], ["spv", "Single-deal SPV"]] },
          { id: "revenue", label: "Revenue, last 12 months (USD)", type: "money" },
        ],
      },
      {
        title: "The shares", tag: "onchain",
        fields: [
          { id: "shareClass", label: "Share class", type: "chips", options: [["common", "Common"], ["preferred", "Preferred"], ["safe", "SAFE or note converting later"], ["llc", "LLC units"]] },
          { id: "valuation", label: "Pre-money valuation (USD)", type: "money", what: "What the company is worth before this raise." },
          { id: "capTablePct", label: "Share of the company this offering represents", type: "percent" },
          { id: "rofr", label: "Company has a right of first refusal on resales", type: "yesno", tag: "rule", what: "Before a holder sells to someone else, the company may buy at the same price. Turns on resale approval in step 5." },
          { id: "dragAlong", label: "Drag-along and tag-along rights", type: "yesno", what: "Drag-along: majority can force a sale. Tag-along: minority can join a sale on the same terms." },
        ],
        calc: (d) => {
          const v = num(d.valuation), p = num(d.capTablePct);
          return v && p ? [["Implied value of this offering", usd((v * p) / 100)]] : [];
        },
      },
    ],
    documents: [
      { kind: "charter", label: "Charter or operating agreement", hint: "Shows the share class and its rights." },
      { kind: "capTable", label: "Cap table", hint: "Who owns what today." },
      { kind: "financials", label: "Financial statements", hint: "Latest annual and quarter." },
    ],
    help: [
      { title: "In plain English", body: "Investors own a slice of the company. They usually can't sell for a while, and the company often gets first say when they do." },
      { title: "Have these ready", body: ["Charter or operating agreement", "Cap table", "Latest financials"] },
    ],
    askLawyer: "Does the token itself represent the shares, or a membership in an SPV that holds them?",
  },

  "private-credit": {
    title: "About your loan", noun: "loan",
    intro: "Your rate and dates set the payout schedule, and the maturity date becomes a rule in the token.",
    sections: [
      {
        title: "What investors are lending into", tag: "listing",
        fields: [
          { id: "structure", label: "Structure", type: "chips", options: [["single", "One loan"], ["pool", "A pool of loans"], ["invoices", "Invoices or receivables"]] },
          { id: "borrowers", label: "Borrowers", type: "text", placeholder: "e.g. 38 small businesses in TX, FL, GA" },
          { id: "principal", label: "Total principal (USD)", type: "money" },
        ],
      },
      {
        title: "Interest and dates", tag: "rule",
        fields: [
          { id: "rate", label: "Interest paid to holders (yearly)", type: "percent", what: "The yearly rate token holders earn, before platform fees." },
          { id: "payEvery", label: "Interest paid", type: "select", options: [["Monthly", "Monthly"], ["Quarterly", "Quarterly"], ["At maturity", "At maturity"]] },
          { id: "accrualStart", label: "Interest accrues from", type: "date" },
          { id: "maturity", label: "Maturity date", type: "date", what: "When principal is repaid. On this date the token stops trading, holders are repaid and the tokens are burned." },
          { id: "amortization", label: "How principal comes back", type: "chips", options: [["bullet", "All at maturity"], ["amortizing", "A little every payment"], ["asRepaid", "Whenever borrowers repay"]] },
        ],
      },
      {
        title: "Protection", tag: "listing",
        fields: [
          { id: "seniority", label: "Where holders stand if borrowers can't pay", type: "chips", options: [["senior", "Senior, secured"], ["junior", "Junior, secured"], ["unsecured", "Unsecured"]] },
          { id: "collateral", label: "Collateral", type: "text", placeholder: "e.g. equipment and receivables (UCC-1 liens)" },
          { id: "collateralValue", label: "Collateral value (USD)", type: "money" },
          { id: "lateRule", label: "If a payment is more than 30 days late", type: "chips", tag: "rule", options: [["pause", "Pause resales and tell holders"], ["notify", "Tell holders only"]], hint: "Stops new buyers paying full price for a note that's behind. You switch it back from the token page." },
        ],
        calc: (d) => {
          const p = num(d.principal), c = num(d.collateralValue);
          return p && c ? [["Collateral covers", pct((c / p) * 100)]] : [];
        },
      },
    ],
    documents: [
      { kind: "npa", label: "Note purchase agreement", hint: "The terms investors sign." },
      { kind: "loanTape", label: "Loan tape", hint: "Every loan, balance and status." },
      { kind: "servicing", label: "Servicing agreement", hint: "Who collects the payments." },
    ],
    help: [
      { title: "In plain English", body: "Investors are lending money. They get interest on a schedule and their money back on the maturity date, when the tokens are burned." },
      { title: "What the token does for you", body: ["Blocks resales after maturity", "Can pause resales when a payment is late", "Payout reminders follow your schedule"] },
    ],
    askLawyer: "Are these notes securities under Reg D, and does the rate trigger usury limits in any borrower's state?",
  },

  funds: {
    title: "About your fund", noun: "fund",
    intro: "Investors deposit stablecoins and get shares of the pool. These answers become real vault settings.",
    sections: [
      {
        title: "Strategy", tag: "listing",
        fields: [
          { id: "strategy", label: "What the fund holds", type: "text", placeholder: "e.g. US Treasury bills, 3–6 months" },
          { id: "manager", label: "Fund manager", type: "text" },
          { id: "targetYield", label: "Target yield (yearly)", type: "percent", hint: "A target, not a promise. Shown with that label." },
        ],
      },
      {
        title: "Valuation and redemptions", tag: "onchain",
        fields: [
          { id: "navSource", label: "Who reports the fund's value (NAV)", type: "chips", options: [["administrator", "Fund administrator"], ["manager", "Manager, audited yearly"], ["oracle", "Chainlink feed"]] },
          { id: "maxNavMovePct", label: "Largest NAV move allowed per report", type: "percent", placeholder: "20", what: "A safety limit written into the vault: a report that moves the value more than this is rejected, so one bad report can't reprice everyone." },
          { id: "redemptionLockDays", label: "Days before new shares can be cashed out", type: "number", tag: "rule", placeholder: "e.g. 90", what: "A lock-up on redemptions, counted from each deposit. Becomes the holding period in step 5." },
          { id: "noticeDays", label: "Redemption notice period (days)", type: "number", placeholder: "e.g. 30" },
        ],
      },
      {
        title: "Fees", tag: "listing",
        fields: [
          { id: "mgmtFee", label: "Management fee (yearly)", type: "percent", placeholder: "e.g. 1" },
          { id: "perfFee", label: "Performance fee", type: "percent", placeholder: "e.g. 10" },
        ],
      },
    ],
    documents: [
      { kind: "ppm", label: "Private placement memorandum", hint: "From your lawyer." },
      { kind: "lpa", label: "Fund agreement", hint: "LPA or operating agreement." },
      { kind: "audit", label: "Latest audit", hint: "If the fund has one." },
    ],
    help: [
      { title: "In plain English", body: "Investors deposit stablecoins and receive shares. Each share is worth a slice of everything the fund holds, including money invested off chain." },
      { title: "What the vault enforces", body: ["NAV reports can't move value more than your limit", "Shares can't be cashed out during the lock-up", "Only verified investors hold shares"] },
    ],
    askLawyer: "Is this a 3(c)(1) fund (99 investors) or 3(c)(7) (qualified purchasers)? It sets the holder limit in step 5.",
  },

  "music-ip": {
    title: "About your music", noun: "music",
    intro: "Investors buy a share of royalties. These answers fill the listing and, after you deploy, the song's official record in the IP registry on your offering's network.",
    sections: [
      {
        title: "The catalog", tag: "listing",
        fields: [
          { id: "title", label: "Title (song, album or catalog)", type: "text" },
          { id: "artist", label: "Artist", type: "text" },
          { id: "rights", label: "Rights", type: "chips", options: [["master", "Master recording"], ["publishing", "Publishing"], ["both", "Both"]], what: "The master is the recording; publishing is the song itself (lyrics and melody). They earn separately." },
          { id: "isrc", label: "ISRC or ISWC codes", type: "text", placeholder: "Comma-separated", what: "The standard IDs for recordings (ISRC) and songs (ISWC)." },
          { id: "distributor", label: "Distributor or label", type: "text" },
        ],
      },
      {
        title: "What investors get", tag: "rule",
        fields: [
          { id: "royaltyPct", label: "Share of royalties offered to holders", type: "percent" },
          { id: "last12", label: "Royalties, last 12 months (USD)", type: "money" },
        ],
        calc: (d) => {
          const r = num(d.last12), p = num(d.royaltyPct);
          return r && p ? [["Holders' share at last year's level", usd((r * p) / 100)]] : [];
        },
      },
    ],
    documents: [
      { kind: "chainOfTitle", label: "Chain of title", hint: "Copyright registrations and assignment agreements." },
      { kind: "royaltyStatements", label: "Royalty statements", hint: "Last 12 months." },
    ],
    help: [
      { title: "In plain English", body: "Investors buy a share of what the music earns from streams, sales and licensing. You send their share from Payouts." },
      { title: "Have these ready", body: ["Copyright registrations", "Distributor statements", "Any producer or feature agreements"] },
    ],
    askLawyer: "Do you own 100% of the rights you're offering, and do any producers or features have a share?",
  },

  film: {
    title: "About your film", noun: "film",
    intro: "After you deploy, your film gets an official IP record and asset NFT on the same network as your token (for example Arbitrum), with license terms others can accept. Investors buy a share of its revenue through a verified-only token.",
    sections: [
      {
        title: "The project", tag: "listing",
        fields: [
          { id: "title", label: "Title", type: "text" },
          { id: "format", label: "Format", type: "select", options: [["feature", "Feature film"], ["series", "Series (one season)"], ["documentary", "Documentary"], ["short", "Short"]] },
          { id: "stage", label: "Where it is today", type: "chips", options: [["development", "Development"], ["production", "In production"], ["post", "Post-production"], ["released", "Released"]], hint: "Before release, investors see a \"Not yet earning\" badge and your target release window." },
          { id: "budget", label: "Budget (USD)", type: "money" },
          { id: "release", label: "Target release", type: "text", placeholder: "e.g. Fall 2027" },
          { id: "distributor", label: "Distributor or platform", type: "text", placeholder: "Or \"seeking\"" },
          { id: "completionBond", label: "Completion bond", type: "yesno", what: "Insurance that the film gets finished on budget, or investors are repaid." },
        ],
      },
      {
        title: "What investors get", tag: "rule",
        fields: [
          { id: "revenueScope", label: "Which revenue is shared", type: "chips", options: [["net", "Producer's net revenue (box office, streaming, licensing)"], ["onchain", "On-chain license royalties only"], ["both", "Both"]], what: "Net revenue is what reaches the producers after distributors and exhibitors take their cut." },
          { id: "holderPct", label: "Share offered to token holders", type: "percent" },
          { id: "recoupment", label: "Recoupment", type: "select", options: [["first120", "Investors are paid first until they get 120% back"], ["first100", "Investors are paid first until they get 100% back"], ["pariPassu", "Paid alongside the producers from day one"]], what: "Who gets paid back first when money starts coming in." },
        ],
        calc: (d) => {
          const p = num(d.holderPct);
          return p ? [["If the film nets $5M, holders share", usd(5_000_000 * (p / 100))]] : [];
        },
      },
      {
        title: "IP registry and licensing", tag: "onchain",
        intro: "After deploying, you register the film in the platform's IP registry on your offering's network (for example Arbitrum or Base). The record shows who owns it, its chain of title and the license terms anyone can accept (clips, remixes, merch). License payments go straight to your company, by USDC or card.",
        fields: [
          { id: "license", label: "License terms for others", type: "chips", options: [["nonCommercial", "No commercial use"], ["commercialRemix", "Paid commercial remix"], ["commercialUse", "Commercial use, no remixing"]], what: "The kinds of license you'll offer. Your counsel writes each template; licensees accept its exact text on chain." },
          { id: "licenseFee", label: "One-time license fee (USD)", type: "money", placeholder: "e.g. 250" },
          { id: "remixShare", label: "Share of spin-off revenue paid back", type: "percent", placeholder: "e.g. 10" },
        ],
      },
    ],
    documents: [
      { kind: "copyright", label: "Script and copyright registration", hint: "Proof you own the story." },
      { kind: "rights", label: "Option or rights agreements", hint: "Underlying book, life rights, music." },
      { kind: "eo", label: "E&O insurance", hint: "Errors and omissions policy." },
      { kind: "collection", label: "Collection account agreement", hint: "Who collects revenue and pays out." },
    ],
    help: [
      { title: "In plain English", body: "Investors buy a share of what the film earns. The IP registry records the film's ownership and license terms on chain, on the same network as your token, and license payments go straight to your company. Box office and streaming money arrives the usual way; you send holders their share from Payouts." },
      { title: "How investors hold it", body: "Investors hold your verified-only token. The film's asset NFT stays with your company (your treasury on mainnet) as the official record of the rights." },
      { title: "Have these ready", body: ["Copyright registration", "Every rights or option agreement", "Budget and finance plan", "E&O insurance (before release)"] },
    ],
    askLawyer: "Is the revenue share a security (almost always yes), and does the recoupment order match your other financiers' deals?",
  },

  sports: {
    title: "About the athlete or team", noun: "athlete or team",
    intro: "Investors buy a share of named income for a set number of years. These answers fill your listing, set the payout terms and pre-set the rules in step 5.",
    sections: [
      {
        title: "Who earns the income", tag: "listing",
        fields: [
          { id: "who", label: "Athlete or team", type: "text", placeholder: "e.g. a pro boxer, a minor-league club" },
          { id: "sport", label: "Sport", type: "chips", options: [["boxing", "Boxing / MMA"], ["football", "Football"], ["basketball", "Basketball"], ["soccer", "Soccer"], ["tennis", "Tennis / golf"], ["esports", "Esports"], ["other", "Other"]] },
          { id: "kind", label: "This is", type: "chips", options: [["athlete", "One athlete"], ["team", "A team or club"]] },
          { id: "league", label: "League or tour", type: "text", placeholder: "e.g. NBA G League, PGA Tour" },
        ],
      },
      {
        title: "What investors share in", tag: "onchain",
        fields: [
          { id: "incomeTypes", label: "Which income", type: "chips", options: [["salary", "Salary"], ["prize", "Prize money / purses"], ["endorsements", "Endorsements"], ["media", "Media rights"], ["tickets", "Tickets & merch"]], what: "Only the income you pick is shared. Anything else stays with the athlete or team." },
          { id: "holderPct", label: "Share paid to holders", type: "percent", placeholder: "e.g. 10" },
          { id: "termYears", label: "For how many years", type: "number", placeholder: "e.g. 5" },
          { id: "lastYearIncome", label: "That income last year (USD)", type: "money" },
          { id: "payoutCap", label: "Stop paying once holders receive (multiple of what they paid)", type: "number", placeholder: "e.g. 3", hint: "Leave empty for no cap.", what: "A cap ends the deal early once holders have been paid this many times their money." },
          { id: "payoutFrequency", label: "How often holders are paid", type: "chips", options: [["monthly", "Monthly"], ["quarterly", "Quarterly"], ["annual", "Yearly"]] },
        ],
        calc: (d) => {
          const inc = num(d.lastYearIncome), p = num(d.holderPct), y = num(d.termYears);
          return inc && p ? [["Holders' share at last year's income", `${usd(inc * p / 100)} a year${y ? `, ${usd(inc * p / 100 * y)} over ${y} years` : ""}`]] : [];
        },
      },
      {
        title: "If things change", tag: "listing",
        fields: [
          { id: "injury", label: "If the athlete is injured or retires early", type: "chips", options: [["ends", "The deal ends; holders keep what they've received"], ["insurance", "Insurance pays holders"], ["extends", "The term extends"]], what: "Investors read this first. Say plainly what happens." },
          { id: "insured", label: "Career-ending injury insurance in place", type: "yesno" },
          { id: "transferRestrictions", label: "League or team rules limit selling income shares", type: "yesno", hint: "Some leagues restrict this. Your lawyer should confirm." },
        ],
      },
    ],
    documents: [
      { kind: "contract", label: "Playing contract or tour status", hint: "Proves the income exists." },
      { kind: "incomeHistory", label: "Income statements, last 2 years", hint: "Tax returns or club accounts." },
      { kind: "isa", label: "Income-share agreement", hint: "The signed agreement this token represents." },
      { kind: "insurance", label: "Insurance policy", hint: "If you have one." },
    ],
    help: [
      { title: "In plain English", body: "Investors pay up front; the athlete or team pays them a share of the named income for the term. If the income doesn't come, neither do the payouts." },
      { title: "Have these ready", body: ["The signed income-share agreement", "Contract or tour status", "Two years of income statements"] },
    ],
    askLawyer: "Income-share agreements are securities and some leagues, unions or states restrict them. Check the league rules and the athlete's contract before you sell.",
  },

  collectibles: {
    title: "About your item", noun: "item",
    intro: "One offering is one item, sold whole or in fractions. These answers prove what it is and where it's kept.",
    sections: [
      {
        title: "The item", tag: "listing",
        fields: [
          { id: "item", label: "What it is", type: "text", placeholder: "e.g. 1998 Speyside single-malt cask" },
          { id: "category", label: "Category", type: "chips", options: [["art", "Fine art"], ["spirits", "Wine or spirits"], ["watch", "Watch or jewelry"], ["memorabilia", "Memorabilia"], ["car", "Car"], ["other", "Other"]] },
          { id: "appraisal", label: "Appraised value (USD)", type: "money" },
          { id: "appraisalDate", label: "Appraisal date", type: "date" },
        ],
      },
      {
        title: "Custody", tag: "onchain",
        fields: [
          { id: "custodian", label: "Who keeps it", type: "text", placeholder: "Bonded warehouse, vault or gallery" },
          { id: "insured", label: "Insured for its full value", type: "yesno" },
          { id: "buyout", label: "If someone offers to buy the whole item", type: "chips", options: [["vote", "Holders vote (majority decides)"], ["issuer", "You decide and share the proceeds"], ["never", "It is never sold"]], what: "What happens when a buyer wants the whole item. Proceeds go to holders in proportion." },
        ],
      },
    ],
    documents: [
      { kind: "authenticity", label: "Certificate of authenticity", hint: "Or the expert's report." },
      { kind: "custody", label: "Custody receipt", hint: "From the warehouse or vault." },
      { kind: "insurance", label: "Insurance certificate", hint: "Covering full value." },
    ],
    help: [
      { title: "In plain English", body: "Investors own fractions of one real item. The item stays with a custodian; the token proves who owns which share." },
      { title: "Have these ready", body: ["Certificate of authenticity", "Custody receipt", "Insurance certificate"] },
    ],
    askLawyer: "Are fractions of this item a security, or a commodity sale? It decides whether investors need verification at all.",
  },

  carbon: {
    title: "About your credits", noun: "credits",
    intro: "One offering is one batch of credits from one registry. One token is one tonne.",
    sections: [
      {
        title: "Where the credits are registered", tag: "onchain",
        fields: [
          { id: "registry", label: "Registry", type: "chips", options: [["verra", "Verra (VCS)"], ["gold", "Gold Standard"], ["acr", "American Carbon Registry"], ["car", "Climate Action Reserve"], ["puro", "Puro.earth"]], what: "The independent registry that issued and tracks the credits." },
          { id: "projectId", label: "Project ID", type: "text", placeholder: "e.g. VCS-1234", hint: "We link investors straight to the registry page." },
          { id: "vintage", label: "Vintage year", type: "number", placeholder: "e.g. 2025", what: "The year the reduction or removal happened." },
          { id: "serials", label: "Serial number range", type: "text", placeholder: "First – last serial", hint: "Move the credits to your custody account before you sell." },
          { id: "tonnes", label: "Tonnes in this batch", type: "number", hint: "The number of tokens is set from this: 1 token = 1 tonne CO2e." },
        ],
      },
      {
        title: "The project", tag: "listing",
        fields: [
          { id: "projectType", label: "Project type", type: "chips", options: [["reforestation", "Reforestation"], ["redd", "Avoided deforestation (REDD+)"], ["cookstoves", "Clean cookstoves"], ["renewable", "Renewable energy"], ["biochar", "Biochar"], ["dac", "Direct air capture"]] },
          { id: "methodology", label: "Methodology", type: "text", placeholder: "e.g. VM0047" },
          { id: "location", label: "Location", type: "text" },
          { id: "verifier", label: "Verified by", type: "text" },
          { id: "verifiedOn", label: "Last verification", type: "date" },
        ],
      },
      {
        title: "Retiring credits", tag: "rule",
        intro: "A buyer who wants to claim the offset retires it: the token is burned on chain, for good, and you retire the same tonnes on the registry.",
        fields: [
          { id: "retireAfterLockup", label: "Only after the holding period", type: "yesno", hint: "Off: any holder may retire at any time (most common)." },
        ],
      },
    ],
    documents: [
      { kind: "verification", label: "Verification report", hint: "From the verification body." },
      { kind: "custody", label: "Registry custody statement", hint: "Shows these serials in your account." },
    ],
    help: [
      { title: "In plain English", body: "Each token is one tonne of verified carbon reduction or removal. Retiring burns the token, so the same tonne can never be claimed twice." },
      { title: "Why we ask for serial numbers", body: "They prove the exact credits behind your tokens. We show them on the listing and match them on every retirement." },
    ],
    askLawyer: "Check your registry's rules: some restrict tokenizing credits or require a specific custody account.",
  },
};

/** The step-chip label for step 2, e.g. "About your property". */
export const aboutLabel = (cls: AssetClassId | undefined) => (cls ? QUESTIONS[cls].title : "About your asset");
