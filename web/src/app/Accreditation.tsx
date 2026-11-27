// Issuer: review accredited-investor reports from Mastercard Open Finance (design canvas UzMg5WJ2BGKFGCzBaWkMRu, A4).
// The summary is numbers only; owner names and institutions are fetched live from Mastercard when a request is opened.
// Approving hands the wallet to the Investors panel, where the issuer verifies it as usual (KYC claim / registry).
import { useCallback, useEffect, useState } from "react";
import { api, type AccreditationAdmin, type Asset } from "../lib/api";

const usd = (n?: number) => (n === undefined ? "—" : n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }));

type Detail = Awaited<ReturnType<typeof api.accreditationReport>>;

export default function AccreditationPanel({ asset, onApprove }: { asset: Asset; onApprove: (wallet: string) => void }) {
  const [rows, setRows] = useState<AccreditationAdmin[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.accreditations(asset.id).then(setRows, (e) => setMsg({ kind: "err", text: e.message })), [asset.id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    setDetail(null);
    if (!open) return;
    api.accreditationReport(open).then(setDetail, (e) => setMsg({ kind: "err", text: e.message }));
  }, [open]);

  async function decide(id: string, decision: "approve" | "decline" | "more") {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.accreditationDecision(id, decision);
      await load();
      if (decision === "approve") {
        onApprove(r.wallet);
        setMsg({ kind: "ok", text: "Approved. The wallet is filled in under Investors: verify it there to let them buy." });
      } else {
        setMsg({ kind: "ok", text: decision === "decline" ? "Declined." : "Marked as needing more information. Contact the investor directly." });
      }
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const sel = rows?.find((r) => r.id === open) ?? null;
  const s = sel?.summary;
  return (
    <div className="panel">
      <h3>Accreditation requests</h3>
      <p className="muted" style={{ fontSize: 14 }}>Reports prepared by Mastercard Open Finance at the investor's written instruction. You decide; the report supports your review.</p>
      {rows === null ? <span className="muted">Loading…</span> : rows.length === 0 ? (
        <span className="muted">No requests yet. Investors start one from your listing's buy panel when their wallet isn't verified.</span>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="tbl">
            <thead><tr><th>Wallet</th><th>Route</th><th>Status</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={open === r.id ? { background: "var(--brand-soft)" } : undefined}>
                  <td style={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}>{r.wallet}</td>
                  <td>{r.route === "income" ? "Income" : "Assets"}</td>
                  <td>
                    {r.decision === "approved" ? <span className="tag g">Approved</span>
                      : r.decision === "declined" ? <span className="tag">Declined</span>
                      : r.decision === "more" ? <span className="tag y">More info</span>
                      : r.status === "ready" ? <span className="tag y">To review</span>
                      : r.status === "failed" ? <span className="tag">Failed</span>
                      : <span className="tag">Preparing</span>}
                  </td>
                  <td><button className="btn ghost sm" onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? "Close" : "Review"}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {sel && (
        <div className="panel" style={{ background: "var(--surface2)" }}>
          <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
            <div>
              <b style={{ fontSize: 17 }}>{detail?.owners?.length ? detail.owners.join(", ") : sel.status === "ready" ? "Reading from Mastercard…" : "Report not ready yet"}</b><br />
              <small className="muted">Mastercard {sel.route === "income" ? "Verification of Income" : "Verification of Assets"}{s?.preparedAt ? ` · prepared ${new Date(s.preparedAt).toLocaleString()}` : ""}</small>
            </div>
          </div>
          {s && sel.route === "income" && (
            <>
              <div className="form3" style={{ gridTemplateColumns: "1fr 1fr" }}>
                <div><b style={{ fontSize: 24 }}>{usd(s.incomeLast12)}</b><br /><small className="muted">Gross income, last 12 months</small></div>
                <div><b style={{ fontSize: 24 }}>{usd(s.incomePrior12)}</b><br /><small className="muted">Gross income, prior 12 months</small></div>
              </div>
              <div className="li"><span className="muted">Test</span><span>Over $200,000 in each of 2 years ($300,000 joint: review manually)</span></div>
              <div className="li"><span className="muted">Months of history</span><span>{s.monthsObserved}</span></div>
              <div className="li"><span className="muted">Income streams</span><span>{s.incomeStreams}</span></div>
            </>
          )}
          {s && sel.route === "assets" && (
            <>
              <div className="form3" style={{ gridTemplateColumns: "1fr 1fr" }}>
                <div><b style={{ fontSize: 24 }}>{usd(s.assetsCurrent)}</b><br /><small className="muted">Balances across linked accounts</small></div>
                <div><b style={{ fontSize: 24 }}>{usd(s.assetsTwoMonthAvg)}</b><br /><small className="muted">Two-month average</small></div>
              </div>
              <div className="notice">Mastercard reports balances, not debts. For the net-worth test, also get a credit report or the investor's written statement of liabilities, as your counsel advises.</div>
            </>
          )}
          {s && (
            <div className="li">
              <span className="muted">Reading</span>
              {s.reading === "meets" ? <span className="tag g">{sel.route === "income" ? "Meets the income test" : "Balances over $1,000,000"}</span>
                : s.reading === "insufficient-history" ? <span className="tag y">Less than 24 months of income history</span>
                : <span className="tag y">Below the threshold</span>}
            </div>
          )}
          {s && <div className="li"><span className="muted">Accounts linked</span><span>{s.accounts} at {s.institutions} institution{s.institutions === 1 ? "" : "s"}</span></div>}
          {detail?.institutions?.map((i) => (
            <div className="li" key={i.name}><span className="muted">{i.name}</span><span>{i.accounts.map((a) => `${a.type}${a.last4 ? ` ending ${a.last4}` : ""}`).join(", ")}</span></div>
          ))}
          <div className="li"><span className="muted">Consent</span><span>Written instruction (FCRA 1W), {new Date(sel.consentAt).toLocaleString()}</span></div>
          <div className="notice">You decide. Your counsel sets the rules for this offering. We keep the report reference and this summary, not the investor's bank data.</div>
          {sel.status === "ready" && !sel.decision && (
            <div className="row" style={{ flexWrap: "wrap" }}>
              <button className="btn primary sm" disabled={busy} onClick={() => decide(sel.id, "approve")}>Approve and verify wallet</button>
              <button className="btn ghost sm" disabled={busy} onClick={() => decide(sel.id, "more")}>Ask for more</button>
              <button className="btn ghost sm" style={{ color: "var(--bad)" }} disabled={busy} onClick={() => decide(sel.id, "decline")}>Decline</button>
            </div>
          )}
          {sel.decision && <small className="muted">Decision: {sel.decision}{sel.decidedBy ? ` by ${sel.decidedBy}` : ""}{sel.decidedAt ? `, ${new Date(sel.decidedAt).toLocaleString()}` : ""}</small>}
        </div>
      )}
      {msg && <div className={`notice ${msg.kind}`}>{msg.text}</div>}
    </div>
  );
}
