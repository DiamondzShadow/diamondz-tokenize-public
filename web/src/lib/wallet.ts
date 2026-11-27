// Browser wallet helpers (EIP-1193 injected wallets: MetaMask, Rabby, Coinbase Wallet extension…).
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  numberToHex,
  type Abi,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { useSyncExternalStore } from "react";
import artifacts from "../contracts/artifacts.json";
import { networkById, type Network } from "./chains";

type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown>; on?: (e: string, f: (...a: any[]) => void) => void; removeListener?: (e: string, f: (...a: any[]) => void) => void };
declare global {
  interface Window {
    ethereum?: Eip1193;
  }
}

export const ART = artifacts as Record<"InvestorRegistry" | "PermissionedToken" | "PrimarySale" | "TestUSD" | "AssetOracle" | "Distributor" | "PermissionedVault" | "PermissionedMultiToken" | "PrimarySale1155" | "PermissionedNFT" | "PrimarySale721" | "PrimarySale3643" | "OfferingRules" | "AssetRegistry" | "LicenseRegistry", { abi: Abi; bytecode: Hex }>;

// The active wallet connection. thirdweb sign-in (email/Google/passkey, MetaMask, WalletConnect…) registers itself
// here; without it we fall back to the injected browser wallet.
let activeProvider: Eip1193 | null = null;
let thirdweb: { forChain: (chainId: number) => Promise<Eip1193>; injected: Eip1193 | null } | null = null;
let connected: Address | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());

/** `injected` = the browser extension behind a thirdweb MetaMask/Rabby/Coinbase login (null for email/passkey/WalletConnect). */
export function setThirdwebConnection(conn: { account: Address; forChain: (chainId: number) => Promise<Eip1193>; injected?: Eip1193 | null } | null) {
  const changed = !conn || conn.account !== connected;
  thirdweb = conn ? { forChain: conn.forChain, injected: conn.injected ?? null } : null;
  connected = conn?.account ?? null;
  // A provider built for another login must never be reused for the new one.
  if (changed) activeProvider = null;
  emit();
}
/** Connected account (thirdweb or injected), for any component. */
export function useConnectedAccount(): Address | null {
  return useSyncExternalStore((f) => (listeners.add(f), () => listeners.delete(f)), () => connected);
}
export const thirdwebActive = () => !!thirdweb;
let thirdwebMode = false;
/** Called by the thirdweb Connect button on mount: from then on, transactions go through it only. */
export function setThirdwebMode() {
  thirdwebMode = true;
}
function provider(): Eip1193 {
  // Signed in through thirdweb: only ever use that connection. Falling back to window.ethereum here sends the tx
  // from the thirdweb account through an extension that never authorized it (EIP-1193 4100).
  if (thirdweb || thirdwebMode) {
    if (!activeProvider) throw new Error("Wallet connection was reset. Press the button again to reconnect.");
    return activeProvider;
  }
  const p = activeProvider ?? (typeof window !== "undefined" ? window.ethereum : undefined);
  if (!p) throw new Error("No wallet connected. Sign in or install a browser wallet.");
  return p;
}

const lc = (a: string[]) => (a ?? []).map((x) => x.toLowerCase());

/**
 * Make sure the browser extension that will sign is unlocked and has `account` selected and authorized for this site.
 * Without this, a locked MetaMask or one switched to another account rejects with 4100 "not been authorized".
 * Email/passkey/WalletConnect logins have no extension, so there is nothing to check.
 */
