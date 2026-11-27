// Investor: show you're an accredited investor, via Mastercard Open Finance (design canvas UzMg5WJ2BGKFGCzBaWkMRu A1–A3, A6).
// Identity details go to Mastercard only (the API passes them through and never stores them); the investor's wallet
// signs the request so nobody can start one for someone else's wallet.
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Connect as McConnect } from "connect-web-sdk";
import { api, type AccreditationPublic, type MarketAsset } from "../lib/api";
import { SiteHeader } from "../lib/Chrome";
import Connect from "../lib/Connect";
import { ensureChain, useConnectedAccount, walletClientFor, walletError } from "../lib/wallet";

const STATES: [string, string][] = [["AL","Alabama"],["AK","Alaska"],["AZ","Arizona"],["AR","Arkansas"],["CA","California"],["CO","Colorado"],["CT","Connecticut"],["DE","Delaware"],["DC","District of Columbia"],["FL","Florida"],["GA","Georgia"],["HI","Hawaii"],["ID","Idaho"],["IL","Illinois"],["IN","Indiana"],["IA","Iowa"],["KS","Kansas"],["KY","Kentucky"],["LA","Louisiana"],["ME","Maine"],["MD","Maryland"],["MA","Massachusetts"],["MI","Michigan"],["MN","Minnesota"],["MS","Mississippi"],["MO","Missouri"],["MT","Montana"],["NE","Nebraska"],["NV","Nevada"],["NH","New Hampshire"],["NJ","New Jersey"],["NM","New Mexico"],["NY","New York"],["NC","North Carolina"],["ND","North Dakota"],["OH","Ohio"],["OK","Oklahoma"],["OR","Oregon"],["PA","Pennsylvania"],["RI","Rhode Island"],["SC","South Carolina"],["SD","South Dakota"],["TN","Tennessee"],["TX","Texas"],["UT","Utah"],["VT","Vermont"],["VA","Virginia"],["WA","Washington"],["WV","West Virginia"],["WI","Wisconsin"],["WY","Wyoming"]];

const message = (p: { assetId: string; wallet: string; route: string; ts: number }) =>
  `Diamondz Tokenize accreditation request\nOffering: ${p.assetId}\nWallet: ${p.wallet}\nRoute: ${p.route}\nTime: ${p.ts}`;
const storeKey = (assetId: string, wallet: string) => `accredit:${assetId}:${wallet.toLowerCase()}`;
const load = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const save = (k: string, v: string | null) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* resume won't survive a reload */ } };

