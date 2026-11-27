// Home — approved light-institutional design D1 (canvas Bzws9rhX8gBzhFXW8pV2eW) + purposeful motion:
// live hero panel (a real listed offering + its on-chain proof), slow Ken Burns on its photo, scroll reveals,
// count-up on the live numbers, and an invest calculator that uses the offering's real price and supply.
// Everything honours prefers-reduced-motion (CSS + the hooks below). No invented numbers: when nothing is listed
// the panels fall back to explanatory copy, never sample data.
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { PLANS, planById } from "../lib/pricing";
import { SiteHeader } from "../lib/Chrome";
import { ASSET_CLASSES, STANDARDS, assetClassById, type AssetClassId } from "../lib/catalog";
import { api, type MarketAsset, type Proof } from "../lib/api";
import { networkById } from "../lib/chains";
import { useProof } from "../lib/Proof";
import { useTenant } from "../lib/tenant";
import BuiltOn from "../lib/BuiltOn";
import Different from "../lib/Different";
import MarketsStrip from "../lib/MarketsStrip";

const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
const reduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const usd = (n: number, max = 0) => n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: max });

/** The platform mark (logo direction A, approved 2026-11-18): a diamond cut into four equal shares, one lighter —
 *  an asset split into tokens. Drawn in the tenant's brand color so white-label tenants without a logo still match. */
export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg className="mark-a" viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
      <polygon className="f" points="24,3.5 33.5,13 24,22.5 14.5,13" />
      <polygon className="f" points="35,14.5 44.5,24 35,33.5 25.5,24" />
      <polygon className="f" points="24,25.5 33.5,35 24,44.5 14.5,35" />
      <polygon className="s" points="13,14.5 22.5,24 13,33.5 3.5,24" />
    </svg>
  );
}

export function Logo({ name, logoUrl }: { name: string; logoUrl?: string }) {
  const platform = !logoUrl && name === "Diamondz Tokenize";
  return (
    <div className="logo">
      {logoUrl ? <img src={logoUrl} alt="" width={28} height={28} style={{ borderRadius: 8 }} /> : <Mark />}
      {platform ? <span className="wm"><b>Diamondz</b><span>Tokenize</span></span> : name}
    </div>
  );
}

/** Adds .in to every .rv inside the page once it scrolls into view (once). */
function useReveal() {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>(".home .rv"));
    if (reduced() || !("IntersectionObserver" in window)) {
      els.forEach((e) => e.classList.add("in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && (e.target.classList.add("in"), io.unobserve(e.target))),
      { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  });
}

/** Counts from 0 to `to` once it's on screen. */
function CountUp({ to, format }: { to: number; format: (n: number) => string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [v, setV] = useState(reduced() ? to : 0);
  useEffect(() => {
    if (reduced()) return setV(to);
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      const t0 = performance.now();
      const step = (t: number) => {
        const k = Math.min(1, (t - t0) / 900);
        setV(to * (1 - Math.pow(1 - k, 3)));
        if (k < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    });
    io.observe(el);
    return () => (io.disconnect(), cancelAnimationFrame(raf));
  }, [to]);
  return <span ref={ref}>{format(v)}</span>;
}

/** Picks the offering to feature: a verified one first, else any listed one. */
function useFeatured() {
  const [list, setList] = useState<MarketAsset[] | null>(null);
  useEffect(() => {
    api.market().then(setList, () => setList([]));
  }, []);
  const [verified, setVerified] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!list?.length) return;
    let live = true;
    Promise.all(list.slice(0, 6).map((a) => api.proof(a.id).then((p) => [a.id, p.verified] as const, () => [a.id, false] as const))).then(
      (r) => live && setVerified(Object.fromEntries(r)),
    );
    return () => void (live = false);
  }, [list]);
  const featured = useMemo(() => {
    if (!list?.length) return null;
    return list.find((a) => verified[a.id] && a.imageUrl) ?? list.find((a) => verified[a.id]) ?? list.find((a) => a.imageUrl) ?? list[0];
  }, [list, verified]);
  return { list, featured };
}

const STATUS_TEXT: Record<string, [string, string]> = {
  current: ["ok", "Current"],
  expiring: ["warn", "Expiring"],
  expired: ["warn", "Expired"],
  failed: ["bad", "Failed"],
  missing: ["no", "Not signed"],
  "verifier-removed": ["warn", "Verifier removed"],
};