async function preflight(account: Address, chainId: number) {
  const ext = thirdweb ? thirdweb.injected : (activeProvider ?? (typeof window !== "undefined" ? window.ethereum : undefined));
  if (!ext) return;
  const want = account.toLowerCase();
  let accts = lc((await ext.request({ method: "eth_accounts" })) as string[]);
  // Locked or not permitted: ask the wallet (shows its unlock / connect prompt).
  if (!accts.includes(want)) accts = lc((await ext.request({ method: "eth_requestAccounts" })) as string[]);
  if (!accts.includes(want)) {
    throw new Error(
      `Your wallet is on ${accts[0] ?? "no account"} but you're signed in here as ${account}. ` +
        `Switch your wallet to ${account} (or disconnect and reconnect here), then press the button again.`,
    );
  }
  // MetaMask grants each site a list of networks. A site allowed the account but not this network gets 4100 on
  // eth_sendTransaction. Switching the extension itself to the network shows MetaMask's "allow network" prompt.
  const current = Number(await ext.request({ method: "eth_chainId" }));
  if (current !== chainId) {
    const n = networkById(chainId)!;
    try {
      await ext.request({ method: "wallet_switchEthereumChain", params: [{ chainId: numberToHex(chainId) }] });
    } catch (e: any) {
      if (e?.code !== 4902 && !String(e?.message).includes("Unrecognized chain")) throw tag(e, `switching your wallet to ${n.name}`);
      await ext.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: numberToHex(chainId), chainName: n.name, nativeCurrency: n.native, rpcUrls: [n.rpc], blockExplorerUrls: [n.explorer] }],
      }).catch((e2) => { throw tag(e2, `adding ${n.name} to your wallet`); });
    }
  }
}

const isUnauthorized = (e: any) =>
  e?.code === 4100 || e?.cause?.code === 4100 || /not been authorized/i.test(`${e?.message ?? ""} ${e?.details ?? ""}`);

/**
 * MetaMask lets a site use an account but only on the networks the user ticked when connecting. Sending on any other
 * network fails with 4100 even though eth_accounts and eth_chainId look fine. Ask the extension to re-grant the
 * account together with this network (MetaMask shows its connect dialog with the network pre-selected).
 * Returns false when there is no extension to ask (email/passkey/WalletConnect).
 */
async function regrant(chainId: number): Promise<boolean> {
  const ext = thirdweb ? thirdweb.injected : (activeProvider ?? (typeof window !== "undefined" ? window.ethereum : undefined));
  if (!ext) return false;
  const chain = numberToHex(chainId);
  try {
    await ext.request({
      method: "wallet_requestPermissions",
      params: [{ eth_accounts: {}, "endowment:permitted-chains": { caveats: [{ type: "restrictNetworkSwitching", value: [chain] }] } }],
    });
  } catch (e: any) {
    if (e?.code === 4001) throw e;
    // Wallets without per-site networks reject the MetaMask-specific permission: re-grant the account only.
    await ext.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
  }
  await ext.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chain }] }).catch(() => {});
  return true;
}

/** Run a wallet send; if the wallet says the site isn't authorized, re-grant this network once and retry. */
async function withRegrant<T>(chainId: number, account: Address, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (!isUnauthorized(e) || !(await regrant(chainId).catch(() => false))) throw e;
    if (thirdweb) activeProvider = await thirdweb.forChain(chainId);
    await preflight(account, chainId);
    return run();
  }
}

/** Remember which wallet request failed, so the error shown says so. */
function tag(e: any, during: string) {
  if (e && typeof e === "object") e.during = during;
  return e;
}

export function hasWallet() {
  return !!thirdweb || !!activeProvider || (typeof window !== "undefined" && !!window.ethereum);
}

export function toViemChain(n: Network): Chain {
  return {
    id: n.id,
    name: n.name,
    nativeCurrency: n.native,
    rpcUrls: { default: { http: [n.rpc] } },
    blockExplorers: { default: { name: "Explorer", url: n.explorer } },
    testnet: n.testnet,
  };
}

export function publicClientFor(chainId: number) {
  const n = networkById(chainId);
  if (!n) throw new Error(`Unsupported network ${chainId}`);
  // Reads go through our read-only proxy (api/src/rpcproxy.ts → Uniblock), which also serves chains whose public RPCs
  // refuse log queries (Arbitrum). Falls back to the public RPC outside a browser (scripts, tests).
  const url = typeof location !== "undefined" && location.origin.startsWith("http") ? `${location.origin}/api/rpc/${n.id}` : n.rpc;
  return createPublicClient({ chain: toViemChain(n), transport: http(url) });
}

