// Platform admin › Go-live reviews (design L3, approved 2026-11-20; reviewer: the platform owner). Company and email
// checks pass automatically; the reviewer confirms the lawyer's license in the state bar's directory, then approves
// or sends it back with a note. Every decision is recorded with who and when.
import { useEffect, useState } from "react";
import { api, type PlatformReview } from "../lib/api";

const STAGE: Record<string, string> = { signed: "Waiting", approved: "Approved", returned: "Sent back", changed: "Terms changed" };

export default function Reviews() {
  const [list, setList] = useState<PlatformReview[] | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [found, setFound] = useState<boolean | null>(null);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => api.reviews().then((r) => { setList(r.reviews); setPick((p) => p ?? r.reviews.find((x) => x.stage === "signed")?.assetId ?? r.reviews[0]?.assetId ?? null); }, (e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  useEffect(() => { setFound(null); setNote(""); }, [pick]);
  const r = list?.find((x) => x.assetId === pick);
  const decide = async (decision: "approve" | "return") => {
    if (!r) return;
    setBusy(true); setErr("");
    try { await api.decideReview(r.assetId, { decision, licenseFound: !!found, note: note.trim() }); await load(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const ok = (b: boolean, yes: string, no: string) => <span className={b ? "tag g" : "tag y"}>{b ? yes : no}</span>;

  return (
    <>
      <div className="topbar"><h1>Go-live reviews</h1></div>
      <div className="content">
        <p className="muted" style={{ fontSize: 14, margin: 0 }}>Every offering going live on a real network needs your approval. Target: within one business day.</p>
        {err && <div className="notice err">{err}</div>}
        {list === null ? <p className="muted">Loading…</p> : !list.length ? <p className="muted">Nothing to review yet.</p> : (
          <div className="team-grid" style={{ gridTemplateColumns: "340px minmax(0,1fr)" }}>
            <section className="panel" style={{ padding: 0, overflow: "hidden" }}>
              {list.map((x) => (
                <button key={x.assetId} type="button" className={`rv-item ${x.assetId === pick ? "on" : ""}`} onClick={() => setPick(x.assetId)}>
                  <span><b>{x.name}</b><br /><span className="muted" style={{ fontSize: 12 }}>{x.issuer}{x.exemption === "506c" ? " · 506(c)" : ""}</span></span>
                  <span className={`tag ${x.stage === "approved" ? "g" : x.stage === "signed" ? "y" : ""}`}>{STAGE[x.stage] ?? x.stage}</span>
                </button>
              ))}
            </section>
            {r && (
              <section className="panel">
                <h3 style={{ fontSize: 22 }}>{r.name}</h3>
                <div className="li"><span><b>Company verified</b><br /><span className="muted" style={{ fontSize: 13 }}>{r.company.name ?? "No name yet"} · Stripe</span></span>{ok(r.company.status === "verified", "Passed", r.company.status)}</div>
                <div className="li"><span><b>Lawyer's email</b><br /><span className="muted" style={{ fontSize: 13 }}>{r.counsel.email} · firm domain, inbox proven with a code</span></span>{ok(r.emailDomainOk, "Passed", "Check")}</div>
                <div className="li"><span><b>Lawyer's license</b><br /><span className="muted" style={{ fontSize: 13 }}>{r.signed.name} · {r.signed.barState} · {r.signed.barNumber} · <a href={`https://www.google.com/search?q=${encodeURIComponent(`${r.signed.barState} state bar attorney search`)}`} target="_blank" rel="noreferrer">Find the {r.signed.barState} attorney search ↗</a></span></span>
                  <span className="row" style={{ gap: 6 }}>
                    <button type="button" className={`btn sm ${found === false ? "primary" : "ghost"}`} onClick={() => setFound(false)}>Not found</button>
                    <button type="button" className={`btn sm ${found === true ? "primary" : "ghost"}`} onClick={() => setFound(true)}>Found, in good standing</button>
                  </span>
                </div>
                <div className="li"><span><b>Opinion letter</b><br /><span className="muted" style={{ fontSize: 13 }}>Signed {new Date(r.signed.at).toLocaleString()}{r.letter ? ` · ${(r.letter.bytes / 1024).toFixed(0)} KB` : ""}</span></span>{r.letter ? <a href={`/api/platform/reviews/${r.assetId}/letter`} target="_blank" rel="noreferrer">Open letter ↗</a> : <span className="tag y">Missing</span>}</div>
                <div className="li"><span><b>Offering matches the letter</b><br /><span className="muted" style={{ fontSize: 13 }}>Terms unchanged since the lawyer signed</span></span>{ok(r.termsMatch, "Passed", "Changed")}</div>
                {r.review && <div className={`notice ${r.review.decision === "approved" ? "ok" : ""}`}>{r.review.decision === "approved" ? "Approved" : "Sent back"} by {r.review.by} on {new Date(r.review.at).toLocaleString()}{r.review.note ? `: “${r.review.note}”` : ""}</div>}
                {r.stage === "signed" && <>
                  <label className="field">Note to the issuer (needed if you send it back)<textarea className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></label>
                  <div className="row" style={{ justifyContent: "flex-end", gap: 10 }}>
                    <button type="button" className="btn ghost" disabled={busy || !note.trim()} onClick={() => decide("return")}>Send back to issuer</button>
                    <button type="button" className="btn primary" disabled={busy || found !== true || !r.termsMatch || r.company.status !== "verified"} onClick={() => decide("approve")}>Approve go-live</button>
                  </div>
                  <small className="muted" style={{ textAlign: "right" }}>Approve unlocks once you've confirmed the license. Your decision is logged with your name and time.</small>
                </>}
              </section>
            )}
          </div>
        )}
      </div>
    </>
  );
}
