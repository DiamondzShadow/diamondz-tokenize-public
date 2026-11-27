// Issuer › offering › signed checks through Adobe Acrobat Sign (designs E1 + E2, canvas 64RrhpPn58Y2JfHVqwmHZ1,
// approved 2026-11-27). The issuer requests a check from an approved verifier firm; Diamondz sends the letter from its
// Adobe account; the signer proves who they are and signs in Adobe; we keep the signed letter + audit report and
// record their fingerprint on chain with the check.
import { useCallback, useEffect, useState } from "react";
import { api, type Asset, type EsignIssuer, type EsignRequest, type EsignSendBody } from "../lib/api";
import { networkById, txUrl } from "../lib/chains";

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");
const ID_LABEL = { GOV_ID: "Government ID", PHONE: "Phone code" } as const;
const OPEN = ["sent", "opened", "identity"];

export const STATUS_TAG: Record<string, [string, string]> = {
  sent: ["y", "Waiting for signature"], opened: ["y", "Opened, not signed"], identity: ["y", "Identity confirmed"],
  signed: ["y", "Signed, recording on chain"], recorded: ["g", "Signed · on chain"],
  declined: ["", "Declined"], expired: ["", "Expired"], canceled: ["", "Canceled"],
};

/** Sent → Opened → Identity confirmed → Signed in Adobe → Recorded on chain. */
export function EsignTimeline({ r }: { r: EsignRequest }) {
  const steps: [string, string | null, string][] = [
    ["Sent", r.sentAt, fmt(r.sentAt)],
    ["Opened", r.openedAt, fmt(r.openedAt)],
    ["Identity confirmed", r.identityAt, ID_LABEL[r.idMethod]],
    ["Signed in Adobe", r.signedAt, fmt(r.signedAt) || "—"],
    ["Recorded on chain", r.recordedAt, fmt(r.recordedAt) || "—"],
  ];
  return (
    <ol className="es-steps" aria-label="Signing progress">
      {steps.map(([label, at, sub]) => (
        <li key={label} className={at ? "on" : ""}><i /><b>{label}</b><span>{sub}</span></li>
      ))}
    </ol>
  );
}

