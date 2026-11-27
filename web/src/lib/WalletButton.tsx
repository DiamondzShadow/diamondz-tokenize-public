// "Connect wallet" via thirdweb: email, Google, Apple or passkey (creates a wallet), MetaMask, Coinbase, Rabby,
// or any mobile wallet through WalletConnect's QR code. Lazy-loaded so pages without it don't ship the SDK.
// The surrounding <ThirdwebProvider> is mounted once in main.tsx so one connection is shared across the app.
// No `chain=` prop on ConnectButton: it nags the wallet back to that chain; deploy/buy switch when they need to.
import { useEffect, useMemo } from "react";
import { createThirdwebClient, defineChain, type Chain } from "thirdweb";
import { ConnectButton, useActiveWallet, useActiveWalletConnectionStatus, useConnect } from "thirdweb/react";
import { EIP1193, createWallet, inAppWallet, injectedProvider, walletConnect } from "thirdweb/wallets";
import type { Address } from "viem";
import { NETWORKS, networkById } from "./chains";
import { setThirdwebConnection, setThirdwebMode } from "./wallet";

const clients = new Map<string, ReturnType<typeof createThirdwebClient>>();
const clientFor = (id: string) => {
  if (!clients.has(id)) clients.set(id, createThirdwebClient({ clientId: id }));
  return clients.get(id)!;
};
const chainFor = (id: number): Chain => {
  const n = networkById(id)!;
  return defineChain({ id: n.id, rpc: n.rpc, name: n.name, nativeCurrency: n.native, testnet: n.testnet || undefined, blockExplorers: [{ name: "Explorer", url: n.explorer }] });
};
const ALL_CHAINS = NETWORKS.map((n) => chainFor(n.id));


interface Props {
  clientId: string;
  /** Network this button should start on (the asset's chain). */
  chainId: number;
  /** thirdweb project pays gas on this chain (EIP-7702). Otherwise in-app wallets are plain EOAs. */
  sponsored?: boolean;
  label?: string;
  compact?: boolean;
}

export default function WalletButton({ clientId, chainId, sponsored = false, label = "Connect wallet", compact }: Props) {
  const client = clientFor(clientId);
  const chain = useMemo(() => chainFor(chainId), [chainId]);
  const wallets = useMemo(
    () => [
      inAppWallet({
        auth: { options: ["email", "google", "apple", "passkey"] },
        ...(sponsored ? { executionMode: { mode: "EIP7702" as const, sponsorGas: true } } : {}),
      }),
      createWallet("io.metamask"),
      createWallet("com.coinbase.wallet"),
      createWallet("io.rabby"),
      walletConnect(),
    ],
    [sponsored],
  );
  const wallet = useActiveWallet();
  const status = useActiveWalletConnectionStatus();
  const { connect } = useConnect();
  useEffect(() => setThirdwebMode(), []);

  // thirdweb's modal connects MetaMask from a delayed effect, so MetaMask can queue the request and the login
  // never completes (and autoConnect won't retry it). When the user comes back to the tab, silently check
  // eth_accounts (read-only, never prompts) and finish the connection if MetaMask already approved this site.
  useEffect(() => {
    const recover = async () => {
      if (wallet || !window.ethereum) return;
      try {
        const accts = (await window.ethereum.request({ method: "eth_accounts" })) as string[];
        if (!accts?.length) return;
        await connect(async () => {
          const w = createWallet("io.metamask");
          await w.connect({ client });
          return w;
        });
      } catch {
        /* user can still click Connect */
      }
    };
    const onVis = () => document.visibilityState === "visible" && recover();
    window.addEventListener("focus", recover);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("focus", recover);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [wallet, connect, client]);

  // Register the connection with lib/wallet so deploy/buy code can use it.
  useEffect(() => {
    if (status === "connecting") return;
    const account = wallet?.getAccount()?.address as Address | undefined;
    if (!wallet || status !== "connected" || !account) {
      setThirdwebConnection(null);
      return;
    }
    // Extension wallets (MetaMask/Rabby/Coinbase): hand lib/wallet the raw extension so it can check it's unlocked
    // and on this account before each transaction. In-app (email/passkey) and WalletConnect have none.
    const injected = wallet.id.includes(".") && wallet.id !== "walletConnect" ? (injectedProvider(wallet.id as any) ?? null) : null;
    setThirdwebConnection({
      account,
      injected: injected as any,
      forChain: async (id: number) => {
        const c = chainFor(id);
        if (wallet.getChain()?.id !== id) await wallet.switchChain(c);
        return EIP1193.toProvider({ wallet, chain: c, client }) as any;
      },
    });
  }, [wallet, status, client]);

  return (
    <ConnectButton
      client={client}
      wallets={wallets}
      chains={[chain, ...ALL_CHAINS.filter((c) => c.id !== chain.id)]}
      theme="dark"
      connectButton={{ label, style: compact ? { minWidth: 0, width: "100%", fontSize: 14 } : { width: "100%" } }}
      connectModal={{ size: "compact", title: label, showThirdwebBranding: false }}
      detailsButton={{ style: { width: "100%" } }}
    />
  );
}
