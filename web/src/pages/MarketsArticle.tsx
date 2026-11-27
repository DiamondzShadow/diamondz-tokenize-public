// /markets/how-we-use-market-data — editorial article on how live market data reaches each product.
// Every figure is dated (data as of 2026-11-26) and every claim maps to code: cre/asset-feeds/main.ts
// (formulas, freshness + sequencer checks), contracts/src/oracle/CreAssetFeed.sol, api/src/markets.ts.
// Keep the "Where this runs today" section honest when the workflow moves to mainnet.
import { useEffect, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { SiteHeader } from "../lib/Chrome";

const A = ({ href, children }: { href: string; children: ReactNode }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>;

const SOURCES: [string, string, string][] = [
  ["Chainlink Data Feeds", "https://docs.chain.link/data-feeds", "WTI crude, gold, silver, SPY and PCE price feeds on Arbitrum and Base"],
  ["Chainlink L2 Sequencer Uptime Feeds", "https://docs.chain.link/data-feeds/l2-sequencer-feeds", "the uptime check run before every price is used"],
  ["Chainlink Runtime Environment (CRE)", "https://docs.chain.link/cre", "the network that runs our workflow"],
  ["Chainlink SmartData (NAVLink)", "https://docs.chain.link/data-feeds/smartdata", "fund NAV published by the fund's administrator"],
  ["FHFA House Price Index", "https://www.fhfa.gov/data/hpi", "state all-transactions house price indexes"],
  ["FRED, Federal Reserve Bank of St. Louis", "https://fred.stlouisfed.org/series/NYSTHPI", "distribution of the state indexes and the series below"],
  ["Freddie Mac Primary Mortgage Market Survey", "https://www.freddiemac.com/pmms", "30-year fixed mortgage rate (FRED MORTGAGE30US)"],
  ["Federal Reserve Bank of New York, SOFR", "https://www.newyorkfed.org/markets/reference-rates/sofr", "Secured Overnight Financing Rate (FRED SOFR)"],
  ["U.S. Bureau of Economic Analysis, PCE price index", "https://www.bea.gov/data/personal-consumption-expenditures-price-index", "inflation (FRED PCEPI)"],
  ["U.S. Energy Information Administration, WTI spot price", "https://www.eia.gov/dnav/pet/hist/rwtcD.htm", "daily WTI Cushing spot price (FRED DCOILWTICO)"],
  ["Massive", "https://massive.com", "daily closes for the GLD, SLV, SPY and VNQ funds"],
];

export default function MarketsArticle() {
  useEffect(() => { document.title = "How we use live market data · Diamondz Tokenize"; window.scrollTo(0, 0); }, []);
  return (
    <div className="page">
      <SiteHeader />
      <article className="wrap tech-art mk-art">
        <span className="eyebrow">Markets · November 26, 2026</span>
        <h1>Priced by the market, checked on chain: how our products use live market data</h1>
        <p className="tech-lead">A tokenized oil royalty earns more when crude rises. A tokenized building is worth what its local market says. A floating-rate loan pays more when rates climb. Every asset class on Diamondz Tokenize depends on a number someone else publishes, so we read those numbers from the people who publish them, on a schedule, and write them on chain next to the listing.</p>

        <section className="tech-part">
          <h2>Where the numbers come from</h2>
          <p>Commodity, stock-market and inflation prices come from <A href="https://docs.chain.link/data-feeds">Chainlink Data Feeds</A>: WTI crude on Arbitrum, gold, silver and the PCE inflation index on Base, and the SPY S&amp;P 500 fund on Arbitrum. Each feed is a contract that a network of independent Chainlink node operators updates, so anyone can read the same value we read.</p>
          <p>Economic series come from the agencies that produce them, delivered through <A href="https://fred.stlouisfed.org/series/NYSTHPI">FRED</A> at the Federal Reserve Bank of St. Louis: the <A href="https://www.fhfa.gov/data/hpi">FHFA house price index</A> for every state, Freddie Mac's <A href="https://www.freddiemac.com/pmms">30-year mortgage rate</A>, the New York Fed's <A href="https://www.newyorkfed.org/markets/reference-rates/sofr">SOFR</A>, the Bureau of Economic Analysis's <A href="https://www.bea.gov/data/personal-consumption-expenditures-price-index">PCE price index</A> and the Energy Information Administration's <A href="https://www.eia.gov/dnav/pet/hist/rwtcD.htm">WTI spot price</A>. Daily fund prices for gold, silver, the S&amp;P 500 and U.S. real estate investment trusts come from <A href="https://massive.com">Massive</A>.</p>
        </section>

        <section className="tech-part">
          <h2>How a number reaches a listing</h2>
          <p>Every 30 minutes, a workflow runs on the <A href="https://docs.chain.link/cre">Chainlink Runtime Environment</A>. Several Chainlink nodes each fetch the same data on their own, agree on the median, and sign the result. The signed report is delivered to our feed contract through Chainlink's forwarder, which accepts only reports the network signed.</p>
          <p>Two checks run before any price is used. A feed round older than one and a half times its heartbeat is rejected as stale. And because Arbitrum and Base are rollups, the workflow first reads Chainlink's <A href="https://docs.chain.link/data-feeds/l2-sequencer-feeds">sequencer uptime feed</A>: when the sequencer is down, or came back less than an hour ago, the run waits for the next cycle.</p>
        </section>

        <section className="tech-part">
          <h2>What it means for each product</h2>
          <dl className="mk-art-list">
            <dt>Oil and gas royalties</dt>
            <dd>The listing shows WTI crude and an estimated monthly royalty: barrels per day × 30 × the WTI price × the royalty share. Our demo oil listing, Blanket, assumes 120 barrels a day at a 12.5% royalty. At the Chainlink WTI price of $84.02 on November 26, that is an estimated <b>$37,810</b> a month, written on chain at 18:00 UTC.</dd>
            <dt>Real estate</dt>
            <dd>An appraisal is a snapshot. Between appraisals, the listing carries the appraised value forward by the state's FHFA house price index: value × (index today ÷ index at appraisal). Our demo New York listing, drama, was appraised at $100 million when the New York index stood at 1,146.86 (fourth quarter 2025). With the index at 1,202.44 for the third quarter of 2026, the carried-forward value is <b>$104.8 million</b>. The listing also shows the PCE inflation index for context.</dd>
            <dt>Private credit</dt>
            <dd>Floating-rate loans show SOFR and the current rate the borrower pays, SOFR plus the loan's spread. SOFR was 3.94% on November 24.</dd>
            <dt>Private equity</dt>
            <dd>Private companies have no daily price, so the listing shows the public market alongside them: the S&amp;P 500 through the SPY fund, which closed at $716.70 on November 25.</dd>
            <dt>Precious-metal collectibles</dt>
            <dd>Holdings are valued at ounces × the Chainlink gold or silver price. Gold read $3,582.11 an ounce on November 26.</dd>
            <dt>Funds</dt>
            <dd>When a fund's administrator publishes its net asset value through Chainlink <A href="https://docs.chain.link/data-feeds/smartdata">SmartData</A>, the workflow records the NAV per share and signs a NAV check valid for two days.</dd>
            <dt>Carbon credits</dt>
            <dd>The workflow reads the credits the issuer holds on chain and signs a registry check, valid for 30 days, that passes while the holding still covers every tokenized metric ton.</dd>
          </dl>
        </section>

        <section className="tech-part">
          <h2>Which numbers can stop a sale</h2>
          <p>Market prices are context: they show investors how comparable assets are moving. The signed checks are the gate. NAV and registry checks are written into each network's proof-of-asset oracle with an expiry date, and the sale contract reads that oracle before it mints a single token. When a required check fails or expires, new sales pause automatically until a fresh check passes.</p>
        </section>

        <section className="tech-part">
          <h2>The year in numbers</h2>
          <p>As of November 26, 2026, from the charts on our <Link to="/markets">Markets page</Link>:</p>
          <ul className="mk-art-facts">
            <li><b>Oil.</b> WTI traded between $55.44 and $114.58 a barrel over the past year and ended near $82, up 39.8%.</li>
            <li><b>Borrowing.</b> The 30-year mortgage rate rose 0.98 points to 7.21%, while SOFR ended near 3.94%.</li>
            <li><b>Inflation.</b> The PCE price index rose 3.6% from November 2025 to October 2026.</li>
            <li><b>Houses.</b> New York prices rose 5.5% in the year to the third quarter. Nevada fell 7.6%, Washington, D.C. 2.3% and Hawaii 1.1%. California rose 0.6%, and Texas and Florida 1.4% each.</li>
            <li><b>Metals and stocks.</b> The gold fund GLD fell 14.5% and the silver fund SLV 23.3%, while SPY rose 5.4% and the VNQ real estate fund 5.1%.</li>
          </ul>
        </section>

        <section className="tech-part">
          <h2>Where this runs today</h2>
          <p>The workflow has run on the Chainlink Runtime Environment since November 26, 2026. It writes to the Base Sepolia test network for two demo listings, so issuers can see the full flow before going live. Mainnet listings join the workflow as issuers launch them.</p>
          <p><Link className="btn primary" to="/markets">See the live markets</Link></p>
        </section>

        <footer className="tech-foot">
          <span className="eyebrow">Sources</span>
          <ol className="mk-art-sources">
            {SOURCES.map(([name, href, what]) => <li key={href}><A href={href}>{name}</A>: {what}.</li>)}
          </ol>
          <small>Figures are as published by each source on the dates shown and may be revised. Market data is for information only and isn't investment advice. Chainlink, FRED and Massive are trademarks of their respective owners; this article describes how Diamondz Tokenize uses their data.</small>
        </footer>
      </article>
    </div>
  );
}
