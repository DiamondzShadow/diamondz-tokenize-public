// Single source of truth for networks lives in the web app (pure data, no browser deps).
import { networkById, type Network } from "../../web/src/lib/chains";
export { NETWORKS, networkById, type Network } from "../../web/src/lib/chains";

/** The RPC the server uses for a network: RPC_<chainId> override → Uniblock (UNIBLOCK_API_KEY; one key for every chain
 *  we run, incl. Robinhood Chain and the testnets) → the network's public RPC. The key never reaches the browser
 *  (browser reads go through /api/rpc/:chainId). */
export function rpcUrl(net: Network): string {
  const override = process.env[`RPC_${net.id}`];
  if (override) return override;
  const key = process.env.UNIBLOCK_API_KEY;
  if (key && net.uniblock !== false && !UNIBLOCK_SKIP.has(net.id)) return `https://api.uniblock.dev/uni/v1/json-rpc?chainId=${net.id}&apiKey=${encodeURIComponent(key)}`;
  return net.rpc;
}
/** Networks to keep on their public RPC even with a Uniblock key (UNIBLOCK_SKIP="10,43114"). */
const UNIBLOCK_SKIP = new Set((process.env.UNIBLOCK_SKIP ?? "").split(",").map(Number).filter((n) => n > 0));

/** The network's proof-of-asset oracle. ASSET_ORACLE_<chainId>=0xAddr:fromBlock overrides it (local forks, tests);
 *  ASSET_ORACLE_<chainId>=none simulates a network without one. */
export function assetOracleFor(net: Network | undefined): Network["assetOracle"] {
  if (!net) return undefined;
  const o = process.env[`ASSET_ORACLE_${net.id}`];
  if (o === "none") return undefined;
  if (o) {
    const [address, block] = o.split(":");
    return { address: address as `0x${string}`, fromBlock: Number(block ?? 0) };
  }
  return net.assetOracle;
}

/** The network's CRE feed receiver. CRE_FEED_<chainId>=0xAddr overrides it (local forks, tests). */
export function creFeedFor(net: Network | undefined): `0x${string}` | undefined {
  if (!net) return undefined;
  return (process.env[`CRE_FEED_${net.id}`] as `0x${string}` | undefined) ?? net.creFeed;
}

/** Every platform oracle on the network, current first. */
export function knownOracles(net: Network | undefined): { address: `0x${string}`; fromBlock: number }[] {
  const cur = assetOracleFor(net);
  return [...(cur ? [cur] : []), ...(net?.legacyOracles ?? [])];
}

/** The oracle that governs an offering: the platform oracle its sale is gated by (immutable on the sale), else the
 *  network's current one (ungated or pre-oracle sales show the current oracle's view). */
export function oracleForSale(net: Network | undefined, saleOracle: string | null | undefined) {
  // A legacy oracle governs only the sales explicitly gated by it; anything else gets the current oracle (or none).
  const match = knownOracles(net).find((o) => saleOracle && o.address.toLowerCase() === saleOracle.toLowerCase());
  return match ?? assetOracleFor(net);
}

/** ERC-3643 platform core. TREX_<chainId>=<json> overrides it (local forks, tests). */
export function trexFor(net: Network | undefined): Network["trex"] {
  if (!net) return undefined;
  const o = process.env[`TREX_${net.id}`];
  if (o) return JSON.parse(o);
  return net.trex;
}

/** Stellar RPC the server uses: STELLAR_<NETWORK>_RPC override → Uniblock (same UNIBLOCK_API_KEY as EVM; free tier) →
 *  the network's public RPC. Uniblock chain ids: stellar-soroban (mainnet), stellar-soroban-testnet. */
export function stellarRpcUrl(network: "testnet" | "mainnet", fallback: string): string {
  const override = process.env[`STELLAR_${network.toUpperCase()}_RPC`];
  if (override) return override;
  const key = process.env.UNIBLOCK_API_KEY;
  if (key) return `https://api.uniblock.dev/uni/v1/json-rpc?chainId=${network === "mainnet" ? "stellar-soroban" : "stellar-soroban-testnet"}&apiKey=${encodeURIComponent(key)}`;
  return fallback;
}