function HeroPanel({ asset, proof }: { asset: MarketAsset | null | undefined; proof: Proof | null }) {
  if (asset === undefined) return <div className="hp hp-skel" aria-hidden="true" />;
  if (!asset)
    return (
      <div className="hp hp-empty">
        <span className="kicker">Live offerings</span>
        <p className="body">Offerings appear here as soon as an issuer lists one. Every listing shows its independent checks and its sale status in real time.</p>
        <Link to="/market" className="btn link">Browse the marketplace →</Link>
      </div>
    );
  const net = networkById(asset.chainId);
  const cls = assetClassById(asset.assetClass);
  const saleOpen = proof ? proof.verified || !proof.gated : null;
  return (
    <Link to={`/market/${asset.id}`} className="hp" aria-label={`${asset.name}, view offering`}>
      <div className="hp-img">
        {asset.imageUrl ? <img src={asset.imageUrl} alt="" /> : <div className="hp-noimg" />}
        <span className="hp-live"><i />Live from chain</span>
      </div>
      <div className="hp-body">
        <div className="row between">
          <div>
            <b className="hp-name">{asset.name}</b>
            <span className="small">{[cls?.name, asset.location].filter(Boolean).join(" · ")}</span>
          </div>
          {net?.testnet && <span className="demo-badge" title="Demo listing on a test network: test tokens, no real money">Demo</span>}
        </div>
        <div className="hp-kv">
          <div><span>Price per token</span><b>{usd(Number(asset.pricePerToken), 2)}</b></div>
          <div><span>Minimum</span><b>{usd(Number(asset.minInvestment))}</b></div>
          <div><span>Distributions</span><b>{asset.schedule || "—"}</b></div>
        </div>
        <ul className="hp-checks" aria-label="Independent checks">
          {proof === null && <li className="small">Reading checks from chain…</li>}
          {proof?.checks.map((c, i) => {
            const [k, t] = STATUS_TEXT[c.status] ?? ["no", c.status];
            return (
              <li key={c.kind} style={{ animationDelay: `${300 + i * 140}ms` }}>
                <span>{c.name}</span>
                <span className={`status ${k}`}>{t}</span>
              </li>
            );
          })}
          {proof && (
            <li className="hp-sale" style={{ animationDelay: `${300 + proof.checks.length * 140}ms` }}>
              <span>Sale</span>
              <span className={`status ${saleOpen ? "ok" : "warn"}`}>{saleOpen ? "Open" : "Paused until checks pass"}</span>
            </li>
          )}
        </ul>
      </div>
    </Link>
  );
}

function Calculator({ asset }: { asset: MarketAsset }) {
  const price = Number(asset.pricePerToken) || 0;
  const min = Math.max(Number(asset.minInvestment) || price, price);
  const supply = Number(asset.totalSupply) || 0;
  const max = Math.max(min * 50, 5000);
  const [amt, setAmt] = useState(Math.min(Math.max(min * 10, 500), max));
  const tokens = price ? Math.floor(amt / price) : 0;
  const share = supply ? (tokens / supply) * 100 : 0;
  const per100k = supply ? (tokens / supply) * 100_000 : 0;
  return (
    <div className="calc panel">
      <div className="row between" style={{ alignItems: "baseline" }}>
        <label htmlFor="calc-amt" className="kicker">If you invest</label>
        <b className="calc-amt">{usd(amt)}</b>
      </div>
      <input
        id="calc-amt"
        type="range"
        min={min}
        max={max}
        step={price >= 1 ? Math.max(price, 10) : 10}
        value={amt}
        onChange={(e) => setAmt(Number(e.target.value))}
        style={{ ["--p" as string]: `${((amt - min) / (max - min)) * 100}%` }}
      />
      <div className="row between small"><span>{usd(min)} minimum</span><span>{usd(max)}</span></div>
      <div className="calc-out">
        <div><span>Tokens</span><b>{tokens.toLocaleString()}</b></div>
        <div><span>Share of {asset.name}</span><b>{share < 0.001 ? share.toExponential(1) : share.toFixed(share < 1 ? 3 : 2)}%</b></div>
        <div><span>Of every $100,000 paid out</span><b>{usd(per100k, 2)}</b></div>
      </div>
      <p className="small">
        Uses {asset.name}'s listed price ({usd(price, 2)}) and supply ({supply.toLocaleString()} tokens). Payouts depend on what the asset
        earns and are not guaranteed.
      </p>
    </div>
  );
}

function Section({ id, kicker, title, children, aside }: { id?: string; kicker: string; title: ReactNode; children?: ReactNode; aside: ReactNode }) {
  return (
    <section className="rule" id={id}>
      <div className="wrap hsec">
        <div className="split">
          <div className="split-l rv">
            <span className="kicker">{kicker}</span>
            <h2 className="h2">{title}</h2>
            {children}
          </div>
          <div className="rv rv-d1">{aside}</div>
        </div>
      </div>
    </section>
  );
}

