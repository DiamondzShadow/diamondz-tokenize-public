// GET /markets — public market data for the /markets page.
//  • live: the same Chainlink price feeds our CRE workflow reads (latestRoundData over the server RPC, Uniblock).
//  • series: one year of history for charts — FRED public CSV (keyless) and Massive daily closes (MASSIVE_API_KEY).
//  • states: house price index for every state from FRED ({ST}STHPI), latest quarter vs a year earlier.
// Everything is cached in memory; a failed refresh keeps serving the last good copy.
import type { Hono } from "hono";
import { createPublicClient, http, type Address } from "viem";
import { networkById, rpcUrl } from "./chains";

export interface LiveFeed { key: string; label: string; unit: "usd" | "index"; value: number; updatedAt: string; chainId: number; address: string; explorer: string }
export interface Series { key: string; label: string; unit: "usd" | "pct" | "index"; source: string; points: [string, number][] }
export interface StateHpi { st: string; name: string; index: number; yoyPct: number; quarter: string }
export interface MarketsPayload { live: LiveFeed[]; series: Series[]; states: StateHpi[]; updatedAt: string }

// Same feeds as cre/asset-feeds/config.staging.json.
const LIVE: { key: string; label: string; unit: LiveFeed["unit"]; chainId: number; address: Address }[] = [
  { key: "WTI", label: "WTI crude oil", unit: "usd", chainId: 42161, address: "0x594b919AD828e693B935705c3F816221729E7AE8" },
  { key: "XAU", label: "Gold (per ounce)", unit: "usd", chainId: 8453, address: "0x5213eBB69743b85644dbB6E25cdF994aFBb8cF31" },
  { key: "XAG", label: "Silver (per ounce)", unit: "usd", chainId: 8453, address: "0x7dBC779B2A6F9B9AaB83a2dED78A2F7E9e203f0c" },
  { key: "SPY", label: "S&P 500 (SPY)", unit: "usd", chainId: 42161, address: "0x46306F3795342117721D8DEd50fbcF6DF2b3cc10" },
  { key: "PCE", label: "US inflation (PCE index)", unit: "index", chainId: 8453, address: "0x18A3fcA54FaC5B05837205bA4b823fc56191F793" },
];

const FRED: { key: string; id: string; label: string; unit: Series["unit"]; years: number }[] = [
  { key: "WTI", id: "DCOILWTICO", label: "WTI crude oil, $ per barrel", unit: "usd", years: 1 },
  { key: "SOFR", id: "SOFR", label: "SOFR, overnight rate %", unit: "pct", years: 1 },
  { key: "MORTGAGE30", id: "MORTGAGE30US", label: "30-year mortgage rate %", unit: "pct", years: 1 },
  { key: "PCE", id: "PCEPI", label: "US inflation (PCE price index)", unit: "index", years: 1 },
];
const MASSIVE: { key: string; ticker: string; label: string }[] = [
  { key: "GOLD", ticker: "GLD", label: "Gold (GLD fund), $" },
  { key: "SILVER", ticker: "SLV", label: "Silver (SLV fund), $" },
  { key: "SPY", ticker: "SPY", label: "S&P 500 (SPY), $" },
  { key: "REIT", ticker: "VNQ", label: "US real estate (VNQ REIT fund), $" },
];

const STATES: [string, string][] = [
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"], ["CA", "California"], ["CO", "Colorado"], ["CT", "Connecticut"],
  ["DE", "Delaware"], ["DC", "District of Columbia"], ["FL", "Florida"], ["GA", "Georgia"], ["HI", "Hawaii"], ["ID", "Idaho"], ["IL", "Illinois"],
  ["IN", "Indiana"], ["IA", "Iowa"], ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"], ["MD", "Maryland"],
  ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"], ["MS", "Mississippi"], ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"],
  ["NV", "Nevada"], ["NH", "New Hampshire"], ["NJ", "New Jersey"], ["NM", "New Mexico"], ["NY", "New York"], ["NC", "North Carolina"],
  ["ND", "North Dakota"], ["OH", "Ohio"], ["OK", "Oklahoma"], ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"],
  ["SC", "South Carolina"], ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"], ["VT", "Vermont"], ["VA", "Virginia"],
  ["WA", "Washington"], ["WV", "West Virginia"], ["WI", "Wisconsin"], ["WY", "Wyoming"],
];

