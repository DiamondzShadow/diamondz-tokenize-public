// Issuer: proof of asset from the SPV's bank account via Stripe Financial Connections or Mastercard Open Finance
// (design canvas UzMg5WJ2BGKFGCzBaWkMRu, A5; Stripe added 2026-11-20).
// The platform reads deposits directly; the issuer can't edit them. When last month's income meets the expectation,
// the platform's data source signs the offering's income check on chain.
import { useCallback, useEffect, useState } from "react";
import { Connect as McConnect } from "connect-web-sdk";
import { api, type Asset, type BankProof } from "../lib/api";
import { txUrl, type Network } from "../lib/chains";
import { useProof } from "../lib/Proof";
import { kindHash, type CheckKindId } from "../lib/verification";
import Connect from "../lib/Connect";
import { ART, connectWallet, ensureChain, send, walletError } from "../lib/wallet";

// Stripe.js must load from js.stripe.com (Stripe's rule); only on demand, when the issuer links a bank.
let stripeJs: Promise<any> | null = null;
function loadStripe(pk: string) {
  stripeJs ??= new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = "https://js.stripe.com/v3/";
    el.onload = () => resolve((window as any).Stripe(pk));
    el.onerror = () => { stripeJs = null; reject(new Error("Couldn't load Stripe. Check your connection and try again.")); };
    document.head.appendChild(el);
  });
  return stripeJs;
}

const usd = (cents: number) => (cents / 100).toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });

