// /invest/:id — investor onboarding, one question at a time (design W13, approved 2026-11-19).
// Orchestrates the existing pieces: wallet (Freighter on Stellar, any wallet elsewhere), country against the offering's
// rules, identity (Stellar: the issuer verifies your request; other networks: the identity partner on /verify),
// accreditation when required, the amount, then the purchase.
import { useEffect, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type MarketAsset, type StellarSale } from "../lib/api";
import { isStellarChain, networkById, stellarById, stellarTxUrl } from "../lib/chains";
import { FREIGHTER_URL, connectFreighter, signWithFreighter } from "../lib/freighter";
import Connect from "../lib/Connect";
import { useConnectedAccount } from "../lib/wallet";
import { useKycStatus } from "../lib/kyc";
import { OPEN_COUNTRIES, US, countryName, lockupLabel, type Rules } from "../lib/rules";
import { SiteHeader } from "../lib/Chrome";
import { Question, WizardShell, type WizStep } from "../app/Wizards";
import { payAmount } from "../app/Stellar";

export default function Invest() {
  const { id = "" } = useParams();
  const [a, setA] = useState<MarketAsset | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { api.marketAsset(id).then(setA, (e) => setErr(e.message)); }, [id]);
  if (err) return <Page><div className="notice err">{err}</div></Page>;
  if (!a) return <Page><p className="muted">Loading…</p></Page>;
  return <Page><Flow a={a} /></Page>;
}

const Page = ({ children }: { children: ReactNode }) => (
  <div className="page">
    <SiteHeader back="/market" title="Invest" />
    <section className="wrap section" style={{ paddingTop: 32, maxWidth: 980 }}>{children}</section>
  </div>
);