const feedAbi = [
  { type: "function", name: "latestRoundData", stateMutability: "view", inputs: [], outputs: [
    { name: "roundId", type: "uint80" }, { name: "answer", type: "int256" }, { name: "startedAt", type: "uint256" },
    { name: "updatedAt", type: "uint256" }, { name: "answeredInRound", type: "uint80" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const yearsAgo = (n: number) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - n); return isoDay(d); };

async function fetchText(url: string): Promise<string> {
  // FRED's edge rejects unfamiliar User-Agents, so send the runtime default.
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url.replace(/(apiKey|api_key)=[^&]+/, "$1=…")}`);
  return r.text();
}

/** FRED public CSV, several series in one request: { id: [date, value][] } (blank / "." rows dropped). */
export function parseFredCsv(csv: string): Record<string, [string, number][]> {
  const [head, ...rows] = csv.trim().split(/\r?\n/);
  const ids = (head ?? "").split(",").slice(1).map((s) => s.trim());
  const out: Record<string, [string, number][]> = Object.fromEntries(ids.map((id) => [id, []]));
  for (const row of rows) {
    const [date, ...vals] = row.split(",");
    vals.forEach((v, i) => { const n = Number(v), id = ids[i]; if (date && id && v && v !== "." && Number.isFinite(n)) out[id]?.push([date, n]); });
  }
  return out;
}

async function loadLive(): Promise<LiveFeed[]> {
  const out = await Promise.all(LIVE.map(async (f): Promise<LiveFeed | null> => {
    const net = networkById(f.chainId)!;
    const client = createPublicClient({ transport: http(rpcUrl(net), { timeout: 15_000 }) });
    try {
      const [round, dec] = await Promise.all([
        client.readContract({ address: f.address, abi: feedAbi, functionName: "latestRoundData" }),
        client.readContract({ address: f.address, abi: feedAbi, functionName: "decimals" }),
      ]);
      return { key: f.key, label: f.label, unit: f.unit, value: Number(round[1]) / 10 ** Number(dec), updatedAt: new Date(Number(round[3]) * 1000).toISOString(),
        chainId: f.chainId, address: f.address, explorer: `${net.explorer}/address/${f.address}` } satisfies LiveFeed;
    } catch (e) { console.warn(`markets: Chainlink ${f.key} read failed`, (e as Error).message); return null; }
  }));
  return out.filter((x): x is LiveFeed => !!x);
}

// FRED's CSV endpoint returns a ZIP when series have different frequencies and caps a request at 12 series,
// so mixed series go one per request and same-frequency series (the states) go in batches of 12.
// With FRED_API_KEY set we use the official API (one call per series; limit 120/min); otherwise the public CSV.
async function fredCsv(ids: string[], since: string): Promise<Record<string, [string, number][]>> {
  const key = process.env.FRED_API_KEY;
  if (key) {
    try {
      const rows = await Promise.all(ids.map(async (id) => {
        const j = JSON.parse(await fetchText(`https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${encodeURIComponent(key)}&file_type=json&observation_start=${since}`));
        const pts = ((j.observations ?? []) as { date: string; value: string }[])
          .filter((o) => o.value !== "." && Number.isFinite(Number(o.value))).map((o) => [o.date, Number(o.value)] as [string, number]);
        return [id, pts] as const;
      }));
      return Object.fromEntries(rows);
    } catch (e) { console.warn("markets: FRED API failed, falling back to CSV", (e as Error).message); }
  }
  return parseFredCsv(await fetchText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${ids.join(",")}&cosd=${since}`));
}

async function loadFredSeries(): Promise<Series[]> {
  const out = await Promise.all(FRED.map(async (f) => {
    try {
      const pts = (await fredCsv([f.id], yearsAgo(f.years)))[f.id] ?? [];
      return { key: f.key, label: f.label, unit: f.unit, source: `FRED ${f.id}`, points: pts } satisfies Series;
    } catch (e) { console.warn(`markets: FRED ${f.id} failed`, (e as Error).message); return null; }
  }));
  return out.filter((x): x is Series => !!x && x.points.length > 1);
}

