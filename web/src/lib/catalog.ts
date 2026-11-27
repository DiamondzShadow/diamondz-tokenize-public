// Shared product catalog: asset classes, token standards, payment methods.
// The API serves the same ids (see api/src/catalog.ts); keep the two in sync.

export type StandardId = "erc3643" | "erc7943" | "erc4626" | "erc721" | "erc1155" | "story-ip" | "stellar-rwa";

export interface Standard {
  id: StandardId;
  name: string;
  what: string;
  bestFor: string;
  transfers: string;
  tag: "" | "v" | "g" | "y";
  /** true when this platform can deploy it today; false = roadmap */
  available: boolean;
}

export const STANDARDS: Standard[] = [
  { id: "erc7943", name: "ERC-7943 (uRWA)", what: "Permissioned ERC-20 with freeze and forced transfer", bestFor: "Real estate, equity, credit", transfers: "Verified only", tag: "", available: true },
  { id: "erc4626", name: "ERC-4626", what: "Vault shares in a pooled asset with on-chain NAV", bestFor: "Funds, yield, royalty pools", transfers: "Verified only", tag: "v", available: true },
  { id: "erc3643", name: "ERC-3643 (T-REX)", what: "Audited security-token standard: on-chain identities, issuer-signed KYC claims", bestFor: "Institutional securities", transfers: "Verified only", tag: "", available: true },
  { id: "erc721", name: "ERC-721", what: "One permissioned token per unique unit, with freeze and forced transfer", bestFor: "Deeds, art, single items", transfers: "Verified only", tag: "y", available: true },
  { id: "erc1155", name: "ERC-1155", what: "Permissioned fractions of one item, with freeze, forced transfer and carbon retirement", bestFor: "Fractions, casks, carbon credits", transfers: "Verified only", tag: "y", available: true },
  // Stellar edition (designs X1–X5): OpenZeppelin's Stellar port of ERC-3643. Picked automatically with a Stellar
  // network, never listed per class (an asset class's standards are the EVM choices).
  { id: "stellar-rwa", name: "Stellar RWA (ERC-3643 on Stellar)", what: "Regulated security token on Stellar: verified identities, compliance rules enforced by the token", bestFor: "Real estate, equity, credit, royalties", transfers: "Verified only", tag: "", available: true },
  // Retired 2026-11-19: Story's L1 is being retired (DATA → Sui). IP is now registered in our own IP registry on the
  // offering's network (contracts/src/ip); kept only so old drafts still parse.
];

export type AssetClassId =
  | "real-estate" | "energy" | "private-equity" | "private-credit"
  | "funds" | "music-ip" | "film" | "sports" | "collectibles" | "carbon";

export interface AssetClass {
  id: AssetClassId;
  icon: string;
  name: string;
  blurb: string;
  standards: StandardId[]; // first = recommended
  why: string;
}

export const ASSET_CLASSES: AssetClass[] = [
  { id: "real-estate", icon: "🏢", name: "Real estate", blurb: "Single properties or portfolios held in an SPV, with rental income paid to holders.", standards: ["erc7943", "erc3643", "erc4626", "erc721", "erc1155"], why: "A permissioned token keeps every holder of the SPV verified." },
  { id: "energy", icon: "🛢️", name: "Energy & commodities", blurb: "Oil and gas royalties, mineral rights and warehoused commodities with reserve reports.", standards: ["erc7943", "erc3643", "erc4626"], why: "Royalty interests are securities; transfers stay with verified holders." },
  { id: "private-equity", icon: "📈", name: "Private equity & SPVs", blurb: "Company shares and deal-by-deal SPVs with cap-table sync and lockups.", standards: ["erc7943", "erc3643"], why: "Equity needs lockups and verified holders on every transfer." },
  { id: "private-credit", icon: "🏦", name: "Private credit", blurb: "Loans, invoices and receivables with scheduled interest and maturity.", standards: ["erc7943", "erc3643", "erc4626"], why: "Notes are redeemed at maturity; the issuer burns on repayment." },
  { id: "funds", icon: "🧺", name: "Funds & yield vaults", blurb: "Pooled funds where investors hold shares of the pool and NAV updates on chain.", standards: ["erc4626"], why: "Vault shares price the whole pool, including capital deployed off-chain." },
  { id: "music-ip", icon: "🎵", name: "Music & IP royalties", blurb: "Song masters, publishing and licenses registered as IP with automatic royalty splits.", standards: ["erc7943", "erc3643"], why: "Royalty shares are securities, so holders stay verified; the song itself gets an official record and licenses in the IP registry." },
  { id: "film", icon: "🎬", name: "Film & TV", blurb: "Films and series with an official IP record and licensing on your offering's network, with investors sharing net revenue and license fees.", standards: ["erc7943", "erc3643"], why: "Investors hold a verified-only token for the revenue share; the film itself gets an official record and licenses in the IP registry." },
  { id: "sports", icon: "🏆", name: "Sports: teams & athletes", blurb: "A share of a team's or athlete's income: salary, prize money, endorsements or media rights, for a set term.", standards: ["erc7943", "erc3643"], why: "An income share is a security; every holder stays verified and payouts follow the contract terms." },
  { id: "collectibles", icon: "🥃", name: "Collectibles & art", blurb: "Fine art, spirits casks, watches and memorabilia, whole or fractional.", standards: ["erc1155", "erc721"], why: "Fixed fractions of one item map cleanly to ERC-1155." },
  { id: "carbon", icon: "🌱", name: "Carbon & impact", blurb: "Carbon credits and impact assets with retirement tracking and registry links.", standards: ["erc1155"], why: "Each offering is one vintage; holders retire credits by burning them, on record for good." },
];

/** ERC-1155 offerings sell one item: this token id. */
export const ITEM_ID = 1n;

/** Story IP was retired (2026-11-19) and is no longer offered; old records still name it, so it resolves here. */
const RETIRED: Standard[] = [{ id: "story-ip", name: "Story IP (retired)", what: "Replaced by the platform's IP registry", bestFor: "—", transfers: "—", tag: "g", available: false }];
export const standardById = (id: StandardId) => (STANDARDS.find((s) => s.id === id) ?? RETIRED.find((s) => s.id === id))!;
export const assetClassById = (id: string) => ASSET_CLASSES.find((a) => a.id === id);

export type PayMethodId = "card" | "usdc" | "usdg" | "pyusd" | "eurc" | "bank" | "deposit-token";

export const PAY_METHODS: { id: PayMethodId; name: string; note?: string; soon?: boolean }[] = [
  { id: "card", name: "Card checkout", note: "Stripe" },
  { id: "usdc", name: "USDC" },
  { id: "usdg", name: "USDG" },
  { id: "pyusd", name: "PYUSD" },
  { id: "eurc", name: "EURC" },
  { id: "bank", name: "ACH / wire" },
  { id: "deposit-token", name: "Tokenized bank deposits", soon: true },
];