export default function EsignPanel({ asset }: { asset: Asset }) {
  const [d, setD] = useState<EsignIssuer | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<string | null>(null); // kind id for the request dialog
  const [busy, setBusy] = useState("");
  const net = networkById(asset.chainId);
  const load = useCallback(() => api.esign(asset.id).then(setD, (e) => setErr(e.message)), [asset.id]);
  useEffect(() => { load(); }, [load]);
  // Keep the timeline moving while something is out for signature.
  useEffect(() => {
    if (!d?.requests.some((r) => OPEN.includes(r.status) || r.status === "signed")) return;
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [d, load]);

  const act = async (rid: string, what: "remind" | "cancel") => {
    if (what === "cancel" && !confirm("Cancel this signing request? The signer's link stops working.")) return;
    setBusy(rid + what); setErr("");
    try { await (what === "remind" ? api.esignRemind(asset.id, rid) : api.esignCancel(asset.id, rid)); await load(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  };

  if (!d) return <section className="panel"><h3>Signed checks</h3>{err ? <div className="notice err">{err}</div> : <span className="muted">Loading…</span>}</section>;
  const latest = (kind: string) => d.requests.filter((r) => r.kind === kind).sort((a, b) => b.sentAt.localeCompare(a.sentAt))[0];

  return (
    <section className="panel es" id="signed-checks">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", alignItems: "flex-end" }}>
        <div>
          <h3 style={{ fontSize: 20 }}>Signed checks</h3>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 14 }}>Each check is a letter signed by an approved professional in Adobe Acrobat Sign. Sales stay paused until every check is current.</p>
        </div>
        <button className="btn primary sm" type="button" disabled={!d.configured || !d.deployed} onClick={() => setOpen(d.kinds.find((k) => !latest(k.id) || !OPEN.includes(latest(k.id)!.status))?.id ?? d.kinds[0]?.id ?? null)}>Request a signed check</button>
      </div>
      {!d.configured && <div className="notice warn">Adobe Acrobat Sign is being connected. Requests open as soon as it's live.</div>}
      {err && <div className="notice err" role="alert">{err}</div>}

      <div className="es-grid">
        <div className="es-list">
          {d.kinds.map((k) => {
            const r = latest(k.id);
            const [cls, label] = r ? STATUS_TAG[r.status] ?? ["", r.status] : ["", "Not requested"];
            return (
              <article className="es-card" key={k.id}>
                <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap" }}>
                  <div style={{ minWidth: 0 }}>
                    <b style={{ fontSize: 16 }}>{k.name}</b>
                    <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>{k.confirms}</div>
                  </div>
                  <span className={`tag ${cls}`}>{label}</span>
                </div>
                {r && <EsignTimeline r={r} />}
                {r && (
                  <div className="es-foot">
                    {r.status === "recorded" || r.status === "signed" ? (
                      <>
                        <span className="muted">Signed by {r.signerName}, {r.firmName}</span>
                        {r.hasFiles && <a href={`/api/esign/${r.id}/letter.pdf`} target="_blank" rel="noreferrer">Signed letter (PDF)</a>}
                        {r.hasFiles && <a href={`/api/esign/${r.id}/audit.pdf`} target="_blank" rel="noreferrer">Adobe audit report</a>}
                        {r.tx && net && <a href={txUrl(net, r.tx)} target="_blank" rel="noreferrer">On-chain record</a>}
                        {r.status === "signed" && r.recordError && <span className="muted">Recording on chain is waiting on Diamondz. We'll finish it shortly.</span>}
                      </>
                    ) : OPEN.includes(r.status) ? (
                      <>
                        <span className="muted" style={{ flex: "1 1 260px" }}>Sent to {r.signerName}, {r.firmName}. Adobe sends a reminder every 3 days; the request expires {fmt(r.expiresAt)}.</span>
                        <button className="btn ghost sm" type="button" disabled={!!busy} onClick={() => act(r.id, "remind")}>{busy === r.id + "remind" ? "Sending…" : "Send a reminder now"}</button>
                        <button className="btn ghost sm es-danger" type="button" disabled={!!busy} onClick={() => act(r.id, "cancel")}>Cancel request</button>
                      </>
                    ) : (
                      <>
                        <span className="muted" style={{ flex: "1 1 260px" }}>
                          {r.status === "declined" ? `${r.signerName} declined${r.declineReason ? `: "${r.declineReason}"` : "."}` : r.status === "expired" ? `The request to ${r.signerName} expired unsigned.` : "This request was canceled."}
                        </span>
                        <button className="btn ghost sm" type="button" disabled={!d.configured} onClick={() => setOpen(k.id)}>Send a new request</button>
                      </>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
        <aside className="es-how">
          <span className="es-kicker">How signing works</span>
          <ol>
            <li>You pick the check and an approved verifier. You never sign checks on your own asset.</li>
            <li>Diamondz sends the letter through Adobe Acrobat Sign. The signer needs no Diamondz or Adobe account.</li>
            <li>The signer confirms their identity, reviews and signs in Adobe.</li>
            <li>We save the signed letter and Adobe's audit report, and record their fingerprint on chain with the check.</li>
          </ol>
          <div className="es-note">Investors see who signed and when, and can download the signed letter and audit report from the listing.</div>
        </aside>
      </div>

      {open && <RequestDialog asset={asset} d={d} kind={open} onClose={() => setOpen(null)} onSent={() => { setOpen(null); load(); }} />}
    </section>
  );
}

function RequestDialog({ asset, d, kind: initial, onClose, onSent }: { asset: Asset; d: EsignIssuer; kind: string; onClose: () => void; onSent: () => void }) {
  const [f, setF] = useState<EsignSendBody & { cc: string; ph: string }>({ kind: initial, firmId: "", signerName: "", signerEmail: "", idMethod: "GOV_ID", note: "", cc: "+1", ph: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const firms = d.firms.filter((x) => x.kinds.includes(f.kind));
  const firm = firms.find((x) => x.id === f.firmId) ?? null;
  const k = d.kinds.find((x) => x.id === f.kind);
  useEffect(() => { setF((v) => ({ ...v, firmId: firms.some((x) => x.id === v.firmId) ? v.firmId : firms[0]?.id ?? "" })); }, [f.kind]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const e = (ev: KeyboardEvent) => ev.key === "Escape" && onClose(); addEventListener("keydown", e); return () => removeEventListener("keydown", e); }, [onClose]);
  const set = (p: Partial<typeof f>) => setF((v) => ({ ...v, ...p }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      const { cc, ph, ...body } = f;
      await api.esignSend(asset.id, { ...body, phone: f.idMethod === "PHONE" ? { countryCode: cc.replace(/^\+/, ""), phone: ph.replace(/\D/g, "") } : undefined });
      onSent();
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="overlay es-overlay" role="dialog" aria-modal="true" aria-labelledby="es-title" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="es-dialog">
        <form onSubmit={submit} className="es-form">
          <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", flexWrap: "nowrap" }}>
            <div>
              <span className="es-kicker">{asset.name} · Proof of asset</span>
              <h2 id="es-title" className="es-h2">Request a signed check</h2>
            </div>
            <button type="button" className="iconbtn" aria-label="Close" onClick={onClose}>✕</button>
          </div>
          <label className="field">Check
            <select value={f.kind} onChange={(e) => set({ kind: e.target.value })}>
              {d.kinds.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
          <label className="field">Verifier firm
            <select value={f.firmId} onChange={(e) => set({ firmId: e.target.value })} disabled={!firms.length}>
              {!firms.length && <option value="">No firm is approved for this check yet</option>}
              {firms.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
            <span className="es-hint">Only firms Diamondz has approved for this check are listed. To add a firm, send Diamondz its name and website through the contact form.</span>
          </label>
          <div className="es-two">
            <label className="field">Signer's name<input required value={f.signerName} onChange={(e) => set({ signerName: e.target.value })} placeholder="Full legal name" autoComplete="off" /></label>
            <label className="field">Signer's work email<input required type="email" value={f.signerEmail} onChange={(e) => set({ signerEmail: e.target.value })} placeholder={firm ? `name@${firm.domain}` : "name@firm.com"} autoComplete="off" /></label>
          </div>
          <fieldset className="es-radio">
            <legend>How the signer proves who they are</legend>
            <label className={f.idMethod === "GOV_ID" ? "on" : ""}><input type="radio" name="idm" checked={f.idMethod === "GOV_ID"} onChange={() => set({ idMethod: "GOV_ID" })} /><span><b>Government ID</b><br /><span className="muted">Photo of a passport or driver's license, checked by Adobe before signing.</span></span></label>
            <label className={f.idMethod === "PHONE" ? "on" : ""}><input type="radio" name="idm" checked={f.idMethod === "PHONE"} onChange={() => set({ idMethod: "PHONE" })} /><span><b>Phone code</b><br /><span className="muted">A one-time code by text message to the signer's phone.</span></span></label>
          </fieldset>
          {f.idMethod === "PHONE" && (
            <div className="es-two" style={{ gridTemplateColumns: "90px minmax(0,1fr)" }}>
              <label className="field">Country<input value={f.cc} onChange={(e) => set({ cc: e.target.value })} inputMode="tel" /></label>
              <label className="field">Signer's mobile<input required value={f.ph} onChange={(e) => set({ ph: e.target.value })} inputMode="tel" placeholder="212 555 0100" /></label>
            </div>
          )}
          <label className="field">Note to the signer <span className="muted">(optional)</span>
            <textarea rows={3} value={f.note} onChange={(e) => set({ note: e.target.value })} placeholder="Policy number, documents attached, deadline" maxLength={600} />
          </label>
          {err && <div className="notice err" role="alert">{err}</div>}
          <div className="row" style={{ justifyContent: "flex-end", borderTop: "1px solid var(--line)", paddingTop: 16, flexWrap: "wrap" }}>
            <button type="button" className="btn ghost sm" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn primary sm" disabled={busy || !firm}>{busy ? "Sending…" : "Send for signature"}</button>
          </div>
        </form>
        <aside className="es-letter">
          <span className="es-kicker">The letter they sign</span>
          <div className="es-paper">
            <b>{k?.name} attestation</b>
            <span>Asset: {asset.name}<br />Token: {asset.deployment?.token}<br />Network: {networkById(asset.chainId)?.name}</span>
            <span>I confirm: {k?.confirms}</span>
            <span>Reference: [filled in by the signer]</span>
            <span>I am authorized by {firm?.name ?? "[firm]"} to give this confirmation.</span>
            <span className="sig">Signature · name · title · date (completed in Adobe)</span>
          </div>
          <p className="muted" style={{ fontSize: 12, margin: 0 }}>The signer fills in the reference and their title in Adobe. The letter template is the same for every offering.</p>
        </aside>
      </div>
    </div>
  );
}
