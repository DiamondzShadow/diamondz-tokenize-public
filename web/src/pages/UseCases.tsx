// /use-cases and /use-cases/:slug — buyer-type landing pages. Financial institutions = design F1/F2 (approved 2026-11-20,
// canvas HLo8dBdpChx7TBZcvT2D4y); the other six reuse that template (owner: "do the other use cases too").
// Keep every claim true to what ships: proof checks, rules, payouts and the wizard questions come from the product
// (lib/questions.ts, lib/catalog.ts). No invented customers, stats or raise numbers. Update the copy when an
// integration changes (Chainlink CRE deploy access, Mastercard production, card checkout for licenses).
import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { SiteHeader } from "../lib/Chrome";
import { PLANS } from "../lib/pricing";
import { api } from "../lib/api";

interface Check { label: string; source?: string }
interface UseCase {
  slug: string;
  nav: string;             // short name for the index and menus
  eyebrow: string;
  title: string;
  lead: string;
  example: { name: string; terms: string; checks: Check[] };
  pillars: { tag: string; title: string; body: string }[];
  launches: { title: string; body: string }[];
  asks: string[];          // real wizard questions for this buyer's asset class
  faq: { q: string; a: string }[];
  firstAsset: string[];    // options for "What would you tokenize first?"
}

const SHARED_CONTROL = { tag: "Control", title: "Your keys, not ours.", body: "Your multisig is the token's admin, and your own wallet runs it day to day. After setup the platform gives up every role it used, and anyone can check that on chain." };

