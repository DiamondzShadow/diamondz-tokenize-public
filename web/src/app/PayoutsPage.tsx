// Console › Payouts: every deployed offering in one place, each with its payout history and "Pay investors".
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Asset } from "../lib/api";
import { networkById } from "../lib/chains";
import PayoutsPanel from "./Payouts";

export default function PayoutsPage() {
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [pick, setPick] = useState<string>("");
  const [err, setErr] = useState("");
  useEffect(() => {
    api.assets().then((a) => {
      const live = a.filter((x) => x.status === "deployed");
      setAssets(live);
      setPick((p) => p || live[0]?.id || "");
    }, (e) => setErr(e.message));
  }, []);
  const asset = assets?.find((a) => a.id === pick);
  const net = asset ? networkById(asset.chainId) : undefined;
  return (
    <>
      <div className="topbar"><h1>Payouts</h1></div>
      <div className="content">
        {err && <div className="notice err">{err}</div>}
        {assets && assets.length === 0 && (
          <div className="empty">
            <b style={{ color: "var(--text)" }}>No deployed offerings yet</b>
            <span>Payouts become available once an offering is deployed and has holders.</span>
            <Link className="btn primary sm" to="/app/new">New issuance</Link>
          </div>
        )}
        {assets && assets.length > 1 && (
          <label className="field" style={{ maxWidth: 420 }}>Offering
            <select className="input" value={pick} onChange={(e) => setPick(e.target.value)}>
              {assets.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.symbol}) · {networkById(a.chainId)?.name}</option>)}
            </select>
          </label>
        )}
        {asset && net && <PayoutsPanel key={asset.id} asset={asset} net={net} />}
      </div>
    </>
  );
}