// Massive's plan allows 5 calls a minute: fetch one ticker every 15 s in the background and keep each for 6 hours.
const massive = new Map<string, { at: number; series: Series }>();
let massiveTimer: ReturnType<typeof setInterval> | null = null;
function startMassive() {
  const key = process.env.MASSIVE_API_KEY;
  if (!key || massiveTimer) return;
  const tick = async () => {
    const due = MASSIVE.find((m) => !massive.has(m.key) || Date.now() - massive.get(m.key)!.at > 6 * 3600_000);
    if (!due) return;
    try {
      const from = yearsAgo(1), to = isoDay(new Date());
      const j = JSON.parse(await fetchText(`https://api.massive.com/v2/aggs/ticker/${due.ticker}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=500&apiKey=${encodeURIComponent(key)}`));
      const points = ((j.results ?? []) as { t: number; c: number }[]).map((r) => [isoDay(new Date(r.t)), r.c] as [string, number]);
      if (points.length > 1) massive.set(due.key, { at: Date.now(), series: { key: due.key, label: due.label, unit: "usd", source: `Massive ${due.ticker} daily close`, points } });
    } catch (e) { console.warn(`markets: Massive ${due.ticker} failed`, (e as Error).message); }
  };
  void tick();
  massiveTimer = setInterval(tick, 15_000);
  massiveTimer.unref?.();
}
const massiveSeries = () => MASSIVE.map((m) => massive.get(m.key)?.series).filter((x): x is Series => !!x);

async function loadStates(): Promise<StateHpi[]> {
  const ids = STATES.map(([st]) => `${st}STHPI`);
  const batches = Array.from({ length: Math.ceil(ids.length / 12) }, (_, i) => ids.slice(i * 12, i * 12 + 12));
  const csv = Object.assign({}, ...(await Promise.all(batches.map((b) => fredCsv(b, yearsAgo(2))))));
  const out: StateHpi[] = [];
  for (const [st, name] of STATES) {
    const pts = csv[`${st}STHPI`] ?? [];
    if (pts.length < 5) continue;
    const [quarter, index] = pts[pts.length - 1];
    const prior = pts[pts.length - 5][1];
    out.push({ st, name, index, quarter, yoyPct: Math.round(((index / prior) - 1) * 1000) / 10 });
  }
  return out;
}

const TTL_MS = 30 * 60_000;
let cache: { at: number; data: Omit<MarketsPayload, "series"> & { fred: Series[] } } | null = null;
let inflight: Promise<unknown> | null = null;

async function refresh() {
  const [live, fred, states] = await Promise.all([
    loadLive().catch(() => cache?.data.live ?? []),
    loadFredSeries().then((s) => (s.length ? s : cache?.data.fred ?? [])),
    loadStates().catch((e) => { console.warn("markets: states failed", e.message); return cache?.data.states ?? []; }),
  ]);
  const data = { live: live.length ? live : cache?.data.live ?? [], fred, states: states.length ? states : cache?.data.states ?? [], updatedAt: new Date().toISOString() };
  cache = { at: Date.now(), data };
  return data;
}

export function mountMarkets(app: Hono<any>) {
  startMassive();
  app.get("/markets", async (c) => {
    if (!cache || Date.now() - cache.at > TTL_MS) {
      inflight ??= refresh().finally(() => { inflight = null; });
      if (!cache) await inflight; // first request waits; later ones serve the last copy while refreshing
    }
    c.header("Cache-Control", "public, max-age=300");
    const { fred, ...rest } = cache!.data;
    const byKey = new Map([...fred, ...massiveSeries()].map((x) => [x.key, x]));
    const order = ["WTI", "GOLD", "SILVER", "SPY", "REIT", "MORTGAGE30", "SOFR", "PCE"];
    const series = order.map((k) => byKey.get(k)).filter((x): x is Series => !!x);
    return c.json({ ...rest, series } satisfies MarketsPayload);
  });
}
