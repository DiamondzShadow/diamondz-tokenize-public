// /client/:token — a client's private page from their advisor (design 4, 2026-11-20). No account: the link plus a
// signature from the client's own wallet. The client sees what the firm can see, the proposals waiting for them,
// and approves or declines each; approving opens the normal investor flow, where they buy from their own wallet.
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { SiteHeader } from "../lib/Chrome";
import Connect from "../lib/Connect";
import { DEFAULT_CHAIN_ID } from "../lib/chains";
import { ensureChain, useConnectedAccount, walletClientFor, walletError } from "../lib/wallet";

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export default function ClientPortal() {
  const { token = "" } = useParams();
  const account = useConnectedAccount();
  const [p, setP] = useState<Awaited<ReturnType<typeof api.portal>> | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const load = () => api.portal(token).then(setP, (e) => setErr(e.message));
  useEffect(() => { load(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const linkWallet = async () => {
    if (!account || !p) return;
    setBusy("link"); setErr("");
    try {
      await ensureChain(DEFAULT_CHAIN_ID);
      const signature = await walletClientFor(DEFAULT_CHAIN_ID, account).signMessage({ account, message: p.message.replace("{wallet}", account) });
      await api.portalLink(token, { wallet: account, chainId: DEFAULT_CHAIN_ID, signature });
      await load();
    } catch (e) { setErr(walletError(e)); } finally { setBusy(""); }
  };
  const decide = async (id: string, d: "approve" | "decline") => {
    setBusy(id); setErr("");
    try {
      const r = await api.portalDecide(token, id, d);
      if (r.investUrl) location.assign(r.investUrl.replace(/\?.*$/, ""));
      else await load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  };

  return (
    <div className="page">
      <SiteHeader />
      <main className="wrap" style={{ maxWidth: 760, margin: "0 auto", padding: "40px 16px 80px", display: "flex", flexDirection: "column", gap: 20 }}>
        {err && <div className="notice err">{err}</div>}
        {!p ? (!err && <p className="muted">Loading…</p>) : <>
          <div>
            <span className="eyebrow">Your client page</span>
            <h1 style={{ fontFamily: "var(--font-display)", fontWeight: "var(--heading-weight)" as any, fontSize: 38, margin: "8px 0 0" }}>Hello, {p.name}</h1>
            <p className="muted" style={{ margin: "8px 0 0", lineHeight: 1.55 }}>{p.firm} manages your tokenized investments with you. You keep your own wallet and approve every purchase yourself.</p>
          </div>
          {!p.wallet ? (
            <section className="panel">
              <h3>1. Connect your wallet</h3>
              <p className="muted" style={{ margin: 0, fontSize: 14 }}>Use any wallet, or create one with your email or Google. It stays yours; {p.firm} can never move it.</p>
              <div style={{ maxWidth: 320 }}><Connect chainId={DEFAULT_CHAIN_ID} label="Connect wallet" /></div>
              <h3>2. Share your holdings with {p.firm}</h3>
              <pre className="consent">{p.message.replace("{wallet}", account ?? "(your wallet)")}</pre>
              <button className="btn primary" disabled={!account || busy === "link"} onClick={linkWallet} style={{ alignSelf: "flex-start" }}>{busy === "link" ? "Confirm in your wallet…" : "Sign and share"}</button>
            </section>
          ) : (
            <div className="notice ok">Wallet connected and shared with {p.firm}: <span className="mono" style={{ wordBreak: "break-all" }}>{p.wallet}</span></div>
          )}
          <section className="panel">
            <h3>Proposals from {p.firm}</h3>
            {!p.proposals.length ? <span className="muted" style={{ fontSize: 14 }}>Nothing waiting for you.</span> : p.proposals.map((x) => (
              <div key={x.id} className="row between alloc-row" style={{ flexWrap: "wrap" }}>
                <span><b>{x.assetName}</b> · {usd(x.amountUsd)}<br /><Link to={`/market/${x.assetId}`} className="lnk" style={{ fontSize: 13 }}>Read the offering first →</Link></span>
                {x.status === "proposed" ? (
                  <span className="row" style={{ gap: 8 }}>
                    <button className="btn ghost sm" disabled={!!busy} onClick={() => decide(x.id, "decline")}>Decline</button>
                    <button className="btn primary sm" disabled={!!busy || !p.wallet} onClick={() => decide(x.id, "approve")}>Approve and invest</button>
                  </span>
                ) : <span className={`role-chip ${x.status === "approved" ? "r-compliance" : ""}`}>{x.status === "approved" ? "Approved" : "Declined"}</span>}
              </div>
            ))}
            <small className="muted">Approving takes you to the offering's investor steps, where you buy from your own wallet. You can still change your mind there.</small>
          </section>
        </>}
      </main>
    </div>
  );
}
