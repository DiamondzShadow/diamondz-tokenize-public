// Console: every wallet approved on this offering's investor registry, and whether it passed an identity check with
// you (2026-11-20). Approvals without one are flagged here and counted on the public listing.
import { useEffect, useState } from "react";
import { api, type ApprovalAudit, type Asset } from "../lib/api";

export default function ApprovalsPanel({ asset }: { asset: Asset }) {
  const [a, setA] = useState<ApprovalAudit | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { api.assetApprovals(asset.id).then(setA, (e) => setErr(e.message)); }, [asset.id]);
  if (err) return <div className="panel"><h3>Approved investors</h3><div className="notice err">{err}</div></div>;
  if (a && !a.covered && a.note?.startsWith("Still")) return <div className="panel"><h3>Approved investors</h3><span className="muted" style={{ fontSize: 14 }}>{a.note}</span></div>;
  if (!a || !a.covered) return null;
  const people = a.wallets.filter((w) => !w.system);
  return (
    <div className="panel">
      <div className="row between"><h3>Approved investors</h3><span className="muted" style={{ fontSize: 13 }}>{a.checked} of {a.total} passed an identity check</span></div>
      {a.manual > 0 && (
        <div className={`notice ${a.testnet ? "" : "err"}`}>
          {a.manual} {a.manual === 1 ? "wallet was" : "wallets were"} approved without an identity check with you. {a.testnet
            ? "That's fine for practice on a test network."
            : "Investors see this count on your listing. Ask them to verify on the offering page, or remove their approval."}
        </div>
      )}
      {people.length === 0 ? <span className="muted" style={{ fontSize: 14 }}>No investors approved yet.</span> : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th scope="col">Wallet</th><th scope="col">Identity check</th><th scope="col">Accredited</th></tr></thead>
            <tbody>{people.map((w) => (
              <tr key={w.wallet}>
                <td className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>{w.wallet}</td>
                <td>{w.checked ? <span className="tag g">Passed</span> : <span className="tag y">{w.identity === "none" ? "Approved without one" : `Not passed (${w.identity})`}</span>}</td>
                <td>{w.accredited ? "Yes" : "No"}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Public listing: counts only, never wallets. */
export function ListingApprovals({ assetId }: { assetId: string }) {
  const [a, setA] = useState<Omit<ApprovalAudit, "wallets"> | null>(null);
  useEffect(() => { api.marketApprovals(assetId).then(setA, () => setA(null)); }, [assetId]);
  if (!a || !a.covered || a.total === 0) return null;
  const all = a.manual === 0;
  return (
    <div className="panel sec-terms"><div className="li">
      <span className="muted">Investor identity checks</span>
      <span style={{ color: all ? "var(--ok)" : "var(--warn)", textAlign: "right" }}>
        {all ? `All ${a.total} approved investors passed one` : `${a.checked} of ${a.total} approved investors passed one · ${a.manual} approved by the issuer without one`}
      </span>
    </div></div>
  );
}
