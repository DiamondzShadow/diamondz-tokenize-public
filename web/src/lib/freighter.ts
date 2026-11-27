// Freighter (Stellar wallet extension) for the Stellar edition (designs X2–X4).
import { getNetworkDetails, isConnected, requestAccess, signTransaction } from "@stellar/freighter-api";
import type { StellarNetwork } from "./chains";

export const FREIGHTER_URL = "https://www.freighter.app/";

/** Connects Freighter and checks it is on the offering's network. Returns the account (G…). */
export async function connectFreighter(net: StellarNetwork): Promise<string> {
  const c = await isConnected().catch(() => ({ isConnected: false }));
  if (!c.isConnected) throw new Error("Freighter isn't installed in this browser.");
  const acc = await requestAccess();
  if (acc.error || !acc.address) throw new Error(acc.error?.message ?? "Freighter didn't share an account.");
  const nd = await getNetworkDetails();
  if (nd.error) throw new Error(nd.error.message ?? "Couldn't read Freighter's network.");
  if (nd.networkPassphrase !== net.passphrase) throw new Error(`Switch Freighter to ${net.testnet ? "Testnet" : "Mainnet"} (it's on ${nd.network}).`);
  return acc.address;
}

/** Asks Freighter to sign a prepared transaction for this account. Returns the signed XDR. */
export async function signWithFreighter(net: StellarNetwork, xdr: string, address: string): Promise<string> {
  const r = await signTransaction(xdr, { networkPassphrase: net.passphrase, address });
  if (r.error || !r.signedTxXdr) throw new Error(r.error?.message ?? "Freighter didn't sign.");
  return r.signedTxXdr;
}
