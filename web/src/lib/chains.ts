// Networks the platform can deploy to. Chain ids and stablecoin addresses were verified on-chain
// (symbol + decimals) on 2026-11-17. Keep in sync with api/src/chains.ts.

export interface Network {
  id: number;
  name: string;
  testnet: boolean;
  rpc: string;
  explorer: string;
  native: { name: string; symbol: string; decimals: number };
  /** Chainalysis sanctions oracle on this chain (verified on-chain 2026-11-17). Absent = off-chain OFAC check only. */
  sanctionsOracle?: `0x${string}`;
  /** Proof-of-asset AssetOracle on this network (platform-run). New sales stop selling while their asset isn't verified. */
  assetOracle?: { address: `0x${string}`; fromBlock: number };
  /** Chainlink CRE receiver holding live per-asset market feeds (cre/asset-feeds workflow). */
  creFeed?: `0x${string}`;
  /** Platform payout contract (Distributor): issuers fund payouts, holders claim gas-free. */
  distributor?: { address: `0x${string}`; fromBlock: number };
  /** Earlier platform oracles on this network. Offerings deployed against one stay governed by it (their sale's
   *  oracle is immutable); new offerings always use `assetOracle`. */
  legacyOracles?: { address: `0x${string}`; fromBlock: number }[];
  /** ERC-3643 platform core (T-REX 4.1.6 / OnchainID 2.2.1), owned by the platform's T-REX relayer. */
  trex?: { trexFactory: `0x${string}`; implementationAuthority: `0x${string}`; iaFactory: `0x${string}`; idFactory: `0x${string}`; rulesModule?: `0x${string}`; fromBlock: number };
  /** IP registry (designs F1–F7): AssetRegistry (asset NFTs) + LicenseRegistry (license NFTs), platform-deployed. */
  ip?: { assets: `0x${string}`; licenses: `0x${string}`; fromBlock: number };
  /** Default payment stablecoin. Testnets without one use a freshly deployed TestUSD. */
  stable?: { address: `0x${string}`; symbol: string; decimals: number };
  /** false = Uniblock doesn't serve this chain (checked 2026-11-27); the server uses `rpc` even with a Uniblock key. */
  uniblock?: false;
  /** Circle CCTP V2 on this network: investors can bring USDC from another chain to buy here (domain = CCTP domain id). */
  cctp?: { domain: number; tokenMessenger: `0x${string}`; messageTransmitter: `0x${string}` };
  note?: string;
}

const ETH = { name: "Ether", symbol: "ETH", decimals: 18 };
// Arc pays gas in USDC: the native balance has 18 decimals; the USDC ERC-20 interface (0x3600…) has 6 (docs.arc.io).
const ARC_USDC_NATIVE = { name: "USDC", symbol: "USDC", decimals: 18 };
// CCTP V2 testnet contracts share one address on every EVM testnet (verified on-chain 2026-11-27: Arc, Fuji, HyperEVM).
// CCTP V2 mainnet contracts: one address on every EVM mainnet; domains read on-chain via localDomain() 2026-11-27.
const CCTP_MAINNET = { tokenMessenger: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d", messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64" } as const;
const CCTP_TESTNET = { tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA", messageTransmitter: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275" } as const;

