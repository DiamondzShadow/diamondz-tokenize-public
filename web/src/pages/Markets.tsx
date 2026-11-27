// /markets — public market data: live Chainlink prices (the feeds our CRE workflow reads), one-year charts
// (FRED + Massive), and house prices by state (FRED state HPI). Data: GET /api/markets (api/src/markets.ts).
// Charts follow the dataviz rules: one series per chart (small multiples), 2px line, crosshair tooltip,
// diverging blue↔red with a gray midpoint for the state map, and a table view for the map.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { SiteHeader } from "../lib/Chrome";

interface LiveFeed { key: string; label: string; unit: "usd" | "index"; value: number; updatedAt: string; chainId: number; address: string; explorer: string }
interface Series { key: string; label: string; unit: "usd" | "pct" | "index"; source: string; points: [string, number][] }
interface StateHpi { st: string; name: string; index: number; yoyPct: number; quarter: string }
interface Payload { live: LiveFeed[]; series: Series[]; states: StateHpi[]; updatedAt: string }
interface Listing { id: string; name: string; assetClass: string; chainId: number; location?: string }

const NET: Record<number, string> = { 42161: "Arbitrum", 8453: "Base" };
const TRACKED_CLASSES = new Set(["energy", "real-estate", "private-equity", "private-credit", "funds", "collectibles", "carbon"]);
const CLASS_LABEL: Record<string, string> = { energy: "Oil royalty", "real-estate": "Real estate", "private-equity": "Private equity", "private-credit": "Private credit", funds: "Fund", collectibles: "Collectibles", carbon: "Carbon" };

const fmt = (v: number, unit: Series["unit"] | LiveFeed["unit"]) =>
  unit === "usd" ? `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  : unit === "pct" ? `${v.toFixed(2)}%` : v.toLocaleString("en-US", { maximumFractionDigits: 2 });
const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};
const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const quarter = (d: string) => `Q${Math.floor(Number(d.slice(5, 7)) / 3) + 1} ${d.slice(0, 4)}`;

// ---------------------------------------------------------------- line chart (one series)
const W = 320, H = 120, PAD = 6;
function LineChart({ s }: { s: Series }) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const vals = s.points.map((p) => p[1]);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const x = (i: number) => (i / (s.points.length - 1)) * W;
  const y = (v: number) => PAD + (1 - (v - min) / span) * (H - PAD * 2);
  const d = s.points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
  const first = vals[0], last = vals[vals.length - 1];
  const change = s.unit === "pct" ? `${last - first >= 0 ? "+" : ""}${(last - first).toFixed(2)} pts` : `${last >= first ? "+" : ""}${(((last / first) - 1) * 100).toFixed(1)}%`;
  const move = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left) / r.width) * (s.points.length - 1));
    setHover(Math.max(0, Math.min(s.points.length - 1, i)));
  };
  const h = hover ?? null;
  return (
    <figure className="mk-chart">
      <figcaption>
        <span className="mk-label">{s.label}</span>
        <span className="mk-now"><b>{fmt(last, s.unit)}</b> <span className="mk-chg">{change} over the period</span></span>
      </figcaption>
      <div className="mk-plot" onPointerMove={move} onPointerLeave={() => setHover(null)}>
        <span className="mk-y top">{fmt(max, s.unit)}</span>
        <span className="mk-y bot">{fmt(min, s.unit)}</span>
        <svg ref={ref} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${s.label}, ${day(s.points[0][0])} to ${day(s.points[s.points.length - 1][0])}, from ${fmt(first, s.unit)} to ${fmt(last, s.unit)}`}>
          <line x1="0" x2={W} y1={y(min)} y2={y(min)} className="mk-grid" vectorEffect="non-scaling-stroke" />
          <line x1="0" x2={W} y1={y(max)} y2={y(max)} className="mk-grid" vectorEffect="non-scaling-stroke" />
          <path d={d} className="mk-line" vectorEffect="non-scaling-stroke" />
          {h !== null && <line x1={x(h)} x2={x(h)} y1="0" y2={H} className="mk-cross" vectorEffect="non-scaling-stroke" />}
        </svg>
        {h !== null && (
          <>
            <span className="mk-dot" style={{ left: `${(x(h) / W) * 100}%`, top: `${(y(s.points[h][1]) / H) * 100}%` }} />
            <span className={`mk-tip ${h > s.points.length / 2 ? "left" : ""}`} style={{ left: `${(x(h) / W) * 100}%` }}>
              <b>{fmt(s.points[h][1], s.unit)}</b>{day(s.points[h][0])}
            </span>
          </>
        )}
      </div>
      <div className="mk-x"><span>{day(s.points[0][0])}</span><span>{s.source}</span><span>{day(s.points[s.points.length - 1][0])}</span></div>
    </figure>
  );
}

