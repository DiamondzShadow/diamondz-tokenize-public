// One "Connect wallet" control for the whole app. Uses thirdweb (email/Google/passkey, MetaMask, WalletConnect…)
// when the tenant has a thirdweb client id; otherwise a plain browser-wallet button.
import { Suspense, lazy, useState } from "react";
import { useTenant } from "./tenant";
import { connectWallet, hasWallet, useConnectedAccount, walletError } from "./wallet";

const WalletButton = lazy(() => import("./WalletButton"));

export default function Connect({ chainId, label, compact }: { chainId: number; label?: string; compact?: boolean }) {
  const { tenant } = useTenant();
  const account = useConnectedAccount();
  const [err, setErr] = useState("");
  const clientId = tenant?.auth.thirdwebClientId;

  if (clientId) {
    return (
      <Suspense fallback={<button className="btn ghost sm" disabled>Loading wallet…</button>}>
        <WalletButton clientId={clientId} chainId={chainId} sponsored={!!tenant?.auth.sponsoredChains?.includes(chainId)} label={label} compact={compact} />
      </Suspense>
    );
  }
  if (account) return <span className="pill" style={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-all", whiteSpace: "normal" }}>{account}</span>;
  if (!hasWallet()) {
    const here = typeof location !== "undefined" ? location.host + location.pathname : "";
    return (
      <div className="notice" style={{ fontSize: 13 }}>
        No wallet found. Install <a href="https://metamask.io/download/" target="_blank" rel="noreferrer">MetaMask</a>, or on a phone open this page in the{" "}
        <a href={`https://metamask.app.link/dapp/${here}`}>MetaMask app</a>.
      </div>
    );
  }
  return (
    <>
      <button className="btn primary sm" style={{ justifyContent: "center" }} onClick={() => connectWallet().then(() => setErr(""), (e) => setErr(walletError(e)))}>
        {label ?? "Connect wallet"}
      </button>
      {err && <div className="notice err">{err}</div>}
    </>
  );
}