const CASES: UseCase[] = [
  {
    slug: "financial-institutions",
    nav: "Financial institutions",
    eyebrow: "For banks, wealth and asset managers",
    title: "Put real assets on your shelf. Keep the keys.",
    lead: "Launch tokenized offerings under your own brand. Investors are verified before they can hold. Your rules are enforced by the token itself. Independent proof stands behind every asset. Build it today in a free sandbox, and go live when your counsel signs off.",
    example: {
      name: "Private Credit Note · Series A",
      terms: "Accredited investors · US only · 12-month lockup",
      checks: [{ label: "Loan tape matches the notes" }, { label: "Servicer report current" }, { label: "Supply within cap", source: "Chainlink" }],
    },
    pillars: [
      SHARED_CONTROL,
      { tag: "Proof", title: "Verified, not just described.", body: "Title, valuation, loan tapes and reserves are checked by independent verifiers and recorded on chain in our proof-of-asset oracle, built on Chainlink. If a check lapses, the sale stops on its own." },
      { tag: "Compliance", title: "Rules the token enforces.", body: "Identity, accreditation and sanctions checks happen before anyone can hold. Country limits, holding caps and lockups are enforced in every transfer. The Form D filing is built in." },
    ],
    launches: [
      { title: "Private credit notes", body: "Scheduled interest paid to holders, loan-tape checks, and redemption at maturity." },
      { title: "Real estate funds and SPVs", body: "Rent paid to holders, title and valuation checks, and a resale lockup." },
      { title: "Yield vaults", body: "ERC-4626 shares, with a NAV that updates on chain and redemption windows." },
      { title: "Client-segment sleeves", body: "The same offering, limited by country, accreditation and ticket size." },
    ],
    asks: ["Which countries investors may live in", "Accredited investors only, or not", "Most any one investor may hold", "How long new holders must wait before reselling", "Whether resales need your approval"],
    faq: [
      { q: "Does this fit our existing structure?", a: "Yes. The token represents interests in the SPV, fund or note you already have. Your counsel picks the exemption, and the platform enforces it." },
      { q: "Can we limit an offering to certain clients?", a: "Yes, by country, accreditation, holding cap and lockup. The token checks these on every transfer, not only at sign-up." },
      { q: "Do we need blockchain developers?", a: "No. The platform deploys and configures the contracts. Your team answers questions and signs with the wallets you already control." },
      { q: "Who holds client money?", a: "You do. Sale payments go straight to your treasury account, and the platform never holds them." },
    ],
    firstAsset: ["Private credit", "Real estate", "A fund or vault", "Not sure yet"],
  },
  {
    slug: "real-estate",
    nav: "Real estate sponsors",
    eyebrow: "For real estate sponsors and syndicators",
    title: "Raise for your next property without the spreadsheet cap table.",
    lead: "Put an SPV's units on chain, verify every investor before they can hold, and pay rent to holders in USDC. The appraisal and title are checked before the sale opens, and the cap table keeps itself.",
    example: {
      name: "Elm Street Apartments LLC",
      terms: "LLC membership units · Accredited investors · 12-month lockup",
      checks: [{ label: "Title held by the SPV" }, { label: "Appraisal within 12 months" }, { label: "Supply within cap", source: "Chainlink" }],
    },
    pillars: [
      { tag: "Income", title: "Rent that finds its holders.", body: "Income goes out in USDC to every holder at once. Claiming costs them nothing, and anything left unclaimed for seven days is delivered automatically." },
      { tag: "Proof", title: "The property is checked, not just pictured.", body: "Title and appraisal are checked by independent verifiers before the sale opens. A stale appraisal is flagged to investors, and a lapsed check closes the sale." },
      SHARED_CONTROL,
    ],
    launches: [
      { title: "Single-property SPVs", body: "One building, one LLC, membership units as tokens." },
      { title: "Portfolio funds", body: "Several properties pooled into vault shares with a reported NAV." },
      { title: "Deeds and unique units", body: "One token per unit or deed (ERC-721) for condos and parcels." },
      { title: "Preferred equity", body: "A preferred class on top of your existing common equity." },
    ],
    asks: ["Property address, type, units and occupancy", "Appraised value, appraisal date and mortgage balance", "Yearly net operating income", "The owning company and state of formation", "What each token represents (LLC units, preferred equity…)"],
    faq: [
      { q: "Do investors own the building?", a: "They own interests in the company that holds title, exactly as in a traditional syndication. The token is the record of those interests." },
      { q: "Which documents do we upload?", a: "Title report, appraisal, rent roll and the operating agreement. Investors see what you choose to publish, and each file's fingerprint is recorded on chain." },
      { q: "Can holders sell their units?", a: "Only to other verified investors, and only after the lockup you set. You can also require your approval for every resale." },
      { q: "How is rent paid?", a: "You fund a payout in USDC and every holder receives their share. The platform never holds the money." },
    ],
    firstAsset: ["Multifamily", "Commercial", "Single-family or condos", "Not sure yet"],
  },
  {
    slug: "private-credit-and-funds",
    nav: "Credit and fund managers",
    eyebrow: "For private credit and fund managers",
    title: "Interest on schedule. NAV on chain. Redemptions by the rules.",
    lead: "Issue notes that pay holders on a schedule and redeem at maturity, or vault shares that track your fund's value. Your loan tape and NAV reports are checked before money moves, with safety limits written into the contract.",
    example: {
      name: "SMB Receivables Pool 2027",
      terms: "Senior secured · Monthly interest · Matures Dec 2027",
      checks: [{ label: "Loan tape matches the notes" }, { label: "Servicer report current" }, { label: "Supply within cap", source: "Chainlink" }],
    },
    pillars: [
      { tag: "Credit", title: "Notes that behave like notes.", body: "Interest goes to holders on the schedule you set. At maturity the token stops trading and holders are repaid. You choose what happens if a payment is more than 30 days late." },
      { tag: "Funds", title: "NAV with a seat belt.", body: "ERC-4626 vault shares price the whole pool. Each NAV report is capped by the largest move you allow, so one bad report can't reprice the fund." },
      SHARED_CONTROL,
    ],
    launches: [
      { title: "Loan pools and receivables", body: "Many borrowers, one note, with the loan tape behind it." },
      { title: "Single-loan notes", body: "One borrower, a fixed rate and a maturity date." },
      { title: "Treasury and income funds", body: "Vault shares with a target yield, labeled as a target, never a promise." },
      { title: "Feeder sleeves", body: "A tokenized class of an existing fund, limited to eligible investors." },
    ],
    asks: ["Structure: one loan, a pool or invoices", "Rate paid to holders, how often and from when", "Maturity date and how principal comes back", "Seniority and collateral", "For funds: who reports NAV, the largest move allowed, lockup and notice period"],
    faq: [
      { q: "Who services the loans?", a: "You or your servicer, as today. The platform records the servicer's reports and pays holders from the funds you send." },
      { q: "What happens on a late payment?", a: "Whatever you chose in the wizard: pause resales and tell holders, or tell holders only. The rule is shown to investors before they buy." },
      { q: "Can investors redeem fund shares any time?", a: "Only after the lockup you set and with your notice period. Both are enforced by the vault, not by a policy document." },
      { q: "Where does the NAV come from?", a: "Your fund administrator or manager reports it, and the vault refuses any move larger than the limit you set." },
    ],
    firstAsset: ["A loan pool", "A single note", "A fund or vault", "Not sure yet"],
  },
  {
    slug: "energy-and-commodities",
    nav: "Energy and commodities",
    eyebrow: "For oil, gas and mineral owners",
    title: "Royalties from the ground, paid out like clockwork.",
    lead: "Offer a share of production revenue to verified investors. The reserve report and division orders back every token, Chainlink oil prices feed the checks, and holders are paid monthly or quarterly in USDC.",
    example: {
      name: "Permian Royalty Interest · Unit 3",
      terms: "Net revenue interest · Accredited investors · Monthly payouts",
      checks: [{ label: "Reserve report current" }, { label: "Division orders match the interest" }, { label: "WTI price feed fresh", source: "Chainlink" }],
    },
    pillars: [
      { tag: "Proof", title: "Reserves on the record.", body: "An independent engineer's reserve report and the division orders are checked before the sale opens, with each file's fingerprint recorded on chain." },
      { tag: "Market data", title: "Real oil prices, not guesses.", body: "Our proof oracle reads Chainlink's WTI crude feed. If the market data goes stale, new sales stop until it's fresh again." },
      SHARED_CONTROL,
    ],
    launches: [
      { title: "Royalty interests", body: "A share of production revenue, free of operating costs." },
      { title: "Overriding royalties", body: "Carved out of a working interest, for a set term or for life of the lease." },
      { title: "Mineral rights", body: "Ownership interests in the minerals under a tract." },
      { title: "Warehoused commodities", body: "Metals or other goods held by a custodian, with receipts as proof." },
    ],
    asks: ["What you're selling a share of (royalty, overriding royalty, minerals…)", "Basin, state, wells and operator", "Net revenue interest offered", "Reserve value (PV-10), report date and engineer", "Average monthly revenue and how often holders are paid"],
    faq: [
      { q: "Are royalty interests securities?", a: "Usually, yes. That's why every holder is verified and transfers stay among verified investors. Your counsel picks the exemption." },
      { q: "How do holders get paid?", a: "You fund each payout in USDC from the operator's checks, and every holder receives their share at once." },
      { q: "What do we upload?", a: "The reserve report, division orders or lease, and production history from the state or the operator." },
      { q: "Do you hold the interest?", a: "No. The owning company keeps it, and the token records who owns shares of that company's interest." },
    ],
    firstAsset: ["Royalty interest", "Mineral rights", "Commodities", "Not sure yet"],
  },
  {
    slug: "music-and-film",
    nav: "Music and film",
    eyebrow: "For labels, publishers and studios",
    title: "Your catalog, officially on the record. Your fans, on the cap table.",
    lead: "Register each song or film in our on-chain IP registry with its own page, certificate and license terms. Sell licenses to creators, and let verified investors share in royalties or net revenue.",
    example: {
      name: "Midnight Sessions · Master Recording",
      terms: "40% of master royalties · Accredited investors · Quarterly payouts",
      checks: [{ label: "Chain of title on file" }, { label: "Royalty statements current" }, { label: "Supply within cap", source: "Chainlink" }],
    },
    pillars: [
      { tag: "IP registry", title: "An official record for every work.", body: "Each song, album or film gets an asset record, a public page and a certificate on your offering's network, with its lineage and license terms." },
      { tag: "Licensing", title: "Licenses that pay you back.", body: "Choose the terms: no commercial use, commercial use, or remix with a share of spin-off revenue paid back. Creators buy a license in USDC; card checkout is being switched on." },
      { tag: "Investors", title: "Royalty shares, kept compliant.", body: "Investors hold a verified-only token for their share of royalties or net revenue, and payouts reach every holder at once in USDC." },
    ],
    launches: [
      { title: "Song masters", body: "A share of master-recording royalties from your distributor." },
      { title: "Publishing catalogs", body: "Songwriter and publisher income across many works." },
      { title: "Films and series", body: "Net revenue shared with investors, with recoupment rules up front." },
      { title: "Licensing programs", body: "Standard licenses for creators, with remix shares paid back." },
    ],
    asks: ["Title, artist and which rights (master, publishing or both)", "ISRC or ISWC codes and distributor", "Share of royalties offered and last 12 months' royalties", "For film: format, stage, budget, completion bond and recoupment", "License terms for others and the license fee"],
    faq: [
      { q: "Do I give up my rights?", a: "No. Investors buy a share of income you choose to share. Ownership stays with the rights holder, and the registry shows who owns what." },
      { q: "Why not just sell royalty tokens anyone can trade?", a: "Royalty shares are usually securities. Keeping them verified-only protects you and your fans." },
      { q: "Who can license my work?", a: "Anyone who accepts your terms. You can require licensees to verify their identity first." },
      { q: "What do we upload?", a: "Chain of title and royalty statements for music; for film, copyright registration, rights agreements, E&O insurance and the collection account agreement." },
    ],
    firstAsset: ["A song or album", "A catalog", "A film or series", "Not sure yet"],
  },
  {
    slug: "sports",
    nav: "Teams and athletes",
    eyebrow: "For teams, athletes and their agents",
    title: "Let your fans back your career and share in the upside.",
    lead: "Offer a share of salary, prize money, endorsements or media rights for a set term. Every holder is verified, payouts follow the agreement, and the deal ends on the terms you set in advance.",
    example: {
      name: "Pro Boxer Income Share · 5 years",
      terms: "10% of purses and endorsements · Stops at 3× · Quarterly payouts",
      checks: [{ label: "Contract or tour status on file" }, { label: "Income history verified" }, { label: "Supply within cap", source: "Chainlink" }],
    },
    pillars: [
      { tag: "Fair terms", title: "A deal with an end.", body: "Set the share, the term and a cap: payouts stop once holders have received a multiple of what they paid. Injury and early-retirement rules are written in before anyone buys." },
      { tag: "Fans", title: "Supporters become backers.", body: "Fans can hold a verified share of your income, not just a ticket. Every transfer stays among verified investors." },
      SHARED_CONTROL,
    ],
    launches: [
      { title: "Athlete income shares", body: "A slice of salary, purses or prize money for a set term." },
      { title: "Endorsement pools", body: "A share of sponsorship and endorsement income." },
      { title: "Club and team stakes", body: "Minor-league and independent clubs raising from their community." },
      { title: "Media rights", body: "A share of a team's or event's media income." },
    ],
    asks: ["Athlete or team, sport and league", "Which income: salary, purses, endorsements or media", "Share paid to holders and for how many years", "Last year's income and the payout cap", "What happens on injury or early retirement, and league rules on selling shares"],
    faq: [
      { q: "Is this allowed by my league?", a: "Some leagues restrict selling income shares. The wizard asks, and your counsel should confirm before you go live." },
      { q: "What if I'm injured?", a: "You decide in advance: the deal ends and holders keep what they've received, insurance pays holders, or the term extends. It's shown to investors before they buy." },
      { q: "How do holders get paid?", a: "You fund each payout in USDC on the schedule you set, and every holder receives their share at once." },
      { q: "What do we upload?", a: "Your playing contract or tour status, two years of income statements, the signed income-share agreement and any insurance policy." },
    ],
    firstAsset: ["An athlete", "A team or club", "Media or endorsements", "Not sure yet"],
  },
  {
    slug: "collectibles-and-carbon",
    nav: "Collectibles and carbon",
    eyebrow: "For collectors, custodians and project developers",
    title: "Fractions of rare things. Credits that can only be used once.",
    lead: "Split a cask, a painting or a watch into fixed fractions, held by a named custodian and insured. Or issue a carbon vintage where holders retire credits by burning them, on record for good.",
    example: {
      name: "1998 Speyside Single-Malt Cask",
      terms: "1,000 fractions · Bonded warehouse · Holders vote on buyouts",
      checks: [{ label: "Certificate of authenticity" }, { label: "Custodian receipt current" }, { label: "Supply within cap", source: "Chainlink" }],
    },
    pillars: [
      { tag: "Collectibles", title: "Fixed fractions of one item.", body: "ERC-1155 fractions or a single ERC-721 token, with the custodian, insurance and appraisal shown to every buyer. You set what happens if someone offers to buy the whole item." },
      { tag: "Carbon", title: "Retired means retired.", body: "Each offering is one vintage. Holders retire credits by burning them, so a credit can never be sold twice, and the retirement stays on chain." },
      SHARED_CONTROL,
    ],
    launches: [
      { title: "Wine and spirits casks", body: "Fractions of a cask in a bonded warehouse." },
      { title: "Fine art", body: "A painting or collection held by a gallery or vault." },
      { title: "Watches and memorabilia", body: "Insured items with an expert's report." },
      { title: "Carbon vintages", body: "Credits with registry links and retirement tracking." },
    ],
    asks: ["What the item is and its category", "Appraised value and appraisal date", "Who keeps it and whether it's insured for full value", "What happens if someone offers to buy the whole item", "For carbon: registry, project ID, vintage, serial range and when holders may retire"],
    faq: [
      { q: "Who holds the item?", a: "A custodian you name: a bonded warehouse, a vault or a gallery. Their details are on the listing." },
      { q: "What if a buyer wants the whole item?", a: "You choose in advance: holders vote and the majority decides, you decide and share the proceeds, or it is never sold. It's shown before anyone buys." },
      { q: "How do carbon retirements work?", a: "A holder burns the credits they want to retire. The retirement is recorded on chain and can't be reversed or resold." },
      { q: "What do we upload?", a: "A certificate of authenticity or expert report, the custodian's receipt and the insurance policy." },
    ],
    firstAsset: ["Spirits or wine", "Art", "Carbon credits", "Not sure yet"],
  },
];

