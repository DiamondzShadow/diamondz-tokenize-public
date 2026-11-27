import { useEffect, useState } from "react";
import { api, type Tenant } from "../lib/api";
import { PAY_METHODS } from "../lib/catalog";
import { useTenant } from "../lib/tenant";
import { PageHelp } from "./onboarding";

/** Card payments for licenses: the issuer connects ITS OWN Stripe account and is the merchant (api/src/cards.ts). */
function StripeConnect() {
  const [s, setS] = useState<{ enabled: boolean; account: string | null; chargesEnabled: boolean; detailsSubmitted: boolean; testMode?: boolean; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { fetch("/api/cards/status", { credentials: "same-origin" }).then((r) => r.json()).then(setS, () => setS(null)); }, []);
  if (!s) return null;
  async function connect() {
    setBusy(true);
    const r = await fetch("/api/cards/connect", { method: "POST", credentials: "same-origin" }).then((x) => x.json()).catch(() => ({ error: "network error" }));
    if (r.url) location.href = r.url;
    else { setS({ ...s!, error: r.error }); setBusy(false); }
  }
  return (
    <div className="panel">
      <h3>Card payments for licenses</h3>
      <p className="muted" style={{ fontSize: 14 }}>Licensees can pay license fees by card into your own Stripe account. You're the merchant; the platform never holds the money. The license is then issued on chain with the card payment recorded.</p>
      {!s.enabled && <div className="notice">Card payments aren't switched on for the platform yet.</div>}
      {s.enabled && (
        <>
          <div className="li"><span className="muted">Stripe account</span><span>{s.account ?? "Not connected"}{s.testMode ? " (test mode)" : ""}</span></div>
          <div className="li"><span className="muted">Can take payments</span><span>{s.chargesEnabled ? "Yes ✓" : s.account ? "Not yet: finish Stripe's onboarding" : "—"}</span></div>
          {!s.chargesEnabled && <button className="btn primary sm" disabled={busy} onClick={connect}>{busy ? "Opening Stripe…" : s.account ? "Continue Stripe onboarding" : "Connect your Stripe account"}</button>}
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>Also switch on "Allow the platform to verify licensees" on each asset's licensing panel: the same switch lets the platform confirm card payments on chain.</p>
        </>
      )}
      {s.error && <div className="notice err">{s.error}</div>}
    </div>
  );
}

const PAYOUT_OPTIONS = ["USDC on Base", "USDC on Arbitrum", "USDG on Ethereum", "PYUSD on Ethereum", "EURC on Base"];

export default function Payments() {
  const { tenant, setTenant } = useTenant();
  const [t, setT] = useState<Tenant | null>(tenant);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => setT(tenant), [tenant]);
  if (!t) return null;

  const p = t.payments;
  const setP = (patch: Partial<Tenant["payments"]>) => setT({ ...t, payments: { ...p, ...patch } });

  async function save() {
    if (!t) return;
    setSaving(true);
    setMsg(null);
    try {
      if (!t.payments.treasury) throw new Error("Add your treasury multisig address first. Raises are paid there.");
      const saved = await api.updateTenant({ payments: t.payments, onboarding: { ...t.onboarding, paymentsDone: true } });
      setTenant(saved);
      setMsg({ kind: "ok", text: "Saved." });
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="topbar">
        <h1>Payments &amp; payouts</h1>
        <button className="btn primary sm" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save"}</button>
      </div>
      <div className="content">
        <PageHelp
          id="payments"
          what="Which payment methods investors can use, where raised money is sent (your treasury multisig), and how income is paid out to holders."
          next="Save, then create your first asset from New issuance."
        />
        {msg && <div className={`notice ${msg.kind}`}>{msg.text}</div>}
        <div className="two">
          <div className="panel">
            <h3>How investors can pay</h3>
            {PAY_METHODS.map((m) => {
              const on = p.methods.includes(m.id);
              return (
                <div className="toggle" key={m.id}>
                  <span>{m.name}{m.note && <span className="muted"> · {m.note}</span>}{m.soon && <span className="soon" style={{ marginLeft: 8 }}>soon</span>}</span>
                  <div
                    className={`tg ${on ? "" : "off"}`}
                    style={m.soon ? { opacity: 0.4, cursor: "not-allowed" } : undefined}
                    onClick={() => !m.soon && setP({ methods: on ? p.methods.filter((x) => x !== m.id) : [...p.methods, m.id] })}
                  />
                </div>
              );
            })}
          </div>
          <div className="panel">
            <h3>Payout settings</h3>
            <label className="field">Default payout currency
              <select className="input" value={p.payoutCurrency} onChange={(e) => setP({ payoutCurrency: e.target.value })}>
                {PAYOUT_OPTIONS.map((o) => <option key={o}>{o}</option>)}
              </select>
            </label>
            <label className="field">Platform fee on distributions (bps, max 1000)
              <input className="input" inputMode="numeric" value={p.distributionFeeBps} onChange={(e) => setP({ distributionFeeBps: Math.min(1000, Number(e.target.value.replace(/\D/g, "") || 0)) })} />
            </label>
            <label className="field">Treasury multisig (receives raises)
              <input className="input" value={p.treasury ?? ""} placeholder="0x… full Safe address" onChange={(e) => setP({ treasury: e.target.value.trim() || undefined })} />
            </label>
            <div className="li"><span className="muted">Card spend of payouts</span><span className="soon">Partner pending</span></div>
          </div>
        </div>
        <StripeConnect />
        <div className="empty">
          <b style={{ color: "var(--text)" }}>No payments yet</b>
          <span>Subscriptions and distributions will appear here once an asset is live.</span>
        </div>
      </div>
    </>
  );
}