// ---------------------------------------------------------------- state tile map
const TILES: Record<string, [number, number]> = {
  AK: [0, 0], ME: [11, 0], VT: [10, 1], NH: [11, 1],
  WA: [1, 2], ID: [2, 2], MT: [3, 2], ND: [4, 2], MN: [5, 2], IL: [6, 2], WI: [7, 2], MI: [8, 2], NY: [9, 2], RI: [10, 2], MA: [11, 2],
  OR: [1, 3], NV: [2, 3], WY: [3, 3], SD: [4, 3], IA: [5, 3], IN: [6, 3], OH: [7, 3], PA: [8, 3], NJ: [9, 3], CT: [10, 3],
  CA: [1, 4], UT: [2, 4], CO: [3, 4], NE: [4, 4], MO: [5, 4], KY: [6, 4], WV: [7, 4], VA: [8, 4], MD: [9, 4], DE: [10, 4],
  AZ: [2, 5], NM: [3, 5], KS: [4, 5], AR: [5, 5], TN: [6, 5], NC: [7, 5], SC: [8, 5], DC: [9, 5],
  OK: [4, 6], LA: [5, 6], MS: [6, 6], AL: [7, 6], GA: [8, 6],
  HI: [0, 7], TX: [4, 7], FL: [9, 7],
};
const BINS: { cls: string; label: string; test: (v: number) => boolean }[] = [
  { cls: "n2", label: "Down 1% or more", test: (v) => v <= -1 },
  { cls: "n1", label: "Down under 1%", test: (v) => v < -0.25 },
  { cls: "z", label: "About flat", test: (v) => v <= 0.25 },
  { cls: "p1", label: "Up under 3%", test: (v) => v < 3 },
  { cls: "p2", label: "Up 3% or more", test: () => true },
];
const bin = (v: number) => BINS.find((b) => b.test(v))!;
const pct = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;

