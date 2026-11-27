// Console › Investors: verify investor wallets and review accreditation requests for any deployed offering, without
// digging through each offering's page. Same panels as the offering page.
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type Asset } from "../lib/api";
import { networkById } from "../lib/chains";
import { InvestorsPanel } from "./AssetDetail";
import AccreditationPanel from "./Accreditation";
import { TrexInvestorsPanel } from "./Trex";
import IdentityChecks from "./IdentityChecks";

export default function InvestorsPage() {
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [params, setParams] = useSearchParams();
  const [prefill, setPrefill] = useState<{ wallet: string; n: number } | null>(null);
  useEffect(() => { api.assets().then((a) => setAssets(a.filter((x) => x.status === "deployed")), () => setAssets([])); }, []);

  const chosen = assets?.find((a) => a.id === params.get("asset")) ?? assets?.[0] ?? null;
  const net = chosen ? networkById(chosen.chainId) : undefined;
  return (
    <>
      <div className="topbar"><h1>Investors</h1></div>
      <div className="content">
        <p className="muted" style={{ fontSize: 14 }}>
          Verify the wallets that may buy and hold an offering. A wallet must be verified before it can buy, receive or send the token, including your own test wallets.
        </p>
        {assets === null ? <span className="muted">Loading…</span> : assets.length === 0 ? (
          <div className="notice">No deployed offerings yet. <Link to="/app/new">Create one</Link> and deploy it to a test network first.</div>
        ) : (
          <>
            <label className="field" style={{ maxWidth: 480 }}>Offering
              <select className="input" value={chosen?.id ?? ""} onChange={(e) => { setPrefill(null); setParams({ asset: e.target.value }); }}>
                {assets.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.symbol}) · {networkById(a.chainId)?.name ?? a.chainId}</option>)}
              </select>
            </label>
            {chosen && net && (
              <>
                <IdentityChecks key={`idc-${chosen.id}`} asset={chosen} onApprove={(w) => { setPrefill({ wallet: w, n: Date.now() }); setTimeout(() => document.getElementById("investor-approve")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50); }} />
                <div id="investor-approve" />
                {chosen.standard === "erc3643" && chosen.trex
                  ? <TrexInvestorsPanel key={chosen.id} asset={chosen} net={net} prefill={prefill} />
                  : <InvestorsPanel key={chosen.id} asset={chosen} net={net} prefill={prefill} />}
                <AccreditationPanel key={`acc-${chosen.id}`} asset={chosen} onApprove={(w) => { setPrefill({ wallet: w, n: Date.now() }); window.scrollTo({ top: 0, behavior: "smooth" }); }} />
                <Link to={`/app/assets/${chosen.id}`} className="muted" style={{ fontSize: 13 }}>Open {chosen.name}'s full page →</Link>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}
