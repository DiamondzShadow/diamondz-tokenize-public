// /verify/:id — investor identity check with Sumsub, or Stripe Identity (hosted page) when Sumsub isn't configured (designs K2 desktop, K3 results, K4 phone; approved 2026-11-18).
// One check per issuer + wallet. Sumsub's own window does the document + selfie steps; results come from our server
// (which reads Sumsub), never from the browser.
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import snsWebSdk from "@sumsub/websdk";
import { api, type MarketAsset } from "../lib/api";
import { SiteHeader } from "../lib/Chrome";
import Connect from "../lib/Connect";
import { useTenant } from "../lib/tenant";
import { useConnectedAccount, walletError } from "../lib/wallet";
import { loadKycId, startKyc, useKycStatus } from "../lib/kyc";

export default function Verify() {
  const { id = "" } = useParams();
  const { tenant } = useTenant();
  const account = useConnectedAccount();
  const [asset, setAsset] = useState<MarketAsset | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [provider, setProvider] = useState<"sumsub" | "stripe" | null>(null);
  const [testMode, setTestMode] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [kycId, setKycId] = useState<string | null>(null);
  // The check belongs to the offering's issuer (the platform site hosts several issuers).
  const issuerId = asset ? asset.issuer?.id ?? tenant?.id : undefined;
  const { status, reload, set } = useKycStatus(issuerId, account);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => { api.marketAsset(id).then(setAsset, (e) => setErr(e.message)); api.kycConfig().then((c) => { setEnabled(c.enabled); setProvider(c.provider ?? (c.enabled ? "sumsub" : null)); setTestMode(!!c.testMode); }, () => setEnabled(false)); }, [id]);
  useEffect(() => { setToken(null); setKycId(account && issuerId ? loadKycId(issuerId, account) : null); }, [account, issuerId]);

  const issuer = asset?.issuer?.name ?? tenant?.name ?? "the issuer";
  const vendor = provider === "stripe" ? "Stripe" : "Sumsub";
  const offering = asset?.name ?? "this offering";

  async function begin() {
    if (!account || !issuerId || !asset) return;
    setErr(""); setBusy(true);
    try {
      const r = await startKyc(issuerId, account, asset.chainId, asset.id);
      setKycId(r.id); set(r.status);
      if (r.url) { window.location.assign(r.url); return; } // Stripe Identity: hosted check, comes back to this page
      if (r.status.status === "init" || r.status.status === "retry") setToken(r.token);
    } catch (e) { setErr(walletError(e)); } finally { setBusy(false); }
  }

  // Sumsub's window. The token refresh goes through our server with the private check id.
  useEffect(() => {
    if (!token || !box.current || !account || !kycId) return;
    const sdk = snsWebSdk
      .init(token, () => api.kycToken(kycId, account).then((r) => r.token))
      .withConf({ lang: "en", theme: tenant?.brand.theme === "dark" ? "dark" : "light" })
      .withOptions({ addViewportTag: false, adaptIframeHeight: true })
      .on("idCheck.onApplicantSubmitted", () => setTimeout(reload, 1500))
      .on("idCheck.onApplicantResubmitted", () => setTimeout(reload, 1500))
      .on("idCheck.onApplicantStatusChanged", () => setTimeout(reload, 1500))
      .on("idCheck.onError", () => setErr("Sumsub's window reported a problem. Reload the page to try again."))
      .build();
    sdk.launch("#sumsub-websdk");
    return () => { try { sdk.destroy?.(); } catch { /* already closed */ } };
  }, [token, kycId, account]); // eslint-disable-line react-hooks/exhaustive-deps

  const s = status?.status;
  const showWindow = !!token && (s === "init" || s === "retry" || s === undefined || s === null);
  return (
    <div className="page">
      <SiteHeader back={`/market/${id}`} title="Verify identity" />
      <section className="wrap section kyc-page">
        <Link to={`/market/${id}`} className="muted desktop-only" style={{ fontSize: 14 }}>← Back to {offering}</Link>
        {err && <div className="notice err">{err}</div>}
        <div className="kyc-grid">
          <div className="kyc-copy kyc-head">
            <span className="eyebrow">Step 2 · {offering}</span>
            <h1>Verify your identity</h1>
            <p className="kyc-lead">The law requires {issuer} to know who its investors are. You do this once for {issuer}; their other offerings use the same check.</p>
          </div>
          <div className="kyc-copy kyc-more">
            <dl className="kyc-facts">
              <div><dt>What you need</dt><dd>A passport, driver's license or national ID card, and a phone or computer with a camera.</dd></div>
              <div><dt>How long it takes</dt><dd>About 3 minutes. Most results come back within a few minutes.</dd></div>
              <div><dt>Who sees your documents</dt><dd>{vendor}, an identity verification company, checks your ID and selfie. {provider === "stripe" ? <>{issuer} receives the result and your name and country; {vendor} keeps the documents.</> : <>{issuer} receives the result and can view your details in {vendor} for its records.</>} Your documents are never stored on this site or on a blockchain.</dd></div>
            </dl>
            <p className="muted" style={{ fontSize: 13, lineHeight: 1.55 }}>By continuing you agree to {vendor} processing your ID and face images to verify you, as described in our <Link to="/legal/privacy" style={{ color: "var(--brand)", textDecoration: "underline" }}>Privacy Policy</Link>. {provider === "stripe" ? "Stripe opens its own secure page and brings you back here when you're done." : "Sumsub asks for your consent again in its window."}</p>
          </div>

          <div className="kyc-side">
            {testMode && <div className="notice">Test mode: identity checks here use {vendor}'s test environment and don't verify anyone for real.</div>}
            {enabled === false ? (
              <div className="kyc-state"><span className="status no">Not available</span><h2>Identity checks aren't switched on yet</h2><p>This platform hasn't finished setting up identity checks. Please check back soon, or contact {issuer}.</p></div>
            ) : !account ? (
              <div className="kyc-state"><h2>Connect the wallet you'll invest with</h2><p>Your check is linked to this wallet, so only it can buy once you're approved.</p><Connect chainId={asset?.chainId ?? 84532} label="Connect wallet" /></div>
            ) : s === "approved" ? (
              <div className="kyc-state"><span className="status ok">Verified</span><h2>Your identity is verified</h2><p>{issuer} can see that your identity check passed. Next, show you're an accredited investor; then {issuer} approves your wallet.</p>
                <div className="row" style={{ gap: 16, flexWrap: "wrap" }}><Link className="btn primary" to={`/accredit/${id}`}>Next: show you're accredited</Link><Link className="btn link" to={`/market/${id}`}>Back to the offering</Link></div></div>
            ) : s === "pending" ? (
              <div className="kyc-state"><span className="status warn">Checking</span><h2>We're checking your documents</h2><p>Most checks finish in a few minutes; some take up to a day. You can close this page. Your checklist updates on its own, and {issuer} is told when you're done.</p>
                <div className="kyc-bar" aria-hidden="true"><i /></div><Link className="btn ghost" to={`/market/${id}`} style={{ alignSelf: "flex-start" }}>Back to the offering</Link></div>
            ) : s === "rejected" ? (
              <div className="kyc-state"><span className="status bad">Not verified</span><h2>We couldn't verify your identity</h2><p>This wallet can't invest in {issuer}'s offerings for now. If you think this is a mistake, contact {issuer}; they can review it with {vendor}. We don't show the detailed reason here for your security.</p>
                <Link className="btn ghost" to="/#contact" style={{ alignSelf: "flex-start" }}>Contact the issuer</Link></div>
            ) : showWindow ? (
              <div className="kyc-window">
                {s === "retry" && status?.message && <div className="notice">{vendor} asked for another try: <i>"{status.message}"</i></div>}
                <div id="sumsub-websdk" ref={box} />
              </div>
            ) : s === "retry" ? (
              <div className="kyc-state"><span className="status warn">Action needed</span><h2>{vendor} needs another photo</h2>{status?.message && <p>{vendor}'s reason, word for word: <i>"{status.message}"</i></p>}
                <div className="row" style={{ gap: 16, flexWrap: "wrap" }}><button className="btn primary" disabled={busy} onClick={begin}>{busy ? "Check your wallet…" : "Try again"}</button><Link className="btn link" to="/#contact">Contact the issuer</Link></div></div>
            ) : (
              <div className="kyc-state">
                <h2>{kycId ? "Continue your check" : "Start your check"}</h2>
                <p>Your wallet asks you to sign a short message first. It proves the wallet is yours and costs nothing.</p>
                <div className="kyc-steps"><span className="status no">1 · Document</span><span className="status no">2 · Photo of ID</span><span className="status no">3 · Selfie video</span></div>
                <button className="btn primary" disabled={busy || !asset} onClick={begin} style={{ alignSelf: "flex-start" }}>{busy ? "Check your wallet…" : kycId ? "Continue" : "Start verification"}</button>
                <span className="muted" style={{ fontSize: 13 }}>On a computer without a camera, {vendor} offers a QR code to finish on your phone. Your progress is saved if you leave and come back.</span>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