export default function BankProofPanel({ asset, net }: { asset: Asset; net: Network }) {
  const [b, setB] = useState<BankProof | null>(null);
  const [accounts, setAccounts] = useState<{ id: string; name: string; type: string; last4: string }[] | null>(null);
  const [form, setForm] = useState({ accountId: "", expected: "", payers: "" });
  const [msg, setMsg] = useState<{ kind: "ok" | "err" | ""; text: string; tx?: string } | null>(null);
  const [busy, setBusy] = useState("");
  const proof = useProof(asset.id, 0);

  const load = useCallback(() => api.bank(asset.id).then((r) => {
    setB(r);
    setForm((f) => ({ accountId: r.accountId ?? f.accountId, expected: r.expectedMonthly != null ? String(r.expectedMonthly) : f.expected, payers: (r.payers ?? []).join(", ") || f.payers }));
  }, (e) => setMsg({ kind: "err", text: e.message })), [asset.id]);
  useEffect(() => { load(); }, [load]);

  async function connectStripe() {
    setBusy("stripe");
    setMsg(null);
    try {
      const cfg = await api.stripeFcConfig();
      if (!cfg.publishableKey) throw new Error("Stripe bank linking isn't configured yet");
      const stripe = await loadStripe(cfg.publishableKey);
      const { clientSecret, sessionId } = await api.bankStripeSession(asset.id);
      const r = await stripe.collectFinancialConnectionsAccounts({ clientSecret });
      if (r.error) throw new Error(r.error.message ?? "Stripe couldn't link the account");
      if (!r.financialConnectionsSession?.accounts?.length) { setBusy(""); return; } // closed without linking
      setAccounts((await api.bankStripeLinked(asset.id, sessionId)).accounts);
      await load();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally { setBusy(""); }
  }

  async function connect() {
    setBusy("connect");
    setMsg(null);
    try {
      const { link } = await api.bankConnect(asset.id);
      McConnect.launch(link, {
        onDone: async () => {
          try { setAccounts((await api.bankLinked(asset.id)).accounts); await load(); } catch (e) { setMsg({ kind: "err", text: (e as Error).message }); }
          setBusy("");
        },
        onCancel: () => setBusy(""),
        onError: () => { setBusy(""); setMsg({ kind: "err", text: "Mastercard's window reported an error. Try again." }); },
        onRoute: () => {}, onUser: () => {}, onLoad: () => {},
      }, { overlay: "rgba(20,23,28,0.6)" });
    } catch (e) {
      setBusy("");
      setMsg({ kind: "err", text: (e as Error).message });
    }
  }

  async function saveSettings() {
    setBusy("save");
    setMsg(null);
    try {
      await api.bankSettings(asset.id, { accountId: form.accountId, expectedMonthly: Number(form.expected), payers: form.payers.split(",").map((p) => p.trim()).filter(Boolean) });
      await load();
      setMsg({ kind: "ok", text: "Saved. The platform re-reads the account daily and signs once a month's income is in." });
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally { setBusy(""); }
  }

  async function checkNow() {
    setBusy("check");
    setMsg(null);
    try {
      const r = await api.bankCheck(asset.id);
      setMsg(r.signed ? { kind: "ok", text: `Signed ${b?.kindName.toLowerCase()} for ${monthName(r.month!)}.`, tx: r.tx } : { kind: "", text: r.reason ?? "Not signed." });
      await load();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally { setBusy(""); }
  }

  // The income check only gates/shows if the offering registered it; the token admin can add it (one transaction).
  const registered = !!proof?.checks.some((c) => c.kind === b?.kind);
  async function addKind() {
    if (!proof?.oracle || !b || !asset.deployment) return;
    setBusy("kind");
    try {
      const me = await connectWallet();
      await ensureChain(net.id);
      const h = await send(net.id, me, proof.oracle as `0x${string}`, ART.AssetOracle.abi, "addKind", [asset.deployment.token, kindHash(b.kind as CheckKindId)]);
      setMsg({ kind: "ok", text: `${b.kindName} added to this offering's checks.`, tx: h });
    } catch (e) {
      setMsg({ kind: "err", text: walletError(e) });
    } finally { setBusy(""); }
  }

  if (!b) return null;
  const linkedAccounts = accounts ?? (b.accountId ? [{ id: b.accountId, name: b.accountLabel ?? "Linked account", type: "", last4: "" }] : []);
  const expectedCents = b.expectedMonthly ? Math.round(b.expectedMonthly * 100) : null;
  return (
    <div className="panel">
      <h3>{b.kindName}, read from the bank</h3>
      <p className="muted" style={{ fontSize: 14 }}>
        Link the SPV's operating account through {b.provider === "mastercard" ? "Mastercard Open Finance" : b.provider === "stripe" ? "Stripe" : "Stripe or Mastercard"}. The platform reads deposits directly; you can't edit them. When last month's income meets what you expect, the platform signs the {b.kindName.toLowerCase()} check on chain, valid {b.maxDays} days.
      </p>
      {proof && !registered && (
        <div className="notice">
          This offering doesn't list {b.kindName.toLowerCase()} among its checks yet, so a signed check won't show on the listing.{" "}
          <span style={{ display: "block", maxWidth: 320, margin: "8px 0" }}><Connect chainId={net.id} label="Connect the token admin wallet" /></span>
          <button className="btn ghost sm" disabled={!!busy} onClick={addKind}>{busy === "kind" ? "Confirm in wallet…" : `Add ${b.kindName.toLowerCase()} to this offering`}</button>
        </div>
      )}
      {!b.linked && (
        <div className="row" style={{ flexWrap: "wrap" }}>
          {b.stripeAvailable && b.provider !== "mastercard" && <button className="btn primary sm" disabled={!!busy} onClick={connectStripe}>{busy === "stripe" ? "Opening Stripe…" : "Link the SPV account with Stripe"}</button>}
          {b.provider !== "stripe" && <button className={`btn ${b.stripeAvailable ? "ghost" : "primary"} sm`} disabled={!!busy} onClick={connect}>{busy === "connect" ? "Opening Mastercard…" : "Link with Mastercard"}</button>}
        </div>
      )}
      {b.linked && (
        <>
          <div className="form3" style={{ gridTemplateColumns: "2fr 1fr" }}>
            <label className="field">Account
              <select className="input" value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>
                <option value="">Choose…</option>
                {linkedAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.last4 ? ` ending ${a.last4}` : ""}</option>)}
              </select>
            </label>
            <label className="field">Expected monthly income (USD)<input className="input" inputMode="decimal" value={form.expected} onChange={(e) => setForm({ ...form, expected: e.target.value.replace(/[^\d.]/g, "") })} /></label>
          </div>
          <label className="field">{b.provider === "stripe" ? "Only count these payers (optional, comma-separated)" : "Payers that count (optional, comma-separated)"}<input className="input" value={form.payers} placeholder="e.g. Harbor Tenants LLC, Property Manager Inc" onChange={(e) => setForm({ ...form, payers: e.target.value })} /></label>
          <small className="muted">{b.provider === "stripe"
            ? "You don't need to name anyone: we count deposits from regular payers (anyone who paid in 2 or more months) automatically. One-off deposits and transfers between your own accounts never count. Name payers only to narrow it further."
            : "With no payers marked, deposits Mastercard categorizes as income count. Transfers between your own accounts never count."}</small>
          {b.provider === "stripe" && b.depositors && b.depositors.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table className="tbl">
                <thead><tr><th>Who deposits</th><th>Months</th><th>Total, last 4 months</th><th>Counts?</th></tr></thead>
                <tbody>{b.depositors.map((d) => {
                  const named = form.payers.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
                  const counts = named.length ? named.some((n) => d.name.toLowerCase().includes(n)) : d.regular;
                  return <tr key={d.name}><td>{d.name}</td><td>{d.months}</td><td>{usd(d.cents)}</td><td>{counts ? <span className="tag g">Counts</span> : <span className="tag">{named.length ? "Not named" : "One-off"}</span>}</td></tr>;
                })}</tbody>
              </table>
            </div>
          )}
          <div className="row" style={{ flexWrap: "wrap" }}>
            <button className="btn primary sm" disabled={!form.accountId || !(Number(form.expected) > 0) || !!busy} onClick={saveSettings}>{busy === "save" ? "Saving…" : "Save"}</button>
            <button className="btn ghost sm" disabled={!b.accountId || !!busy} onClick={checkNow}>{busy === "check" ? "Reading the bank…" : `Check ${monthName(b.lastCompleteMonth)} now`}</button>
            <button className="btn ghost sm" disabled={!!busy} onClick={b.provider === "stripe" ? connectStripe : connect}>Re-link accounts</button>
          </div>
          {b.readError && <div className="notice err">{b.readError}</div>}
          {b.holder && (
            <div className={`notice ${b.holder.match === true ? "ok" : b.holder.match === false ? "err" : ""}`}>
              {b.holder.names.length === 0 ? "Stripe is still confirming who owns this account. Check back in a few minutes."
                : b.holder.match === true ? <>Account holder <b>{b.holder.names.join(", ")}</b> matches the owning company.</>
                : b.holder.match === false ? <>Account holder <b>{b.holder.names.join(", ")}</b> doesn't match the owning company{b.holder.expected ? <> (<b>{b.holder.expected}</b>)</> : null}. Link the SPV's own account.</>
                : <>Account holder: <b>{b.holder.names.join(", ")}</b>. Add the owning company in the offering's details to compare.</>}
            </div>
          )}
          {b.months && b.months.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table className="tbl">
                <thead><tr><th>Month</th><th>Income found</th><th>Expected</th><th>Result</th></tr></thead>
                <tbody>
                  {b.months.map((m) => {
                    const done = m.month <= b.lastCompleteMonth;
                    const met = expectedCents !== null && m.cents >= expectedCents;
                    return (
                      <tr key={m.month}>
                        <td>{monthName(m.month)}</td>
                        <td>{usd(m.cents)} <small className="muted">({m.deposits} deposit{m.deposits === 1 ? "" : "s"})</small></td>
                        <td>{expectedCents !== null ? usd(expectedCents) : "—"}</td>
                        <td>{!done ? <span className="tag">In progress</span> : met ? <span className="tag g">Met</span> : <span className="tag y">Short {expectedCents ? `${(((expectedCents - m.cents) / expectedCents) * 100).toFixed(1)}%` : ""}</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="li"><span className="muted">Signed by</span><span>Platform bank data source, reading from {b.provider === "stripe" ? "Stripe Financial Connections" : "Mastercard Open Finance"}</span></div>
          <div className="li"><span className="muted">Last month signed</span><span>{b.lastMonthSigned ? <>{monthName(b.lastMonthSigned)}{b.lastTx && <> · <a href={txUrl(net, b.lastTx)} target="_blank" rel="noreferrer">transaction ↗</a></>}</> : "None yet"}</span></div>
        </>
      )}
      {msg?.text && <div className={`notice ${msg.kind}`}>{msg.text} {msg.tx && <a href={txUrl(net, msg.tx)} target="_blank" rel="noreferrer">View transaction ↗</a>}</div>}
    </div>
  );
}
