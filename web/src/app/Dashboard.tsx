import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type Asset } from "../lib/api";
import { assetClassById, standardById } from "../lib/catalog";
import { networkById } from "../lib/chains";
import { useTenant } from "../lib/tenant";
import { PageHelp, SetupChecklist, WelcomeTour, tourSeen } from "./onboarding";

export default function Dashboard() {
  const { tenant } = useTenant();
  const nav = useNavigate();
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [err, setErr] = useState("");
  const [kyc, setKyc] = useState<Awaited<ReturnType<typeof api.kycList>> | null>(null);
  useEffect(() => { api.kycList().then(setKyc, () => setKyc(null)); }, []);
  const [tour, setTour] = useState(() => !tourSeen());

  useEffect(() => {
    api.assets().then(setAssets, (e) => setErr(e.message));
  }, []);

  const deployed = assets?.filter((a) => a.status === "deployed").length ?? 0;
  const drafts = assets?.filter((a) => a.status === "draft").length ?? 0;

  return (
    <>
      <div className="topbar">
        <h1>Dashboard</h1>
        <div className="row">
          <span className="pill"><span className="dot" style={{ background: "var(--warn)" }} />Testnet</span>
          <Link className="btn primary sm" to="/app/new">＋ New issuance</Link>
        </div>
      </div>
      <div className="content">
        {err && <div className="notice err">{err}</div>}
        <PageHelp
          id="dashboard"
          what="Your home base: every asset you're tokenizing, your progress, and what still needs doing."
          next={<>Work down the setup checklist. Stuck on a word? The <Link to="/app/guide">Guide</Link> explains every step and term.</>}
        />
        {assets && <SetupChecklist assets={assets} />}
        <div className="kpis">
          <div className="kpi"><span>Assets</span><b>{assets?.length ?? "—"}</b><small>{deployed} deployed · {drafts} draft</small></div>
          <div className="kpi"><span>Verified investors</span><b>{kyc ? kyc.checks.filter((k) => k.status === "approved").length : "—"}</b><small className="muted">{kyc?.enabled ? `identity checks by ${kyc.provider === "stripe" ? "Stripe" : "Sumsub"}` : "identity checks being set up"}</small></div>
          <div className="kpi"><span>Capital raised</span><b>—</b><small className="muted">appears after first sale</small></div>
          <div className="kpi"><span>Paid to holders</span><b>—</b><small className="muted">appears after first payout</small></div>
        </div>

        {assets && assets.length === 0 ? (
          <div className="empty">
            <b style={{ color: "var(--text)", fontSize: 18 }}>No assets yet</b>
            <span>Create your first issuance. It stays a draft until you deploy it.</span>
            <Link className="btn primary sm" to="/app/new">＋ New issuance</Link>
          </div>
        ) : (
          <div className="table">
            <div className="tr h"><span>Asset</span><span>Standard</span><span>Chain</span><span>Supply</span><span>Price</span><span>Status</span></div>
            {assets?.map((a) => (
              <div className="tr clickable" key={a.id} onClick={() => nav(`/app/assets/${a.id}`)}>
                <span><b>{a.name}</b><small>{assetClassById(a.assetClass)?.name} · {a.symbol}</small></span>
                <span>{standardById(a.standard)?.name}</span>
                <span>{networkById(a.chainId)?.name ?? a.chainId}</span>
                <span>{Number(a.totalSupply || 0).toLocaleString()}</span>
                <span>{a.pricePerToken ? `$${a.pricePerToken}` : "—"}</span>
                <span className={`tag ${a.status === "deployed" ? "g" : "y"}`}>{a.status === "deployed" ? "Deployed" : "Draft"}</span>
              </div>
            ))}
          </div>
        )}

        <div className="two" style={{ gridTemplateColumns: "1fr" }}>
          <div className="panel">
            <h3>Compliance</h3>
            <div className="li"><span className="muted">Identity checks</span><span className={kyc?.enabled ? "" : "muted"}>{kyc?.enabled ? `${kyc.provider === "stripe" ? "Stripe Identity" : "Sumsub"}${kyc.sandbox ? " (test mode)" : ""}` : "Not connected"}</span></div>
            <div className="li"><span className="muted">Admin multisig</span><span>{tenant?.payments.treasury ? "Set" : <span className="muted">Not set</span>}</span></div>
            <div className="li"><span className="muted">Offering exemption</span><span className="muted">Set per issuance</span></div>
            <div className="li"><span className="muted">Transfer agent</span><span className="muted">Not connected</span></div>
          </div>
        </div>
      </div>
      {tour && <WelcomeTour onClose={() => setTour(false)} />}
    </>
  );
}