function Flow({ a }: { a: MarketAsset }) {
  const stellar = isStellarChain(a.chainId) ? stellarById(a.chainId) : undefined;
  const evm = stellar ? undefined : networkById(a.chainId);
  const r = (a.rules ?? {}) as Rules;
  const evmAccount = useConnectedAccount();
  const [sWallet, setSWallet] = useState("");
  const wallet = stellar ? sWallet : evmAccount ?? "";
  const [at, setAt] = useState(0);
  const [country, setCountry] = useState(US);
  const [who, setWho] = useState<"me" | "company">("me");
  const [sStatus, setSStatus] = useState<"none" | "requested" | "verified" | "frozen" | null>(null);
  const kyc = useKycStatus(a.issuer?.id, stellar ? undefined : evmAccount);
  const [usd, setUsd] = useState("");
  const [sale, setSale] = useState<StellarSale | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok?: ReactNode; err?: string }>({});

  useEffect(() => { if (stellar) api.stellarSale(a.id).then((x) => setSale(x.sale), () => setSale(null)); }, [a.id, stellar]);
  useEffect(() => {
    if (!stellar || !sWallet) return;
    api.stellarStatus(a.id, sWallet).then((s) => { setSStatus(s.status); if (s.status === "verified") setAt((x) => Math.max(x, 4)); }, () => setSStatus(null));
  }, [a.id, stellar, sWallet]);

  const allowed = r.countryMode === "allow" ? (r.countries ?? []).includes(country) : r.countryMode === "block" ? !(r.countries ?? []).includes(country) : true;
  const identityDone = stellar ? sStatus === "verified" || sStatus === "requested" : kyc.status?.status === "approved";
  const verified = stellar ? sStatus === "verified" : kyc.status?.status === "approved";

  // pricing: the Stellar sale's own terms, else the offering's
  const pd = sale?.payToken.decimals ?? stellar?.payToken.decimals ?? 6;
  const price = sale ? Number(sale.price) / 10 ** pd : Number(a.pricePerToken || 0);
  const minimum = sale ? Number(sale.minPurchase) / 10 ** pd : Number(a.minInvestment || 0);
  const code = sale?.payToken.code ?? stellar?.payToken.code ?? evm?.stable?.symbol ?? "USDC";
  const tokens = price > 0 && Number(usd) > 0 ? Math.floor(Number(usd) / price) : 0;
  const capTokens = r.maxHolderPct ? Math.floor(Number(a.totalSupply) * r.maxHolderPct / 100) : 0;
  const left = sale ? Number((BigInt(sale.cap) - BigInt(sale.sold)) / 10_000_000n) : 0;
  const amountErr = !tokens ? "" : minimum && tokens * price < minimum ? `The minimum is ${minimum.toLocaleString()} ${code}.`
    : capTokens && tokens > capTokens ? `One investor can hold at most ${capTokens.toLocaleString()} tokens (${r.maxHolderPct}%).`
    : stellar && sale && tokens > left ? `Only ${left.toLocaleString()} tokens are left in the sale.` : "";

  const steps: WizStep[] = [
    { key: "wallet", title: "Wallet", done: !!wallet },
    { key: "country", title: "Where you live", done: allowed },
    { key: "who", title: "Who you are", done: identityDone },
    { key: "accredited", title: "Accredited?", done: true },
    { key: "amount", title: "How much", done: tokens > 0 && !amountErr },
    { key: "confirm", title: "Confirm", done: false },
  ];
  const of = steps.length;
  const go = (i: number) => { setMsg({}); setAt(i); };
  const back = at > 0 ? () => go(at - 1) : undefined;
  const next = () => go(at + 1);

  const connectStellar = async () => {
    setMsg({});
    try { if (stellar) setSWallet(await connectFreighter(stellar)); } catch (e) { setMsg({ err: (e as Error).message }); }
  };
  const request = async () => {
    setBusy(true); setMsg({});
    try { await api.stellarRequest(a.id, sWallet, country); setSStatus((await api.stellarStatus(a.id, sWallet)).status); } catch (e) { setMsg({ err: (e as Error).message }); } finally { setBusy(false); }
  };
  const buy = async () => {
    if (!stellar) return;
    setBusy(true); setMsg({});
    try {
      const p = await api.stellarBuy(a.id, sWallet, String(tokens));
      if (!p.xdr) throw new Error("Couldn't prepare the purchase");
      const res = await api.stellarBuy(a.id, sWallet, String(tokens), await signWithFreighter(stellar, p.xdr, sWallet));
      setMsg({ ok: <>Bought {tokens.toLocaleString()} {a.symbol}. {res.tx && <a href={stellarTxUrl(stellar, res.tx)} target="_blank" rel="noreferrer">See the transaction</a>}</> });
    } catch (e) { setMsg({ err: (e as Error).message }); } finally { setBusy(false); }
  };

  let body: ReactNode = null;
  if (at === 0) body = (
    <Question n={1} of={of} title="Connect your wallet" canNext={!!wallet} onNext={next}
      intro={stellar ? "This offering is on Stellar, so you use Freighter. Already verified with this wallet? We skip ahead." : `Any wallet, or log in with email. Your tokens arrive in this wallet on ${evm?.name ?? "the offering's network"}.`}>
      {stellar ? (
        <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
          <button type="button" className="btn primary" onClick={connectStellar}>{sWallet ? "Reconnect Freighter" : "Connect Freighter"}</button>
          {sWallet && <span className="mono">{sWallet}</span>}
          {!sWallet && <span className="muted" style={{ fontSize: 13 }}>No Freighter yet? <a href={FREIGHTER_URL} target="_blank" rel="noreferrer">Install it</a> and switch it to {stellar.testnet ? "Testnet" : "Mainnet"}.</span>}
        </div>
      ) : <Connect chainId={a.chainId} />}
    </Question>
  );
  if (at === 1) body = (
    <Question n={2} of={of} title="Where do you live?" canNext={allowed} onBack={back} onNext={next} intro="Some offerings are only open to certain countries. We tell you now, before any paperwork.">
      <div className="q"><label htmlFor="iv-country">Country of residence</label>
        <select id="iv-country" className="input" value={country} onChange={(e) => setCountry(Number(e.target.value))}>
          {OPEN_COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
        </select>
      </div>
      {!allowed && <div className="notice err">Sorry, this offering isn't open to investors in {countryName(country)}{r.countryMode === "allow" ? `. It's open to: ${(r.countries ?? []).map(countryName).join(", ")}.` : "."}</div>}
    </Question>
  );
  if (at === 2) body = (
    <Question n={3} of={of} title="Are you investing as yourself or for a company?" canNext={identityDone} onBack={back} onNext={next}>
      <div className="gl-cards" role="radiogroup" aria-label="Investing as">
        <button type="button" role="radio" aria-checked={who === "me"} className={`gl-card ${who === "me" ? "on" : ""}`} onClick={() => setWho("me")}><b>Myself</b><span className="muted">Photo ID and a selfie</span></button>
        <button type="button" role="radio" aria-checked={who === "company"} className={`gl-card ${who === "company" ? "on" : ""}`} onClick={() => setWho("company")}><b>A company or trust</b><span className="muted">Company documents and the people who own it</span></button>
      </div>
      {stellar ? (
        <>
          <div className="wz-tip"><b>What happens next</b><br />You ask {a.issuer?.name ?? "the issuer"} to verify this wallet. They check your identity{who === "company" ? " and your company's documents" : ""}{r.accreditedOnly ? " and accreditation" : ""} with you directly. The blockchain only records that this wallet passed, and your country code.</div>
          {sStatus === "verified" ? <span className="gl-chk ok">✓ This wallet is verified</span>
            : sStatus === "requested" ? <span className="gl-chk warn">Request sent. You can continue; you can buy once the issuer verifies you.</span>
            : sStatus === "frozen" ? <div className="notice err">This wallet is frozen for this offering. Contact the issuer.</div>
            : <button type="button" className="btn primary" disabled={busy || !sWallet} onClick={request}>{busy ? "Sending…" : "Ask to be verified"}</button>}
        </>
      ) : (
        <>
          <div className="wz-tip"><b>What happens next</b><br />A secure check opens from our identity partner. Your documents go to them, not to the issuer and not on the blockchain. The blockchain only records that this wallet passed.</div>
          {kyc.status?.status === "approved" ? <span className="gl-chk ok">✓ Identity verified</span>
            : <div className="row" style={{ flexWrap: "wrap", gap: 10 }}><Link className="btn primary" to={`/verify/${a.id}`}>{kyc.status ? "Continue the identity check" : "Start identity check"}</Link>{kyc.status && <span className="muted">Status: {kyc.status.status}</span>}</div>}
        </>
      )}
    </Question>
  );
  if (at === 3) body = (
    <Question n={4} of={of} title={r.accreditedOnly ? "Are you an accredited investor?" : "Accreditation"} canNext onBack={back} onNext={next}
      intro={r.accreditedOnly ? "This offering is only open to accredited investors: for example income over $200,000 ($300,000 with a spouse) for two years, net worth over $1 million not counting your home, or a Series 7, 65 or 82 license." : "This offering doesn't require accreditation. Nothing to do here."}>
      {r.accreditedOnly && (stellar
        ? <span className="hint">The issuer confirms your accreditation when they verify you.</span>
        : <div className="row" style={{ flexWrap: "wrap", gap: 10 }}><Link className="btn primary" to={`/accredit/${a.id}`}>Prove accreditation</Link><span className="muted" style={{ fontSize: 14 }}>Income, net worth, or a professional license, with the proof each needs.</span></div>)}
    </Question>
  );
  if (at === 4) body = (
    <Question n={5} of={of} title="How much do you want to invest?" canNext={steps[4]!.done} onBack={back} onNext={next}>
      <div className="q"><label htmlFor="iv-usd">Amount ({code})</label><input id="iv-usd" className="input" inputMode="decimal" value={usd} onChange={(e) => setUsd(e.target.value.replace(/[^0-9.]/g, ""))} placeholder={minimum ? `At least ${minimum.toLocaleString()}` : "e.g. 1000"} /></div>
      <div className="gl-review">
        <div className="li"><span className="muted">Price</span><span>{price ? `${price.toLocaleString()} ${code} a token` : "Not set yet"}</span></div>
        <div className="li"><span className="muted">You get</span><b>{tokens.toLocaleString()} {a.symbol}</b></div>
        {minimum > 0 && <div className="li"><span className="muted">Minimum</span><span>{minimum.toLocaleString()} {code}</span></div>}
        {capTokens > 0 && <div className="li"><span className="muted">Most one investor can hold</span><span>{capTokens.toLocaleString()} tokens</span></div>}
        <div className="li"><span className="muted">Before you can resell</span><span>{r.lockupDays ? lockupLabel(r.lockupDays) : "No waiting period"}</span></div>
      </div>
      {amountErr && <div className="notice err">{amountErr}</div>}
    </Question>
  );
  if (at === 5) body = (
    <Question n={6} of={of} title="Confirm your investment" onBack={back}
      canNext={ack && (!stellar || (verified && !!sale?.open))} busy={busy}
      nextLabel={stellar ? `Pay ${(tokens * price).toLocaleString()} ${code} in Freighter` : "Continue to payment"}
      onNext={stellar ? buy : () => { window.location.assign(`/market/${a.id}`); }}
      intro={`${tokens.toLocaleString()} ${a.symbol} for ${(tokens * price).toLocaleString()} ${code}.`}>
      <span className="hint">Read the offering documents on the <Link to={`/market/${a.id}`}>listing</Link> before you invest.</span>
      <label className="row" style={{ gap: 10, alignItems: "flex-start" }}>
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} style={{ marginTop: 4 }} />
        <span>I've read the offering documents. I understand this is a private investment, I could lose all of it, and I may not be able to sell for {r.lockupDays ? lockupLabel(r.lockupDays).toLowerCase() : "some time"}.</span>
      </label>
      {stellar && !verified && <div className="notice err">You can pay once the issuer has verified this wallet.</div>}
      {stellar && verified && sale && !sale.open && <div className="notice err">The sale isn't open right now.</div>}
      {stellar && !sale && <div className="notice err">This offering doesn't sell online yet.</div>}
      {sale && <span className="muted" style={{ fontSize: 13 }}>Payment goes straight to the issuer's account. Tokens arrive in the same transaction. Price {payAmount(sale.price, pd)} {code}.</span>}
    </Question>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div className="gl-title">
        <span className="muted gl-kicker">Invest in {a.name}</span>
        <h1>Get ready to invest</h1>
        <p className="muted">{a.issuer?.name ?? "The issuer"} only accepts verified investors. This takes about five minutes, and you only do it once per wallet.</p>
      </div>
      {msg.ok && <div className="notice ok">{msg.ok}</div>}
      {msg.err && <div className="notice err">{msg.err}</div>}
      <WizardShell steps={steps} at={at} onPick={go}>{body}</WizardShell>
    </div>
  );
}