export default function Accredit() {
  const { id = "" } = useParams();
  const account = useConnectedAccount();
  const [asset, setAsset] = useState<MarketAsset | null>(null);
  const [consent, setConsent] = useState<string>("");
  const [err, setErr] = useState("");
  const [route, setRoute] = useState<"income" | "assets">("income");
  const [f, setF] = useState({ firstName: "", lastName: "", birthday: "", state: "", email: "" });
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [req, setReq] = useState<{ id: string; link?: string } | null>(null);
  const [status, setStatus] = useState<AccreditationPublic | null>(null);
  const embed = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.marketAsset(id).then(setAsset, (e) => setErr(e.message));
    api.accreditationConsent(id).then((c) => setConsent(c.text), () => {});
  }, [id]);

  // Resume a request this wallet already started for this offering.
  useEffect(() => {
    if (!account) return;
    const prev = load(storeKey(id, account));
    if (prev) api.accreditationStatus(prev, account).then((s) => { setReq({ id: prev }); setStatus(s); }, () => save(storeKey(id, account), null));
  }, [account, id]);

  // While the report is being prepared, check every 10 seconds.
  useEffect(() => {
    if (!req || !account || !status || !["reporting"].includes(status.status)) return;
    const t = setInterval(() => api.accreditationStatus(req.id, account).then(setStatus, () => {}), 10_000);
    return () => clearInterval(t);
  }, [req, account, status]);

  // Embed Mastercard Data Connect when we have a link.
  useEffect(() => {
    if (!req?.link || !embed.current || !account) return;
    McConnect.launch(req.link, {
      onDone: async () => {
        try {
          setStatus(await api.accreditationLinked(req.id, account));
        } catch (e) {
          setErr(walletError(e));
        }
      },
      onCancel: () => setErr("You closed Mastercard's window before linking an account. Reopen it to continue."),
      onError: () => setErr("Mastercard's window reported an error. Reopen it and try again."),
      onRoute: () => {},
      onUser: () => {},
      onLoad: () => {},
    }, { selector: "#mc-connect" });
    return () => { try { McConnect.destroy(); } catch { /* already closed */ } };
  }, [req?.link, account]);

  async function start() {
    if (!account || !asset) return;
    setErr("");
    setBusy(true);
    try {
      await ensureChain(asset.chainId); // thirdweb logins need their provider built for this network before they can sign
      const ts = Math.floor(Date.now() / 1000);
      const signature = await walletClientFor(asset.chainId, account).signMessage({ account, message: message({ assetId: asset.id, wallet: account, route, ts }) });
      const r = await api.accreditationStart({ assetId: asset.id, wallet: account, route, ...f, state: f.state, consent: true, ts, signature });
      save(storeKey(asset.id, account), r.id);
      setReq({ id: r.id, link: r.link });
      setStatus({ id: r.id, assetId: asset.id, wallet: account, route, status: "linking", decision: null, preparedAt: null, consentAt: new Date().toISOString() });
    } catch (e) {
      setErr(walletError(e));
    } finally {
      setBusy(false);
    }
  }

  const valid = !!account && agreed && f.firstName.trim() && f.lastName.trim() && /^\d{4}-\d{2}-\d{2}$/.test(f.birthday) && f.state && /.+@.+\..+/.test(f.email);
  const phase = !status ? "form" : status.status === "linking" ? "connect" : "done";
  const offering = asset?.name ?? "this offering";

  return (
    <div className="page">
      <SiteHeader back={`/market/${id}`} title="Accredited investor check" />
      <section className="wrap section" style={{ paddingTop: 40, gap: 24, maxWidth: 1100 }}>
        <Link to={`/market/${id}`} className="muted desktop-only" style={{ fontSize: 14 }}>← {offering}</Link>
        {err && <div className="notice err">{err}</div>}

        {phase === "form" && (
          <div className="acc-grid">
            <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
              <h1 style={{ fontSize: 40, lineHeight: 1.08 }}>Show you're an accredited investor</h1>
              <p className="muted" style={{ fontSize: 17, lineHeight: 1.6 }}>
                {offering} is open only to accredited investors. Link your bank or brokerage through Mastercard Open Finance and the issuer receives a verified report. You don't upload statements.
              </p>
              <fieldset style={{ border: 0, margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
                <legend className="eyebrow" style={{ marginBottom: 10 }}>How do you qualify?</legend>
                {([
                  ["income", "Income", "Over $200,000 a year in each of the last two years, or $300,000 with a spouse. Mastercard reads two years of deposits."],
                  ["assets", "Assets", "Net worth over $1 million, not counting your home. Mastercard reports your account balances; the issuer may also ask about debts."],
                ] as const).map(([v, t, d]) => (
                  <label key={v} className={`choice-card ${route === v ? "sel" : ""}`}>
                    <input type="radio" name="route" checked={route === v} onChange={() => setRoute(v)} />
                    <span style={{ display: "flex", flexDirection: "column", gap: 4 }}><b style={{ fontSize: 14 }}>{t}</b><span className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>{d}</span></span>
                  </label>
                ))}
              </fieldset>

              <div className="panel">
                <div><b>Your details for Mastercard</b><br /><small className="muted">Sent straight to Mastercard to create your report. We don't keep them.</small></div>
                <div className="form3" style={{ gridTemplateColumns: "1fr 1fr" }}>
                  <label className="field">Legal first name<input className="input" autoComplete="given-name" value={f.firstName} onChange={(e) => setF({ ...f, firstName: e.target.value })} /></label>
                  <label className="field">Legal last name<input className="input" autoComplete="family-name" value={f.lastName} onChange={(e) => setF({ ...f, lastName: e.target.value })} /></label>
                  <label className="field">Date of birth<input className="input" type="date" autoComplete="bday" value={f.birthday} onChange={(e) => setF({ ...f, birthday: e.target.value })} /></label>
                  <label className="field">State
                    <select className="input" value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })}>
                      <option value="">Choose…</option>
                      {STATES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
                    </select>
                  </label>
                </div>
                <label className="field">Email<input className="input" type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
              </div>

              <label className="choice-card" style={{ cursor: "pointer" }}>
                <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
                <span className="muted" style={{ fontSize: 14, lineHeight: 1.55 }}>{consent || "Loading the consent wording…"}</span>
              </label>

              {!account && <div style={{ maxWidth: 320 }}><Connect chainId={asset?.chainId ?? 84532} label="Connect the wallet you'll invest from" /></div>}
              <div className="row" style={{ flexWrap: "wrap" }}>
                <button className="btn primary" disabled={!valid || busy || !consent} onClick={start}>{busy ? "Confirm in your wallet…" : "Continue to link accounts"}</button>
                <small className="muted">Your wallet signs the request (free). About 3 minutes.</small>
              </div>
            </div>
            <aside style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div className="panel">
                {[["Report by", "Mastercard Open Finance"], ["Shared with", `${offering} issuer only`], ["On chain", "Nothing personal"], ["Who decides", "The issuer"]].map(([k, v]) => (
                  <div className="li" key={k}><span className="muted">{k}</span><span>{v}</span></div>
                ))}
              </div>
              <div className="notice">The issuer reviews the report and, if you qualify, verifies your wallet. You can then buy. Your bank login is entered in Mastercard's window, never on this site.</div>
            </aside>
          </div>
        )}

        {phase === "connect" && (
          <div className="acc-grid">
            <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
              <h1 style={{ fontSize: 34 }}>Link your accounts</h1>
              <p className="muted" style={{ fontSize: 15, lineHeight: 1.6 }}>Pick your bank or brokerage in Mastercard's window and sign in there. Choose the accounts that show your {route === "income" ? "income" : "balances"}.</p>
              <div>
                <div className="setup-step done"><span className="c">✓</span><div className="t"><b>Details sent to Mastercard</b><small>{route === "income" ? "Income" : "Assets"} route · consent recorded</small></div></div>
                <div className="setup-step next"><span className="c">2</span><div className="t"><b>Link your accounts</b><small>In Mastercard's window. Your login never reaches this site.</small></div></div>
                <div className="setup-step"><span className="c">3</span><div className="t"><b>Mastercard prepares your report</b><small>Usually under a minute</small></div></div>
                <div className="setup-step"><span className="c">4</span><div className="t"><b>Sent to the issuer</b><small>They review it and verify your wallet</small></div></div>
              </div>
              {!req?.link && <div className="notice">Mastercard's window needs a fresh link. Start again to reopen it.</div>}
              {!req?.link && <button className="btn ghost sm" style={{ alignSelf: "flex-start" }} onClick={() => { if (account) save(storeKey(id, account), null); setReq(null); setStatus(null); }}>Start again</button>}
            </div>
            <div id="mc-connect" ref={embed} className="panel" style={{ position: "relative", minHeight: 640, padding: 0, overflow: "hidden" }} aria-label="Mastercard Data Connect" />
          </div>
        )}

        {phase === "done" && status && (
          <div style={{ maxWidth: 720, display: "flex", flexDirection: "column", gap: 20 }}>
            {status.status === "failed"
              ? <span className="tag y" style={{ alignSelf: "flex-start" }}>Report failed</span>
              : status.decision === "approved" ? <span className="tag g" style={{ alignSelf: "flex-start" }}>Approved</span>
              : status.status === "ready" ? <span className="tag g" style={{ alignSelf: "flex-start" }}>Report ready</span>
              : <span className="tag" style={{ alignSelf: "flex-start" }}>Preparing your report…</span>}
            <h1 style={{ fontSize: 40, lineHeight: 1.1 }}>
              {status.status === "failed" ? "Mastercard couldn't prepare your report" : status.decision === "approved" ? "The issuer approved your accreditation" : status.status === "ready" ? `Sent to the ${offering} issuer` : "Mastercard is preparing your report"}
            </h1>
            <p className="muted" style={{ fontSize: 17, lineHeight: 1.6 }}>
              {status.status === "failed" ? "Start again and link accounts that hold your income or balances." : status.decision === "approved" ? "Your wallet will be verified for this offering; you can buy once it shows as verified." : status.decision === "declined" ? "The issuer didn't approve this request. Contact them if you think that's a mistake." : status.decision === "more" ? "The issuer needs more information. They'll contact you." : "The issuer will review it and, if you qualify, verify your wallet. We'll show it here when that happens."}
            </p>
            <div className="panel">
              <div className="li"><span className="muted">Route</span><span>{status.route === "income" ? "Income" : "Assets"}</span></div>
              <div className="li"><span className="muted">Report</span><span>Mastercard {status.route === "income" ? "Verification of Income" : "Verification of Assets"}</span></div>
              {status.preparedAt && <div className="li"><span className="muted">Prepared</span><span>{new Date(status.preparedAt).toLocaleString()}</span></div>}
              <div className="li"><span className="muted">Wallet</span><span style={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}>{status.wallet}</span></div>
            </div>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <Link className="btn ghost" to={`/market/${id}`}>Back to {offering}</Link>
              {status.status === "failed" && <button className="btn primary" onClick={() => { if (account) save(storeKey(id, account), null); setReq(null); setStatus(null); }}>Start again</button>}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
