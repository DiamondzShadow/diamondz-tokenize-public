// Public IP pages (designs F1, F2, F3, F6; approved 2026-11-19), laid out the way Story shows an IP asset but backed
// by our own AssetRegistry + LicenseRegistry on the offering's chain.
//   /ip/:id                         the asset: record, licenses, lineage, royalties, chain of title, history
//   /ip/:id/license/:key            get a license: request/verification, read + sign the exact terms, pay
//   /license/:chainId/:licenseId    the certificate (printable, QR → this page) and live status
import { useEffect, useMemo, useRef, useState } from "react";
import snsWebSdk from "@sumsub/websdk";
import { api } from "../lib/api";
import { kycMessage } from "../lib/kyc";
import { Link, useParams } from "react-router-dom";
import { formatUnits, parseAbiItem, type Address } from "viem";
import qrcode from "qrcode-generator";
import { SiteHeader } from "../lib/Chrome";
import { AssetClassIcon } from "../lib/Icons";
import { assetClassById } from "../lib/catalog";
import { addrUrl, networkById, txUrl } from "../lib/chains";
import { ART, connectWallet, ensureChain, publicClientFor, send, useConnectedAccount, walletClientFor, walletError } from "../lib/wallet";
import Connect from "../lib/Connect";
import { ID_FIELDS, ipApi, termsHash, type IpPage, type LicenseInfo } from "../lib/ip";
import type { AssetClassId } from "../lib/catalog";

