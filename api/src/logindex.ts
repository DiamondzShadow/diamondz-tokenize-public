// Incremental event-log index shared by every server-side reader (IP pages, payouts, proof of asset).
//
// Why: page views used to re-scan a contract's whole history on every request (thousands of eth_getLogs a year
// in), and our RPC (Uniblock, entry tier: 40M compute units a month, 1,000 CU/s, eth_getLogs ≈ 89 CU, ranges up
// to 50,000 blocks) can't afford that. Now each contract is scanned ONCE from its first block, then only new blocks:
//   - one raw-log stream per (chain, contract), all events together, decoded on read;
//   - confirmed history is cached; the last CONFIRMATIONS blocks are re-read fresh (reorg-safe);
//   - at most one refresh per contract every REFRESH_MS; concurrent callers share it;
//   - every eth_getLogs goes through one global queue with a minimum gap and 429 back-off.
// In memory: a restart rescans each contract once (a year of Arbitrum ≈ 3k calls ≈ 280k CU ≈ 0.7% of a month).
//
// Env: LOG_CHUNK_BLOCKS (default 50000), LOG_MIN_GAP_MS (default 150), LOG_REFRESH_MS (default 3000: a refresh only reads the newest blocks).
import { decodeEventLog, getAddress, type AbiEvent, type Address, type Hex, type PublicClient } from "viem";

const CHUNK = BigInt(process.env.LOG_CHUNK_BLOCKS ?? 50_000);
const MIN_GAP_MS = Number(process.env.LOG_MIN_GAP_MS ?? 150);
const REFRESH_MS = Number(process.env.LOG_REFRESH_MS ?? 3_000);
const CONFIRMATIONS = 64n;

export interface RawLog { address: Address; topics: Hex[]; data: Hex; blockNumber: bigint; transactionHash: Hex; logIndex: number }
interface Entry { from: bigint; cursor: bigint; logs: RawLog[]; tail: RawLog[]; at: number; pending: Promise<void> | null }

const index = new Map<string, Entry>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let gate: Promise<unknown> = Promise.resolve();
export const stats = { calls: 0, retries: 0 };

/** One eth_getLogs at a time platform-wide, spaced by MIN_GAP_MS, retried with back-off on rate limits. */
function queued<T>(f: () => Promise<T>): Promise<T> {
  const run = gate.then(async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        stats.calls++;
        return await f();
      } catch (e: any) {
        const msg = `${e?.shortMessage ?? ""} ${e?.message ?? ""} ${e?.details ?? ""}`;
        const limited = /429|-32429|rate limit|Throughput|too many/i.test(msg);
        if (!limited || attempt >= 4) throw e;
        stats.retries++;
        await sleep(1000 * 2 ** attempt);
      }
    }
  });
  gate = run.catch(() => {}).then(() => sleep(MIN_GAP_MS));
  return run;
}

const RANGE_ERR = /range limit|block range|range is too|exceed|too large|too many blocks|Invalid parameters|-32602|-32005|query returned more than/i;
const MIN_CHUNK = 500n;

/** Some RPC backends behind a load-balanced provider cap eth_getLogs at a smaller range than others (seen on Base
 *  Sepolia via Uniblock: 50k ok, 20k "Block range limit exceeded" a moment later). On a range error the chunk halves
 *  (down to MIN_CHUNK) and the rest of this scan keeps the smaller size. */
async function fetchRange(pc: PublicClient, address: Address, from: bigint, to: bigint): Promise<RawLog[]> {
  const out: RawLog[] = [];
  let size = CHUNK;
  for (let s = from; s <= to; ) {
    const e = s + size - 1n > to ? to : s + size - 1n;
    let logs;
    try {
      logs = await queued(() => pc.getLogs({ address, fromBlock: s, toBlock: e }));
    } catch (err: any) {
      const msg = `${err?.shortMessage ?? ""} ${err?.message ?? ""} ${err?.details ?? ""}`;
      if (RANGE_ERR.test(msg) && size > MIN_CHUNK) { size = size / 2n < MIN_CHUNK ? MIN_CHUNK : size / 2n; stats.retries++; continue; }
      throw err;
    }
    for (const l of logs) {
      out.push({ address: getAddress(l.address), topics: l.topics as Hex[], data: l.data, blockNumber: l.blockNumber!, transactionHash: l.transactionHash!, logIndex: l.logIndex! });
    }
    s = e + 1n;
  }
  return out;
}

/** Every log a contract emitted since `fromBlock`, oldest first (cached + only new blocks fetched). */
export async function contractLogs(pc: PublicClient, chainId: number, address: Address, fromBlock: bigint | number): Promise<RawLog[]> {
  const from = BigInt(fromBlock);
  const key = `${chainId}:${address.toLowerCase()}`;
  let e = index.get(key);
  if (!e || from < e.from) {
    e = { from, cursor: from - 1n, logs: [], tail: [], at: 0, pending: null };
    index.set(key, e);
  }
  const entry = e;
  if (Date.now() - entry.at > REFRESH_MS) {
    entry.pending ??= (async () => {
      try {
        const head = await queued(() => pc.getBlockNumber({ cacheTime: 0 }));
        const safe = head > CONFIRMATIONS ? head - CONFIRMATIONS : 0n;
        if (entry.cursor < safe) {
          const got = await fetchRange(pc, address, entry.cursor + 1n, safe);
          entry.logs.push(...got);
          entry.cursor = safe;
        }
        entry.tail = head > entry.cursor ? await fetchRange(pc, address, entry.cursor + 1n, head) : [];
        entry.at = Date.now();
      } finally {
        entry.pending = null;
      }
    })();
    await entry.pending;
  }
  return entry.from === from ? [...entry.logs, ...entry.tail] : [...entry.logs, ...entry.tail].filter((l) => l.blockNumber >= from);
}

export interface Decoded<A = Record<string, any>> { args: A; blockNumber: bigint; transactionHash: Hex; logIndex: number }

/** Logs of one event, decoded, optionally filtered by exact-match args (a value or a list of accepted values). */
export async function eventLogs<A = Record<string, any>>(
  pc: PublicClient, chainId: number, address: Address, fromBlock: bigint | number, event: AbiEvent,
  match: Record<string, unknown | unknown[]> = {},
): Promise<Decoded<A>[]> {
  const raw = await contractLogs(pc, chainId, address, fromBlock);
  const out: Decoded<A>[] = [];
  const norm = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : typeof v === "number" ? BigInt(v) : v);
  for (const l of raw) {
    let d: { eventName: string; args: any };
    try {
      d = decodeEventLog({ abi: [event], data: l.data, topics: l.topics as [Hex, ...Hex[]] }) as any;
    } catch {
      continue; // a different event
    }
    if (d.eventName !== event.name) continue;
    let ok = true;
    for (const [k, want] of Object.entries(match)) {
      const got = norm(d.args?.[k]);
      const wants = Array.isArray(want) ? want.map(norm) : [norm(want)];
      if (!wants.some((w) => w === got)) { ok = false; break; }
    }
    if (ok) out.push({ args: d.args as A, blockNumber: l.blockNumber, transactionHash: l.transactionHash, logIndex: l.logIndex });
  }
  return out;
}

/** Forget the freshness of a contract's stream, so the next read fetches new blocks at once (call after our own
 *  writes, e.g. a relayed claim, so the page that follows shows it). History already indexed is kept. */
export function invalidate(chainId: number, address: Address) {
  const e = index.get(`${chainId}:${address.toLowerCase()}`);
  if (e) e.at = 0;
}