export default function Landing() {
  const { tenant } = useTenant();
  const isPlatform = !tenant || tenant.id === "diamondz";
  const name = tenant?.name ?? "Diamondz Tokenize";
  const classes = ASSET_CLASSES.filter((c) => !tenant || tenant.offerings.includes(c.id));
  const { list, featured } = useFeatured();
  const proof = useProof(featured?.id, 60_000);
  const [hovered, setHovered] = useState<AssetClassId | null>(null);
  useReveal();

  const live = (list ?? []).length;
  const verifiedCount = proof?.verified ? 1 : 0;

  return (
    <div className="page home">
      <SiteHeader
        links={isPlatform ? undefined : <>
          <Link to="/market">Offerings</Link>
          <a onClick={() => scrollTo("how")}>How it works</a>
          <a onClick={() => scrollTo("proof")}>Proof of asset</a>
          <Link to="/pricing">Pricing</Link>
          <Link to="/portfolio">Your income</Link>
        </>}
        actions={isPlatform ? undefined : <>
          <Link className="btn ghost sm" to="/app">Sign in</Link>
          <a className="btn primary sm" onClick={() => scrollTo("contact")}>Book a call</a>
        </>}
      />

      <header className="wrap hhero">
        <div className="hhero-copy">
          <h1 className="display hl">
            {(isPlatform ? ["Tokenized real assets,", "run under your name."] : ["Own a share of real assets.", "Get paid on chain."]).map((l, i) => (
              <span key={i} className="hl-line" style={{ animationDelay: `${i * 120}ms` }}>{l}</span>
            ))}
          </h1>
          <p className="lead fade-up" style={{ animationDelay: "260ms" }}>
            {isPlatform
              ? "Structure an offering, verify investors, issue the token and pay holders, from one platform you can run as your own. Real estate, energy, private credit, funds and royalties."
              : `${name} lets verified investors own a share of real assets, check the independent proof behind each one, and receive their income on chain.`}
          </p>
          {isPlatform ? (
            // Two doors (design S1): issuers sign up; investors never need an account.
            <div className="doors fade-up" style={{ animationDelay: "380ms" }}>
              <Link to="/start" className="door main">
                <span className="kicker">For companies and issuers</span>
                <b>Tokenize an asset</b>
                <span>Free account with Google or email. Demo offerings on test networks, with 14 days of Growth features. No wallet needed.</span>
                <span className="btn primary sm">Start free</span>
              </Link>
              <Link to="/market" className="door">
                <span className="kicker">For investors</span>
                <b>Invest in an offering</b>
                <span>No account to create: connect a wallet on the offering you want and verify yourself there.</span>
                <span className="btn ghost sm">Browse offerings</span>
              </Link>
            </div>
          ) : (
            <div className="row fade-up" style={{ gap: 20, animationDelay: "380ms", flexWrap: "wrap" }}>
              <Link className="btn primary" to="/market">View offerings</Link>
              <Link className="btn link" to="/market">How payouts work →</Link>
            </div>
          )}
        </div>
        <div className="fade-up" style={{ animationDelay: "200ms" }}>
          <HeroPanel asset={list === null ? undefined : featured} proof={proof} />
        </div>
      </header>

      <section className="wrap hclasses">
        <div className="cols c4">
          {classes.slice(0, 8).map((c, i) => (
            <Link
              to="/market"
              key={c.id}
              className={`item rv ${hovered && hovered !== c.id ? "dim" : ""}`}
              style={{ transitionDelay: `${(i % 4) * 70}ms` }}
              onMouseEnter={() => setHovered(c.id)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(c.id)}
              onBlur={() => setHovered(null)}
            >
              <b>{c.name}</b>
              <span className="small">{c.blurb}</span>
            </Link>
          ))}
        </div>
      </section>

      <Section
        id="how"
        kicker="How it works"
        title="From asset to investor, with every step on the record."
        aside={
          <ol className="cols c2 steps4">
            {[
              ["Structure", "Choose the asset class, legal wrapper and offering exemption, and upload the documents."],
              ["Verify", "Investors pass identity, accreditation and sanctions checks once. No personal data goes on chain."],
              ["Issue", "Deploy the token and sale from your own wallet. Admin control passes to your multisig."],
              ["Pay holders", "Rent, royalties and interest go to holders pro rata. Claiming is free for them."],
            ].map(([t, d], i) => (
              <li className="item rv" key={t} style={{ transitionDelay: `${i * 90}ms` }}>
                <span className="n">0{i + 1}</span>
                <b>{t}</b>
                <span className="small">{d}</span>
              </li>
            ))}
          </ol>
        }
      />

      {isPlatform && (
        <Section
          id="markets"
          kicker="Markets"
          title="Every listing, priced by the market it lives in."
          aside={<MarketsStrip />}
        >
          <p className="body">Every 30 minutes, a Chainlink workflow reads oil, gold, silver, stock-market and inflation prices, plus house prices for every state, and writes them on chain next to the listings they affect. Oil royalties show estimated income at today's crude price, and buildings carry their appraisal forward with the local house price index.</p>
          <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
            <Link to="/markets" className="btn link">See live markets →</Link>
            <Link to="/markets/how-we-use-market-data" className="btn link">Read the article →</Link>
          </div>
        </Section>
      )}

      <Section
        id="proof"
        kicker="Proof of asset"
        title="Independent verification, not marketing."
        aside={
          featured && proof ? (
            <div className="panel proof-live">
              <div className="row between" style={{ marginBottom: 4 }}>
                <span className="small">{featured.name} · checked {new Date(proof.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                <span className={`status ${proof.verified ? "ok" : "warn"}`}>{proof.verified ? "Verified" : "Not verified"}</span>
              </div>
              {proof.checks.map((c) => {
                const [k, t] = STATUS_TEXT[c.status] ?? ["no", c.status];
                return (
                  <div className="kv" key={c.kind} title={c.confirms}>
                    <span>{c.name}{c.verifier ? <em className="by"> · signed by {c.verifier.name}</em> : null}</span>
                    <span className={`status ${k}`}>{t}</span>
                  </div>
                );
              })}
              <div className="kv"><span>Sale</span><span>{proof.verified || !proof.gated ? "Open while all checks are current" : "Paused until every check passes"}</span></div>
              <Link to={`/market/${featured.id}`} className="btn link" style={{ marginTop: 12 }}>See the evidence →</Link>
            </div>
          ) : (
            <div className="panel proof-live">
              <div className="kv"><span>Title &amp; ownership</span><span className="small">Signed by a title company or counsel</span></div>
              <div className="kv"><span>Independent valuation</span><span className="small">Signed by an appraiser or auditor</span></div>
              <div className="kv"><span>Insurance in force</span><span className="small">Signed by the insurer or broker</span></div>
              <div className="kv"><span>Sale</span><span>Open while all checks are current</span></div>
            </div>
          )
        }
      >
        <p className="body">
          Title companies, appraisers, insurers and custodians sign their checks on chain. If a check lapses or fails, sales stop until it is
          fixed. Live market data comes through Chainlink.
        </p>
        {live > 0 && (
          <div className="mini-stats">
            <div><b><CountUp to={live} format={(n) => Math.round(n).toString()} /></b><span>listed offerings</span></div>
            <div><b><CountUp to={proof?.checks.filter((c) => c.status === "current").length ?? 0} format={(n) => Math.round(n).toString()} /></b><span>current checks on {featured?.name}</span></div>
            {verifiedCount > 0 && <div><b>Live</b><span>read from chain every minute</span></div>}
          </div>
        )}
      </Section>

      {featured && Number(featured.pricePerToken) > 0 && Number(featured.totalSupply) > 0 && (
        <Section
          id="calculator"
          kicker="For investors"
          title="See exactly what your money buys."
          aside={<Calculator asset={featured} />}
        >
          <p className="body">Every offering lists its price per token and total supply, so your share of each payout is simple arithmetic, not a projection.</p>
          <Link to="/market" className="btn link">Browse offerings →</Link>
        </Section>
      )}

      {isPlatform && (
        <Section
          id="white-label"
          kicker="For issuers and platforms"
          title="Your domain, your brand, the same infrastructure."
          aside={
            <table className="table" aria-label="Token standards by asset">
              <thead><tr><th>Token</th><th>Best for</th><th>Status</th></tr></thead>
              <tbody>
                {STANDARDS.map((s) => (
                  <tr key={s.id}>
                    <td>{s.name}</td>
                    <td className="small">{s.bestFor}</td>
                    <td>{s.available ? <span className="status ok">Available</span> : <span className="status no">Coming</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          }
        >
          <p className="body">Run the investor site on your own domain with your logo and colors, the asset classes and networks you choose, and your own compliance accounts.</p>
          <Link to="/pricing" className="btn link">See pricing →</Link>
        </Section>
      )}

      <section className="rule" id="contact">
        <div className="wrap hsec">
          <div className="split">
            <div className="split-l rv">
              <span className="kicker">Talk to us</span>
              <h2 className="h2">Practice on a test network for free. Go live when your counsel is ready.</h2>
              <Link className="btn primary" to="/app" style={{ alignSelf: "flex-start", marginTop: 8 }}>Open the console</Link>
            </div>
            <div className="rv rv-d1"><ContactForm kind={isPlatform ? "platform" : `tenant:${tenant?.id}`} /></div>
          </div>
        </div>
      </section>

      <Different />
      <BuiltOn />

      <footer className="hfoot">
        <div className="wrap">
          <div className="row between" style={{ flexWrap: "wrap", gap: 12 }}>
            <span>© {new Date().getFullYear()} {name}{tenant?.poweredBy !== false && !isPlatform ? " · Powered by Diamondz Tokenize" : ""}</span>
            <nav className="legal-links" aria-label="Legal">{isPlatform && <><Link to="/use-cases">Use cases</Link><Link to="/technology">Technology</Link></>}<Link to="/legal/terms">Terms</Link><Link to="/legal/privacy">Privacy</Link><Link to="/legal/risk">Risk disclosures</Link></nav>
          </div>
          <p>
            {name} is software. It is not a broker-dealer, exchange, transfer agent or investment adviser. Offerings are made by issuers under
            their own exemptions; secondary trading of securities is available only through licensed partners where permitted.
          </p>
        </div>
      </footer>
    </div>
  );
}

function ContactForm({ kind }: { kind: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [err, setErr] = useState("");
  // Arriving from a pricing card (/?plan=growth&billing=yearly#contact): scroll here and carry the choice into the message.
  const { search, hash } = useLocation();
  const q = new URLSearchParams(search);
  const chosen = PLANS.some((p) => p.id === q.get("plan")) ? planById(q.get("plan")!) : null;
  const yearly = q.get("billing") === "yearly";
  const [plan, setPlan] = useState(chosen);
  useEffect(() => {
    if (hash !== "#contact") return;
    // The page above the form is still loading (offerings, images) and grows; re-aim a few times, stop once the visitor scrolls.
    let moved = false;
    const stop = () => { moved = true; };
    window.addEventListener("wheel", stop, { once: true });
    window.addEventListener("touchstart", stop, { once: true });
    const go = () => { if (!moved) document.getElementById("contact")?.scrollIntoView({ block: "start" }); };
    const timers = [60, 400, 1000, 1800].map((ms) => setTimeout(go, ms));
    return () => { timers.forEach(clearTimeout); window.removeEventListener("wheel", stop); window.removeEventListener("touchstart", stop); };
  }, [hash, search]);
  useEffect(() => setPlan(chosen), [search]); // eslint-disable-line react-hooks/exhaustive-deps

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setState("sending");
    try {
      await api.demoRequest({
        kind,
        name: String(f.get("name") ?? ""),
        email: String(f.get("email") ?? ""),
        company: String(f.get("company") ?? ""),
        message: [plan ? `Plan: ${plan.name}, billed ${yearly ? "yearly" : "monthly"}.` : "", String(f.get("message") ?? "")].filter(Boolean).join("\n\n"),
      });
      setState("sent");
    } catch (x) {
      setErr((x as Error).message);
      setState("error");
    }
  }

  if (state === "sent") return <div className="notice ok">Thanks, we'll be in touch within one business day.</div>;

  return (
    <form onSubmit={onSubmit} className="panel" style={{ width: "100%", textAlign: "left" }}>
      {plan && (
        <div className="plan-pick">
          <span>Plan: <b>{plan.name}</b>, billed {yearly ? "yearly" : "monthly"}</span>
          <Link to="/pricing">Change</Link>
          <button type="button" onClick={() => setPlan(null)}>Remove</button>
        </div>
      )}
      <div className="form3" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <label className="field">Name<input className="input" name="name" required maxLength={120} /></label>
        <label className="field">Work email<input className="input" name="email" type="email" required maxLength={200} /></label>
      </div>
      <label className="field">Company<input className="input" name="company" maxLength={200} /></label>
      <label className="field">What do you want to tokenize?<textarea className="input" name="message" rows={3} maxLength={2000} /></label>
      {state === "error" && <div className="notice err">{err}</div>}
      <button className="btn primary" disabled={state === "sending"} style={{ justifyContent: "center" }}>
        {state === "sending" ? "Sending…" : "Book a call"}
      </button>
    </form>
  );
}
