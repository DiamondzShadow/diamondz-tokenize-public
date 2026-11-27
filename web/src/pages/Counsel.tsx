// /counsel/:token — the lawyer's sign-off page (designs L2 desktop, L4 phone; approved 2026-11-20). Opens only after a
// one-time code sent to the invited inbox. The lawyer reviews the offering and the rules the token enforces, uploads
// a signed PDF letter, confirms three statements and types their name to sign, or sends comments back instead.
import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { api, type CounselView } from "../lib/api";
import { networkById, stellarById } from "../lib/chains";
import { Mark } from "./Landing";
import { BAR_STATES } from "../app/Legal";

const EX: Record<string, string> = { "506c": "Rule 506(c)", regs: "Regulation S", unsure: "Not decided yet" };

export default function Counsel() {
  const { token = "" } = useParams();
  const [v, setV] = useState<CounselView | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [bar, setBar] = useState({ state: "NY", number: "" });
  const [st, setSt] = useState([false, false, false]);
  const [name, setName] = useState("");
  const [comments, setComments] = useState("");
  const [showComments, setShowComments] = useState(false);
  const [done, setDone] = useState("");
  const load = () => api.counsel(token).then((x) => { setV(x); if (x.counsel) setBar((b) => (b.number ? b : { state: x.counsel!.barState, number: x.counsel!.barNumber })); }, (e) => setErr(e.message));
  useEffect(() => { load(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (k: string, fn: () => Promise<void>) => { setBusy(k); setErr(""); try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(""); } };
  const sendCode = () => run("code", async () => { setSentTo((await api.counselCode(token)).email); });
  const verify = (e: FormEvent) => { e.preventDefault(); run("verify", async () => { await api.counselVerify(token, code); await load(); }); };
  const upload = (f: File | undefined) => f && run("upload", async () => { await api.counselLetter(token, f); await load(); });
  const sign = (e: FormEvent) => { e.preventDefault(); run("sign", async () => { await api.counselSign(token, { barState: bar.state, barNumber: bar.number.trim(), statements: [true, true, true], name: name.trim() }); setDone("signed"); await load(); }); };
  const sendComments = (e: FormEvent) => { e.preventDefault(); run("comments", async () => { await api.counselComments(token, comments.trim()); setDone("comments"); }); };

  const o = v?.offering;
  const net = o ? (networkById(o.chainId)?.name ?? stellarById(o.chainId)?.name ?? `Network ${o.chainId}`) : "";
  const rules = (o?.rules ?? {}) as Record<string, any>;
  return (
    <div className="page counsel">
      <header className="wrap counsel-hdr"><span className="row" style={{ gap: 10 }}><Mark /><b className="display" style={{ fontSize: 20 }}>Diamondz Tokenize</b><span className="muted" style={{ fontSize: 13 }}>· Counsel sign-off</span></span>
        {v && !v.needsCode && v.counsel && <span className="tag g">Signed in as {v.counsel.email} (code verified)</span>}</header>
      <main className="wrap counsel-main">
        {err && <div className="notice err">{err}</div>}
        {!v ? (!err && <p className="muted">Loading…</p>) : v.needsCode ? (
          <section className="panel counsel-gate">
            <span className="eyebrow">Sign-off requested by {v.issuer}</span>
            <h1>Confirm it's you</h1>
            <p className="muted">We'll email a one-time code to {v.email}. Only the invited lawyer can open this page.</p>
            {!sentTo ? <button className="btn primary" disabled={!!busy} onClick={sendCode}>{busy === "code" ? "Sending…" : "Email me a code"}</button> : (
              <form onSubmit={verify} className="col" style={{ gap: 10 }}>
                <label className="field">Code sent to {sentTo}<input className="input" inputMode="numeric" autoComplete="one-time-code" autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} /></label>
                <button className="btn primary" disabled={!!busy || code.length !== 6}>{busy === "verify" ? "Checking…" : "Open the sign-off page"}</button>
                <button type="button" className="btn link sm" onClick={sendCode} disabled={!!busy}>Send a new code</button>
              </form>
            )}
          </section>
        ) : done === "comments" ? (
          <div className="notice ok">Thanks. Your comments went to {v.issuer}. They can change the offering and ask you again.</div>
        ) : (
          <>
            <div>
              <h1 className="counsel-h1">{v.issuer} asks you to sign off on an offering</h1>
              <p className="muted" style={{ margin: "6px 0 0" }}>Review what the token will enforce, attach your signed opinion or approval letter, and sign. Your sign-off is recorded with your bar details, the time and a fingerprint of your letter.</p>
            </div>
            <div className="counsel-grid">
              <section className="panel">
                <h3>The offering</h3>
                <div className="li"><span className="muted">Name</span><span>{o!.name} ({o!.symbol})</span></div>
                <div className="li"><span className="muted">Issuer</span><span>{v.company?.name ?? v.issuer}{v.company?.status === "verified" ? " · verified by Stripe" : " · company not yet verified"}</span></div>
                <div className="li"><span className="muted">Exemption chosen</span><span>{EX[o!.exemption ?? ""] ?? "Not set"}</span></div>
                <div className="li"><span className="muted">Raise</span><span>{Number(o!.totalSupply).toLocaleString()} tokens at ${o!.pricePerToken}{Number(o!.minInvestment) ? ` · $${Number(o!.minInvestment).toLocaleString()} minimum` : ""}</span></div>
                <div className="li"><span className="muted">Network</span><span>{net}</span></div>
                <h3 style={{ marginTop: 10 }}>Rules the token enforces on every transfer</h3>
                <div className="li"><span className="muted">Who can hold</span><span>Identity-checked{rules.accreditedOnly ? ", accredited investors only" : " investors"}</span></div>
                {Array.isArray(rules.countries) && rules.countries.length > 0 && <div className="li"><span className="muted">Countries</span><span>{rules.countries.join(", ")}</span></div>}
                {(rules.lockupDays || o!.lockup) && <div className="li"><span className="muted">Holding period</span><span>{rules.lockupDays ? `${rules.lockupDays} days before resale` : o!.lockup}</span></div>}
                {rules.maxHolders ? <div className="li"><span className="muted">Most holders</span><span>{rules.maxHolders}</span></div> : null}
                {rules.resaleApproval ? <div className="li"><span className="muted">Resales</span><span>Need the issuer's approval</span></div> : null}
                <h3 style={{ marginTop: 10 }}>Documents on file</h3>
                {o!.documents.length ? o!.documents.map((d) => <div className="li" key={d.sha256}><span className="muted">{d.name}</span>{d.url ? <a href={d.url} target="_blank" rel="noreferrer">Open ↗</a> : <span className="mono" style={{ fontSize: 11 }}>{d.sha256.slice(0, 16)}…</span>}</div>) : <span className="muted" style={{ fontSize: 13 }}>No documents attached.</span>}
              </section>
              {v.signed || done === "signed" ? (
                <section className="panel"><h3>Signed</h3><div className="notice ok">You signed off{v.signed ? ` on ${new Date(v.signed.at).toLocaleString()}` : ""}. Diamondz will confirm your license and approve. If the terms change, you'll be asked again.</div></section>
              ) : (
                <form className="panel" onSubmit={sign}>
                  <h3>Your sign-off</h3>
                  <div className="wz-two">
                    <div className="q"><label htmlFor="cs-state">State bar</label><select id="cs-state" className="input" value={bar.state} onChange={(e) => setBar({ ...bar, state: e.target.value })}>{BAR_STATES.map((x) => <option key={x}>{x}</option>)}</select></div>
                    <div className="q"><label htmlFor="cs-num">License number</label><input id="cs-num" className="input" value={bar.number} onChange={(e) => setBar({ ...bar, number: e.target.value })} /></div>
                  </div>
                  <label className="field">Your opinion or approval letter (signed PDF, up to 10 MB)
                    {v.letter ? <span className="counsel-file">Uploaded · {(v.letter.bytes / 1024).toFixed(0)} KB <label className="btn link sm">Replace<input type="file" accept="application/pdf" hidden onChange={(e) => upload(e.target.files?.[0])} /></label></span>
                      : <input type="file" accept="application/pdf" className="input" disabled={busy === "upload"} onChange={(e) => upload(e.target.files?.[0])} />}
                  </label>
                  {[
                    `I'm licensed to practice law in ${bar.state} and I'm in good standing.`,
                    "I've reviewed the offering's terms, documents and the transfer rules listed here.",
                    "In my opinion the offering may proceed under the exemption shown, as described in my letter.",
                  ].map((t, i) => <label key={i} className="counsel-ck"><input type="checkbox" checked={st[i]} onChange={(e) => setSt(st.map((x, j) => (j === i ? e.target.checked : x)))} />{t}</label>)}
                  <label className="field">Type your full name to sign<input className="input counsel-sig" value={name} onChange={(e) => setName(e.target.value)} placeholder={v.counsel?.name} /></label>
                  <button className="btn primary" disabled={!!busy || !v.letter || !st.every(Boolean) || name.trim().length < 3 || !bar.number.trim()} style={{ justifyContent: "center" }}>{busy === "sign" ? "Signing…" : "Sign off"}</button>
                  {!showComments ? <button type="button" className="btn link sm" onClick={() => setShowComments(true)}>I can't sign this yet: send my comments to the issuer</button> : null}
                </form>
              )}
            </div>
            {showComments && !v.signed && done !== "signed" && (
              <form className="panel" onSubmit={sendComments}>
                <label className="field">Your comments for {v.issuer}<textarea className="input" rows={4} value={comments} onChange={(e) => setComments(e.target.value)} /></label>
                <button className="btn ghost" disabled={!!busy || comments.trim().length < 3} style={{ alignSelf: "flex-start" }}>{busy === "comments" ? "Sending…" : "Send comments"}</button>
              </form>
            )}
            <p className="muted" style={{ fontSize: 12 }}>Diamondz Tokenize is software, not a law firm or broker-dealer. Your sign-off goes to the issuer and to Diamondz's review; Diamondz checks your license with the state bar before the offering can go live.</p>
          </>
        )}
      </main>
    </div>
  );
}
