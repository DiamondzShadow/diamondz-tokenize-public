import { useEffect, useState } from "react";
import { dayOn, exemptionText, filedOn, formName } from "../app/FormD";
import { ListingApprovals, ListingIssuer } from "../app/Approvals";
import { Link, useParams } from "react-router-dom";
import { formatUnits, parseUnits, type Address } from "viem";
import { api, type MarketAsset, type StellarSale } from "../lib/api";
import { ASSET_CLASSES, ITEM_ID, assetClassById } from "../lib/catalog";
import { addrUrl, networkById, txUrl, isStellarChain, stellarById, stellarAccountUrl, stellarTxUrl, type StellarNetwork } from "../lib/chains";
import { useStellarProof, stellarCheckName, stellarAmount, payAmount } from "../app/Stellar";
import { FREIGHTER_URL, connectFreighter, signWithFreighter } from "../lib/freighter";
import { ART, ensureChain, publicClientFor, send, useConnectedAccount, walletError } from "../lib/wallet";
import Connect from "../lib/Connect";
import { ProofBadge, ProofPanel, VerifiedCard, lockReason, proofState, useProof } from "../lib/Proof";
import type { Proof } from "../lib/api";
import { InvestorTabs, Sheet, SiteHeader } from "../lib/Chrome";
import { AssetClassIcon } from "../lib/Icons";
import VerifyChecklist from "../lib/VerifyChecklist";
import BringUsdc, { canBringUsdc } from "../lib/BringUsdc";
import { QUESTIONS, type Details } from "../lib/questions";
import { OPEN_COUNTRIES, US, countryName, lockupLabel, type Rules } from "../lib/rules";

/** Step-2 answers as listing facts (empty answers and the street address hidden). */
function AssetFacts({ a }: { a: MarketAsset }) {
  const q = QUESTIONS[a.assetClass as keyof typeof QUESTIONS];
  const d = (a.details ?? {}) as Details;
  if (!q || !Object.keys(d).length) return null;
  const rows = q.sections.flatMap((s) => s.fields.flatMap((f) => {
    const v = d[f.id];
    if (v === undefined || v === "" || f.id === "address") return [];
    const shown = f.type === "yesno" ? (v ? "Yes" : "No") : f.type === "money" ? `$${Number(v).toLocaleString()}` : f.type === "percent" ? `${v}%`
      : f.options ? f.options.find(([k]) => k === v)?.[1] ?? String(v) : String(v);
    return [[f.label, shown] as [string, string]];
  }));
  const calcs = q.sections.flatMap((s) => s.calc?.(d) ?? []);
  if (!rows.length) return null;
  return (
    <div className="panel sec-overview">
      <h3>{q.title.replace(/^About your/, "About this")}</h3>
      {rows.map(([k, v]) => <div className="li" key={k}><span className="muted">{k}</span><span>{v}</span></div>)}
      {calcs.map(([k, v]) => <div className="li" key={k}><span className="muted">{k}</span><b>{v}</b></div>)}
    </div>
  );
}

/** Link to the asset's public IP page once it's registered (designs F1/F6). */
function IpLink({ id }: { id: string }) {
  const [p, setP] = useState<{ licenseTypes: { active: boolean }[] } | null>(null);
  useEffect(() => { fetch(`/api/ip/${id}`).then((r) => (r.ok ? r.json() : null)).then(setP, () => setP(null)); }, [id]);
  if (!p) return null;
  const lic = p.licenseTypes.some((t) => t.active);
  return (
    <div className="panel sec-overview">
      <h3>Registered IP asset</h3>
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>The asset's official on-chain record: identifiers, chain of title and history{lic ? ", plus licenses anyone can get" : ""}.</p>
      <Link className="btn ghost sm" to={`/ip/${id}`}>{lic ? "View IP and licenses →" : "View the asset record →"}</Link>
    </div>
  );
}

/** What the token itself enforces (wizard step 5), in plain English, plus the document fingerprints. */
function EnforcedRules({ a }: { a: MarketAsset }) {
  const r = a.rules as Rules | undefined;
  const docs = (a.documents ?? []) as { kind: string; name: string; sha256: string }[];
  if (!r && !docs.length) return null;
  return (
    <div className="panel sec-terms">
      {r && <>
        <h3>Rules the token enforces</h3>
        <div className="li"><span className="muted">Who may hold</span><span>{r.accreditedOnly ? "Verified, accredited investors" : "Verified investors"}{r.countryMode === "allow" ? ` in ${r.countries.map(countryName).join(", ")}` : r.countryMode === "block" ? `, not in ${r.countries.map(countryName).join(", ")}` : ""}</span></div>
        <div className="li"><span className="muted">Holding period</span><span>{r.lockupDays ? `${lockupLabel(r.lockupDays)} from each purchase` : "None"}</span></div>
        {(r.maxHolders > 0 || r.maxHolderPct > 0) && <div className="li"><span className="muted">Limits</span><span>{[r.maxHolders ? `${r.maxHolders.toLocaleString()} holders max` : "", r.maxHolderPct ? `${r.maxHolderPct}% per investor max` : ""].filter(Boolean).join(" · ")}</span></div>}
        {r.resaleApproval && <div className="li"><span className="muted">Resales</span><span>Approved by the issuer</span></div>}
        {r.maturity && <div className="li"><span className="muted">Matures</span><span>{r.maturity}</span></div>}
        {(r.saleStartsAt || r.saleEndsAt) && <div className="li"><span className="muted">Sale dates</span><span>{r.saleStartsAt || "Open"} – {r.saleEndsAt || "until sold out"}</span></div>}
      </>}
      {docs.length > 0 && <>
        <h3 style={{ marginTop: r ? 12 : 0 }}>Document fingerprints</h3>
        <small className="muted" style={{ lineHeight: 1.5 }}>Recorded in the token. If the issuer shares a document with you, its sha256 must match.</small>
        {docs.map((x) => <div className="li" key={x.kind}><span className="muted">{x.name}</span><span style={{ fontFamily: "monospace", fontSize: 11, wordBreak: "break-all" }}>{x.sha256}</span></div>)}
      </>}
    </div>
  );
}