export const NETWORKS: Network[] = [
  // --- mainnets
  { id: 8453, assetOracle: { address: "0x322209c05FAeb273864318d40b9B9127C1a23258", fromBlock: 60001666 }, distributor: { address: "0x6A09a1c8d7856977041CC6e220802cF78AF66183", fromBlock: 60002133 }, trex: { trexFactory: "0x116eED74469ABf1E4d441f4A2AAbF01ca7DE1899", implementationAuthority: "0xA06b42451600F2CA10D21665f2A931df058b6d4d", iaFactory: "0xb79CeA785C59080090b4d9C09E6c8ccab6B6037D", idFactory: "0x4d0347e8F8ec803cf7A48c69200C230F7F82594c", rulesModule: "0x3cF15D0Ae4CD0190428c918bde975Da79525E1fC", fromBlock: 60002242 }, ip: { assets: "0x00fAdc0C46D0877096F956745FE75A0D491767a7", licenses: "0xfB39C3CdDD48b8Ef537115CDC19e266240fc7636", fromBlock: 59440558 }, sanctionsOracle: "0x3A91A31cB3dC49b4db9Ce721F50a9D076c8D739B", name: "Base", testnet: false, rpc: "https://base-rpc.publicnode.com", explorer: "https://basescan.org", native: ETH, stable: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 }, cctp: { domain: 6, ...CCTP_MAINNET } },
  { id: 42161, ip: { assets: "0x7e6D5983bF4daFF658bEf2d5fAB2A082976641c4", licenses: "0x47c8c67C24bEeCF705aec4273B59f313310E7a74", fromBlock: 525568981 }, sanctionsOracle: "0x40C57923924B5c5c5455c48D93317139ADDaC8fb", assetOracle: { address: "0xDf653b2c669A49e725a5A3CE5b75ad026De154A1", fromBlock: 525700845 }, distributor: { address: "0x2CE49A57d5d69107A5DA5f350F81Cee4369daa0C", fromBlock: 525975432 }, trex: { trexFactory: "0x116eED74469ABf1E4d441f4A2AAbF01ca7DE1899", implementationAuthority: "0xA06b42451600F2CA10D21665f2A931df058b6d4d", iaFactory: "0xb79CeA785C59080090b4d9C09E6c8ccab6B6037D", idFactory: "0x4d0347e8F8ec803cf7A48c69200C230F7F82594c", rulesModule: "0x3cF15D0Ae4CD0190428c918bde975Da79525E1fC", fromBlock: 525975456 }, name: "Arbitrum", testnet: false, rpc: "https://arb1.arbitrum.io/rpc", explorer: "https://arbiscan.io", native: ETH, stable: { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", symbol: "USDC", decimals: 6 }, cctp: { domain: 3, ...CCTP_MAINNET } },
  { id: 4663, assetOracle: { address: "0x3677c9Dfa227Ea0338A744f6eb8b0ed155334bf2", fromBlock: 119179346 }, distributor: { address: "0x5190466F8E866E2118FDc5713abF29b2628a967d", fromBlock: 119180257 }, trex: { trexFactory: "0x116eED74469ABf1E4d441f4A2AAbF01ca7DE1899", implementationAuthority: "0xA06b42451600F2CA10D21665f2A931df058b6d4d", iaFactory: "0xb79CeA785C59080090b4d9C09E6c8ccab6B6037D", idFactory: "0x4d0347e8F8ec803cf7A48c69200C230F7F82594c", rulesModule: "0x3cF15D0Ae4CD0190428c918bde975Da79525E1fC", fromBlock: 119180379 }, name: "Robinhood Chain", testnet: false, rpc: "https://rpc.mainnet.chain.robinhood.com", explorer: "https://explorer.mainnet.chain.robinhood.com", native: ETH, stable: { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", symbol: "USDG", decimals: 6 } },
  { id: 137, sanctionsOracle: "0x40C57923924B5c5c5455c48D93317139ADDaC8fb", name: "Polygon", testnet: false, rpc: "https://polygon-bor-rpc.publicnode.com", explorer: "https://polygonscan.com", native: { name: "POL", symbol: "POL", decimals: 18 }, stable: { address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", symbol: "USDC", decimals: 6 }, cctp: { domain: 7, ...CCTP_MAINNET } },
  { id: 1, sanctionsOracle: "0x40C57923924B5c5c5455c48D93317139ADDaC8fb", name: "Ethereum", testnet: false, rpc: "https://ethereum-rpc.publicnode.com", explorer: "https://etherscan.io", native: ETH, stable: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6 }, note: "Highest gas costs.", cctp: { domain: 0, ...CCTP_MAINNET } },
  { id: 10, sanctionsOracle: "0x40C57923924B5c5c5455c48D93317139ADDaC8fb", name: "Optimism", testnet: false, rpc: "https://optimism-rpc.publicnode.com", explorer: "https://optimistic.etherscan.io", native: ETH, stable: { address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", symbol: "USDC", decimals: 6 }, cctp: { domain: 2, ...CCTP_MAINNET } },
  { id: 43114, sanctionsOracle: "0x40C57923924B5c5c5455c48D93317139ADDaC8fb", name: "Avalanche", testnet: false, rpc: "https://avalanche-c-chain-rpc.publicnode.com", explorer: "https://snowtrace.io", native: { name: "Avalanche", symbol: "AVAX", decimals: 18 }, stable: { address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", symbol: "USDC", decimals: 6 }, cctp: { domain: 1, ...CCTP_MAINNET } },
  { id: 999, name: "HyperEVM", testnet: false, rpc: "https://rpc.hyperliquid.xyz/evm", explorer: "https://hyperevmscan.io", native: { name: "HYPE", symbol: "HYPE", decimals: 18 }, stable: { address: "0xb88339CB7199b77E23DB6E890353E22632Ba630f", symbol: "USDC", decimals: 6 }, note: "Small blocks: a large deploy may need big-block mode enabled on your wallet address.", cctp: { domain: 19, ...CCTP_MAINNET } },
  // --- testnets
  { id: 84532, ip: { assets: "0xBbEaD7550c0a1A90745324869b4Bb46714fCBb4c", licenses: "0xCd42B708429dC0Bed13Ecd49c19769Bc4FB8D323", fromBlock: 60776155 }, sanctionsOracle: "0x40C57923924B5c5c5455c48D93317139ADDaC8fb", assetOracle: { address: "0xB0787B722906E8DBd1B3017ebE436d7E155E9474", fromBlock: 60276557 }, legacyOracles: [{ address: "0x0473e5014c8e064cCA1C38106200399b5250D8e6", fromBlock: 60084053 }], creFeed: "0x3F4396417f142fD406215E8437C448Cb28bf7552", distributor: { address: "0x29E23523029bf7607c1903d9D5E474C78E311A31", fromBlock: 60276916 }, trex: { trexFactory: "0x7a1DEB778D7f6eB8D3eB72f95a8Ddc9CC34D514D", implementationAuthority: "0x57050445537753702DeEE687214801b1448d81FB", iaFactory: "0x286D91C993E5879735F3dF4BaD3567C0194373cf", idFactory: "0x5e7BE9830f3242bb02Be45320C7bdcF3Dd05D143", fromBlock: 60277149 }, name: "Base Sepolia", testnet: true, rpc: "https://base-sepolia-rpc.publicnode.com", explorer: "https://sepolia.basescan.org", native: ETH, stable: { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", symbol: "USDC", decimals: 6 }, cctp: { domain: 6, ...CCTP_TESTNET } },
  { id: 421614, ip: { assets: "0xc5DE2C42ffE217D9d60bd55a17C5aA2B49b925f7", licenses: "0xf9B805344366ba27830d8B79052224E463c3BDd0", fromBlock: 330684181 }, assetOracle: { address: "0x174ea537e1d4D31b0B52F41E25B1804a315444DC", fromBlock: 330314624 }, legacyOracles: [{ address: "0xC5a69D0d88d66FCe9087bF2aE8cFbFaF965749b6", fromBlock: 330293295 }], creFeed: "0xF26d24dD2443C5914BAd5461C65ebe0c133ac2b6", distributor: { address: "0x92A94f251C332A6A6278e55167cb92a4aCF6bAc1", fromBlock: 330314687 }, trex: { trexFactory: "0x116eED74469ABf1E4d441f4A2AAbF01ca7DE1899", implementationAuthority: "0xA06b42451600F2CA10D21665f2A931df058b6d4d", iaFactory: "0xb79CeA785C59080090b4d9C09E6c8ccab6B6037D", idFactory: "0x4d0347e8F8ec803cf7A48c69200C230F7F82594c", fromBlock: 330314717 }, name: "Arbitrum Sepolia", testnet: true, rpc: "https://arbitrum-sepolia-rpc.publicnode.com", explorer: "https://sepolia.arbiscan.io", native: ETH, stable: { address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", symbol: "USDC", decimals: 6 }, cctp: { domain: 3, ...CCTP_TESTNET } },
  { id: 46630, ip: { assets: "0x083dF477AC1e02bE233df77C76021E2AAbD21F9c", licenses: "0x0b6386E68882f52f3E819e7e8F160e5AE350001D", fromBlock: 155362241 }, assetOracle: { address: "0x9c45Ed0C55ce66a36e95a5C4fC7328A34a06585f", fromBlock: 154821723 }, legacyOracles: [{ address: "0x1EdE69722207f5e4822036a5e5499C436789A66e", fromBlock: 154790315 }], distributor: { address: "0x41830020d19ba4bA292C80ddE48d24FF9E81011A", fromBlock: 154822306 }, trex: { trexFactory: "0x116eED74469ABf1E4d441f4A2AAbF01ca7DE1899", implementationAuthority: "0xA06b42451600F2CA10D21665f2A931df058b6d4d", iaFactory: "0xb79CeA785C59080090b4d9C09E6c8ccab6B6037D", idFactory: "0x4d0347e8F8ec803cf7A48c69200C230F7F82594c", fromBlock: 154822422 }, stable: { address: "0xf2b2a7D121d2167BedBC6619A4A805786723e8CB", symbol: "tUSD", decimals: 6 }, name: "Robinhood Chain Testnet", testnet: true, rpc: "https://rpc.testnet.chain.robinhood.com", explorer: "https://explorer.testnet.chain.robinhood.com", native: ETH, note: "Uses the free platform Test USD (tUSD) for practice purchases and payouts." },
  // Added 2026-11-27 (chain ids, USDC address + decimals verified on-chain; platform contracts land via deploy-platform.sh).
  { id: 5042002, assetOracle: { address: "0x7aaB9e2261bC022b89376F5F6ad0417f076E6e7A", fromBlock: 74325289 }, distributor: { address: "0xa5313558D3972AEcd8696517788699621024D36F", fromBlock: 74325807 }, trex: { trexFactory: "0x116eED74469ABf1E4d441f4A2AAbF01ca7DE1899", implementationAuthority: "0xA06b42451600F2CA10D21665f2A931df058b6d4d", iaFactory: "0xb79CeA785C59080090b4d9C09E6c8ccab6B6037D", idFactory: "0x4d0347e8F8ec803cf7A48c69200C230F7F82594c", rulesModule: "0x6410ef5B7A142fedd9b094B3Cd58B09589D5e9b3", fromBlock: 74325878 }, name: "Arc Testnet", testnet: true, rpc: "https://rpc.testnet.arc.io", explorer: "https://explorer.testnet.arc.io", native: ARC_USDC_NATIVE, stable: { address: "0x3600000000000000000000000000000000000000", symbol: "USDC", decimals: 6 }, cctp: { domain: 26, ...CCTP_TESTNET }, note: "Circle's Arc: gas is paid in USDC and settles in under a second." },
  { id: 43113, assetOracle: { address: "0x1D542f9e3e5bBfae3E31960Ed0ca4F90E16f3D54", fromBlock: 61698511 }, distributor: { address: "0x0e893017B121fB8FFaDE34e0abD5ccD19788e00e", fromBlock: 61698745 }, trex: { trexFactory: "0x116eED74469ABf1E4d441f4A2AAbF01ca7DE1899", implementationAuthority: "0xA06b42451600F2CA10D21665f2A931df058b6d4d", iaFactory: "0xb79CeA785C59080090b4d9C09E6c8ccab6B6037D", idFactory: "0x4d0347e8F8ec803cf7A48c69200C230F7F82594c", rulesModule: "0x6410ef5B7A142fedd9b094B3Cd58B09589D5e9b3", fromBlock: 61698764 }, name: "Avalanche Fuji", testnet: true, rpc: "https://api.avax-test.network/ext/bc/C/rpc", explorer: "https://testnet.snowtrace.io", native: { name: "Avalanche", symbol: "AVAX", decimals: 18 }, stable: { address: "0x5425890298aed601595a70AB815c96711a31Bc65", symbol: "USDC", decimals: 6 }, cctp: { domain: 1, ...CCTP_TESTNET } },
  { id: 1449000, assetOracle: { address: "0xe3F850FEa1cA73442EA618AaD0dc2cfc5d35fe21", fromBlock: 9716540 }, distributor: { address: "0x764A7cfe40984180c55554D9A1Cfb341D1BD0CF3", fromBlock: 9716603 }, trex: { trexFactory: "0x116eED74469ABf1E4d441f4A2AAbF01ca7DE1899", implementationAuthority: "0xA06b42451600F2CA10D21665f2A931df058b6d4d", iaFactory: "0xb79CeA785C59080090b4d9C09E6c8ccab6B6037D", idFactory: "0x4d0347e8F8ec803cf7A48c69200C230F7F82594c", rulesModule: "0x6410ef5B7A142fedd9b094B3Cd58B09589D5e9b3", fromBlock: 9716609 }, stable: { address: "0xEEF3afEf47E342320616ac977EeB3a91CCfB61eB", symbol: "tUSD", decimals: 6 }, name: "XRPL EVM Testnet", testnet: true, uniblock: false, rpc: "https://rpc.testnet.xrplevm.org", explorer: "https://explorer.testnet.xrplevm.org", native: { name: "XRP", symbol: "XRP", decimals: 18 }, note: "XRP Ledger's EVM sidechain. Uses the free platform Test USD (tUSD) for practice purchases and payouts." },
  { id: 998, name: "HyperEVM Testnet", testnet: true, rpc: "https://rpc.hyperliquid-testnet.xyz/evm", explorer: "https://testnet.purrsec.info", native: { name: "HYPE", symbol: "HYPE", decimals: 18 }, stable: { address: "0x2B3370eE501B4a559b57D449569354196457D8Ab", symbol: "USDC", decimals: 6 }, cctp: { domain: 19, ...CCTP_TESTNET }, note: "Small blocks: a large deploy may need big-block mode enabled on your wallet address." },
];

export const networkById = (id: number | undefined) => NETWORKS.find((n) => n.id === id);
export const DEFAULT_CHAIN_ID = 84532;

export const txUrl = (n: Network, hash: string) => `${n.explorer}/tx/${hash}`;
export const addrUrl = (n: Network, a: string) => `${n.explorer}/address/${a}`;

// ------------------------------------------------------------------ Stellar (Soroban) edition
// Kept OUT of NETWORKS on purpose: every EVM code path (viem clients, log index, payouts, jobs) iterates NETWORKS or
// looks ids up with networkById, so Stellar can never reach them. Stellar ids are negative, never valid EVM chain ids.
// Contracts: OpenZeppelin Stellar Contracts v0.8.0 RWA stack (stellar/ in the repo). The platform relayer deploys
// each offering with the issuer's wallet as admin; wasm hashes are the code uploaded once per network.
export interface StellarNetwork {
  id: number;
  kind: "stellar";
  key: "testnet" | "mainnet";
  name: string;
  testnet: boolean;
  rpc: string;
  passphrase: string;
  explorer: string;
  /** Uploaded contract code (stellar/deployments/<network>-wasm.json). */
  wasm: Record<StellarWasm, string>;
  /** Stablecoin investors pay with: a Stellar Asset Contract (verified against developers.stellar.org, 2026-11-19). */
  payToken: { contract: string; code: string; issuer: string; decimals: number };
  /** EVM network where the offering's StellarAssetAnchor lives (Chainlink CRE writes there; it can't write to Stellar). */
  anchorChainId: number;
}
export type StellarWasm =
  | "cti" | "claimIssuer" | "identity" | "registry" | "verifier" | "compliance" | "token"
  | "supplyLimit" | "maxBalance" | "countryAllow" | "countryRestrict" | "lockup" | "sale";
export const STELLAR_TESTNET_ID = -1481;
export const STELLAR_NETWORKS: StellarNetwork[] = [
  {
    id: STELLAR_TESTNET_ID, kind: "stellar", key: "testnet", name: "Stellar testnet", testnet: true,
    rpc: "https://soroban-testnet.stellar.org", passphrase: "Test SDF Network ; September 2015",
    explorer: "https://stellar.expert/explorer/testnet", anchorChainId: 84532,
    // Circle's testnet USDC (free from faucet.circle.com).
    payToken: { contract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5", decimals: 7 },
    wasm: {
      cti: "2cbbc311bddbba637f5d48f2dbf5d09a74af120a69b656dc864b68faffad849b",
      claimIssuer: "bcbe2d4933620a47735e0a380d449b40473dd6efa82a6ca24749fd24964ad545",
      identity: "bdabdd228716a19cc2dfd0bda283c39f0979b0bf9041d28c6a86baf4e2baf768",
      registry: "a281391fcfbbe95e5de702d45b19095a6b42c6c00e585431214c7c140efa96e1",
      verifier: "6ea2a404f77e4f3e34daca0ea7ed56dd2bc29127aecf2786455128876b63d769",
      compliance: "a7f6972ca3c938fb9dcab970a65bf9b983173fb36cdb8e218f6052d98336071f",
      token: "5d2dd2b7fc73e7661532f04f3367f033affd181dd59cd66311487fc88fb756ba",
      supplyLimit: "b0ed4bd7dd69bafeba985c249fd34cb6b6d78d68901c216aef26cfec64044c1d",
      maxBalance: "e2fdfbf460fd5b4c2dd6df3053f28c0fe5c548fb46888f886e54e341fc282fa3",
      countryAllow: "17e744be528b3f0e50334886238debadd5fb30ea576de2affcbe88a41307f2d8",
      countryRestrict: "53810896aafeb25baec610f786393be8b4d3257e1bf7efd3c810a89b1f1833f0",
      lockup: "6d39b026eab4956901afd61d6bc90b2f4b8b24957297343eda512cb22cd1fe27",
      sale: "30035311aa17c162662d551569aec12958f129cfa337482667a921ab117fe815",
    },
  },
];
// Stellar mainnet (designs X1–X5 + mainnet rules): code uploaded 2026-11-20 by stellar/upload-mainnet.sh
// (stellar/deployments/mainnet-wasm.json); deploys refuse if any hash is empty. Admin = the issuer's multisig, day-to-day manager =
// the issuer's own wallet; the platform relayer gives up every role after setup.
export const STELLAR_MAINNET_ID = -1480;
STELLAR_NETWORKS.push({
  id: STELLAR_MAINNET_ID, kind: "stellar", key: "mainnet", name: "Stellar", testnet: false,
  rpc: "https://mainnet.sorobanrpc.com", passphrase: "Public Global Stellar Network ; September 2015",
  explorer: "https://stellar.expert/explorer/public", anchorChainId: 42161,
  // Circle USDC (verified against developers.stellar.org, 2026-11-19).
  payToken: { contract: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", code: "USDC", issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", decimals: 7 },
  wasm: {
    cti: "2cbbc311bddbba637f5d48f2dbf5d09a74af120a69b656dc864b68faffad849b",
    claimIssuer: "bcbe2d4933620a47735e0a380d449b40473dd6efa82a6ca24749fd24964ad545",
    identity: "bdabdd228716a19cc2dfd0bda283c39f0979b0bf9041d28c6a86baf4e2baf768",
    registry: "a281391fcfbbe95e5de702d45b19095a6b42c6c00e585431214c7c140efa96e1",
    verifier: "6ea2a404f77e4f3e34daca0ea7ed56dd2bc29127aecf2786455128876b63d769",
    compliance: "a7f6972ca3c938fb9dcab970a65bf9b983173fb36cdb8e218f6052d98336071f",
    token: "5d2dd2b7fc73e7661532f04f3367f033affd181dd59cd66311487fc88fb756ba",
    supplyLimit: "b0ed4bd7dd69bafeba985c249fd34cb6b6d78d68901c216aef26cfec64044c1d",
    maxBalance: "e2fdfbf460fd5b4c2dd6df3053f28c0fe5c548fb46888f886e54e341fc282fa3",
    countryAllow: "17e744be528b3f0e50334886238debadd5fb30ea576de2affcbe88a41307f2d8",
    countryRestrict: "53810896aafeb25baec610f786393be8b4d3257e1bf7efd3c810a89b1f1833f0",
    lockup: "6d39b026eab4956901afd61d6bc90b2f4b8b24957297343eda512cb22cd1fe27",
    sale: "30035311aa17c162662d551569aec12958f129cfa337482667a921ab117fe815",
  },
});
/** True once every contract's code is uploaded to that network. */
export const stellarCodeReady = (n: StellarNetwork) => Object.values(n.wasm).every((h) => /^[0-9a-f]{64}$/.test(h));
export const stellarById = (id: number | undefined) => STELLAR_NETWORKS.find((n) => n.id === id);
export const isStellarChain = (id: number | undefined) => !!stellarById(id);
/** Any network the platform supports (EVM or Stellar), for labels. */
export const anyNetworkName = (id: number | undefined) => networkById(id)?.name ?? stellarById(id)?.name;
export const stellarAccountUrl = (n: StellarNetwork, a: string) => `${n.explorer}/${a.startsWith("C") ? "contract" : "account"}/${a}`;
export const stellarTxUrl = (n: StellarNetwork, hash: string) => `${n.explorer}/tx/${hash}`;