const money = (v: string, dec: number) => `$${Number(formatUnits(BigInt(v || "0"), dec)).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const day = (t: number) => new Date(t * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
const short = (a: string) => a; // never abbreviate addresses (house rule)
const idLabel = (cls: AssetClassId, key: string) => (ID_FIELDS[cls] ?? []).find(([k]) => k === key)?.[1] ?? key.replace(/_/g, " ");
const STATUS: Record<string, string> = { active: "Active", expired: "Expired", revoked: "Revoked", none: "Not found" };

function useIp(id: string | undefined) {
  const [p, setP] = useState<IpPage | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { if (id) ipApi.page(id).then(setP, (e) => setErr(e.message)); }, [id]);
  return { p, err };
}

// ------------------------------------------------------------------ F1 / F6
export function IpAssetPage() {
  const { id } = useParams();
  const { p, err } = useIp(id);
  if (err) return <><SiteHeader back="/market" title="IP asset" /><div className="content"><div className="notice err">{err}</div></div></>;
  if (!p) return <><SiteHeader back="/market" title="IP asset" /><div className="content"><p className="muted">Loading from the network…</p></div></>;
  const net = networkById(p.chainId)!;
  const dec = net.stable?.decimals ?? 6;
  const cls = assetClassById(p.assetClass);
  const types = p.licenseTypes.filter((t) => t.active);
  const lineage = p.licenses.filter((l) => l.status !== "revoked" && l.work);
  const stage = p.stage && p.stage !== "released" ? String(p.stage) : null;

  return (
    <>
      <SiteHeader back={`/market/${p.offering}`} title="IP asset" />
      <div className="ip-wrap">
        <div className="ip-hero">
          <div className="ip-poster" role="img" aria-label={`${p.name} cover`} style={p.imageUrl ? { backgroundImage: `url(${p.imageUrl})` } : undefined}>
            {!p.imageUrl && <><span className="ico-inline"><AssetClassIcon id={p.assetClass} size={28} /></span><b>{p.name}</b></>}
          </div>
          <div className="panel ip-card">
            <div className="ip-badges">
              <span className="ip-bd ip">IP asset</span>
              {p.documents.length > 0 && <span className="ip-bd ok">Chain of title recorded</span>}
              {types.length > 0 && <span className="ip-bd soft">Licensable</span>}
              {stage && <span className="ip-bd warn">{stage === "production" ? "In production" : stage[0]!.toUpperCase() + stage.slice(1)} · not yet earning</span>}
            </div>
            <h1 className="ip-title">{p.name}</h1>
            {p.summary && <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>{p.summary}</p>}
            <div className="ip-kv">
              <div><span>Asset ID</span><b className="addr">#{p.assetId} · {short(p.registry)}</b></div>
              <div><span>Held by</span><b className="addr">{short(p.owner)}</b></div>
              <div><span>Registered</span><b>{day(p.registeredAt)} · {net.name}</b></div>
              <div><span>Asset type</span><b>{cls?.name}</b></div>
              {Object.entries(p.identifiers).map(([k, v]) => <div key={k}><span>{idLabel(p.assetClass, k)}</span><b className="addr">{v}</b></div>)}
              <div><span>Licenses issued</span><b>{p.licenses.length}</b></div>
            </div>
            <div className="row" style={{ flexWrap: "wrap" }}>
              {types.length > 0 && <a className="btn primary" href="#licenses">Get a license</a>}
              <Link className="btn ghost" to={`/market/${p.offering}`}>Invest ({p.symbol})</Link>
              <a className="btn ghost" href={addrUrl(net, p.registry)} target="_blank" rel="noreferrer">View on chain ↗</a>
            </div>
          </div>
        </div>

        {types.length > 0 && (
          <section id="licenses" className="ip-sec">
            <h2>Licenses</h2>
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>Standard terms from the rights holder's counsel. Every license is signed on chain and comes with a certificate.</p>
            <div className="ip-lics">
              {types.map((t) => (
                <div className="panel ip-lic" key={t.key}>
                  <div className="ip-badges"><span className={`ip-bd ${t.byRequest ? "warn" : "soft"}`}>{t.byRequest ? "By request" : "Instant"}</span>{t.revShareBps > 0 && <span className="ip-bd ok">Revenue share</span>}</div>
                  <h3>{t.name}</h3>
                  <div className="ip-price">{t.byRequest ? "Negotiated" : <>{money(t.fee, dec)}{t.revShareBps ? <span> + {t.revShareBps / 100}% of revenue</span> : <span> one time</span>}</>}</div>
                  <ul>{t.scope.split("·").map((x) => x.trim()).filter(Boolean).map((x) => <li key={x}>{x}</li>)}<li>{t.territory} · {t.durationDays ? (t.durationDays >= 365 ? `${+(t.durationDays / 365).toFixed(1)} years` : `${t.durationDays} days`) : "Perpetual"}</li></ul>
                  <Link className={`btn ${t.byRequest ? "ghost" : "primary"}`} to={`/ip/${p.offering}/license/${t.key}`}>{t.byRequest ? "Request terms" : "Get this license"}</Link>
                </div>
              ))}
            </div>
          </section>
        )}

        {lineage.length > 0 && (
          <section className="panel ip-sec">
            <h2>Lineage</h2>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>Works made from this asset under license</p>
            <div className="ip-lineage" role="img" aria-label={`${p.name} and ${lineage.length} licensed works`}>
              <div className="ip-node root"><span>Original</span><b>{p.name}</b></div>
              <div className="ip-branches">
                {lineage.map((l) => (
                  <div className="ip-branch" key={l.licenseId}>
                    <div className="ip-node"><span>{p.licenseTypes.find((t) => t.typeId === l.typeId)?.name ?? "License"} · #{l.licenseId}</span><b>{l.work}</b><Link to={`/license/${p.chainId}/${l.licenseId}`} style={{ fontSize: 12 }}>Certificate</Link></div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        <section className="panel ip-sec">
          <h2>Royalties</h2>
          <div className="kpis">
            <div className="kpi"><span>License fees received</span><b>{money(p.royalties.fees, dec)}</b></div>
            <div className="kpi"><span>Revenue shares received</span><b>{money(p.royalties.revenueShares, dec)}</b></div>
            <div className="kpi"><span>Owed to {p.symbol} holders ({p.holdersBps / 100}%)</span><b>{money(p.royalties.holdersOwed, dec)}</b></div>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>License payments go straight to the rights holder on chain. Token holders' share is paid through Payouts and shows on the {p.symbol} offering page.</p>
        </section>

        {p.documents.length > 0 && (
          <section className="panel ip-sec">
            <h2>Chain of title</h2>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>Each document's fingerprint is recorded on chain. If the rights holder shares a document with you, its sha256 must match.</p>
            {p.documents.map((d) => <div className="li" key={d.kind}><span>{d.name}</span><span className="addr" style={{ fontSize: 11 }}>{d.sha256}</span></div>)}
          </section>
        )}

        <section className="panel ip-sec">
          <h2>History</h2>
          {p.history.map((h, i) => <div className="li" key={i}><span>{h.text}</span><a href={txUrl(net, h.tx)} target="_blank" rel="noreferrer">block {h.at} ↗</a></div>)}
        </section>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ licensee verification (Sumsub)
/** Business verification (companies) or ID check (individuals) with this issuer, then on-chain verification by the
 *  platform verifier when the asset's holder allowed it. The licensee signs once to prove the wallet. */
function LicenseeCheck({ p, wallet, kind, onVerified }: { p: IpPage; wallet: `0x${string}`; kind: "company" | "individual"; onVerified: () => void }) {
  const [checkId, setCheckId] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  async function start() {
    setBusy(true);
    setNote("");
    try {
      await ensureChain(p.chainId);
      const ts = Math.floor(Date.now() / 1000);
      const signature = await walletClientFor(p.chainId, wallet).signMessage({ account: wallet, message: kycMessage({ tenantId: p.issuer, wallet, ts }) });
      const r = await api.kycStart({ wallet, chainId: p.chainId, ts, signature, licensee: { assetId: p.offering, kind } });
      setCheckId(r.id);
      setStatus(r.status.status);
      // Stripe Identity: its hosted check opens in a new tab; this page keeps polling the status.
      if (r.url) { window.open(r.url, "_blank", "noopener"); setNote("Finish the identity check in the new tab. This page updates on its own."); }
      else if (r.status.status === "init" || r.status.status === "retry") setToken(r.token);
      if (r.status.status === "approved") await finish();
    } catch (e) {
      setNote(walletError(e));
    } finally {
      setBusy(false);
    }
  }
  async function finish() {
    const v = await ipApi.verifyMe(p.offering, wallet);
    if (v.onChain) { setNote("Verified on chain. You can sign and pay below."); onVerified(); }
    else if (v.approved) setNote(v.reason ?? "Your check passed. The rights holder records it on chain.");
    else setNote(`Check status: ${v.status}.`);
  }
  useEffect(() => {
    if (!checkId || !status || !["init", "pending"].includes(status)) return;
    const t = setInterval(() => api.kycStatus(checkId, wallet).then((s) => { setStatus(s.status); if (s.status === "approved") finish(); }, () => {}), 8000);
    return () => clearInterval(t);
  }, [checkId, status]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!token || !checkId || !box.current) return;
    const sdk = snsWebSdk
      .init(token, () => api.kycToken(checkId, wallet).then((r) => r.token))
      .withConf({ lang: "en" })
      .withOptions({ addViewportTag: false, adaptIframeHeight: true })
      .on("idCheck.onApplicantSubmitted", () => setStatus("pending"))
      .on("idCheck.onApplicantResubmitted", () => setStatus("pending"))
      .build();
    sdk.launch("#sumsub-licensee");
    return () => { try { sdk.destroy?.(); } catch { /* closed */ } };
  }, [token, checkId]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="ip-sec">
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>{kind === "company" ? "Business verification (KYB)" : "Identity check"} by Sumsub, once per rights holder. Documents stay with Sumsub; the rights holder sees only the result.</p>
      {!checkId && <button className="btn primary sm" disabled={busy} onClick={start}>{busy ? "Sign in your wallet…" : "Verify with Sumsub"}</button>}
      {status && <span className="muted" style={{ fontSize: 13 }}>Status: {status === "init" ? "waiting for your documents" : status === "pending" ? "being reviewed" : status}</span>}
      <div id="sumsub-licensee" ref={box} />
      {note && <div className="notice">{note}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ F2
const offerMade = parseAbiItem("event OfferMade(uint256 indexed offerId, uint256 indexed typeId, address indexed licensee, uint256 fee, uint16 revShareBps, uint64 expiresAt)");

export function LicenseCheckout() {
  const { id, key } = useParams();
  const { p, err } = useIp(id);
  const me = useConnectedAccount();
  const [terms, setTerms] = useState("");
  const [hashOk, setHashOk] = useState<boolean | null>(null);
  const [verifiedUntil, setVerifiedUntil] = useState<number | null>(null);
  const [offers, setOffers] = useState<{ offerId: bigint; fee: bigint; revShareBps: number; expiresAt: number }[]>([]);
  const [agree, setAgree] = useState({ read: false, report: false });
  const [work, setWork] = useState("");
  const [req, setReq] = useState({ company: "", kind: "company" as "company" | "individual", jurisdiction: "", email: "", message: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string; link?: string } | null>(null);
  const [kybOn, setKybOn] = useState(false);
  const paidSession = typeof location !== "undefined" ? new URLSearchParams(location.search).get("paid") : null;
  const [refresh, setRefresh] = useState(0);
  useEffect(() => { ipApi.config().then((c) => setKybOn(c.kyb), () => setKybOn(false)); }, []);
  const t = p?.licenseTypes.find((x) => x.key === key);
  const net = p ? networkById(p.chainId) : undefined;
  const dec = net?.stable?.decimals ?? 6;

  useEffect(() => {
    if (!p || !t) return;
    ipApi.terms(p.offering, t.key).then(async (text) => { setTerms(text); setHashOk((await termsHash(text)).toLowerCase() === t.termsHash.toLowerCase()); }, () => setHashOk(false));
  }, [p, t]);
  useEffect(() => {
    if (!p || !t || !me || !net) return;
    const pc = publicClientFor(net.id);
    pc.readContract({ address: p.licenseRegistry, abi: ART.LicenseRegistry.abi, functionName: "verifiedUntil", args: [BigInt(p.assetId), me] }).then((v) => setVerifiedUntil(Number(v)));
    void refresh;
    (async () => {
      const head = await pc.getBlockNumber();
      const from = BigInt(net.ip?.fromBlock ?? 0);
      const found: typeof offers = [];
      for (let s = from; s <= head; s += 40_000n) {
        const logs = await pc.getLogs({ address: p.licenseRegistry, event: offerMade, args: { typeId: BigInt(t.typeId), licensee: me }, fromBlock: s, toBlock: s + 39_999n > head ? head : s + 39_999n });
        for (const l of logs) {
          const o = (await pc.readContract({ address: p.licenseRegistry, abi: ART.LicenseRegistry.abi, functionName: "offer", args: [l.args.offerId!] })) as any;
          if (!o.used && Number(o.expiresAt) > Date.now() / 1000) found.push({ offerId: l.args.offerId!, fee: o.fee, revShareBps: Number(o.revShareBps), expiresAt: Number(o.expiresAt) });
        }
      }
      setOffers(found);
    })().catch(() => setOffers([]));
  }, [p, t, me, net, refresh]);

  if (err) return <><SiteHeader back="/market" title="License" /><div className="content"><div className="notice err">{err}</div></div></>;
  if (!p || !net) return <><SiteHeader back="/market" title="License" /><div className="content"><p className="muted">Loading…</p></div></>;
  if (!t) return <><SiteHeader back={`/ip/${p.offering}`} title="License" /><div className="content"><div className="notice err">That license type isn't offered.</div></div></>;
  const verified = verifiedUntil !== null && verifiedUntil > Date.now() / 1000;
  const fee = BigInt(t.fee);
  const canSign = verified && hashOk && agree.read && (t.revShareBps === 0 || agree.report) && work.trim().length > 0;

  async function pay(offerId?: bigint, offerFee?: bigint) {
    setMsg(null);
    try {
      const acct = await connectWallet();
      await ensureChain(net!.id);
      const amount = offerId !== undefined ? offerFee! : fee;
      if (amount > 0n) {
        setBusy("Approve the payment in your wallet…");
        await send(net!.id, acct, t!.feeToken as Address, ART.TestUSD.abi, "approve", [p!.licenseRegistry, amount]);
      }
      setBusy("Sign the terms and pay in your wallet…");
      if (offerId !== undefined) await send(net!.id, acct, p!.licenseRegistry, ART.LicenseRegistry.abi, "acceptOffer", [offerId, t!.termsHash, work.trim()]);
      else await send(net!.id, acct, p!.licenseRegistry, ART.LicenseRegistry.abi, "buy", [BigInt(t!.typeId), t!.termsHash, work.trim()]);
      const count = (await publicClientFor(net!.id).readContract({ address: p!.licenseRegistry, abi: ART.LicenseRegistry.abi, functionName: "licenseCount" })) as bigint;
      setMsg({ kind: "ok", text: "Licensed. Your license NFT is in your wallet.", link: `/license/${p!.chainId}/${count}` });
    } catch (e) {
      setMsg({ kind: "err", text: walletError(e) });
    } finally {
      setBusy(null);
    }
  }
  async function payByCard() {
    setMsg(null);
    try {
      if (!me) throw new Error("Connect your wallet first.");
      try { sessionStorage.setItem(`ipwork:${p!.offering}:${t!.key}`, work.trim()); } catch { /* the work title can be retyped */ }
      const r = await fetch(`/api/ip/${p!.offering}/card-checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ typeKey: t!.key, wallet: me, work: work.trim() }) }).then((x) => x.json());
      if (!r.url) throw new Error(r.error ?? "Card checkout isn't available");
      location.href = r.url;
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    }
  }
  async function claimCard() {
    setMsg(null);
    try {
      const acct = await connectWallet();
      await ensureChain(net!.id);
      setBusy("Confirming your card payment with Stripe…");
      const r = await fetch(`/api/ip/${p!.offering}/card-receipt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: paidSession, wallet: acct, typeKey: t!.key }) }).then((x) => x.json());
      if (!r.receipt) throw new Error(r.error ?? "Couldn't confirm the payment");
      setBusy("Sign the terms in your wallet (no payment: you paid by card)…");
      await send(net!.id, acct, p!.licenseRegistry, ART.LicenseRegistry.abi, "buyWithReceipt", [BigInt(r.typeId), r.termsHash, work.trim(), {
        paymentRef: r.receipt.paymentRef, amount: BigInt(r.receipt.amount), deadline: BigInt(r.receipt.deadline), sig: r.receipt.sig,
      }]);
      const count = (await publicClientFor(net!.id).readContract({ address: p!.licenseRegistry, abi: ART.LicenseRegistry.abi, functionName: "licenseCount" })) as bigint;
      setMsg({ kind: "ok", text: "Licensed. Your license NFT is in your wallet.", link: `/license/${p!.chainId}/${count}` });
    } catch (e) {
      setMsg({ kind: "err", text: walletError(e) });
    } finally {
      setBusy(null);
    }
  }
  useEffect(() => {
    if (!paidSession || !p || !t) return;
    try { const w = sessionStorage.getItem(`ipwork:${p.offering}:${t.key}`); if (w) setWork(w); } catch { /* retype */ }
    setAgree({ read: true, report: true });
  }, [paidSession, p, t]);

  async function request() {
    setMsg(null);
    try {
      if (!me) throw new Error("Connect the wallet that will hold the license first.");
      await ipApi.request(p!.offering, { wallet: me, ...req, typeKey: t!.key, work: work.trim() });
      setMsg({ kind: "ok", text: "Request sent. The rights holder checks your details and verifies you (or sends you an offer); then come back to this page." });
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    }
  }

  return (
    <>
      <SiteHeader back={`/ip/${p.offering}`} title="License" />
      <div className="ip-wrap">
        <div>
          <h1 className="ip-title" style={{ fontSize: 34 }}>License {p.name}</h1>
          <p className="muted" style={{ margin: "6px 0 0" }}>{t.name} · {t.byRequest ? "negotiated" : `${money(t.fee, dec)}${t.revShareBps ? ` + ${t.revShareBps / 100}% of revenue` : ""}`} · {t.territory}</p>
        </div>
        <div className="wz">
          <div className="wz-main">
            <div className="panel ip-sec">
              <h2>1 · Your wallet</h2>
              <div style={{ maxWidth: 320 }}><Connect chainId={net.id} /></div>
              {me && <p className="muted" style={{ margin: 0, fontSize: 14 }}>{verified ? `✓ Verified by the rights holder until ${day(verifiedUntil!)}.` : "Not verified for this asset yet: send your details below."}</p>}
            </div>

            {me && !verified && (
              <div className="panel ip-sec">
                <h2>2 · Who is licensing</h2>
                <p className="muted" style={{ margin: 0, fontSize: 14 }}>The rights holder checks the licensee before any license is issued. Your details go only to them.</p>
                <div className="chips">{(["company", "individual"] as const).map((k) => <button type="button" key={k} className={`chip ${req.kind === k ? "on" : ""}`} aria-pressed={req.kind === k} onClick={() => setReq({ ...req, kind: k })}>{k === "company" ? "A company" : "An individual"}</button>)}</div>
                <div className="form3">
                  <label className="field">{req.kind === "company" ? "Legal name" : "Full name"}<input className="input" value={req.company} onChange={(e) => setReq({ ...req, company: e.target.value })} /></label>
                  <label className="field">{req.kind === "company" ? "Registered in" : "Country"}<input className="input" value={req.jurisdiction} onChange={(e) => setReq({ ...req, jurisdiction: e.target.value })} /></label>
                  <label className="field">Email<input className="input" type="email" value={req.email} onChange={(e) => setReq({ ...req, email: e.target.value })} /></label>
                </div>
                <label className="field">What you'll make<input className="input" value={work} onChange={(e) => setWork(e.target.value)} placeholder="e.g. Night Shift: The Game" /></label>
                {t.byRequest && <label className="field">Your proposal (territory, term, fee)<textarea className="input" rows={3} value={req.message} onChange={(e) => setReq({ ...req, message: e.target.value })} /></label>}
                <button className="btn primary sm" disabled={!req.company || !req.jurisdiction || !req.email} onClick={request}>{t.byRequest ? "Request terms" : "Send for verification"}</button>
                {kybOn && <LicenseeCheck p={p} wallet={me} kind={req.kind} onVerified={() => setRefresh((n) => n + 1)} />}
              </div>
            )}

            <div className="panel ip-sec">
              <h2>{verified ? "2" : "3"} · Read and sign the terms</h2>
              <pre className="ip-terms" tabIndex={0} aria-label="License terms">{terms || "Loading the published terms…"}</pre>
              <div className="li"><span className="muted">Terms</span><span>{p.licenseTypes.find((x) => x.key === t.key)?.termsName || t.name}</span></div>
              <div className="li"><span className="muted">Fingerprint</span><span className="addr" style={{ fontSize: 11 }}>{t.termsHash} {hashOk === true ? "✓ matches the text above" : hashOk === false ? "✗ doesn't match: don't sign" : ""}</span></div>
              {verified && <label className="field">What you'll make<input className="input" value={work} onChange={(e) => setWork(e.target.value)} /></label>}
              <label className="row" style={{ gap: 10, alignItems: "flex-start" }}><input type="checkbox" checked={agree.read} onChange={(e) => setAgree({ ...agree, read: e.target.checked })} /> <span>I have read the license and agree to it on behalf of the licensee.</span></label>
              {t.revShareBps > 0 && <label className="row" style={{ gap: 10, alignItems: "flex-start" }}><input type="checkbox" checked={agree.report} onChange={(e) => setAgree({ ...agree, report: e.target.checked })} /> <span>I'll report revenue every quarter and pay {t.revShareBps / 100}% to the rights holder.</span></label>}
              <div className="wz-tip">Your wallet signs the exact fingerprint above when it pays. That signature, your verification and the payment together make the license; the certificate records all three.</div>
            </div>

            {verified && (
              <div className="panel ip-sec">
                <h2>3 · Pay and receive your license</h2>
                {offers.map((o) => (
                  <div className="notice" key={o.offerId.toString()}>
                    <b>Offer for you:</b> {money(o.fee.toString(), dec)}{o.revShareBps ? ` + ${o.revShareBps / 100}%` : ""} · valid until {day(o.expiresAt)}
                    <div style={{ marginTop: 8 }}><button className="btn primary sm" disabled={!canSign || !!busy} onClick={() => pay(o.offerId, o.fee)}>Accept: sign and pay {money(o.fee.toString(), dec)}</button></div>
                  </div>
                ))}
                {paidSession && !t.byRequest && (
                  <div className="notice"><b>Card payment received.</b> Sign the terms with your wallet to receive the license (no further payment).
                    <div style={{ marginTop: 8 }}><button className="btn primary sm" disabled={!canSign || !!busy} onClick={claimCard}>Sign terms and receive the license</button></div>
                  </div>
                )}
                {!paidSession && !t.byRequest && (
                  <div className="row" style={{ flexWrap: "wrap" }}>
                    <button className="btn primary" disabled={!canSign || !!busy} onClick={() => pay()}>Sign terms and pay {money(t.fee, dec)} in {net.stable?.symbol ?? "Test USD"}</button>
                    <button className="btn ghost" disabled={!canSign || !!busy} onClick={payByCard}>Pay {money(t.fee, dec)} by card</button>
                  </div>
                )}
                {t.byRequest && offers.length === 0 && <p className="muted" style={{ fontSize: 14, margin: 0 }}>This license is by request: the rights holder sends you an offer, which appears here.</p>}
                <span className="muted" style={{ fontSize: 13 }}>You receive a license NFT that can't be transferred, and a certificate anyone can check with its QR code. Card payments go to the rights holder's own Stripe account; you then sign the terms on chain.</span>
              </div>
            )}
            {busy && <div className="notice">{busy}</div>}
            {msg && <div className={`notice ${msg.kind === "err" ? "err" : ""}`}>{msg.text} {msg.link && <Link to={msg.link}>View your certificate →</Link>}</div>}
          </div>
          <aside className="wz-rail">
            <div className="panel wz-help">
              <h4>Summary</h4>
              <div className="li"><span className="muted">Licensed work</span><span>{p.name}</span></div>
              <div className="li"><span className="muted">License</span><span>{t.name}</span></div>
              <div className="li"><span className="muted">Territory</span><span>{t.territory}</span></div>
              <div className="li"><span className="muted">Term</span><span>{t.durationDays ? `${t.durationDays} days` : "Perpetual"}</span></div>
              {!t.byRequest && <div className="li"><span className="muted">Fee today</span><b>{money(t.fee, dec)}</b></div>}
              {t.revShareBps > 0 && <div className="li"><span className="muted">Revenue share</span><span>{t.revShareBps / 100}%, quarterly</span></div>}
            </div>
            <div className="panel wz-help"><h4>Where your payment goes</h4><p>Straight to the rights holder. {p.holdersBps / 100}% of license revenue belongs to {p.symbol} token holders, paid through Payouts.</p></div>
          </aside>
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ F3
export function LicenseCertificate() {
  const { chainId, licenseId } = useParams();
  const [l, setL] = useState<LicenseInfo | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { if (chainId && licenseId) ipApi.license(chainId, licenseId).then(setL, (e) => setErr(e.message)); }, [chainId, licenseId]);
  const url = typeof location !== "undefined" ? location.href : "";
  const qr = useMemo(() => {
    const q = qrcode(0, "M");
    q.addData(url);
    q.make();
    return q.createSvgTag({ cellSize: 3, margin: 2, scalable: true });
  }, [url]);
  const net = l ? networkById(l.chainId) : undefined;
  const dec = net?.stable?.decimals ?? 6;
  if (err) return <><SiteHeader title="License" /><div className="content"><div className="notice err">{err}</div></div></>;
  if (!l || !net) return <><SiteHeader title="License" /><div className="content"><p className="muted">Checking the license on chain…</p></div></>;
  return (
    <>
      <div className="no-print"><SiteHeader title="License" /></div>
      <div className="cert-wrap">
        <div className={`cert-status ${l.status}`} role="status">{STATUS[l.status]}{l.status === "active" && l.end ? ` until ${day(l.end)}` : ""} · checked on {net.name} just now</div>
        <div className="cert">
          <div className="cert-frame">
            <div className="cert-top">
              <div>
                <div className="cert-eyebrow">License certificate · #{l.licenseId}</div>
                <h1>{l.typeName}</h1>
                <div className="muted" style={{ fontSize: 13 }}>Asset #{l.assetId} · offering token <span className="addr">{l.offering}</span></div>
              </div>
              <div className="cert-qr" role="img" aria-label="QR code that opens this license" dangerouslySetInnerHTML={{ __html: qr }} />
            </div>
            <p className="cert-grant">The asset's rights holder grants the licensee below a non-exclusive, non-transferable <b>{l.typeName}</b> license, on the terms fingerprinted below.</p>
            <div className="cert-kv">
              <div><span>Licensee wallet</span><b className="addr">{l.licensee}</b></div>
              <div><span>Work</span><b>{l.work || "—"}</b></div>
              <div><span>Territory</span><b>{l.territory}</b></div>
              <div><span>Term</span><b>{day(l.start)} – {l.end ? day(l.end) : "perpetual"}</b></div>
              <div><span>Fee paid</span><b>{money(l.feePaid, dec)}</b></div>
              <div><span>Revenue share</span><b>{l.revShareBps ? `${l.revShareBps / 100}% of gross revenue` : "None"}</b></div>
              <div><span>Terms fingerprint (sha256)</span><b className="addr" style={{ fontSize: 11 }}>{l.termsHash}</b></div>
              <div><span>Terms text</span><b><a href={l.termsURI} target="_blank" rel="noreferrer">Read the license</a></b></div>
              <div><span>License NFT</span><b className="addr">{net.name} · {l.registry} #{l.licenseId}</b></div>
              <div><span>Revenue reported</span><b>{money(l.revenueReported, dec)}</b></div>
            </div>
            <div className="cert-foot">This certificate summarizes a license recorded on chain. The license terms (fingerprint above) govern. Scan the QR code to check the license is current and hasn't been revoked.</div>
          </div>
        </div>
        <div className="row no-print" style={{ justifyContent: "center", gap: 10 }}>
          <button className="btn primary" onClick={() => window.print()}>Download PDF</button>
          <a className="btn ghost" href={addrUrl(net, l.registry)} target="_blank" rel="noreferrer">View on chain ↗</a>
        </div>
      </div>
    </>
  );
}