const STEPS = [
  { n: "01", title: "Open a sandbox", body: "Sign in with Google or email. You don't need a wallet." },
  { n: "02", title: "Answer the questions", body: "The wizard asks about your asset and sets the right rules." },
  { n: "03", title: "Run a test sale", body: "Verify test investors and let them buy with play money." },
  { n: "04", title: "Go live", body: "Add your counsel's sign-off, your multisig and the fee, then deploy." },
];

const COMPARE: [string, string, string, string][] = [
  ["First test offering", "After the build", "After a demo and onboarding", "Today, in a free sandbox"],
  ["Pricing", "Your engineering budget", "Quote on request", `Published: from $${PLANS[0]!.monthlyUsd}/month`],
  ["Who controls the token", "You", "Often the vendor's admin panel", "Your multisig. We give up every setup role."],
  ["Proof the asset exists", "You build it", "Uploaded PDFs", "Independent verifiers, recorded on chain"],
  ["Token standards", "Whatever you build", "Often one", "6, matched to the asset"],
  ["US securities workflow", "You build it", "Varies", "Reg D 506(c) checks + Form D filing built in"],
];

const FACTS: [string, string][] = [
  ["6", "token standards, including ERC-3643, ERC-4626 and Stellar"],
  ["9", "networks: Ethereum, Base, Arbitrum, Stellar and more"],
  ["10", "asset classes, each with its own questions"],
  ["$0", "to build and test your first offering"],
];

