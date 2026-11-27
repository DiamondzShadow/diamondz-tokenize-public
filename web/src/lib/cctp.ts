// Bring USDC from another network to an offering's network with Circle CCTP V2 + the Circle Forwarding Service.
// The investor signs two transactions on the SOURCE network (approve USDC, then burn with Circle's forwarding hook);
// Circle attests and mints the USDC into the SAME wallet on the offering's network. Nothing is bought here: the
// investor then buys with the normal Buy button, so identity checks and offering rules apply exactly as before.
// Pure data + fetch helpers only (no React, no wallet): safe to import from the API and scripts.
import { pad, type Address, type Hex } from "viem";
import { NETWORKS, networkById, type Network } from "./chains";

/** Circle's Forwarding Service hook: "cctp-forward" magic bytes + version 0 + no extra data (developers.circle.com). */
export const FORWARD_HOOK: Hex = "0x636374702d666f72776172640000000000000000000000000000000000000000";
/** Fast Transfer: Circle attests at "confirmed" instead of waiting for hard finality. */
export const FAST_FINALITY = 1000;

export const irisBase = (testnet: boolean) => (testnet ? "https://iris-api-sandbox.circle.com" : "https://iris-api.circle.com");

export const TOKEN_MESSENGER_V2_ABI = [
  {
    type: "function", name: "depositForBurnWithHook", stateMutability: "nonpayable", outputs: [],
    inputs: [
      { name: "amount", type: "uint256" }, { name: "destinationDomain", type: "uint32" }, { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" }, { name: "destinationCaller", type: "bytes32" }, { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" }, { name: "hookData", type: "bytes" },
    ],
  },
] as const;

/** A network can receive or send USDC through CCTP when it has CCTP contracts and Circle USDC as its stablecoin. */
export const cctpReady = (n: Network | undefined): n is Network & { cctp: NonNullable<Network["cctp"]>; stable: NonNullable<Network["stable"]> } =>
  !!n?.cctp && n.stable?.symbol === "USDC";

/** Networks an investor can bring USDC from to buy on `destChainId` (same mainnet/testnet side, never the network itself). */
export function sourcesFor(destChainId: number): Network[] {
  const dest = networkById(destChainId);
  if (!cctpReady(dest)) return [];
  return NETWORKS.filter((n) => n.id !== dest.id && n.testnet === dest.testnet && cctpReady(n));
}

export interface RouteFee {
  /** Fast Transfer protocol fee in basis points (fractional, e.g. 1.3). */
  fastBps: number;
  /** Circle Forwarding Service fee in USDC base units (6 decimals), the "high" quote for a safety margin. */
  forwardFee: bigint;
}

export async function fetchRouteFee(src: Network, dest: Network, f: typeof fetch = fetch): Promise<RouteFee> {
  if (!cctpReady(src) || !cctpReady(dest)) throw new Error("This route doesn't support Circle USDC transfers");
  const r = await f(`${irisBase(dest.testnet)}/v2/burn/USDC/fees/${src.cctp.domain}/${dest.cctp.domain}?forward=true`);
  if (!r.ok) throw new Error(`Circle fee quote failed (${r.status})`);
  const rows = (await r.json()) as { finalityThreshold: number; minimumFee: number; forwardFee?: { high: number } }[];
  const fast = rows.find((x) => x.finalityThreshold === FAST_FINALITY);
  if (!fast?.forwardFee) throw new Error("Circle doesn't forward USDC on this route");
  return { fastBps: fast.minimumFee, forwardFee: BigInt(fast.forwardFee.high) };
}

/** What to burn so `deliver` USDC (6-decimal units) lands on the destination: deliver + forwarding fee + fast fee,
 *  each rounded UP. maxFee caps what Circle may take; any unused part of it is delivered to the investor. */
export function burnFor(deliver: bigint, fee: RouteFee): { amount: bigint; maxFee: bigint } {
  if (deliver <= 0n) throw new Error("Amount must be more than zero");
  // Fast fee is charged on the burned amount; solve amount = deliver + forward + ceil(amount * bps / 10_000).
  const bpsScaled = BigInt(Math.ceil(fee.fastBps * 1000)); // bps with 3 decimals
  const base = deliver + fee.forwardFee;
  const amount = (base * 10_000_000n + (10_000_000n - bpsScaled) - 1n) / (10_000_000n - bpsScaled);
  return { amount, maxFee: amount - deliver };
}

export function burnArgs(dest: Network & { cctp: NonNullable<Network["cctp"]> }, srcUsdc: Address, recipient: Address, amount: bigint, maxFee: bigint) {
  return [amount, dest.cctp.domain, pad(recipient, { size: 32 }), srcUsdc, pad("0x", { size: 32 }), maxFee, FAST_FINALITY, FORWARD_HOOK] as const;
}

export type TransferStatus =
  | { state: "pending" } // Circle hasn't seen or attested the burn yet
  | { state: "attested" } // attested; the Forwarding Service is minting on the destination
  | { state: "delivered"; mintTx?: Hex };

/** Track a burn by its source transaction hash (Circle Iris /v2/messages). */
export async function fetchTransferStatus(src: Network, burnTx: Hex, f: typeof fetch = fetch): Promise<TransferStatus> {
  if (!cctpReady(src)) throw new Error("Not a Circle USDC network");
  const r = await f(`${irisBase(src.testnet)}/v2/messages/${src.cctp.domain}?transactionHash=${burnTx}`);
  if (r.status === 404) return { state: "pending" };
  if (!r.ok) throw new Error(`Circle status check failed (${r.status})`);
  // Observed live 2026-11-27 (Arc testnet → Fuji, 1 USDC, landed in 5s): status "pending_confirmations" → "complete";
  // once Circle has broadcast the mint, forwardState is "SENT" and forwardTxHash is the destination tx. The UI still
  // treats the destination USDC balance going up as the final word.
  const body = (await r.json()) as { messages?: { status?: string; forwardState?: string; forwardTxHash?: Hex }[] };
  const m = body.messages?.[0];
  if (!m || m.status !== "complete") return { state: "pending" };
  if (m.forwardTxHash) return { state: "delivered", mintTx: m.forwardTxHash };
  return { state: "attested" };
}
