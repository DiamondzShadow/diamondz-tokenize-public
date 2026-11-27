// /sign/:token — the verifier's view of one signing request before Adobe (design E3, approved 2026-11-27).
// The link comes in Adobe Acrobat Sign's email from Diamondz. It shows what's asked and opens Adobe's signing page;
// the signer can also decline with a reason, which the issuer sees.
import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { api, type EsignSignerView } from "../lib/api";
import { Mark } from "./Landing";

const fmt = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export default function SignRequest() {
  const { token = "" } = useParams();
  const [v, setV] = useState<EsignSignerView | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [declined, setDeclined] = useState(false);
  useEffect(() => { api.signRequest(token).then(setV, (e) => setErr(e.message)); }, [token]);

  const open = async () => {
    setBusy("open"); setErr("");
    try { window.location.assign((await api.signUrl(token)).url); } catch (e) { setErr((e as Error).message); setBusy(""); }
  };
  const decline = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("decline"); setErr("");
    try { await api.signDecline(token, reason.trim()); setDeclined(true); } catch (x) { setErr((x as Error).message); } finally { setBusy(""); }
  };
  const waiting = v && ["sent", "opened", "identity"].includes(v.status);

  return (
    <div className="page counsel">
      <header className="wrap counsel-hdr">
        <span className="row" style={{ gap: 10 }}><Mark /><b className="display" style={{ fontSize: 20 }}>Diamondz</b><span className="muted" style={{ fontSize: 13 }}>· Verify</span></span>
        {v && <span className="muted" style={{ fontSize: 13 }}>For {v.signerName} · {v.firmName}</span>}
      </header>
      <main className="wrap counsel-main es-sign">
        {err && <div className="notice err" role="alert">{err}</div>}
        {!v ? (!err && <p className="muted">Loading…</p>) : (
          <section className="panel">
            <div>
              <span className="es-kicker">{v.kindName}</span>
              <h1 className="es-h2" style={{ marginTop: 4 }}>{v.offering}{v.assetClass ? ` (${v.assetClass.replace("-", " ")})` : ""}</h1>
              <p className="muted" style={{ margin: "6px 0 0", lineHeight: 1.5 }}>{v.issuer} asks you to confirm: {v.confirms} Your signed letter is shown to investors on the listing.</p>
            </div>
            <dl className="es-dl">
              <div><dt>Issuer</dt><dd>{v.issuer}</dd></div>
              <div><dt>Network</dt><dd>{v.network}{v.testnet ? " (test network)" : ""}</dd></div>
              <div><dt>Identity check</dt><dd>{v.idMethod === "GOV_ID" ? "Government ID, in Adobe" : "Phone code, in Adobe"}</dd></div>
              <div><dt>{waiting ? "Request expires" : "Status"}</dt><dd>{waiting ? fmt(v.expiresAt) : v.status === "recorded" || v.status === "signed" ? `Signed${v.signedAt ? ` ${fmt(v.signedAt)}` : ""}` : v.status === "declined" ? "Declined" : v.status === "expired" ? "Expired" : "Canceled by the issuer"}</dd></div>
            </dl>
            {v.note && <div className="notice">Note from the issuer: {v.note}</div>}
            {declined ? (
              <div className="notice ok">Thanks. {v.issuer} has your reason and can send a new request.</div>
            ) : waiting ? (
              <>
                <div className="es-next">
                  <b>What happens next</b>
                  <ol>
                    <li>Adobe Acrobat Sign opens with the attestation letter.</li>
                    <li>You confirm your identity {v.idMethod === "GOV_ID" ? "with your government ID" : "with a code sent to your phone"}.</li>
                    <li>You fill in the reference and your title, review and sign.</li>
                    <li>Diamondz records the signed letter's fingerprint on chain. You don't need a wallet or pay anything.</li>
                  </ol>
                </div>
                {!declining ? (
                  <div className="row" style={{ flexWrap: "wrap" }}>
                    <button className="btn primary" type="button" disabled={!!busy} onClick={open}>{busy === "open" ? "Opening Adobe…" : "Review and sign in Adobe ↗"}</button>
                    <button className="btn ghost" type="button" disabled={!!busy} onClick={() => setDeclining(true)}>Decline with a reason</button>
                  </div>
                ) : (
                  <form onSubmit={decline} className="col" style={{ gap: 10 }}>
                    <label className="field">Why you can't sign (the issuer sees this)
                      <textarea rows={3} required minLength={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: the policy lapsed on Nov 1; renewal pending." />
                    </label>
                    <div className="row" style={{ flexWrap: "wrap" }}>
                      <button className="btn primary" type="submit" disabled={!!busy || reason.trim().length < 3}>{busy === "decline" ? "Sending…" : "Decline this request"}</button>
                      <button className="btn ghost" type="button" onClick={() => setDeclining(false)}>Back</button>
                    </div>
                  </form>
                )}
                <p className="muted" style={{ fontSize: 12, margin: 0 }}>You also got this request by email from Adobe Acrobat Sign on behalf of Diamondz. Either link opens the same letter.</p>
              </>
            ) : null}
          </section>
        )}
      </main>
    </div>
  );
}
