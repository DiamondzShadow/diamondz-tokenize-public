// Question-by-question wizards (designs W11 go live on mainnet, W12 online sale setup; approved 2026-11-19).
// One question per screen, a step rail, and a live check on every answer before Continue unlocks.
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type Asset, type LegalState, type StellarAccountFacts, type StellarSaleTerms, type StellarTerms } from "../lib/api";
import { NETWORKS, STELLAR_NETWORKS, isStellarChain, networkById, stellarById, stellarCodeReady, type StellarNetwork } from "../lib/chains";
import { connectFreighter, signWithFreighter, FREIGHTER_URL } from "../lib/freighter";
import { useTenant } from "../lib/tenant";
import { connectWallet, walletClientFor } from "../lib/wallet";
import { claimSignerMessage } from "../lib/claims";
import FormDPanel from "./FormD";
import LegalPanel from "./Legal";

// ------------------------------------------------------------------ shared shell
export type WizStep = { key: string; title: string; done: boolean };

export function WizardShell({ steps, at, onPick, children }: { steps: WizStep[]; at: number; onPick: (i: number) => void; children: ReactNode }) {
  // Only questions the person has reached show a tick: a default answer isn't an answer yet.
  const [seen, setSeen] = useState(at);
  useEffect(() => setSeen((x) => Math.max(x, at)), [at]);
  return (
    <div className="gl-wrap">
      <ol className="gl-rail" aria-label="Questions">
        {steps.map((s, i) => {
          const reachable = i <= Math.max(at, seen) || steps.slice(0, i).every((x) => x.done);
          const tick = s.done && i !== at && i <= seen;
          return (
            <li key={s.key}>
              <button type="button" className={`gl-step ${i === at ? "now" : ""}`} aria-current={i === at ? "step" : undefined} disabled={!reachable} onClick={() => onPick(i)}>
                <span className={`gl-dot ${tick ? "ok" : i === at ? "now" : ""}`} aria-hidden="true">{tick ? "✓" : i + 1}</span>
                <span>{s.title}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <div className="gl-main">{children}</div>
    </div>
  );
}

export function Question({ n, of, title, intro, children, canNext, nextLabel = "Continue", onBack, onNext, busy }: {
  n: number; of: number; title: string; intro?: ReactNode; children?: ReactNode;
  canNext: boolean; nextLabel?: string; onBack?: () => void; onNext: () => void; busy?: boolean;
}) {
  return (
    <section className="panel gl-q">
      <div className="gl-head">
        <span className="gl-n">Question {n} of {of}</span>
        <h2>{title}</h2>
        {intro && <p className="muted" style={{ margin: 0 }}>{intro}</p>}
      </div>
      {children}
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        {onBack ? <button type="button" className="btn ghost" onClick={onBack}>Back</button> : <span />}
        <button type="button" className="btn primary" disabled={!canNext || busy} onClick={onNext}>{busy ? "Working…" : nextLabel}</button>
      </div>
    </section>
  );
}

const Check = ({ ok, warn, children }: { ok: boolean; warn?: boolean; children: ReactNode }) => (
  <span className={`gl-chk ${ok ? "ok" : warn ? "warn" : "bad"}`}>{ok ? "✓ " : "✗ "}{children}</span>
);

/** Live check of a Stellar account (exists, multisig, can receive the pay token). */
function useAccountFacts(net: StellarNetwork | undefined, account: string) {
  const [facts, setFacts] = useState<StellarAccountFacts | null>(null);
  const [err, setErr] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    setFacts(null); setErr("");
    if (!net || !/^G[A-Z2-7]{55}$/.test(account)) return;
    let live = true;
    api.stellarAccount(net.key, account).then((f) => live && setFacts(f), (e) => live && setErr(e.message));
    return () => { live = false; };
  }, [net, account, tick]);
  return { facts, err, recheck: () => setTick((t) => t + 1) };
}

const G_RE = /^G[A-Z2-7]{55}$/;

// ------------------------------------------------------------------ W11 · go live on mainnet
export function GoLive() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const { tenant } = useTenant();
  const [asset, setAsset] = useState<Asset | null>(null);
  const [err, setErr] = useState("");
  const [at, setAt] = useState(0);
  useEffect(() => { api.asset(id).then(setAsset, (e) => setErr(e.message)); }, [id]);

  // answers
  const [hasMs, setHasMs] = useState<"yes" | "no">("yes");
  const [admin, setAdmin] = useState("");
  const [signers, setSigners] = useState(["", "", ""]);
  const [wallet, setWallet] = useState("");
  const [feeTx, setFeeTx] = useState("");
  // The issuer's claim-signing EVM wallet (a Trezor or Ledger behind MetaMask), named by one signature.
  const [claimSigner, setClaimSigner] = useState<{ address: string; signature: string } | null>(null);
  const [feeCheck, setFeeCheck] = useState<{ ok: boolean; error?: string } | null>(null);
  const [terms, setTerms] = useState<StellarTerms | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [legal, setLegal] = useState<LegalState | null>(null);
  useEffect(() => { if (id) api.legal(id).then(setLegal, () => {}); }, [id]);

  const current = asset ? (stellarById(asset.chainId) ?? networkById(asset.chainId)) : undefined;
  const onStellar = !!asset && isStellarChain(asset.chainId);
  const stellarMain = STELLAR_NETWORKS.find((n) => !n.testnet);
  const target = asset && !current?.testnet ? current : undefined; // already switched to a real network
  const sNet = target && onStellar ? (target as StellarNetwork) : undefined;
  useEffect(() => { if (sNet) api.stellarTerms(sNet.key).then(setTerms, () => setTerms(null)); }, [sNet]);
  const adminCheck = useAccountFacts(sNet, admin);

  if (err) return <div className="notice err">{err}</div>;
  if (!asset || !tenant) return <p className="muted">Loading…</p>;
  const locked = asset.status === "deployed" || (onStellar && !!asset.stellar && current?.testnet);
  if (locked) return (
    <div className="panel">
      <h2>Go live on a real network</h2>
      <p className="muted">{asset.status === "deployed" ? "This offering is already deployed" : "This offering's test deployment has started"} on {current?.name}, so its network can't change. Start a new issuance with the same terms and pick a real network there.</p>
      <div className="row"><Link className="btn primary" to="/app/new">New issuance</Link><Link className="btn ghost" to={`/app/assets/${asset.id}`}>Back to the offering</Link></div>
    </div>
  );

  // networks the asset can move to without changing its token type
  const options = onStellar
    ? (stellarMain ? [{ id: stellarMain.id, name: stellarMain.name, pay: stellarMain.payToken.code, open: stellarCodeReady(stellarMain), note: stellarCodeReady(stellarMain) ? "Multisig admin, the platform keeps no role" : "Opening soon: the platform is uploading its contracts" }] : [])
    : NETWORKS.filter((n) => !n.testnet && n.stable).map((n) => ({
      id: n.id, name: n.name, pay: n.stable!.symbol,
      open: !!tenant.platform.feeRecipients?.[String(n.id)] && asset.standard !== "erc3643",
      note: asset.standard === "erc3643" ? "ERC-3643 is on test networks for now" : tenant.platform.feeRecipients?.[String(n.id)] ? "Treasury multisig, offering fee paid at deploy" : "Not open for offerings yet",
    }));

  const pickNetwork = async (chainId: number) => {
    setBusy(true); setMsg("");
    try { setAsset(await api.updateAsset(asset.id, { chainId })); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  const checkFee = async () => {
    if (!sNet) return;
    setBusy(true); setFeeCheck(null);
    try { setFeeCheck(await api.stellarFeeCheck(sNet.key, feeTx.trim(), asset.id)); } catch (e) { setFeeCheck({ ok: false, error: (e as Error).message }); } finally { setBusy(false); }
  };
  const deploy = async () => {
    setBusy(true); setMsg("");
    try {
      if (sNet) {
        await api.stellarDeployMainnet(asset.id, admin.trim(), wallet, feeTx.trim(), claimSigner!);
      }
      nav(`/app/assets/${asset.id}`);
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };

  const plan = tenant.plan;
  const evmTreasury = tenant.payments.treasury;
  const steps: WizStep[] = [
    { key: "network", title: "Which network", done: !!target },
    { key: "plan", title: "Your plan", done: !plan.testnetOnly },
    { key: "legal", title: "Company and lawyer", done: !!legal?.cleared },
    { key: "formd", title: "SEC Form D", done: true },
    { key: "admin", title: "Who controls it", done: onStellar ? !!adminCheck.facts?.multisig && admin !== wallet : !!evmTreasury },
    { key: "wallet", title: "Day-to-day wallet", done: onStellar ? G_RE.test(wallet) && wallet !== admin && !!claimSigner : true },
    { key: "fee", title: "Offering fee", done: onStellar ? !!feeCheck?.ok : true },
    { key: "review", title: "Review and deploy", done: false },
  ];
  const go = (i: number) => { setMsg(""); setAt(i); };
  const back = at > 0 ? () => go(at - 1) : undefined;
  const next = () => go(at + 1);
  const of = steps.length;

  let body: ReactNode = null;
  if (at === 0) body = (
    <Question n={1} of={of} title="Which real network should it go live on?" intro={`It's on ${current?.name} today. Investors will pay in the network's stablecoin.`} canNext={!!target} onNext={next} busy={busy}>
      <div className="gl-cards" role="radiogroup" aria-label="Network">
        {options.map((o) => (
          <button type="button" role="radio" aria-checked={asset.chainId === o.id} key={o.id} disabled={!o.open || busy} className={`gl-card ${asset.chainId === o.id ? "on" : ""}`} onClick={() => pickNetwork(o.id)}>
            <b>{o.name} · {o.pay}</b><span className="muted">{o.note}</span>
          </button>
        ))}
        {!options.length && <span className="muted">No real network is open for this token type yet.</span>}
      </div>
      {!onStellar && <span className="hint">Moving between Stellar and the other networks changes the token type: do that in Edit terms.</span>}
    </Question>
  );
  if (at === 1) body = (
    <Question n={2} of={of} title="Is your plan ready for real money?" canNext={!plan.testnetOnly} onBack={back} onNext={next}
      intro={plan.testnetOnly ? "The Free plan runs on test networks only." : `You're on ${plan.name}. Going live costs a one-time offering fee of $${plan.offeringFeeUsd.toLocaleString()}.`}>
      {plan.testnetOnly
        ? <div className="row"><Link className="btn primary" to="/app/billing">Choose a plan</Link><span className="muted" style={{ fontSize: 14 }}>Come back here when it's active.</span></div>
        : <Check ok>Plan active</Check>}
    </Question>
  );
  // L1 (2026-11-20): three independent checks replace the self-ticked "counsel approved" box.
  if (at === 2) body = (
    <Question n={3} of={of} title="Company, lawyer and Diamondz review" canNext={!!legal?.cleared} onBack={back} onNext={next}
      intro="Nobody can vouch for themselves here. Stripe verifies your company, your lawyer signs directly with us, and Diamondz reviews both before real money.">
      <LegalPanel assetId={asset.id} onState={setLegal} />
    </Question>
  );
  // Design 5 (2026-11-20): a reminder, never a blocker. Rule 506 offerings file within 15 days after the first sale.
  if (at === 3) body = (
    <Question n={4} of={of} title="SEC Form D" canNext onBack={back} onNext={next} nextLabel={asset.formD ? "Continue" : "Continue without it for now"}
      intro={asset.exemption === "506c" || asset.formD
        ? "Rule 506 offerings file a Form D with the SEC within 15 days after the first sale. Attach yours and the listing shows it, read straight from EDGAR. Not filed yet? Continue, and attach it once it's filed."
        : "Only offerings under Regulation D file a Form D. If yours uses Reg D, attach the filing here once it's on EDGAR; otherwise continue."}>
      <FormDPanel asset={asset} onChange={setAsset} />
      {!asset.formD && <span className="hint">Investors see "Form D: not filed yet" on Rule 506(c) listings until it's attached. <a href="https://www.sec.gov/resources-small-businesses/exempt-offerings/filing-form-d-notice" target="_blank" rel="noreferrer">How to file on EDGAR ↗</a></span>}
    </Question>
  );
  if (at === 4) body = onStellar ? (
    <Question n={5} of={of} title="Who should be able to pause the token or change who runs it?" canNext={steps[4]!.done} onBack={back} onNext={next}
      intro="On a real network this is the most powerful key. We require more than one person to sign, so one lost phone or one bad actor can't take over.">
      <div className="gl-cards" role="radiogroup" aria-label="Do you already have a multisig account?">
        <button type="button" role="radio" aria-checked={hasMs === "yes"} className={`gl-card ${hasMs === "yes" ? "on" : ""}`} onClick={() => setHasMs("yes")}><b>Yes, I have one</b><span className="muted">Paste its address. We check it really needs more than one signature.</span></button>
        <button type="button" role="radio" aria-checked={hasMs === "no"} className={`gl-card ${hasMs === "no" ? "on" : ""}`} onClick={() => setHasMs("no")}><b>No, help me set one up</b><span className="muted">Who signs, and how many must agree.</span></button>
      </div>
      {hasMs === "no" && (
        <ol className="gl-howto">
          <li>Create a new Stellar account for the company (any wallet, for example Freighter or a hardware wallet) and fund it with a few XLM.</li>
          <li>Add each signer: every person's own wallet, weight 1. Keep the account's own key at weight 1 or remove it.</li>
          <li>Set the medium and high thresholds to how many must agree, for example 2 of 3. Never 1.</li>
          <li>Store the backup of every signer key somewhere different. Then paste the account below.</li>
        </ol>
      )}
      <div className="q">
        <label htmlFor="gl-admin">Multisig address</label>
        <input id="gl-admin" className="input mono" placeholder="G…" value={admin} onChange={(e) => setAdmin(e.target.value.trim())} />
        {adminCheck.facts && (
          <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
            <Check ok={adminCheck.facts.exists}>{adminCheck.facts.exists ? "Account exists" : "Account not found"}</Check>
            {adminCheck.facts.exists && <Check ok={adminCheck.facts.signers >= 2}>{adminCheck.facts.signers} signer{adminCheck.facts.signers === 1 ? "" : "s"}</Check>}
            {adminCheck.facts.exists && <Check ok={adminCheck.facts.multisig}>{adminCheck.facts.multisig ? `${adminCheck.facts.medThreshold} signature weight needed` : `Not a multisig: ${adminCheck.facts.why}`}</Check>}
            <button type="button" className="btn ghost sm" onClick={adminCheck.recheck}>Check again</button>
          </div>
        )}
        {adminCheck.err && <span className="notice err">{adminCheck.err}</span>}
      </div>
      <fieldset className="q" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend>Who are the signers? <span className="muted">(for your own records, kept in this browser only)</span></legend>
        <div className="gl-three">{signers.map((s, i) => <input key={i} aria-label={`Signer ${i + 1}`} className="input" value={s} placeholder={["e.g. CEO · hardware wallet", "e.g. CFO · hardware wallet", "e.g. counsel · backup"][i]} onChange={(e) => setSigners(signers.map((x, j) => (j === i ? e.target.value : x)))} />)}</div>
      </fieldset>
      <div className="wz-two">
        <div className="wz-tip"><b>What this key can do</b><br />Pause all transfers, approve the online sale, replace your day-to-day wallet. It can't change your rules: those lock at launch.</div>
        <div className="wz-tip"><b>What the platform keeps</b><br />Nothing. We set the contracts up, then give up every role. Your offering page shows it on chain.</div>
      </div>
    </Question>
  ) : (
    <Question n={5} of={of} title="Who controls the offering on a real network?" canNext={!!evmTreasury} onBack={back} onNext={next}
      intro="On mainnet, admin control of the token, registry and sale moves to your treasury multisig (a Safe) as part of deploying.">
      {evmTreasury
        ? <div className="li"><span className="muted">Treasury multisig</span><span className="mono">{evmTreasury}</span></div>
        : <div className="row" style={{ flexWrap: "wrap" }}><Link className="btn primary" to="/app/payments">Set your treasury multisig</Link><span className="muted" style={{ fontSize: 14 }}>No Safe yet? Create one at <a href="https://app.safe.global" target="_blank" rel="noreferrer">app.safe.global</a> with at least 2 signers.</span></div>}
    </Question>
  );
  if (at === 5) body = onStellar ? (
    <Question n={6} of={of} title="Which wallet runs the offering day to day?" canNext={steps[5]!.done} onBack={back} onNext={next}
      intro="This wallet verifies investors, issues tokens and freezes wallets. You sign each action in Freighter. It must be different from the multisig.">
      <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
        <button type="button" className="btn primary" onClick={async () => { setMsg(""); try { if (sNet) setWallet(await connectFreighter(sNet)); } catch (e) { setMsg((e as Error).message); } }}>{wallet ? "Reconnect Freighter" : "Connect Freighter"}</button>
        {wallet && <span className="mono">{wallet}</span>}
      </div>
      {wallet && wallet === admin && <div className="notice err">That's the multisig. Switch Freighter to a different account.</div>}
      {!wallet && <span className="muted" style={{ fontSize: 13 }}>No Freighter yet? <a href={FREIGHTER_URL} target="_blank" rel="noreferrer">Install it</a> and switch it to Mainnet.</span>}
      <div className="q" style={{ marginTop: 14 }}>
        <b>Your claim-signing wallet</b>
        <span className="muted" style={{ fontSize: 14 }}>You vouch for each investor you verify by signing their identity claims. Use an Ethereum wallet, ideally a Trezor or Ledger connected through MetaMask. It becomes the only key that can sign claims for this offering. The platform never holds one.</span>
        <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
          <button type="button" className="btn" onClick={async () => {
            setMsg("");
            try {
              const me = await connectWallet();
              const signature = await walletClientFor(42161, me).signMessage({ account: me, message: claimSignerMessage(asset.id, sNet!, me) });
              setClaimSigner({ address: me, signature });
            } catch (e) { setMsg((e as Error).message); }
          }}>{claimSigner ? "Sign with a different wallet" : "Connect and sign"}</button>
          {claimSigner && <span className="mono">{claimSigner.address}</span>}
        </div>
      </div>
    </Question>
  ) : (
    <Question n={6} of={of} title="Which wallet deploys?" canNext onBack={back} onNext={next}
      intro="The wallet you connect on the offering page deploys and pays the network fees. Right after deploying, admin control moves to your treasury multisig." />
  );
  if (at === 6) body = onStellar ? (
    <Question n={7} of={of} title="Pay the offering fee" canNext={!!feeCheck?.ok} onBack={back} onNext={next}
      intro={terms?.feeAccount ? <>Send <b>{terms.feeUsd.toLocaleString()} {terms.payToken.code}</b> on Stellar to the platform's fee account, then paste the payment's transaction hash. Each payment counts once.</> : "The platform's fee account isn't set up yet."}>
      {terms?.feeAccount && <div className="li"><span className="muted">Send to</span><span className="mono">{terms.feeAccount}</span></div>}
      <div className="q">
        <label htmlFor="gl-fee">Transaction hash</label>
        <div className="row" style={{ gap: 8 }}>
          <input id="gl-fee" className="input mono" placeholder="64 characters" value={feeTx} onChange={(e) => { setFeeTx(e.target.value.trim()); setFeeCheck(null); }} />
          <button type="button" className="btn ghost" disabled={!/^[0-9a-f]{64}$/i.test(feeTx) || busy} onClick={checkFee}>Check payment</button>
        </div>
        {feeCheck && <Check ok={feeCheck.ok}>{feeCheck.ok ? "Payment found on Stellar" : feeCheck.error}</Check>}
      </div>
    </Question>
  ) : (
    <Question n={7} of={of} title="The offering fee" canNext onBack={back} onNext={next}
      intro={`The $${plan.offeringFeeUsd.toLocaleString()} fee is paid in ${networkById(asset.chainId)?.stable?.symbol ?? "USDC"} as one of the deploy steps; the platform checks it on chain.`} />
  );
  if (at === 7) {
    const rows: [string, string][] = [
      ["Network", current?.name ?? ""],
      ["Plan", plan.name],
      ["Company and lawyer", legal?.cleared ? `Approved · ${legal.counsel?.name ?? ""}, ${legal.counsel?.firm ?? ""}` : "Not cleared yet"],
      ...(onStellar ? [["Admin (multisig)", admin] as [string, string], ["Day-to-day wallet", wallet] as [string, string], ["Claim-signing wallet", claimSigner?.address ?? "Not named"] as [string, string], ["Offering fee", feeCheck?.ok ? `Paid · ${feeTx.slice(0, 12)}…` : "Not checked"] as [string, string]]
        : [["Treasury multisig", evmTreasury ?? "Missing"] as [string, string]]),
    ];
    const ready = steps.slice(0, 7).every((s) => s.done);
    body = (
      <Question n={8} of={of} title="Review and deploy" canNext={ready} onBack={back} onNext={deploy} busy={busy}
        nextLabel={onStellar ? `Deploy on ${current?.name}` : "Continue to deploy"}
        intro={onStellar ? "The platform creates the contracts, pays the network fees, then gives up every role. You can leave the page; progress shows on your offering." : "Deploying runs on the offering page with your connected wallet."}>
        <div className="gl-review">{rows.map(([k, v]) => <div className="li" key={k}><span className="muted">{k}</span><span className={k.includes("wallet") || k.includes("multisig") ? "mono" : ""}>{v}</span></div>)}</div>
        {!ready && <div className="notice err">Finish the questions marked without a tick first.</div>}
      </Question>
    );
  }

  return (
    <div className="gl-page">
      <div className="gl-title">
        <span className="muted gl-kicker">{asset.name} · {asset.symbol}</span>
        <h1>Go live on a real network</h1>
        <p className="muted">Eight questions move this offering to real money. You can stop at any point and come back.</p>
      </div>
      {msg && <div className="notice err">{msg}</div>}
      <WizardShell steps={steps} at={at} onPick={go}>{body}</WizardShell>
    </div>
  );
}

// ------------------------------------------------------------------ W12 · online sale setup (Stellar)
const toTs = (d: string) => (d ? Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000) : 0);
const fromTs = (s: string | undefined) => s ?? "";

export function SaleWizard({ asset, net, onCreated }: { asset: Asset; net: StellarNetwork; onCreated: (a: Asset) => void }) {
  const r: any = asset.rules ?? {};
  const [at, setAt] = useState(0);
  const [price, setPrice] = useState(asset.pricePerToken ?? "");
  const [minimum, setMinimum] = useState(asset.minInvestment ?? "");
  const [treasury, setTreasury] = useState(asset.stellar?.issuer ?? "");
  const [startMode, setStartMode] = useState<"now" | "date">(r.saleStartsAt ? "date" : "now");
  const [start, setStart] = useState(fromTs(r.saleStartsAt));
  const [endMode, setEndMode] = useState<"soldout" | "date">(r.saleEndsAt ? "date" : "soldout");
  const [end, setEnd] = useState(fromTs(r.saleEndsAt));
  const [sellMode, setSellMode] = useState<"all" | "part">("all");
  const [pct, setPct] = useState("40");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const tr = useAccountFacts(net, treasury);

  const supply = BigInt(asset.totalSupply || "0");
  const capTokens = sellMode === "all" ? supply : (supply * BigInt(Math.max(1, Math.min(100, Math.round(Number(pct) || 0))))) / 100n;
  const priceOk = /^\d{1,12}(\.\d{1,6})?$/.test(price) && Number(price) > 0;
  const minOk = minimum === "" || /^\d{1,12}(\.\d{1,2})?$/.test(minimum);
  const datesOk = (startMode === "now" || !!start) && (endMode === "soldout" || (!!end && (startMode === "now" || toTs(end) > toTs(start))));
  const code = net.payToken.code;
  const steps: WizStep[] = [
    { key: "price", title: "Price", done: priceOk },
    { key: "min", title: "Minimum", done: minOk },
    { key: "pay", title: "How buyers pay", done: !!tr.facts?.exists && !!tr.facts?.canReceive },
    { key: "dates", title: "Sale dates", done: datesOk },
    { key: "amount", title: "How much to sell", done: capTokens > 0n },
    { key: "create", title: "Create the sale", done: false },
  ];
  const of = steps.length;
  const back = at > 0 ? () => setAt(at - 1) : undefined;
  const next = () => setAt(at + 1);

  const addTrust = async () => {
    setErr(""); setBusy(true);
    try {
      const w = await connectFreighter(net);
      if (w !== treasury) throw new Error(`Switch Freighter to ${treasury}, or add ${code} to that account in its own wallet.`);
      const p = await api.stellarTrustline(net.key, w);
      if (!p.xdr) throw new Error("Couldn't prepare the trustline");
      await api.stellarTrustline(net.key, w, await signWithFreighter(net, p.xdr, w));
      tr.recheck();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const create = async () => {
    setErr(""); setBusy(true);
    const terms: StellarSaleTerms = {
      price, minimum: minimum || "0", treasury, capTokens: capTokens.toString(),
      startsAt: startMode === "now" ? 0 : toTs(start), endsAt: endMode === "soldout" ? 0 : toTs(end),
    };
    try { onCreated(await api.stellarSaleSetup(asset.id, terms)); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const minTokens = priceOk && minimum ? Math.ceil(Number(minimum) / Number(price)) : 0;
  let body: ReactNode = null;
  if (at === 0) body = (
    <Question n={1} of={of} title="What does one token cost?" intro={`In ${code}. Buyers see this on your listing.`} canNext={priceOk} onNext={next}>
      <div className="q"><label htmlFor="sw-price">Price per token ({code})</label><input id="sw-price" className="input" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value.trim())} placeholder="e.g. 10" /></div>
      {priceOk && <span className="hint">All {supply.toLocaleString()} tokens at this price: {(Number(price) * Number(supply)).toLocaleString()} {code}.</span>}
    </Question>
  );
  if (at === 1) body = (
    <Question n={2} of={of} title="What's the smallest purchase?" intro="Leave empty for no minimum." canNext={minOk} onBack={back} onNext={next}>
      <div className="q"><label htmlFor="sw-min">Minimum per purchase ({code})</label><input id="sw-min" className="input" inputMode="decimal" value={minimum} onChange={(e) => setMinimum(e.target.value.trim())} placeholder="e.g. 500" /></div>
      {minTokens > 0 && <span className="hint">That's at least {minTokens.toLocaleString()} token{minTokens === 1 ? "" : "s"}.</span>}
    </Question>
  );
  if (at === 2) body = (
    <Question n={3} of={of} title="What do buyers pay with, and where does the money go?" canNext={steps[2]!.done} onBack={back} onNext={next}>
      <div className="gl-cards" role="radiogroup" aria-label="Currency">
        <button type="button" role="radio" aria-checked className="gl-card on"><b>{code}</b><span className="muted">{net.payToken.issuer === "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" ? "Circle · most Stellar wallets hold it" : "This network's payment token"}</span></button>
      </div>
      <div className="q">
        <label htmlFor="sw-treasury">Where should sale money arrive?</label>
        <span className="hint">Usually your company's treasury account. Payments go straight there; the platform never holds them.</span>
        <input id="sw-treasury" className="input mono" value={treasury} onChange={(e) => setTreasury(e.target.value.trim())} placeholder="G…" />
      </div>
      {tr.facts && (
        <div className="gl-review">
          <div className="li"><span>Exists on Stellar</span><Check ok={tr.facts.exists}>{tr.facts.exists ? "Yes" : "Not found"}</Check></div>
          {tr.facts.exists && <div className="li"><span>Can receive {code}</span><Check ok={tr.facts.canReceive} warn>{tr.facts.canReceive ? "Yes" : `Not yet: add ${code} to it first`}</Check></div>}
          {tr.facts.exists && !tr.facts.canReceive && (
            <div className="row" style={{ flexWrap: "wrap" }}>
              <button type="button" className="btn ghost" disabled={busy} onClick={addTrust}>{busy ? "Waiting for Freighter…" : `Add ${code} to this account in Freighter`}</button>
              <button type="button" className="btn ghost sm" onClick={tr.recheck}>Check again</button>
              <span className="muted" style={{ fontSize: 13 }}>For a multisig, add the {code} trustline from its own wallet, then check again.</span>
            </div>
          )}
        </div>
      )}
      {tr.err && <div className="notice err">{tr.err}</div>}
      {err && <div className="notice err">{err}</div>}
    </Question>
  );
  if (at === 3) body = (
    <Question n={4} of={of} title="When is the sale open?" canNext={datesOk} onBack={back} onNext={next} intro="You can still close the sale at any time, and it closes on its own if a proof-of-asset check stops passing.">
      <fieldset className="q" style={{ border: 0, padding: 0, margin: 0 }}><legend>Opens</legend>
        <div className="chips">{([["now", "As soon as I open it"], ["date", "On a date"]] as const).map(([v, l]) => <button type="button" key={v} className={`chip ${startMode === v ? "on" : ""}`} aria-pressed={startMode === v} onClick={() => setStartMode(v)}>{l}</button>)}</div>
        {startMode === "date" && <input aria-label="Opening date" type="date" className="input" value={start} onChange={(e) => setStart(e.target.value)} />}
      </fieldset>
      <fieldset className="q" style={{ border: 0, padding: 0, margin: 0 }}><legend>Closes</legend>
        <div className="chips">{([["soldout", "When sold out"], ["date", "On a date"]] as const).map(([v, l]) => <button type="button" key={v} className={`chip ${endMode === v ? "on" : ""}`} aria-pressed={endMode === v} onClick={() => setEndMode(v)}>{l}</button>)}</div>
        {endMode === "date" && <input aria-label="Closing date" type="date" className="input" value={end} onChange={(e) => setEnd(e.target.value)} />}
      </fieldset>
      {!datesOk && endMode === "date" && end && <span className="notice err">The sale must close after it opens.</span>}
    </Question>
  );
  if (at === 4) body = (
    <Question n={5} of={of} title="How much do you want to sell online?" canNext={capTokens > 0n} onBack={back} onNext={next}>
      <div className="chips">{([["all", "All of it"], ["part", "A first tranche"]] as const).map(([v, l]) => <button type="button" key={v} className={`chip ${sellMode === v ? "on" : ""}`} aria-pressed={sellMode === v} onClick={() => setSellMode(v)}>{l}</button>)}</div>
      {sellMode === "part" && <div className="q"><label htmlFor="sw-pct">Share of the supply (%)</label><input id="sw-pct" className="input" inputMode="numeric" value={pct} onChange={(e) => setPct(e.target.value.replace(/[^0-9]/g, ""))} /></div>}
      <span className="hint">{capTokens.toLocaleString()} of {supply.toLocaleString()} tokens{priceOk ? `, up to ${(Number(capTokens) * Number(price)).toLocaleString()} ${code}` : ""}. Tokens you issue yourself from the console don't count against this.</span>
    </Question>
  );
  if (at === 5) {
    const rows: [string, string][] = [
      ["Price", `${price} ${code} a token`], ["Minimum", minimum && Number(minimum) > 0 ? `${minimum} ${code}` : "None"], ["Money goes to", treasury],
      ["Opens", startMode === "now" ? "When you open it" : start], ["Closes", endMode === "soldout" ? "When sold out" : end], ["Selling", `${capTokens.toLocaleString()} tokens`],
    ];
    body = (
      <Question n={6} of={of} title="Create the sale" canNext={steps.slice(0, 5).every((s) => s.done)} onBack={back} onNext={create} busy={busy} nextLabel="Create the sale"
        intro={`Next you approve it with ${net.testnet ? "your admin wallet in Freighter" : "your multisig"}, so it can issue tokens to buyers, then open it. These terms are fixed once the sale is created.`}>
        <div className="gl-review">{rows.map(([k, v]) => <div className="li" key={k}><span className="muted">{k}</span><span className={k === "Money goes to" ? "mono" : ""}>{v}</span></div>)}</div>
        {err && <div className="notice err">{err}</div>}
      </Question>
    );
  }
  return <WizardShell steps={steps} at={at} onPick={setAt}>{body}</WizardShell>;
}

/** "Go live" entry for a draft on a test network (shown on the offering page). */
export function GoLiveCard({ asset }: { asset: Asset }) {
  const net = stellarById(asset.chainId) ?? networkById(asset.chainId);
  if (asset.status === "deployed" || !net?.testnet || (isStellarChain(asset.chainId) && asset.stellar)) return null;
  return (
    <div className="panel gl-card-cta">
      <div><b>Ready for real money?</b><br /><span className="muted" style={{ fontSize: 14 }}>Eight questions move this offering from {net.name} to a real network.</span></div>
      <Link className="btn primary" to={`/app/assets/${asset.id}/go-live`}>Go live</Link>
    </div>
  );
}
