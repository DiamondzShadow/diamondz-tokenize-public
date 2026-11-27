// Console › Investors: identity checks (design K5). Every investor who started a Sumsub check with this issuer, with
// identity + accreditation status for the chosen offering. "Approve wallet" stays a manual issuer action (owner decision
// 2026-11-18): it only fills in the on-chain approval form below, and only once every required check has passed.
import { useEffect, useMemo, useState } from "react";
import { api, type AccreditationAdmin, type Asset, type KycCheck } from "../lib/api";

const ID_LABEL: Record<KycCheck["status"], [string, string]> = {
  approved: ["ok", "Verified"], pending: ["warn", "Checking"], retry: ["warn", "Asked to retry"], rejected: ["bad", "Not verified"], init: ["no", "Not finished"],
};
const ago = (iso: string) => {
  const d = new Date(iso), days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  return days <= 0 ? "Today" : days === 1 ? "Yesterday" : d.toLocaleDateString([], { month: "short", day: "numeric" });
};

export default function IdentityChecks({ asset, accreditationRequired = true, onApprove }: { asset: Asset; accreditationRequired?: boolean; onApprove: (wallet: string) => void }) {
  const [data, setData] = useState<{ enabled: boolean; provider?: "sumsub" | "stripe" | null; sandbox: boolean; clientId: string | null; checks: KycCheck[] } | null>(null);
  const [acc, setAcc] = useState<AccreditationAdmin[]>([]);
  const [err, setErr] = useState("");
  useEffect(() => { api.kycList().then(setData, (e) => setErr(e.message)); }, []);
  useEffect(() => { api.accreditations(asset.id).then(setAcc, () => setAcc([])); }, [asset.id]);

  // Latest accreditation request per wallet for this offering.
  const accBy = useMemo(() => {
    const m = new Map<string, AccreditationAdmin>();
    for (const a of [...acc].sort((x, y) => x.createdAt.localeCompare(y.createdAt))) m.set(a.wallet.toLowerCase(), a);
    return m;
  }, [acc]);

  if (err) return <div className="notice err">{err}</div>;
  if (!data) return null;
  // Dashboard links: the account (clientId) and sandbox flag make them open in the right place.
  const qs = (() => { const q = new URLSearchParams(); if (data.clientId) q.set("clientId", data.clientId); if (data.sandbox) q.set("sbx", "true"); const s = q.toString(); return s ? `?${s}` : ""; })();
  const sumsub = (id: string) => `https://cockpit.sumsub.com/checkus/applicant/${encodeURIComponent(id)}${qs}`;
  // Stripe Identity checks run on the platform's Stripe account: issuers see the result, name and country here.
  const stripe = data.provider === "stripe";
  const vendor = stripe ? "Stripe Identity" : "Sumsub";
  const ready = data.checks.filter((c) => c.status === "approved" && (!accreditationRequired || accBy.get(c.wallet.toLowerCase())?.decision === "approved"));
  const checking = data.checks.filter((c) => c.status === "pending").length;

  return (
    <section className="panel kyc-console" aria-labelledby="idc-h">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <h3 id="idc-h">Identity checks</h3>
        {!stripe && <a className="btn ghost sm" href={`https://cockpit.sumsub.com/checkus/home${qs}`} target="_blank" rel="noreferrer">Open Sumsub dashboard ↗</a>}
      </div>
      {!data.enabled && <div className="notice">Identity checks aren't switched on for this platform yet. Investors see the step as "being set up".</div>}
      {data.sandbox && data.enabled && <div className="notice">{vendor} test mode: checks here are tests, not real verifications. Don't approve wallets for real money from them.</div>}
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <span className={`status ${ready.length ? "warn" : "no"}`}>{ready.length} ready for your approval</span>
        <span className="status no">{checking} checking</span>
      </div>
      {data.checks.length === 0 ? (
        <p className="muted" style={{ fontSize: 14, margin: 0 }}>No investor has started an identity check yet. They start from the offering's page.</p>
      ) : (
        <div className="idc-wrap">
          <table className="idc">
            <thead><tr><th>Wallet</th><th>Identity ({vendor})</th>{accreditationRequired && <th>Accredited (Mastercard)</th>}<th>Started</th><th aria-label="Approve" /></tr></thead>
            <tbody>
              {data.checks.map((c) => {
                const a = accBy.get(c.wallet.toLowerCase());
                const [tone, label] = ID_LABEL[c.status];
                const accOk = !accreditationRequired || a?.decision === "approved";
                const can = c.status === "approved" && accOk;
                return (
                  <tr key={c.id}>
                    <td><span className="mono">{c.wallet}</span><div className="muted small">{c.name ? `${c.name}${c.country ? ` · ${c.country}` : ""}` : c.status === "init" ? "Hasn't submitted yet" : "Name shown after the check"}</div></td>
                    <td><span className={`status ${tone}`}>{label}</span>{c.applicantId && !c.applicantId.startsWith("vs_") && <div><a className="small" href={sumsub(c.applicantId)} target="_blank" rel="noreferrer">{c.status === "rejected" ? "See reason in Sumsub ↗" : "View in Sumsub ↗"}</a></div>}</td>
                    {accreditationRequired && (
                      <td>{a ? <span className={`status ${a.decision === "approved" ? "ok" : a.decision === "declined" ? "bad" : a.status === "ready" ? "warn" : "no"}`}>{a.decision === "approved" ? "Approved" : a.decision === "declined" ? "Declined" : a.status === "ready" ? "Report ready" : a.status === "failed" ? "Failed" : "In progress"}</span> : <span className="status no">Not started</span>}
                        {a?.status === "ready" && !a.decision && <div className="muted small">Review it below</div>}</td>
                    )}
                    <td className="small muted">{ago(c.createdAt)}</td>
                    <td style={{ textAlign: "right" }}>
                      {c.status === "rejected" ? <span className="muted small">Can't be approved</span>
                        : <button className={`btn sm ${can ? "primary" : "ghost"}`} disabled={!can} title={can ? "Fill in the approval form below" : "Every required check must pass first"} onClick={() => onApprove(c.wallet)}>Approve wallet</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small" style={{ margin: 0 }}>Names and countries come live from {vendor} and aren't stored here. "Approve wallet" fills in the approval form below; you confirm the transaction from your wallet.</p>
    </section>
  );
}
