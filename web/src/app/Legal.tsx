// Go live › legal sign-off (design L1): Stripe-verified company + the lawyer signs from an emailed link + Diamondz
// review. Replaces the old self-ticked "counsel approved" box.
import { useEffect, useState, type FormEvent } from "react";
import { api, type LegalState } from "../lib/api";

export const BAR_STATES = ["AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","PR"];
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");

export default function LegalPanel({ assetId, onState }: { assetId: string; onState?: (s: LegalState) => void }) {
  const [s, setS] = useState<LegalState | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [f, setF] = useState({ name: "", firm: "", email: "", barState: "NY", barNumber: "" });
  const [sent, setSent] = useState("");
  const load = () => api.legal(assetId).then((x) => { setS(x); onState?.(x); }, (e) => setErr(e.message));
  useEffect(() => { load(); }, [assetId]); // eslint-disable-line react-hooks/exhaustive-deps

  const verifyCompany = async () => {
    setBusy("company"); setErr("");
    try { location.assign((await api.legalCompany(location.pathname)).url); } catch (e) { setErr((e as Error).message); setBusy(""); }
  };
  const invite = async (e: FormEvent) => {
    e.preventDefault(); setBusy("invite"); setErr(""); setSent("");
    try { await api.legalInvite(assetId, { ...f, name: f.name.trim(), firm: f.firm.trim(), email: f.email.trim(), barNumber: f.barNumber.trim() }); setSent(f.name.trim()); await load(); }
    catch (x) { setErr((x as Error).message); } finally { setBusy(""); }
  };
  if (!s) return err ? <div className="notice err">{err}</div> : <p className="muted">Loading…</p>;
  const c = s.counsel;
  const ad = s.adobe?.current ? s.adobe : null;
  const steps: [string, string | null][] = s.adobeConnected || ad
    ? [["Sent", c?.invitedAt ?? null], ["Opened by your lawyer", c?.openedAt ?? null], ["Identity confirmed", ad?.identityAt ?? (s.stage === "changed" ? null : c?.via === "adobe" ? c.signedAt : null)], ["Signed in Adobe", s.stage === "changed" ? null : c?.via === "adobe" ? c.signedAt : null], ["Diamondz review", s.stage === "approved" ? s.review?.at ?? null : null]]
    : [["Invited", c?.invitedAt ?? null], ["Lawyer opened it", c?.openedAt ?? null], ["Lawyer signed", s.stage === "changed" ? null : c?.signedAt ?? null], ["Diamondz approved", s.stage === "approved" ? s.review?.at ?? null : null]];
  const remind = async () => { setBusy("remind"); setErr(""); try { await api.legalRemind(assetId); setSent(""); await load(); } catch (e) { setErr((e as Error).message); } finally { setBusy(""); } };
  const canInvite = !c || ["comments", "changed", "returned"].includes(s.stage) || s.stage === "invited" || s.stage === "opened";

  return (
    <div className="col" style={{ gap: 14 }}>
      {err && <div className="notice err">{err}</div>}
      <div className="legal-row">
        <div><b>1. Verify your company</b><span className="muted">Stripe checks your company's tax ID, address and owners over 25%.</span></div>
        {s.company.status === "verified"
          ? <span className="tag g">Verified by Stripe{s.company.name ? ` · ${s.company.name}` : ""}</span>
          : <button type="button" className="btn primary sm" disabled={!!busy} onClick={verifyCompany}>{busy === "company" ? "Opening Stripe…" : s.company.status === "not started" ? "Verify with Stripe" : s.company.status === "in review" ? "Stripe is reviewing · open" : "Continue with Stripe"}</button>}
      </div>

      <div className="legal-row" style={{ alignItems: "flex-start", flexDirection: "column" }}>
        <div><b>2. Your lawyer signs off</b><span className="muted">{s.adobeConnected ? "We email your securities lawyer a private link. They review the offering, upload their opinion letter, and sign in Adobe Acrobat Sign after a government ID check. You can't sign for them." : "We email your securities lawyer a private link. They review the offering and sign themselves. You can't sign for them."}</span></div>
        {c && (
          <div className="legal-tl" aria-label="Where it stands">
            {steps.map(([label, at]) => <div key={label} className={at ? "on" : ""}><b>{label}</b><span>{at ? when(at) : ""}</span></div>)}
          </div>
        )}
        {c && <span className="muted" style={{ fontSize: 13 }}>Sent to {c.name}, {c.firm} ({c.email}) · {c.barState} bar {c.barNumber}</span>}
        {ad?.status === "out" && (
          <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
            <span className="tag y">Out for signature in Adobe since {when(ad.sentAt)}</span>
            <button type="button" className="btn ghost sm" disabled={!!busy} onClick={remind}>{busy === "remind" ? "Sending…" : "Send a reminder now"}</button>
          </div>
        )}
        {ad && ["declined", "expired", "canceled"].includes(ad.status) && <div className="notice">The Adobe request {ad.status === "declined" ? "was declined" : ad.status === "expired" ? "expired unsigned" : "was canceled"}. Your lawyer can open the link again and press Sign off for a new one, or send the link again below.</div>}
        {s.stage === "comments" && c?.comments && <div className="notice">Your lawyer didn't sign yet and wrote: “{c.comments.text}”</div>}
        {s.stage === "changed" && <div className="notice err">The terms changed after your lawyer signed. Send the link again so they can review the new terms.</div>}
        {s.stage === "returned" && s.review && <div className="notice err">Diamondz sent the review back: “{s.review.note}”</div>}
        {sent && <div className="notice ok">We emailed {sent} a private link. You'll see here when they open it and sign.</div>}
        {canInvite && (
          <form onSubmit={invite} className="col" style={{ gap: 10, width: "100%" }}>
            <div className="wz-two">
              <div className="q"><label htmlFor="lg-name">Lawyer's full name</label><input id="lg-name" className="input" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
              <div className="q"><label htmlFor="lg-firm">Law firm</label><input id="lg-firm" className="input" required value={f.firm} onChange={(e) => setF({ ...f, firm: e.target.value })} /></div>
              <div className="q"><label htmlFor="lg-email">Work email at the firm</label><input id="lg-email" type="email" className="input" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
              <div className="q"><label htmlFor="lg-bar">State bar and license number</label>
                <span className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
                  <select className="input" aria-label="State bar" style={{ width: 96 }} value={f.barState} onChange={(e) => setF({ ...f, barState: e.target.value })}>{BAR_STATES.map((x) => <option key={x}>{x}</option>)}</select>
                  <input id="lg-bar" className="input" required value={f.barNumber} onChange={(e) => setF({ ...f, barNumber: e.target.value })} />
                </span>
              </div>
            </div>
            <span className="hint">The email must be at the law firm's own domain. Free email addresses and your own company's domain aren't accepted.</span>
            {!s.emailOn && <div className="notice err">Email isn't set up on the platform yet, so the link can't be sent. Try again shortly.</div>}
            <button className="btn primary" disabled={!!busy || !s.emailOn} style={{ alignSelf: "flex-start" }}>{busy === "invite" ? "Sending…" : c ? "Send the link again" : "Email the sign-off link"}</button>
          </form>
        )}
      </div>

      <div className="legal-row">
        <div><b>3. Diamondz review</b><span className="muted">We confirm the lawyer's bar license and the company check, usually within one business day.</span></div>
        {s.stage === "approved" ? <span className="tag g">Approved</span> : s.stage === "signed" ? <span className="tag y">Waiting for review</span> : <span className="tag">After your lawyer signs</span>}
      </div>
    </div>
  );
}
