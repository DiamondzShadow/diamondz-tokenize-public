// /technology — "Thinking outside the box" (design G2, approved 2026-11-18): the unexpected job we gave each technology
// partner's product. Statuses must stay honest: update a section's `status` when that integration changes.
// Logos: Chainlink (owner has authorization), Temporal, MongoDB, USDC (Circle brand kit, used as provided).
// Mastercard, Sumsub and thirdweb stay as text until we have permission to use their logos.
import { Fragment, useEffect, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { SiteHeader } from "../lib/Chrome";

type Tone = "ok" | "warn";
interface Part { id: string; name: string; logo?: string; status: [Tone, string]; title: string; body: ReactNode[] }

const PARTS: Part[] = [
  {
    id: "chainlink", name: "Chainlink", logo: "chainlink", status: ["warn", "Workflows deployed on Chainlink CRE · receivers live on test networks · badges approved"],
    title: "Chainlink: a price feed that can stop a sale",
    body: [
      <>Most apps use oracles to <i>show</i> a price. We use them to <i>enforce</i> one. A Chainlink Runtime Environment workflow reads what each asset depends on (Chainlink feeds for WTI crude, the S&amp;P 500, gold, silver and inflation, the New York Fed's SOFR rate, royalty vaults and carbon registries) and signs the results into our proof-of-asset oracle through Chainlink's own ReceiverTemplate.</>,
      <>The sale contract reads that oracle before it mints a single token. If the data goes stale or a check fails, new sales stop on their own. Nobody has to notice; the market data <i>is</i> the compliance gate. Our listings carry the official “Market Data secured with Chainlink” badge, and our cross-chain bridge carries the CCIP badge.</>,
    ],
  },
  {
    id: "temporal", name: "Temporal", logo: "temporal", status: ["ok", "Live in production"],
    title: "Temporal: money that can't be sent twice",
    body: [
      <>Paying hundreds of token holders is the moment a platform can't afford a glitch. A server restart in the middle of a payout must not pay anyone twice, or skip anyone. So every job that moves money or checks the truth runs as a Temporal schedule: payout delivery, proof refreshes, the monthly bank check, accreditation reports and the daily sanctions-list reload.</>,
      <>Temporal guarantees each run happens once per schedule, with retries and a full history, no matter how many servers are online. We spent zero lines of code on locks and duplicate detection, and gained an audit trail for every cent.</>,
    ],
  },
  {
    id: "mastercard", name: "Mastercard", status: ["warn", "Sandbox · production needs a Mastercard agreement"],
    title: "Mastercard Open Finance: rent proven by the bank, not a spreadsheet",
    body: [
      <>An issuer saying “the property earned $40,000 this month” is a claim. The SPV's bank account receiving $40,000 is a fact. The issuer links the operating account once; every month we read the deposits through Mastercard Open Finance, leave out transfers between the SPV's own accounts, and sign the income check on chain only if the money really arrived.</>,
      <>The same service checks accredited investors without us ever seeing a bank statement: Mastercard prepares the income or asset report under the investor's consent, and we keep a numbers-only summary.</>,
    ],
  },
  {
    id: "sumsub", name: "Sumsub", status: ["warn", "Built and tested in Sumsub's sandbox · switching on soon"],
    title: "Sumsub: verify people without keeping their passports",
    body: [
      <>Securities law requires issuers to know their investors, and that usually means a platform sitting on a vault of passports and selfies. We designed the opposite. Investors photograph their ID and record a short selfie video inside Sumsub's window on the offering page; Sumsub checks them; we receive only the result and a reference number.</>,
      <>Each check belongs to the issuer, not to us, so one verification covers all of that issuer's offerings, and the issuer reviews details in Sumsub when it needs to. Results arrive by signed webhook and are always re-read from Sumsub's own record, so a forged message can't approve anyone.</>,
    ],
  },
  {
    id: "thirdweb", name: "thirdweb", status: ["ok", "Live in production"],
    title: "thirdweb: crypto infrastructure that stays out of sight",
    body: [
      <>Our investors use thirdweb wallets they can open with an email or a Google account, with gas sponsored on supported networks. For issuers we went a step further: they sign up with Google, Apple or an email code, and never see a wallet at all.</>,
      <>Behind the scenes the login's account signs a one-time message that our server verifies, so we store no passwords and need no secret keys to trust a sign-in. A real-estate manager gets a free workspace in under a minute, and the blockchain stays invisible until the moment they deploy.</>,
    ],
  },
  {
    id: "mongodb", name: "MongoDB", logo: "mongodb", status: ["ok", "Live in production"],
    title: "MongoDB Atlas: one database, every issuer, nothing mixed up",
    body: [
      <>One codebase now serves white-label platforms on their own domains and self-serve issuers who signed up five minutes ago. A dedicated Atlas cluster holds all of it: offerings, workspaces, payouts, identity and accreditation records, each kept to its own issuer.</>,
      <>Every storage call goes through one interface with two backends, and a contract test runs the same scenario against Atlas and a local database, requiring identical answers, 47 of them at last count. What we test is what runs.</>,
    ],
  },
  {
    id: "usdc", name: "USDC", logo: "usdc", status: ["ok", "Live on test networks"],
    title: "Circle USDC: income that finds its holders",
    body: [
      <>Investors buy with USDC, and income reaches them in USDC through Merkle distributions. Claiming costs holders nothing, and any payout left unclaimed for seven days is delivered to them automatically. Income shouldn't depend on someone remembering to click.</>,
    ],
  },
];

export default function Technology() {
  useEffect(() => { document.title = "Technology · Diamondz Tokenize"; window.scrollTo(0, 0); }, []);
  return (
    <div className="page">
      <SiteHeader />
      <article className="wrap tech-art">
        <span className="eyebrow">Technology · November 2026</span>
        <h1>Thinking outside the box: how we put great infrastructure to unexpected work</h1>
        <p className="tech-lead">Tokenizing a real asset is easy. Proving it's real, paying it on time and keeping investors' private data private is the hard part. We didn't build that alone. Here is the unusual job we gave each technology partner's product, and why it worked.</p>
        <div className="tech-facts">
          <div><b>0</b><span>passports, selfies or bank logins stored by the platform</span></div>
          <div><b>0</b><span>passwords or wallets needed to sign up as an issuer</span></div>
          <div><b>1×</b><span>every payout runs exactly once, however many servers are up</span></div>
        </div>

        {PARTS.map((p) => (
          <Fragment key={p.id}>
          {p.id === "thirdweb" && (
            <figure className="tech-quote">
              <blockquote>“Every company on this page built something excellent. Our job was to ask, ‘What else could this do?’ A price feed that stops a sale. A payment schedule that can't pay twice. That's where the platform came from.”</blockquote>
              <figcaption>Yakini Crews, CEO and Developer, Diamondz</figcaption>
            </figure>
          )}
          <section id={p.id} className="tech-part" aria-labelledby={`${p.id}-h`}>
            <div className="tech-bar">
              {p.logo ? (
                <span className="tech-logo">
                  <img className="tl-light" src={`/logos/${p.logo}.svg`} alt={p.name} />
                  <img className="tl-dark" src={`/logos/${p.logo}-white.svg`} alt={p.name} />
                </span>
              ) : <span className="tech-word">{p.name}</span>}
              <span className={`tech-status ${p.status[0]}`}>{p.status[1]}</span>
            </div>
            <h2 id={`${p.id}-h`}>{p.title}</h2>
            {p.body.map((b, i) => <p key={i}>{b}</p>)}
          </section>
          </Fragment>
        ))}

        <section className="tech-part" aria-labelledby="sec-h">
          <h2 id="sec-h">And straight from the SEC</h2>
          <p>Issuers attach their Form D read directly from the SEC's EDGAR system, so the listing shows the exemption, filing date and a link to SEC.gov, next to a plain statement that the SEC doesn't review or approve offerings.</p>
        </section>

        <footer className="tech-about">
          <span className="eyebrow">About Diamondz Tokenize</span>
          <p>Diamondz Tokenize, by Shadow Diamondz Development, Inc., is software for structuring, issuing and servicing tokenized real-world assets. It is not a broker-dealer, exchange, transfer agent or investment adviser. Offerings are made by issuers under their own exemptions.</p>
          <small>Chainlink, Temporal, Mastercard, Sumsub, thirdweb, MongoDB, Atlas, Circle and USDC are trademarks of their respective owners. This article describes how Diamondz Tokenize uses their technology.</small>
          <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
            <Link className="btn primary" to="/start">Start free</Link>
            <Link className="btn ghost" to="/#contact">Press and partnership inquiries</Link>
          </div>
        </footer>
      </article>
    </div>
  );
}