function CardBadge({ a }: { a: MarketAsset }) {
  const proof = useProof(a.id, 0);
  return <ProofBadge proof={proof} assetClass={a.assetClass} />;
}

function SiteNav({ back }: { back?: boolean }) {
  return back ? <SiteHeader back="/market" title="Offering" /> : <SiteHeader />;
}

const money = (v: string | number) => `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

export function MarketList() {
  const [items, setItems] = useState<MarketAsset[] | null>(null);
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState<string>("all");
  useEffect(() => {
    api.market().then(setItems, (e) => setErr(e.message));
  }, []);
  const shown = (items ?? []).filter((a) => filter === "all" || a.assetClass === filter);
  const classes = ASSET_CLASSES.filter((c) => items?.some((a) => a.assetClass === c.id));

  return (
    <div className="page has-tabs">
      <SiteNav />
      <InvestorTabs />
      <section className="wrap section" style={{ paddingTop: 56 }}>
        <div className="section-head">
          <span className="eyebrow">Marketplace</span>
          <h2>Open offerings</h2>
          <p>Each offering is a token on a public blockchain. Only verified investors can buy, and income is paid to holders on chain.</p>
        </div>
        {classes.length > 1 && (
          <div className="chips chips-scroll">
            <button className={`chip ${filter === "all" ? "on" : ""}`} onClick={() => setFilter("all")}>All</button>
            {classes.map((c) => <button key={c.id} className={`chip ${filter === c.id ? "on" : ""}`} onClick={() => setFilter(c.id)}>{c.name}</button>)}
          </div>
        )}
        {err && <div className="notice err">{err}</div>}
        {items && shown.length === 0 && (
          <div className="empty">
            <b style={{ color: "var(--text)", fontSize: 18 }}>No open offerings yet</b>
            <span>Offerings appear here once an issuer deploys an asset and switches its listing on.</span>
            <span style={{ fontSize: 13 }}>Issuer? <Link to="/app" style={{ color: "var(--brand)" }}>Open the console</Link> → create an asset → deploy it (a testnet is fine) → Marketplace listing → “Show on the marketplace”.</span>
          </div>
        )}
        <div className="grid4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
          {shown.map((a) => {
            const cls = assetClassById(a.assetClass);
            const net = networkById(a.chainId) ?? stellarById(a.chainId);
            return (
              <Link to={`/market/${a.id}`} key={a.id} className="card" style={{ padding: 0, overflow: "hidden" }}>
                <div className="m-img" style={{ position: "relative", ...(a.imageUrl ? { backgroundImage: `url("${a.imageUrl}")` } : {}) }}>
                  {!a.imageUrl && <span><AssetClassIcon id={a.assetClass} size={40} /></span>}
                  {net?.testnet && <span className="demo-badge" style={{ position: "absolute", top: 12, left: 12 }} title="Demo listing on a test network: test tokens, no real money">Demo</span>}
                  <span style={{ position: "absolute", top: 12, right: 12 }}><CardBadge a={a} /></span>
                </div>
                <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 8 }}>
                  <span className="muted" style={{ fontSize: 12 }}>{cls?.name}{a.location ? ` · ${a.location}` : ""}</span>
                  <h3>{a.name}</h3>
                  <div className="row" style={{ justifyContent: "space-between", fontSize: 14 }}>
                    <span>{money(a.pricePerToken)} <span className="muted">/ token</span></span>
                    <span className="muted">min {a.minInvestment ? money(a.minInvestment) : "—"}</span>
                  </div>
                  <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                    <span className={`tag ${net?.testnet ? "y" : ""}`}>{net?.name}{net?.testnet ? " · testnet" : ""}</span>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
}

interface SaleState {
  price: bigint;
  cap: bigint;
  sold: bigint;
  minPurchase: bigint;
  isOpen: boolean;
  payDecimals: number;
  paySymbol: string;
  /** ERC-4626 fund vault: investors deposit an amount and get shares at NAV. price = assets per share. */
  vault?: boolean;
  /** ERC-1155 offering: whole fractions of one item (shareDecimals = 0). */
  multi?: boolean;
  /** ERC-721 offering: whole NFTs, issued in order (shareDecimals = 0, at most 50 per purchase). */
  nft?: boolean;
  /** ERC-3643 (T-REX): buyers are checked against the token's identity registry via the sale's canBuy. */
  trex?: boolean;
  shareDecimals: number;
}

export function MarketItem() {
  const { id = "" } = useParams();
  const [a, setA] = useState<MarketAsset | null>(null);
  const [sale, setSale] = useState<SaleState | null>(null);
  const [err, setErr] = useState("");
  const proof = useProof(a?.id);
  const [tab, setTab] = useState<"overview" | "proof" | "terms">("overview");
  const [buyOpen, setBuyOpen] = useState(false);

  useEffect(() => {
    api.marketAsset(id).then(setA, (e) => setErr(e.message));
  }, [id]);

  const loadSale = async (x: MarketAsset) => {
    const pc = publicClientFor(x.chainId);
    if (x.standard === "erc4626") {
      const v = { address: x.deployment.sale, abi: ART.PermissionedVault.abi } as const;
      const p = { address: x.deployment.payToken, abi: ART.TestUSD.abi } as const;
      const [shareDecimals, total, cap, paused, verified, left, payDecimals, paySymbol] = await Promise.all([
        pc.readContract({ ...v, functionName: "decimals" }), pc.readContract({ ...v, functionName: "totalAssets" }),
        pc.readContract({ ...v, functionName: "depositCap" }), pc.readContract({ ...v, functionName: "paused" }),
        pc.readContract({ ...v, functionName: "assetVerified" }), pc.readContract({ ...v, functionName: "capRemaining" }),
        pc.readContract({ ...p, functionName: "decimals" }), pc.readContract({ ...p, functionName: "symbol" }),
      ]);
      const price = (await pc.readContract({ ...v, functionName: "convertToAssets", args: [10n ** BigInt(shareDecimals as number)] })) as bigint;
      setSale({
        price, cap: cap as bigint, sold: total as bigint, minPurchase: parseUnits(x.minInvestment || "0", Number(payDecimals)),
        isOpen: !paused && !!verified && (left as bigint) > 0n, payDecimals: Number(payDecimals), paySymbol: paySymbol as string,
        vault: true, shareDecimals: Number(shareDecimals),
      });
      return;
    }
    const multi = x.standard === "erc1155";
    const nft = x.standard === "erc721";
    const trex = x.standard === "erc3643";
    const s = { address: x.deployment.sale, abi: multi ? ART.PrimarySale1155.abi : nft ? ART.PrimarySale721.abi : trex ? ART.PrimarySale3643.abi : ART.PrimarySale.abi } as const;
    const p = { address: x.deployment.payToken, abi: ART.TestUSD.abi } as const;
    const [price, cap, sold, minPurchase, isOpen, payDecimals, paySymbol] = await Promise.all([
      pc.readContract({ ...s, functionName: "price" }), pc.readContract({ ...s, functionName: "cap" }),
      pc.readContract({ ...s, functionName: "sold" }), pc.readContract({ ...s, functionName: "minPurchase" }),
      pc.readContract({ ...s, functionName: "isOpen" }), pc.readContract({ ...p, functionName: "decimals" }),
      pc.readContract({ ...p, functionName: "symbol" }),
    ]);
    // shareDecimals = token unit decimals: 18 for ERC-20 offerings, 0 for ERC-1155 fractions.
    setSale({ price, cap, sold, minPurchase, isOpen, payDecimals: Number(payDecimals), paySymbol, shareDecimals: multi || nft ? 0 : 18, multi, nft, trex } as SaleState);
  };
  useEffect(() => {
    if (a && !isStellarChain(a.chainId)) loadSale(a).catch((e) => setErr(walletError(e)));
  }, [a]);

  if (err) return <div className="page"><SiteNav back /><div className="wrap section"><div className="notice err">{err}</div><Link to="/market">← Back to marketplace</Link></div></div>;
  if (!a) return <div className="page"><SiteNav back /></div>;
  const stellarNet = stellarById(a.chainId);
  if (stellarNet) return <StellarListing a={a} net={stellarNet} />;
  const cls = assetClassById(a.assetClass);
  const net = networkById(a.chainId)!;
  const pct = sale && sale.cap > 0n ? Number((sale.sold * 10000n) / sale.cap) / 100 : 0;

  return (
    <div className="page has-actionbar">
      <SiteNav back />
      <section className="wrap section" style={{ paddingTop: 40, gap: 28 }}>
        <Link to="/market" className="muted desktop-only" style={{ fontSize: 14 }}>← All offerings</Link>
        <div className="lst-grid">
          <div className="lst-hero">
            <div className="m-img lg" style={a.imageUrl ? { backgroundImage: `url("${a.imageUrl}")` } : undefined}>{!a.imageUrl && <span><AssetClassIcon id={a.assetClass} size={56} /></span>}</div>
            <div>
              <span className="eyebrow">{cls?.name}{a.location ? ` · ${a.location}` : ""}</span>
              <h1 style={{ fontSize: 40, margin: "8px 0" }}>{a.name}</h1>
              <span className="muted">{a.symbol} on {net.name}{net.testnet ? " (testnet, play money)" : ""}</span>
              <div className="row" style={{ marginTop: 12 }}><Link className="btn primary" to={`/invest/${a.id}`}>Start investing</Link><span className="muted" style={{ fontSize: 13 }}>Six questions, about five minutes.</span></div>
            </div>
            {net.testnet && (
              <div className="demo-note" role="note">
                <span className="demo-badge">Demo</span>
                <span>This is a demo listing on {net.name}, a test network. Tokens and USDC here are test tokens with no real value; nothing is for sale and no money changes hands. It shows how a live offering works.</span>
              </div>
            )}
          </div>
          <div className="lst-body" data-tab={tab}>
            <div className="seg" role="tablist" aria-label="Sections">
              {(["overview", "proof", "terms"] as const).map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t[0]!.toUpperCase() + t.slice(1)}</button>
              ))}
            </div>
            {a.description && <p className="sec-overview" style={{ whiteSpace: "pre-wrap", lineHeight: 1.65, color: "var(--muted)" }}>{a.description}</p>}
            <AssetFacts a={a} />
            <IpLink id={a.id} />
            <div className="sec-proof"><ProofPanel proof={proof} assetClass={a.assetClass} /></div>
            <div className="panel sec-terms">
              <h3>Terms</h3>
              {[
                ["Price per token", money(a.pricePerToken)],
                ["Minimum investment", a.minInvestment ? money(a.minInvestment) : "—"],
                ["Total supply", Number(a.totalSupply).toLocaleString()],
                ["Income paid", a.schedule || "—"],
                ...(a.rules ? [] : [["Lockup", a.lockup || "—"]]),
              ].map(([k, v]) => <div className="li" key={k}><span className="muted">{k}</span><span>{v}</span></div>)}
              <div className="li"><span className="muted">Token contract</span><a href={addrUrl(net, a.deployment.token)} target="_blank" rel="noreferrer" style={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}>{a.deployment.token}</a></div>
            </div>
            <EnforcedRules a={a} />
            <ListingIssuer assetId={a.id} />
            <ListingApprovals assetId={a.id} />
            {!a.formD && a.exemption === "506c" && (
              <div className="panel sec-terms sec-filing" aria-labelledby="sec-filing-h">
                <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap" }}>
                  <h3 id="sec-filing-h">SEC filing</h3>
                  <span className="formd-pending">Not filed yet</span>
                </div>
                <p className="muted" style={{ margin: 0, fontSize: 14, lineHeight: 1.55 }}>This is a Rule 506(c) offering. The issuer files a Form D with the SEC within 15 days after the first sale, and it appears here once attached.</p>
                <small className="muted" style={{ lineHeight: 1.5 }}>The SEC does not review or approve offerings.</small>
              </div>
            )}
            {a.formD && (
              <div className="panel sec-terms sec-filing" aria-labelledby="sec-filing-h">
                <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap" }}>
                  <h3 id="sec-filing-h">SEC filing</h3>
                  <a className="formd-link" href={a.formD.url} target="_blank" rel="noreferrer">View on SEC.gov ↗</a>
                </div>
                <div className="li"><span className="muted">Notice of exempt offering</span><span>{formName(a.formD)} · filed {filedOn(a.formD.filedAt)}</span></div>
                <div className="li"><span className="muted">Issuer</span><span>{a.formD.entityName} · CIK {a.formD.cik}</span></div>
                <div className="li"><span className="muted">Exemption</span><span>{exemptionText(a.formD)}{a.formD.exemptions.some((e) => e.code === "06c") ? ", accredited investors only" : ""}</span></div>
                {a.formD.dateOfFirstSale && <div className="li"><span className="muted">First sale</span><span>{dayOn(a.formD.dateOfFirstSale)}</span></div>}
                <small className="muted" style={{ lineHeight: 1.5 }}>A Form D is a notice the issuer files with the SEC. The SEC does not review or approve the offering or the accuracy of the filing.</small>
              </div>
            )}
          </div>
          <div className="lst-aside">
            <VerifiedCard proof={proof} assetClass={a.assetClass} />
            <div className="panel">
              <h3>Raise progress</h3>
              <div className="setup-bar"><i style={{ width: `${Math.min(100, pct)}%` }} /></div>
              <span className="muted" style={{ fontSize: 13 }}>
                {!sale ? "Loading from the network…" : sale.vault
                  ? `$${Number(formatUnits(sale.sold, sale.payDecimals)).toLocaleString()} of $${Number(formatUnits(sale.cap, sale.payDecimals)).toLocaleString()} raised (${pct}%)`
                  : `${Number(formatUnits(sale.sold, sale.shareDecimals)).toLocaleString()} of ${Number(formatUnits(sale.cap, sale.shareDecimals)).toLocaleString()} ${sale.multi ? "fractions" : sale.nft ? "NFTs" : "tokens"} sold (${pct}%)`}
              </span>
            </div>
            {sale && <div className="buy-desktop"><BuyPanel a={a} sale={sale} proof={proof} onBought={() => loadSale(a)} /></div>}
            <p className="disclaimer" style={{ padding: 0 }}>
              {a.formD?.exemptions.length ? <>Offered by the issuer under {exemptionText(a.formD)} (<a href={a.formD.url} target="_blank" rel="noreferrer" style={{ color: "var(--brand)" }}>Form D on file</a>).</> : "Offered by the issuer under its own exemption."} Tokens are only available to verified investors and may be subject to transfer restrictions. Investing involves risk, including loss of principal.
            </p>
          </div>
        </div>
      </section>
      <div className="actionbar">
        <div className="p"><b>{money(a.pricePerToken)}</b><span>per token{a.minInvestment ? ` · min ${money(a.minInvestment)}` : ""}</span></div>
        <button className="btn primary" disabled={!sale} onClick={() => setBuyOpen(true)}>{lockReason(proof) ? "Why paused?" : "Buy"}</button>
      </div>
      <Sheet open={buyOpen} onClose={() => setBuyOpen(false)} title={`Buy ${a.symbol}`}>
        {sale && <BuyPanel a={a} sale={sale} proof={proof} onBought={() => loadSale(a)} inSheet />}
      </Sheet>
    </div>
  );
}

function BuyPanel({ a, sale, proof, onBought, inSheet }: { a: MarketAsset; sale: SaleState; proof: Proof | null; onBought: () => void; inSheet?: boolean }) {
  const locked = lockReason(proof);
  const net = networkById(a.chainId)!;
  const account = useConnectedAccount();
  const [verified, setVerified] = useState<boolean | null>(null);
  const [blocked, setBlocked] = useState<string>("");
  const [payBal, setPayBal] = useState<bigint>(0n);
  const [held, setHeld] = useState<bigint>(0n);
  const [qty, setQty] = useState("");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err" | ""; text: string; tx?: string } | null>(null);
  const [bringing, setBringing] = useState(false);
  const bringable = canBringUsdc(a.chainId, sale.paySymbol);

  const one = 10n ** BigInt(sale.shareDecimals); // base units per whole token (1 for ERC-1155 fractions)
  const units = !sale.vault && /^\d{1,15}$/.test(qty) ? BigInt(qty) * one : 0n;
  const cost = sale.vault
    ? (/^\d{1,12}(\.\d{1,6})?$/.test(qty) ? parseUnits(qty, sale.payDecimals) : 0n)
    : units ? (units * sale.price + one - 1n) / one : 0n;
  const fmt = (v: bigint) => `${Number(formatUnits(v, sale.payDecimals)).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${sale.paySymbol}`;

  async function refresh(acct: Address) {
    const pc = publicClientFor(a.chainId);
    const verifiedRead = sale.vault
      ? pc.readContract({ address: a.deployment.registry, abi: ART.InvestorRegistry.abi, functionName: "isVerified", args: [acct] })
      : sale.trex
      ? pc.readContract({ address: a.deployment.sale, abi: ART.PrimarySale3643.abi, functionName: "canBuy", args: [acct] })
      : pc.readContract({ address: a.deployment.token, abi: sale.multi ? ART.PermissionedMultiToken.abi : sale.nft ? ART.PermissionedNFT.abi : ART.PermissionedToken.abi, functionName: "canReceive", args: [acct] });
    const [v, b, h] = await Promise.all([
      verifiedRead,
      pc.readContract({ address: a.deployment.payToken, abi: ART.TestUSD.abi, functionName: "balanceOf", args: [acct] }),
      sale.multi
        ? pc.readContract({ address: a.deployment.token, abi: ART.PermissionedMultiToken.abi, functionName: "balanceOf", args: [acct, ITEM_ID] })
        : pc.readContract({ address: a.deployment.token, abi: ART.PermissionedToken.abi, functionName: "balanceOf", args: [acct] }),
    ]);
    setVerified(v as boolean);
    setPayBal(b as bigint);
    setHeld(h as bigint);
  }

  useEffect(() => {
    if (!account) {
      setVerified(null);
      return;
    }
    setMsg(null);
    setBlocked("");
    api.screen(account, a.chainId).then(
      (r) => r.sanctioned && setBlocked("This wallet is on a sanctions list and can't invest."),
      (e) => setBlocked(e.message),
    );
    ensureChain(a.chainId)
      .then(() => refresh(account))
      .catch((e) => setMsg({ kind: "err", text: walletError(e) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, a.chainId]);

  async function getTestUsd() {
    if (!account) return;
    setBusy("mint");
    try {
      await ensureChain(a.chainId);
      await send(a.chainId, account, a.deployment.payToken, ART.TestUSD.abi, "mint", [account, parseUnits("10000", 6)]);
      await refresh(account);
    } catch (e) {
      setMsg({ kind: "err", text: walletError(e) });
    } finally {
      setBusy("");
    }
  }

  async function buy() {
    if (!account || !cost) return;
    setMsg(null);
    try {
      await ensureChain(a.chainId);
      const pc = publicClientFor(a.chainId);
      const allowance = (await pc.readContract({ address: a.deployment.payToken, abi: ART.TestUSD.abi, functionName: "allowance", args: [account, a.deployment.sale] })) as bigint;
      if (allowance < cost) {
        setBusy("approve");
        await send(a.chainId, account, a.deployment.payToken, ART.TestUSD.abi, "approve", [a.deployment.sale, cost]);
      }
      setBusy("buy");
      const tx = sale.vault
        ? await send(a.chainId, account, a.deployment.sale, ART.PermissionedVault.abi, "deposit", [cost, account])
        : await send(a.chainId, account, a.deployment.sale, sale.multi ? ART.PrimarySale1155.abi : sale.nft ? ART.PrimarySale721.abi : sale.trex ? ART.PrimarySale3643.abi : ART.PrimarySale.abi, "buy", [units]);
      setMsg({ kind: "ok", text: sale.vault ? `You invested ${fmt(cost)} in ${a.symbol}.` : `You bought ${Number(qty).toLocaleString()} ${a.symbol}.`, tx });
      setQty("");
      await refresh(account);
      onBought();
    } catch (e) {
      setMsg({ kind: "err", text: walletError(e) });
    } finally {
      setBusy("");
    }
  }

  const belowMin = cost > 0n && cost < sale.minPurchase;
  const overNftLimit = !!sale.nft && units > 50n;
  const tooPoor = cost > payBal;

  return (
    <div className={inSheet ? "buy-sheet-body" : "panel"}>
      {!inSheet && <h3>Invest</h3>}
      {locked
        ? <div className={`locked ${proofState(proof) === "bad" ? "bad" : ""}`}>{locked} <a href="#proof" className="lnk">See why</a></div>
        : !sale.isOpen && <div className="notice">This offering isn't accepting purchases right now.</div>}
      <Connect chainId={a.chainId} label="Sign in to invest" />
      {account && (
        <>
          <div className="li"><span className="muted">Wallet</span><span style={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}>{account}</span></div>
          <div className="li"><span className="muted">You hold</span><span>{Number(formatUnits(held, sale.shareDecimals)).toLocaleString(undefined, { maximumFractionDigits: 4 })} {a.symbol}</span></div>
          <div className="li"><span className="muted">{sale.paySymbol} balance</span><span>{fmt(payBal)}</span></div>
          {blocked && <div className="notice err">{blocked}</div>}
          {verified === false && (
            <>
              <VerifyChecklist assetId={a.id} issuerId={a.issuer?.id} wallet={account} sanctioned={!!blocked && /sanctions/i.test(blocked)} />
              <span className="muted" style={{ fontSize: 12 }}>Issuer testing your own offering? <Link to={`/app/investors?asset=${a.id}`} style={{ color: "inherit", textDecoration: "underline" }}>Approve this wallet in your console</Link>.</span>
            </>
          )}
          {net.testnet && sale.paySymbol === "tUSD" && (
            <button className="btn ghost sm" disabled={!!busy} onClick={getTestUsd} style={{ alignSelf: "flex-start" }}>{busy === "mint" ? "Minting…" : "Get 10,000 test USD (free, testnet only)"}</button>
          )}
          {bringing ? (
            <BringUsdc
              destChainId={a.chainId}
              account={account}
              shortfall={cost > payBal ? cost - payBal : 0n}
              onClose={() => setBringing(false)}
              onArrived={(amt, mintTx) => {
                setBringing(false);
                setMsg({ kind: "ok", text: `${Number(formatUnits(amt, 6)).toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC arrived on ${net.name}.`, tx: mintTx });
                refresh(account);
              }}
            />
          ) : <>
          {sale.vault ? (
            <>
              <label className="field">Amount to invest ({sale.paySymbol})
                <input className="input" inputMode="decimal" value={qty} placeholder="e.g. 500" onChange={(e) => setQty(e.target.value.replace(/[^\d.]/g, "").slice(0, 18))} />
              </label>
              <div className="quick">
                {[100, 500, 1000].map((n) => <button key={n} type="button" onClick={() => setQty(String(n))}>${n.toLocaleString()}</button>)}
                <button type="button" onClick={() => setQty(formatUnits(payBal, sale.payDecimals))}>Max</button>
              </div>
              <span className="muted" style={{ fontSize: 12 }}>Shares are issued at the current net asset value: 1 {a.symbol} = {fmt(sale.price)}.</span>
            </>
          ) : (
            <>
              <label className="field">{sale.multi ? "How many fractions?" : sale.nft ? "How many NFTs? (up to 50 per purchase)" : "How many tokens?"}
                <input className="input" inputMode="numeric" value={qty} placeholder="e.g. 1000" onChange={(e) => setQty(e.target.value.replace(/\D/g, "").slice(0, 15))} />
              </label>
              <div className="quick">
                {(sale.nft ? [1, 2, 5] : [10, 50, 100]).map((n) => <button key={n} type="button" onClick={() => setQty(String(n))}>{n}</button>)}
                <button type="button" onClick={() => { const m = sale.price > 0n ? (payBal * one / sale.price) / one : 0n; setQty(String(sale.nft && m > 50n ? 50n : m)); }}>Max</button>
              </div>
            </>
          )}
          {cost > 0n && <div className="li"><span className="muted">You pay</span><b>{fmt(cost)}</b></div>}
          {belowMin && <div className="notice err">The minimum investment is {fmt(sale.minPurchase)}.</div>}
          {tooPoor && !belowMin && <div className="notice err">Not enough {sale.paySymbol} in this wallet{bringable ? ` on ${net.name}` : ""}.</div>}
          {bringable && (tooPoor || payBal === 0n) && !belowMin && (
            <div className="bring-cta" style={{ background: "var(--brand-soft)", border: "1px solid var(--brand-line)", borderRadius: "var(--radius)", padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
              <b style={{ fontSize: 14 }}>Have USDC on another network?</b>
              <small className="muted" style={{ lineHeight: 1.5 }}>Bring it here with Circle. It arrives in this same wallet, usually in seconds.</small>
              <button type="button" className="btn ghost sm" style={{ justifyContent: "center" }} onClick={() => { setMsg(null); setBringing(true); }}>Bring USDC from another network</button>
            </div>
          )}
          {overNftLimit && <div className="notice err">At most 50 NFTs per purchase. Buy the rest in another purchase.</div>}
          <button
            className="btn primary"
            style={{ justifyContent: "center" }}
            disabled={!!locked || !!blocked || !sale.isOpen || !verified || !cost || belowMin || tooPoor || overNftLimit || !!busy}
            onClick={buy}
          >
            {locked ? "Buy unavailable" : busy === "approve" ? `Approve ${sale.paySymbol} in wallet…` : busy === "buy" ? "Confirm purchase in wallet…" : "Buy"}
          </button>
          <p className="muted" style={{ fontSize: 12 }}>{verified === false ? "Buying unlocks once your wallet is approved." : `Two wallet confirmations: allow the sale to take ${sale.paySymbol}, then buy.`}</p>
          </>}
        </>
      )}
      {msg?.text && (
        <div className={`notice ${msg.kind}`}>
          {msg.text} {msg.tx && <a href={txUrl(net, msg.tx)} target="_blank" rel="noreferrer">View transaction ↗</a>}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Stellar listing (designs X4 desktop, X5 phone)
// Same layout classes as an EVM listing (responsive). The investor connects Freighter, asks the issuer to verify the
// wallet, and the token itself then accepts them; Chainlink's checks are read at the offering's EVM anchor.
function StellarListing({ a, net }: { a: MarketAsset; net: StellarNetwork }) {
  const cls = assetClassById(a.assetClass);
  const d = a.deployment as unknown as { token: string; anchor: { chainId: number; address: `0x${string}` } };
  const proof = useStellarProof(a.assetClass, d.anchor);
  const [wallet, setWallet] = useState("");
  const [status, setStatus] = useState<"none" | "requested" | "verified" | "frozen" | null>(null);
  const [bal, setBal] = useState<string | null>(null);
  const [country, setCountry] = useState(US);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const r = a.rules as Rules | undefined;
  const now = Date.now() / 1000;

  const refresh = async (w: string) => {
    const s = await api.stellarStatus(a.id, w);
    setStatus(s.status);
    if (s.status === "verified" || s.status === "frozen") setBal((await api.stellarBalance(net.key, d.token, w)).balance);
  };
  const connect = async () => {
    setErr("");
    try { const w = await connectFreighter(net); setWallet(w); await refresh(w); } catch (e) { setErr((e as Error).message); }
  };
  const request = async () => {
    setErr(""); setBusy(true);
    try { await api.stellarRequest(a.id, wallet, country); await refresh(wallet); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const verified = status === "verified" || status === "frozen";
  const step = (state: "done" | "now" | "wait", title: string, body: React.ReactNode) => (
    <li style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={state === "done" ? "var(--ok)" : state === "now" ? "var(--brand)" : "var(--muted)"} strokeWidth={2.5} role="img" aria-label={state === "done" ? "Done" : state === "now" ? "Next" : "Waiting"} style={{ flex: "none" }}>
        <circle cx="12" cy="12" r="10" strokeDasharray={state === "now" ? "4 3" : undefined} />{state === "done" && <path d="M7.5 12.5l3 3 6-7" />}
      </svg>
      <span><b style={{ fontWeight: 500 }}>{title}</b>{body && <><br /><span className="muted">{body}</span></>}</span>
    </li>
  );
  const passed = (proof ?? []).filter((p) => p.result === 1 && p.validUntil > now);

  // ---- online sale (contracts/sale): pay with the sale's stablecoin, signed in Freighter
  const [sale, setSale] = useState<StellarSale | null>(null);
  const [qty, setQty] = useState("");
  const [bought, setBought] = useState("");
  useEffect(() => { api.stellarSale(a.id).then((x) => setSale(x.sale), () => setSale(null)); }, [a.id]);
  const pd = sale?.payToken.decimals ?? net.payToken.decimals;
  const cost = sale && qty ? (BigInt(qty) * BigInt(sale.price)) : 0n; // whole tokens × price per whole token
  const left = sale ? (BigInt(sale.cap) - BigInt(sale.sold)) / 10_000_000n : 0n;
  const belowMin = !!sale && !!qty && cost < BigInt(sale.minPurchase);
  const canBuy = !!sale?.open && status === "verified" && !!qty && !belowMin && BigInt(qty) <= left;
  const buy = async () => {
    setErr(""); setBought(""); setBusy(true);
    try {
      const p = await api.stellarBuy(a.id, wallet, qty);
      if (!p.xdr) throw new Error("Couldn't prepare the purchase");
      const r = await api.stellarBuy(a.id, wallet, qty, await signWithFreighter(net, p.xdr, wallet));
      setBought(r.tx ?? "");
      setQty("");
      await refresh(wallet);
      api.stellarSale(a.id).then((x) => setSale(x.sale), () => {});
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="page">
      <SiteNav back />
      <section className="wrap section" style={{ paddingTop: 40, gap: 28 }}>
        <Link to="/market" className="muted desktop-only" style={{ fontSize: 14 }}>← All offerings</Link>
        <div className="lst-grid">
          <div className="lst-hero">
            <div className="m-img lg" style={a.imageUrl ? { backgroundImage: `url("${a.imageUrl}")` } : undefined}>{!a.imageUrl && <span><AssetClassIcon id={a.assetClass} size={56} /></span>}</div>
            <div>
              <span className="eyebrow">{cls?.name}{a.location ? ` · ${a.location}` : ""}</span>
              <div className="row" style={{ flexWrap: "wrap", alignItems: "baseline" }}>
                <h1 style={{ fontSize: 40, margin: "8px 0" }}>{a.name}</h1>
                <span className="tag">On Stellar</span>
              </div>
              <span className="muted">{a.symbol} on {net.name}{net.testnet ? " (testnet, play money)" : ""}</span>
              <div className="row" style={{ marginTop: 12 }}><Link className="btn primary" to={`/invest/${a.id}`}>Start investing</Link><span className="muted" style={{ fontSize: 13 }}>Six questions, about five minutes.</span></div>
            </div>
            {net.testnet && (
              <div className="demo-note" role="note">
                <span className="demo-badge">Demo</span>
                <span>This is a demo listing on {net.name}, a test network. Tokens here have no real value; nothing is for sale and no money changes hands.</span>
              </div>
            )}
          </div>
          <div className="lst-body">
            {a.description && <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.65, color: "var(--muted)" }}>{a.description}</p>}
            <div className="st-stats three">
              <div><span className="muted">Price per token</span><b>{a.pricePerToken ? money(a.pricePerToken) : "—"}</b></div>
              <div><span className="muted">Minimum</span><b>{a.minInvestment ? money(a.minInvestment) : "—"}</b></div>
              <div><span className="muted">Income</span><b>{a.schedule || "—"}</b></div>
            </div>
            <AssetFacts a={a} />
            <div className="panel">
              <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
                <h3>Verified facts</h3>
                <span className="st-chainlink">Checked by Chainlink</span>
              </div>
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10, fontSize: 14 }}>
                {(proof ?? []).map((p) => {
                  const ok = p.result === 1 && p.validUntil > now;
                  return (
                    <li key={p.kind} style={{ display: "flex", gap: 10 }}>
                      <span className={ok ? "st-pass" : "st-wait"} style={{ minWidth: 64 }}>{ok ? "Pass" : "Waiting"}</span>
                      <span>{stellarCheckName(p.kind)}{p.kind === "REGISTRY" ? ": read from the Stellar ledger by Chainlink, rechecked every 30 minutes." : "."}</span>
                    </li>
                  );
                })}
                {!proof && <li className="muted">Reading Chainlink's checks…</li>}
              </ul>
              {proof && passed.length < proof.length && <small className="muted">Purchases open once every check passes.</small>}
            </div>
            <EnforcedRules a={a} />
            <div className="panel">
              <h3>Terms</h3>
              <div className="li"><span className="muted">Total supply</span><span>{Number(a.totalSupply).toLocaleString()}</span></div>
              <div className="li"><span className="muted">Token on Stellar</span><a className="mono" href={stellarAccountUrl(net, d.token)} target="_blank" rel="noreferrer">{d.token}</a></div>
            </div>
          </div>
          <div className="lst-aside">
            <div className="panel">
              <h3>Invest</h3>
              <p className="muted" style={{ margin: 0, fontSize: 14 }}>This offering lives on Stellar, so you hold it in a Stellar wallet.</p>
              <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10, fontSize: 14 }}>
                {step(wallet ? "done" : "now", wallet ? "Stellar wallet connected" : "Connect your Stellar wallet", wallet ? <span className="mono">{wallet}</span> : "Freighter")}
                {step(verified ? "done" : wallet ? "now" : "wait", verified ? "Identity verified" : "Verify your identity",
                  status === "requested" ? "Requested. The issuer reviews your documents and records your verification for this wallet." : verified ? null : "Once approved, your verification is recorded for this wallet so the token accepts you.")}
                {r?.accreditedOnly && step(verified ? "done" : "wait", "Confirm you're accredited", "Required for this offering; the issuer checks it when verifying you")}
              </ol>
              {!wallet && (
                <>
                  <button type="button" className="btn primary" style={{ justifyContent: "center" }} onClick={connect}>Connect Freighter</button>
                  <small className="muted">No Freighter yet? <a href={FREIGHTER_URL} target="_blank" rel="noreferrer">Install it</a> and switch it to {net.testnet ? "Testnet" : "Mainnet"}.</small>
                </>
              )}
              {wallet && status === "none" && (
                <>
                  <label htmlFor="st-country" className="muted" style={{ fontSize: 13 }}>Country of residence</label>
                  <select id="st-country" className="input" value={country} onChange={(e) => setCountry(Number(e.target.value))}>
                    {OPEN_COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
                  </select>
                  <button type="button" className="btn primary" style={{ justifyContent: "center" }} disabled={busy} onClick={request}>{busy ? "Sending…" : "Verify my identity"}</button>
                </>
              )}
              {verified && (
                <div className="li"><span className="muted">You hold</span><span>{bal !== null ? `${stellarAmount(bal)} ${a.symbol}` : "…"}{status === "frozen" ? " (frozen)" : ""}</span></div>
              )}
              {status === "verified" && sale?.open && (
                <>
                  <label htmlFor="st-qty" className="muted" style={{ fontSize: 13 }}>Tokens to buy</label>
                  <input id="st-qty" className="input" inputMode="numeric" placeholder="e.g. 50" value={qty} onChange={(e) => setQty(e.target.value.replace(/[^0-9]/g, "").replace(/^0+/, ""))} />
                  <div className="li"><span className="muted">You pay</span><span>{qty ? `${payAmount(cost.toString(), pd)} ${sale.payToken.code}` : "—"}</span></div>
                  {belowMin && <small style={{ color: "var(--bad)" }}>The minimum is {payAmount(sale.minPurchase, pd)} {sale.payToken.code}.</small>}
                  {qty && BigInt(qty) > left && <small style={{ color: "var(--bad)" }}>Only {left.toLocaleString()} tokens are left.</small>}
                </>
              )}
              <button type="button" className="btn primary" disabled={!canBuy || busy} onClick={buy}
                style={{ justifyContent: "center", ...(canBuy ? {} : { background: "var(--line)", color: "var(--muted)" }) }}>
                {busy && qty ? "Waiting for Freighter…" : "Buy"}
              </button>
              {bought && <div className="notice ok">Done. Your tokens are in your Stellar wallet. <a href={stellarTxUrl(net, bought)} target="_blank" rel="noreferrer">Transaction ↗</a></div>}
              <small className="muted">{!verified
                ? "Buying unlocks after verification."
                : !sale
                  ? "This offering has no online sale yet; the issuer issues tokens to this wallet when you subscribe."
                  : !sale.open
                    ? (sale.closedByProof ? "The sale is paused while a proof-of-asset check is renewed." : "The sale isn't open right now.")
                    : `You pay in ${sale.payToken.code} from this wallet${sale.payToken.issuer ? ` (it needs a ${sale.payToken.code} trustline)` : ""}; tokens arrive in the same transaction.`}
                {r?.lockupDays ? ` Tokens are locked for ${lockupLabel(r.lockupDays).toLowerCase()} after purchase.` : ""}</small>
              {err && <div className="notice err">{err}</div>}
            </div>
            <p className="disclaimer" style={{ padding: 0 }}>
              {a.formD?.exemptions.length ? <>Offered by the issuer under {exemptionText(a.formD)} (<a href={a.formD.url} target="_blank" rel="noreferrer" style={{ color: "var(--brand)" }}>Form D on file</a>).</> : "Offered by the issuer under its own exemption."} Tokens are only available to verified investors and may be subject to transfer restrictions. Investing involves risk, including loss of principal.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