const useTitle = (t: string) => useEffect(() => { document.title = `${t} · Diamondz Tokenize`; window.scrollTo(0, 0); }, [t]);

export function UseCasesIndex() {
  useTitle("Use cases");
  return (
    <div className="page">
      <SiteHeader />
      <main className="wrap uc">
        <section className="uc-hero solo">
          <span className="eyebrow">Use cases</span>
          <h1>Who builds on Diamondz Tokenize</h1>
          <p className="uc-lead">One platform, a different set of questions and rules for each kind of issuer. Pick yours to see what you'd launch first and what the wizard asks.</p>
        </section>
        <div className="uc-index">
          {CASES.map((c) => (
            <Link key={c.slug} to={`/use-cases/${c.slug}`} className="uc-card">
              <span className="eyebrow">{c.nav}</span>
              <b>{c.title}</b>
              <span className="muted">{c.launches.map((l) => l.title).join(" · ")}</span>
              <span className="uc-more">See the use case →</span>
            </Link>
          ))}
        </div>
        <CtaBand />
      </main>
    </div>
  );
}

export default function UseCasePage() {
  const { slug } = useParams();
  const c = CASES.find((x) => x.slug === slug);
  useTitle(c ? `For ${c.nav.toLowerCase()}` : "Use cases");
  if (!c) return <Navigate to="/use-cases" replace />;
  return (
    <div className="page">
      <SiteHeader />
      <main className="wrap uc">
        <section className="uc-hero">
          <div className="uc-hero-copy">
            <span className="eyebrow">{c.eyebrow}</span>
            <h1>{c.title}</h1>
            <p className="uc-lead">{c.lead}</p>
            <div className="row uc-ctas">
              <Link className="btn primary" to="/start">Open a free sandbox</Link>
              <a className="btn ghost" href="#walkthrough">Book a 20-minute walkthrough</a>
            </div>
            <ul className="uc-ticks">
              <li>Every price is public</li><li>No card to start</li><li>Your multisig holds admin</li><li>Asset checks recorded on chain</li>
            </ul>
          </div>
          <aside className="uc-example" aria-label="Example offering">
            <div className="row between"><span className="eyebrow">Example offering</span><span className="uc-open">Sale open</span></div>
            <b className="uc-ex-name">{c.example.name}</b>
            <span className="muted">{c.example.terms}</span>
            <ul className="uc-checks">
              {c.example.checks.map((k) => (
                <li key={k.label}><span>{k.label}{k.source && <i> ({k.source})</i>}</span><em>Passed</em></li>
              ))}
            </ul>
            <small className="muted">If any check lapses, the sale closes on its own until it passes again. Illustration only, not a live offering.</small>
          </aside>
        </section>

        <section className="uc-facts" aria-label="Platform facts">
          {FACTS.map(([b, s]) => <div key={b}><b>{b}</b><span>{s}</span></div>)}
        </section>

        <section className="uc-sec">
          <span className="eyebrow">Why issuers choose us</span>
          <h2>Most platforms ask for a sales call first. We hand you the keys.</h2>
          <div className="uc-table-wrap">
            <table className="uc-table">
              <thead><tr><th scope="col"><span className="sr-only">Compared</span></th><th scope="col">Build in-house</th><th scope="col">Typical white-label vendor</th><th scope="col" className="us">Diamondz Tokenize</th></tr></thead>
              <tbody>{COMPARE.map(([k, a, b, us]) => <tr key={k}><th scope="row">{k}</th><td data-l="Build in-house">{a}</td><td data-l="Typical white-label vendor">{b}</td><td className="us" data-l="Diamondz Tokenize">{us}</td></tr>)}</tbody>
            </table>
          </div>
        </section>

        <section className="uc-pillars">
          {c.pillars.map((p) => (
            <div key={p.tag}><span className="eyebrow">{p.tag}</span><h3>{p.title}</h3><p>{p.body}</p></div>
          ))}
        </section>

        <section className="uc-sec">
          <span className="eyebrow">What you launch first</span>
          <div className="uc-grid4">
            {c.launches.map((l) => <div key={l.title}><b>{l.title}</b><p className="muted">{l.body}</p></div>)}
          </div>
        </section>

        <section className="uc-sec uc-asks">
          <div>
            <span className="eyebrow">The wizard asks</span>
            <h2>Questions written for your asset, not a generic form.</h2>
            <p className="muted">Each answer marked as a rule is written into the token, so it holds on every transfer.</p>
          </div>
          <ol>{c.asks.map((a) => <li key={a}>{a}</li>)}</ol>
        </section>

        <section className="uc-sec">
          <span className="eyebrow">Sandbox to live in four moves</span>
          <div className="uc-grid4">
            {STEPS.map((s) => <div key={s.n}><span className="uc-n">{s.n}</span><b>{s.title}</b><p className="muted">{s.body}</p></div>)}
          </div>
        </section>

        <section className="uc-sec uc-prices">
          <div><h2>Every price on the page.</h2><p className="muted">No “contact sales” wall. Pick a plan when you're ready to go live.</p></div>
          <div className="uc-plans">
            {PLANS.map((p) => (
              <Link key={p.id} to="/pricing" className="uc-plan">
                <span>{p.name}</span><b>${p.monthlyUsd.toLocaleString("en-US")}<small>/mo</small></b>
                <span className="muted">{p.liveOfferings ? `${p.liveOfferings} live offerings` : "Unlimited, your domain"}</span>
              </Link>
            ))}
          </div>
        </section>

        <section className="uc-sec uc-faq-row" id="walkthrough">
          <div className="uc-faq">
            <h2>Questions people ask</h2>
            {c.faq.map((f) => <details key={f.q}><summary>{f.q}</summary><p>{f.a}</p></details>)}
          </div>
          <Walkthrough c={c} />
        </section>

        <CtaBand />
        <p className="uc-legal muted">Diamondz Tokenize is software. It is not a broker-dealer, exchange, transfer agent or investment adviser. Offerings are made by issuers under their own exemptions.</p>
      </main>
    </div>
  );
}