function StateMap({ states }: { states: StateHpi[] }) {
  const [hover, setHover] = useState<StateHpi | null>(null);
  const [table, setTable] = useState(false);
  const sorted = useMemo(() => [...states].sort((a, b) => b.yoyPct - a.yoyPct), [states]);
  if (!states.length) return null;
  const q = quarter(states[0].quarter);
  return (
    <section className="mk-sec" aria-labelledby="mk-states">
      <div className="mk-sec-head">
        <div>
          <h2 id="mk-states">House prices by state</h2>
          <p className="mk-sub">Change in each state's house price index over the year to {q}. Source: FRED, Federal Reserve Bank of St. Louis (FHFA all-transactions index).</p>
        </div>
        <button className="btn ghost sm" onClick={() => setTable((t) => !t)} aria-pressed={table}>{table ? "Show map" : "Show as table"}</button>
      </div>
      {table ? (
        <div className="mk-table-wrap">
          <table className="mk-table">
            <thead><tr><th>State</th><th>1-year change</th><th>Index</th></tr></thead>
            <tbody>{sorted.map((s) => <tr key={s.st}><td>{s.name}</td><td>{pct(s.yoyPct)}</td><td>{s.index.toLocaleString("en-US")}</td></tr>)}</tbody>
          </table>
        </div>
      ) : (
        <>
          <div className="mk-map" onPointerLeave={() => setHover(null)}>
            {states.map((s) => {
              const t = TILES[s.st];
              if (!t) return null;
              return (
                <button key={s.st} className={`mk-tile ${bin(s.yoyPct).cls} ${hover?.st === s.st ? "on" : ""}`} style={{ gridColumn: t[0] + 1, gridRow: t[1] + 1 }}
                  onPointerEnter={() => setHover(s)} onFocus={() => setHover(s)} aria-label={`${s.name}: ${pct(s.yoyPct)} over the year`}>
                  <b>{s.st}</b><span>{pct(s.yoyPct)}</span>
                </button>
              );
            })}
            <div className="mk-map-tip" aria-live="polite">
              {hover ? <><b>{hover.name}</b> {pct(hover.yoyPct)} over the year · index {hover.index.toLocaleString("en-US")}</> : <span>Point at a state for details</span>}
            </div>
          </div>
          <ul className="mk-legend" aria-label="Legend">
            {BINS.map((b) => <li key={b.cls}><i className={`mk-sw ${b.cls}`} />{b.label}</li>)}
          </ul>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- page
export default function Markets() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState(false);
  const [listings, setListings] = useState<Listing[]>([]);
  useEffect(() => {
    document.title = "Markets · Diamondz Tokenize"; window.scrollTo(0, 0);
    fetch("/api/markets").then((r) => (r.ok ? r.json() : Promise.reject())).then(setData).catch(() => setErr(true));
    fetch("/api/market").then((r) => (r.ok ? r.json() : [])).then((l: Listing[]) => setListings(l.filter((a) => TRACKED_CLASSES.has(a.assetClass)))).catch(() => {});
  }, []);

  return (
    <div className="page">
      <SiteHeader />
      <article className="wrap mk">
        <span className="eyebrow">Markets</span>
        <h1>The market data behind every listing</h1>
        <p className="mk-lead">Our Chainlink workflow reads these prices every 30 minutes and writes them on chain next to the listings they affect. Oil prices feed oil royalty estimates, house prices carry a property's appraisal forward, and stock and metal prices put private assets in context.</p>
        <p className="mk-read"><Link to="/markets/how-we-use-market-data">Read how each product uses this data, with sources →</Link></p>

        {err && <p className="mk-sub">Market data couldn't load right now. Please try again in a minute.</p>}
        {!data && !err && <p className="mk-sub">Loading market data…</p>}

        {data && data.live.length > 0 && (
          <section className="mk-sec" aria-labelledby="mk-live">
            <h2 id="mk-live">Live on Chainlink</h2>
            <p className="mk-sub">Read directly from Chainlink price feeds on Arbitrum and Base, the same feeds our workflow uses.</p>
            <div className="mk-live">
              {data.live.map((f) => (
                <div className="mk-stat" key={f.key}>
                  <span className="mk-label">{f.label}</span>
                  <b>{fmt(f.value, f.unit)}</b>
                  <span className="mk-meta">Updated {ago(f.updatedAt)} · <a href={f.explorer} target="_blank" rel="noreferrer">feed on {NET[f.chainId] ?? "chain"}</a></span>
                </div>
              ))}
            </div>
          </section>
        )}

        {data && data.series.length > 0 && (
          <section className="mk-sec" aria-labelledby="mk-charts">
            <h2 id="mk-charts">The past year</h2>
            <p className="mk-sub">Daily closes and official releases. Point at a chart to read a date.</p>
            <div className="mk-charts">{data.series.map((s) => <LineChart key={s.key} s={s} />)}</div>
          </section>
        )}

        {data && <StateMap states={data.states} />}

        {listings.length > 0 && (
          <section className="mk-sec" aria-labelledby="mk-tracked">
            <h2 id="mk-tracked">Listings this data is written to</h2>
            <p className="mk-sub">Open a listing to see its live market data in the proof panel.</p>
            <div className="mk-listings">
              {listings.map((l) => (
                <Link key={l.id} to={`/market/${l.id}`} className="mk-listing">
                  <span className="mk-badge">Demo · test network</span>
                  <b>{l.name}</b>
                  <span className="mk-meta">{CLASS_LABEL[l.assetClass] ?? l.assetClass}{l.location ? ` · ${l.location}` : ""}</span>
                </Link>
              ))}
            </div>
          </section>
        )}

        <footer className="mk-foot">
          <p>Sources: Chainlink price feeds; FRED, Federal Reserve Bank of St. Louis; Massive. Market data is for information only and isn't investment advice. {data && `Updated ${ago(data.updatedAt)}.`}</p>
          <small>Chainlink is a trademark of its owner. This page describes how Diamondz Tokenize uses Chainlink technology.</small>
        </footer>
      </article>
    </div>
  );
}
