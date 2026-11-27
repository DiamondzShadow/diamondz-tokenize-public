// Investor "Your income" (design frames 15–16): payouts ready to claim (gas-free) and payouts already received.
import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { api, type Income } from "../lib/api";
import { NETWORKS, networkById, txUrl } from "../lib/chains";
import { useConnectedAccount } from "../lib/wallet";
import Connect from "../lib/Connect";
import { InvestorTabs, SiteHeader } from "../lib/Chrome";

const fmt = (v: string | bigint, d: number) => Number(formatUnits(BigInt(v), d)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

export default function Portfolio() {
  const account = useConnectedAccount();
  const [data, setData] = useState<{ claimable: Income[]; paid: (Income & { tx: string })[] } | null>(null);
  const [busy, setBusy] = useState<string>("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string; tx?: string; chainId?: number } | null>(null);

  const load = (a: string) => api.portfolio(a).then(setData, (e) => setMsg({ kind: "err", text: e.message }));
  useEffect(() => {
    setData(null);
    if (account) load(account);
  }, [account]);

  async function claim(items: Income[]) {
    if (!account) return;
    setMsg(null);
    for (const it of items) {
      setBusy(it.payoutId);
      try {
        const r = await api.claim(it.payoutId, account);
        setMsg({ kind: "ok", text: `Claimed: $${fmt(r.amount, it.decimals)} ${it.payoutSymbol} sent to your wallet.`, tx: r.tx, chainId: it.chainId });
      } catch (e: any) {
        setMsg({ kind: "err", text: e.message });
        break;
      }
    }
    setBusy("");
    load(account);
  }

  const toClaim = (data?.claimable ?? []).reduce((s, x) => s + Number(formatUnits(BigInt(x.amount), x.decimals)), 0);
  const received = (data?.paid ?? []).reduce((s, x) => s + Number(formatUnits(BigInt(x.amount), x.decimals)), 0);
  const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div className="page has-tabs">
      <SiteHeader />
      <InvestorTabs />
      <section className="wrap section" style={{ paddingTop: 40, gap: 24 }}>
        <div className="section-head">
          <span className="eyebrow">Portfolio</span>
          <h2>Your income</h2>
          <p>Payouts from the offerings you hold. Claiming is free: we pay the network fee. Anything you don't claim within 7 days is delivered to your wallet automatically.</p>
        </div>
        {!account && <div className="panel" style={{ maxWidth: 480 }}><Connect chainId={NETWORKS[0].id} label="Sign in to see your income" /></div>}
        {account && (
          <div className="lst-grid">
            <div className="lst-hero">
              <div className="panel">
                <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
                  <h3>Ready to claim</h3>
                  {(data?.claimable.length ?? 0) > 1 && <button className="btn primary sm" disabled={!!busy} onClick={() => claim(data!.claimable)}>Claim all · {money(toClaim)}</button>}
                </div>
                {!data && <span className="muted">Loading…</span>}
                {data && data.claimable.length === 0 && <span className="muted">Nothing to claim right now.</span>}
                {data?.claimable.map((it) => (
                  <div className="claim" key={it.payoutId}>
                    <div style={{ minWidth: 0 }}>
                      <span className="muted" style={{ fontSize: 13 }}>{it.assetName} · {it.memo}</span>
                      <b>${fmt(it.amount, it.decimals)} {it.payoutSymbol}</b>
                      <small>For {fmt(it.tokens, it.tokenDecimals ?? 18)} {it.symbol} held on {day(it.snapshotTime)} · claim by {day(it.claimDeadline)}</small>
                    </div>
                    <button className="btn primary sm" disabled={!!busy} onClick={() => claim([it])}>{busy === it.payoutId ? "Claiming…" : "Claim"}</button>
                  </div>
                ))}
              </div>
            </div>
            <div className="lst-aside">
              <div className="kpis" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
                <div className="kpi"><span>Received</span><b>{money(received)}</b><small>all time</small></div>
                <div className="kpi"><span>To claim</span><b>{money(toClaim)}</b><small style={{ color: "var(--warn)" }}>{data?.claimable.length ?? 0} payout{data?.claimable.length === 1 ? "" : "s"}</small></div>
              </div>
              {msg && (
                <div className={msg.kind === "ok" ? "ok-note" : "notice err"}>
                  {msg.kind === "ok" ? "✓ " : ""}{msg.text}{" "}
                  {msg.tx && msg.chainId && <a className="lnk" href={txUrl(networkById(msg.chainId)!, msg.tx)} target="_blank" rel="noreferrer">Transaction ↗</a>}
                </div>
              )}
              <p className="note">Payouts go to the wallet that held the tokens at the snapshot. Tax documents for your payouts are available from the issuer.</p>
            </div>
            <div className="lst-body">
              <div className="panel">
                <h3>Paid to you</h3>
                {data && data.paid.length === 0 && <span className="muted">No payouts received yet.</span>}
                {data?.paid.map((it) => (
                  <div className="li" key={it.payoutId}>
                    <span>{it.assetName} · {it.memo}
                      <small className="muted" style={{ display: "block", fontSize: 12 }}>{day(it.snapshotTime)} · <a className="lnk" href={txUrl(networkById(it.chainId)!, it.tx)} target="_blank" rel="noreferrer">Transaction ↗</a></small>
                    </span>
                    <span>${fmt(it.amount, it.decimals)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