export async function connectWallet(): Promise<Address> {
  if (thirdweb || thirdwebMode) {
    if (!thirdweb || !connected) throw new Error("Connect your wallet first with the Connect wallet button.");
    return connected;
  }
  const accts = (await provider().request({ method: "eth_requestAccounts" })) as string[];
  if (!accts[0]) throw new Error("No account selected in your wallet");
  connected = accts[0] as Address;
  emit();
  return connected;
}

/** Switch the wallet to `chainId`, adding the network first if the wallet doesn't know it. */
export async function ensureChain(chainId: number) {
  if (thirdweb) {
    // thirdweb's EIP-1193 adapter is bound to one chain: switch the wallet, then rebuild the adapter.
    activeProvider = await thirdweb.forChain(chainId);
    return;
  }
  const eth = provider();
  const n = networkById(chainId)!;
  const current = Number(await eth.request({ method: "eth_chainId" }));
  if (current === chainId) return;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: numberToHex(chainId) }] });
  } catch (e: any) {
    if (e?.code !== 4902 && !String(e?.message).includes("Unrecognized chain")) throw e;
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: numberToHex(chainId), chainName: n.name, nativeCurrency: n.native, rpcUrls: [n.rpc], blockExplorerUrls: [n.explorer] }],
    });
  }
}

export function walletClientFor(chainId: number, account: Address) {
  const n = networkById(chainId)!;
  return createWalletClient({ account, chain: toViemChain(n), transport: custom(provider()) });
}

/** Deploy a contract and wait for it. Returns its address and the tx hash. */
export async function deploy(chainId: number, account: Address, name: keyof typeof ART, args: unknown[]) {
  await ensureChain(chainId);
  await preflight(account, chainId);
  const pc = publicClientFor(chainId);
  const hash = await withRegrant(chainId, account, () => {
    const wc = walletClientFor(chainId, account);
    return wc.deployContract({ abi: ART[name].abi, bytecode: ART[name].bytecode, args, account, chain: wc.chain });
  }).catch((e) => { throw tag(e, `sending the ${name} deployment`); });
  const rcpt = await pc.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (rcpt.status !== "success" || !rcpt.contractAddress) throw new Error(`${name} deployment failed (tx ${hash})`);
  return { address: rcpt.contractAddress, hash };
}

/** Send a contract call and wait for it to be mined successfully. */
export async function send(chainId: number, account: Address, address: Address, abi: Abi, functionName: string, args: unknown[]) {
  await ensureChain(chainId);
  await preflight(account, chainId);
  const pc = publicClientFor(chainId);
  const hash = await withRegrant(chainId, account, () => {
    const wc = walletClientFor(chainId, account);
    return wc.writeContract({ address, abi, functionName, args, account, chain: wc.chain });
  }).catch((e) => { throw tag(e, `sending ${functionName}`); });
  const rcpt = await pc.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (rcpt.status !== "success") throw new Error(`${functionName} failed (tx ${hash})`);
  return hash;
}

/** Turn wallet/RPC errors into one readable sentence. */
export function walletError(e: unknown): string {
  const any = e as { shortMessage?: string; message?: string; details?: string; code?: number; during?: string; cause?: { code?: number; message?: string } };
  const where = any?.during ? ` (while ${any.during})` : "";
  if (isUnauthorized(any)) {
    const raw = (any?.details ?? any?.cause?.message ?? "").slice(0, 200);
    return (
      `Your wallet refused the request${where}. Open your wallet, make sure it's unlocked, on the signed-in account, ` +
      `and that this site is allowed to use this network (MetaMask: click the site icon at the top of the extension → Edit networks → tick this network). ` +
      `Signed in through WalletConnect? Disconnect and reconnect so your phone wallet approves this network. Then press the button again.` +
      (raw ? ` Wallet said: "${raw}"` : "")
    );
  }
  if (any?.code === 4001 || /rejected|denied/i.test(any?.message ?? "")) return "You canceled the request in your wallet.";
  if (/insufficient funds/i.test(any?.message ?? "")) return "Your wallet doesn't have enough gas on this network.";
  return (any?.shortMessage ?? any?.message ?? String(e)) + where;
}

export const ROLES = {
  ADMIN: "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
};