function Walkthrough({ c }: { c: UseCase }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [err, setErr] = useState("");
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setState("sending");
    try {
      await api.demoRequest({
        kind: `walkthrough:${c.slug}`,
        name: String(f.get("name") ?? ""),
        email: String(f.get("email") ?? ""),
        company: String(f.get("company") ?? ""),
        message: `Walkthrough request from the "${c.nav}" use-case page.\nFirst to tokenize: ${String(f.get("first") ?? "")}`,
      });
      setState("sent");
    } catch (x) { setErr((x as Error).message); setState("error"); }
  }
  return (
    <form className="panel uc-form" onSubmit={onSubmit}>
      <h3>Book a 20-minute walkthrough</h3>
      <p className="muted">Four fields. We don't ask for your phone number.</p>
      {state === "sent" ? <div className="notice ok">Thanks, we'll be in touch within one business day.</div> : <>
        <label className="field">Your name<input className="input" name="name" required maxLength={120} autoComplete="name" /></label>
        <label className="field">Work email<input className="input" name="email" type="email" required maxLength={200} autoComplete="email" /></label>
        <label className="field">Company<input className="input" name="company" maxLength={200} autoComplete="organization" /></label>
        <fieldset className="uc-first">
          <legend>What would you tokenize first?</legend>
          {c.firstAsset.map((o, i) => <label key={o}><input type="radio" name="first" value={o} defaultChecked={i === c.firstAsset.length - 1} />{o}</label>)}
        </fieldset>
        {state === "error" && <div className="notice err">{err}</div>}
        <button className="btn primary" disabled={state === "sending"} style={{ justifyContent: "center" }}>{state === "sending" ? "Sending…" : "Book my walkthrough"}</button>
        <small className="muted">Rather explore first? <Link to="/start">Open a free sandbox</Link>.</small>
      </>}
    </form>
  );
}

function CtaBand() {
  return (
    <section className="uc-band">
      <b>Your first tokenized offering, running on a test network today.</b>
      <Link className="btn primary" to="/start">Open a free sandbox</Link>
    </section>
  );
}
