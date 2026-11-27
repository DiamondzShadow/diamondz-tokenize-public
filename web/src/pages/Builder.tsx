// Contract Builder (design approved 2026-11-20): for issuers and developers. Pick who can buy, the token type, the
// network and the rules; see in plain English and in code exactly what the platform deploys. Issuers continue into
// the console wizard with the same setup; Reg CF waits for the funding-portal partner, whose checkout runs the sale.
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { SiteHeader } from "../lib/Chrome";
import { lockupLabel } from "../lib/rules";
import {
  CF_STEPS, DEFAULT_BUILD, HOLDER_CAPS, LOCKUPS, ROUTES, STDS, builtFrom, code, decodeBuild, effective, encodeBuild,
  exemptionFor, gates, holderNote, locks, networkName, networksFor, summary, toRules, type Build,
} from "../lib/builder";

const short = (d: number) => lockupLabel(d).replace(/ \(.*\)$/, "");

export default function Builder() {
  const [params, setParams] = useSearchParams();
  const [b, setB] = useState<Build>(() => decodeBuild(params.get("b")) ?? DEFAULT_BUILD);
  const [view, setView] = useState<"plain" | "code">("plain");
  const [copied, setCopied] = useState<"" | "code" | "link">("");
  useEffect(() => { document.title = "Contract Builder · Diamondz Tokenize"; }, []);

  const e = effective(b);
  const lk = locks(b);
  const set = (patch: Partial<Build>) => setB((x) => ({ ...x, ...patch }));
  const out = useMemo(() => code(b), [b]);
  const nets = networksFor(e.std);
  const route = ROUTES.find((r) => r.id === e.route)!;
  const cf = e.route === "cf";
  const enc = encodeBuild(e);
  const startUrl = `/app/new?builder=${enc}`;

  const flash = (k: "code" | "link") => { setCopied(k); setTimeout(() => setCopied(""), 1600); };
  const copyCode = () => navigator.clipboard.writeText(out.text).then(() => flash("code"), () => {});
  const copyLink = () => {
    setParams({ b: enc }, { replace: true });
    navigator.clipboard.writeText(`${location.origin}/builder?b=${enc}`).then(() => flash("link"), () => {});
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([out.text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url; a.download = out.fileName; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="page">
      <SiteHeader />
      <div className="wrap bld">
        <header className="bld-head">
          <div>
            <span className="eyebrow">For issuers and developers</span>
            <h1>Contract Builder</h1>
            <p className="muted">Pick options and see exactly what gets deployed, in plain English or in code. Only the building blocks the platform already runs.</p>
          </div>
          <div className="row bld-actions">
            <button type="button" className="btn ghost sm" onClick={copyLink}>{copied === "link" ? "Link copied" : "Copy setup link"}</button>
            {cf
              ? <span className="bld-cta-note">Reg CF opens with our funding-portal partner</span>
              : <Link className="btn primary sm" to={startUrl}>Start this offering on {networkName(e.chainId)}</Link>}
          </div>
        </header>

        <div className="bld-grid">
          <section aria-label="Options" className="bld-col">
            <div className="bld-card">
              <h2>1. Basics</h2>
              <div className="bld-2">
                <label className="bld-field">Name
                  <input className="input" value={b.name} maxLength={80} onChange={(ev) => set({ name: ev.target.value })} />
                </label>
                <label className="bld-field">Symbol
                  <input className="input" value={b.symbol} onChange={(ev) => set({ symbol: ev.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 11) })} />
                </label>
              </div>
            </div>

            <div className="bld-card">
              <h2>2. Who can buy</h2>
              <div className="bld-3">
                {ROUTES.map((r) => (
                  <button type="button" key={r.id} className={`bld-opt ${e.route === r.id ? "on" : ""}`} aria-pressed={e.route === r.id} onClick={() => set({ route: r.id })}>
                    <b>{r.label}</b><span>{r.sub}</span>
                  </button>
                ))}
              </div>
              <p className="bld-note">{route.note}</p>
              {cf && (
                <div className="bld-flow">
                  <div className="bld-flow-head"><b>How a fan buys</b><span className="muted">Checkout happens on the portal, not on this site</span></div>
                  <ol>
                    {CF_STEPS.map(([title, who], i) => (
                      <li key={title}>
                        <span className={`bld-n ${i < 3 ? "portal" : "us"}`}>{i + 1}</span>
                        <span><b>{title}</b><span className="muted">{who}</span></span>
                      </li>
                    ))}
                  </ol>
                  <p className="bld-ads"><b>Promoting the raise:</b> your posts and ads can only say a raise is open, name the company, the amount and the terms, and link to the portal page. Pitching the deal (returns, “get in early”) belongs on the portal only.</p>
                </div>
              )}
            </div>

            <div className="bld-card">
              <h2>3. Token type</h2>
              <div className="bld-3">
                {STDS.map((s) => (
                  <button type="button" key={s.id} className={`bld-opt ${e.std === s.id ? "on" : ""}`} aria-pressed={e.std === s.id} onClick={() => set({ std: s.id })}>
                    <b>{s.label}</b><span>{s.sub}</span>
                  </button>
                ))}
              </div>
              <div className="bld-row">
                <span className="bld-label">Network</span>
                <div className="chips">
                  {nets.map((n) => (
                    <button type="button" key={n.id} className={`chip ${e.chainId === n.id ? "on" : ""}`} aria-pressed={e.chainId === n.id} onClick={() => set({ chainId: n.id })}>{n.name}</button>
                  ))}
                </div>
              </div>
              {e.std === "erc3643" && <p className="note">ERC-3643 runs on the networks where the platform's T-REX factory is deployed.</p>}
            </div>

            <div className="bld-card">
              <h2>4. Rules the token enforces</h2>
              <div className="bld-row col">
                <span className="bld-label">Holding period per purchase</span>
                <div className="chips">
                  {LOCKUPS.map((d) => (
                    <button type="button" key={d} disabled={lk.lockup && d !== e.lockupDays} className={`chip ${e.lockupDays === d ? "on" : ""}`} aria-pressed={e.lockupDays === d} onClick={() => set({ lockupDays: d })}>{short(d)}</button>
                  ))}
                </div>
                {lk.lockup && <span className="note">Reg CF: one year by law.</span>}
              </div>
              <div className="bld-row col">
                <span className="bld-label">Most holders allowed</span>
                <div className="chips">
                  {HOLDER_CAPS.map(([v, l]) => (
                    <button type="button" key={v} disabled={lk.holders && v !== 0} className={`chip ${e.maxHolders === v ? "on" : ""}`} aria-pressed={e.maxHolders === v} onClick={() => set({ maxHolders: v })}>{l}</button>
                  ))}
                </div>
                <span className="note">{holderNote(e)}</span>
              </div>
              <div className="bld-2">
                <label className={`bld-toggle ${lk.resale ? "locked" : ""}`}>
                  <input type="checkbox" checked={e.resaleApproval} disabled={lk.resale} onChange={() => set({ resaleApproval: !b.resaleApproval })} />
                  <span><b>Issuer approves each resale</b><span className="muted">{cf ? "Required for a Reg CF raise" : e.std === "stellar-rwa" ? "Not available on Stellar yet" : "Buyers can only resell to wallets you approve"}</span></span>
                </label>
                <label className="bld-toggle">
                  <input type="checkbox" checked={e.countryOn} onChange={() => set({ countryOn: !b.countryOn })} />
                  <span><b>{e.route === "regs" ? "Block US investors" : "US investors only"}</b><span className="muted">Checked on every transfer</span></span>
                </label>
                <label className={`bld-toggle ${lk.maturity ? "locked" : ""}`}>
                  <input type="checkbox" checked={!!e.maturity} disabled={lk.maturity}
                    onChange={() => set({ maturity: b.maturity ? "" : new Date(Date.now() + 5 * 365 * 864e5).toISOString().slice(0, 10) })} />
                  <span><b>Ends on a set date</b><span className="muted">{lk.maturity ? "Not available on Stellar yet" : "Transfers stop at maturity; redemptions still work"}</span></span>
                </label>
                {!!e.maturity && (
                  <label className="bld-field">Maturity date
                    <input className="input" type="date" value={e.maturity} onChange={(ev) => set({ maturity: ev.target.value })} />
                  </label>
                )}
              </div>
            </div>
          </section>

          <section aria-label="Result" className="bld-col">
            <div role="tablist" aria-label="View" className="bld-tabs">
              <button type="button" role="tab" aria-selected={view === "plain"} className={view === "plain" ? "on" : ""} onClick={() => setView("plain")}>Plain English</button>
              <button type="button" role="tab" aria-selected={view === "code"} className={view === "code" ? "on" : ""} onClick={() => setView("code")}>Code</button>
            </div>

            {view === "plain" ? (
              <div className="bld-card">
                <span className="bld-kicker">What you are creating</span>
                <h2 className="bld-headline">{STDS.find((s) => s.id === e.std)!.label} for {{ "506c": "accredited investors", cf: "fans and the public", regs: "international buyers" }[e.route]}</h2>
                <ul className="bld-list">
                  {summary(b).map((l) => <li key={l}><Check />{l}</li>)}
                </ul>
                <div className="bld-built">
                  <span className="bld-kicker">Built from</span>
                  <div className="chips">{builtFrom(e).map((x) => <span key={x} className="bld-tag">{x}</span>)}</div>
                </div>
              </div>
            ) : (
              <div className="bld-code">
                <div className="bld-code-bar">
                  <span>{out.fileName}</span>
                  <span className="row" style={{ gap: 8 }}>
                    <button type="button" onClick={copyCode}>{copied === "code" ? "Copied" : "Copy"}</button>
                    <button type="button" onClick={download}>Download</button>
                  </span>
                </div>
                <pre>{out.text}</pre>
              </div>
            )}

            <div className="bld-card">
              <span className="bld-kicker">Before this can go live</span>
              <ul className="bld-list gates">
                {gates(e).map((g) => <li key={g}><Alert />{g}</li>)}
              </ul>
              {!cf && <p className="note">Starting the offering saves it as a draft in your console with these settings (exemption: {exemptionFor(e.route) === "506c" ? "Reg D 506(c)" : "Reg S"}, {toRules(e).lockupDays ? short(toRules(e).lockupDays) : "no"} holding period). Nothing is deployed until you go live.</p>}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

const Check = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--ok)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>;
const Alert = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--warn)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v6" /><path d="M12 16.5v.5" /></svg>;
