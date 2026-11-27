// Proof of asset from the SPV's bank account, via Mastercard Open Finance (design canvas UzMg5WJ2BGKFGCzBaWkMRu, A5).
//
// The issuer links the SPV's operating account in Mastercard Data Connect, picks the account, sets the expected
// monthly income and (optionally) marks which payers count. The platform reads deposits directly from Mastercard; the
// issuer can't edit them. When the last complete month's income meets the expectation, the platform's
// "Mastercard Open Finance data source" signs the class's income check (RENT_INCOME for real estate, ROYALTY_INCOME
// for energy and music) on the offering's oracle, valid for the kind's maximum (45 / 120 days). A short month or a
// disconnected account means no renewal: the check lapses and, where it's required, new sales pause.
//
// Signing: the data-source key (MC_DATA_SOURCE_KEY, platform-held, approved on each oracle by the platform admin only
// for the income kinds) signs EIP-712; the T-REX relayer submits attestBySig and pays gas.
//
// Endpoints (issuer console, admin session):
//   GET  /api/assets/:id/bank                 status + live monthly income (from Mastercard)
//   POST /api/assets/:id/bank/connect         → { link } (Data Connect for the SPV account)
//   POST /api/assets/:id/bank/linked          → { accounts } (after Data Connect finishes)
//   POST /api/assets/:id/bank/settings        { accountId, expectedMonthly, payers? }
//   POST /api/assets/:id/bank/check           sign now if last month met the expectation
// Public evidence (numbers only): GET /api/proof/bank/:assetId/:month
import type { BankProofRow, Store } from "./store";
import type { Hono } from "hono";
import { createHash } from "node:crypto";
import { getAddress, keccak256, toHex, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import artifacts from "../../web/src/contracts/artifacts.json";
import { CHECK_KINDS, kindHash, type CheckKindId } from "../../web/src/lib/verification";
import { networkById, oracleForSale } from "./chains";
import { McError, relay } from "./mastercard";
import { publicFor, walletFor } from "./trex";
import { registerJob } from "./jobs";
import { STRIPE_PREFIX, StripeFcError, fetchStripeTransactions, getAccount, isStripeRow, linkedAccounts, ownerNames, sameCompany, startSession, stripeFcConfigured } from "./stripefc";

const ORACLE = (artifacts as any).AssetOracle.abi as Abi;
const SANDBOX = process.env.MC_OF_TESTING !== "0";
const INCOME_KIND: Record<string, CheckKindId> = { "real-estate": "RENT_INCOME", energy: "ROYALTY_INCOME", "music-ip": "ROYALTY_INCOME" };
export const incomeKindFor = (assetClass: string) => INCOME_KIND[assetClass] ?? null;

type Row = BankProofRow; // storage: api/src/store.ts (SQLite or MongoDB)

// ------------------------------------------------------------------ income from transactions
export interface MonthIncome { month: string; cents: number; deposits: number }

const monthKey = (epochSec: number) => new Date(epochSec * 1000).toISOString().slice(0, 7);

/** Deposits into the chosen account that count as income: from a marked payer if any are marked, otherwise anything
 *  Mastercard categorises as income. Transfers between own accounts never count. */
export function monthlyIncome(transactions: any[], accountId: string, payers: string[], opts: { regularOnly?: boolean } = {}): MonthIncome[] {
  const marked = payers.map((p) => p.trim().toLowerCase()).filter(Boolean);
  // Nobody names payers: count deposits from REGULAR payers (seen in 2+ months), found automatically.
  if (!marked.length && opts.regularOnly) {
    const regular = new Set(depositors(transactions, accountId).filter((d) => d.regular).map((d) => d.name));
    return monthlyIncome(transactions.filter((t) => regular.has(payerKey(String(t?.categorization?.normalizedPayeeName ?? t?.description ?? "")))), accountId, [], {});
  }
  const by = new Map<string, MonthIncome>();
  for (const t of transactions) {
    if (String(t?.accountId) !== String(accountId)) continue;
    const amt = Number(t?.amount);
    if (!(amt > 0)) continue;
    const cat = String(t?.categorization?.category ?? "").toLowerCase();
    if (cat.includes("transfer")) continue;
    const payee = String(t?.categorization?.normalizedPayeeName ?? t?.description ?? "").toLowerCase();
    const counts = marked.length ? marked.some((p) => payee.includes(p)) : cat.includes("income") || cat.includes("rent");
    if (!counts) continue;
    const k = monthKey(Number(t.postedDate ?? t.transactionDate));
    const m = by.get(k) ?? { month: k, cents: 0, deposits: 0 };
    m.cents += Math.round(amt * 100);
    m.deposits += 1;
    by.set(k, m);
  }
  return [...by.values()].sort((a, b) => (a.month < b.month ? 1 : -1));
}

/** A payer's name without reference numbers, dates and punctuation, so the same tenant matches month to month. */
export function payerKey(desc: string) {
  return desc.toUpperCase().replace(/[#*:]/g, " ").replace(/\b(ACH|DEPOSIT|CREDIT|PMT|PAYMENT|ONLINE|MOBILE|EDI|CCD|PPD|WEB|TRANSFER IN|INCOMING|WIRE)\b/g, " ")
    .replace(/\d+/g, " ").replace(/[^A-Z&' ]/g, " ").replace(/\s+/g, " ").trim().split(" ").slice(0, 4).join(" ");
}

/** Depositors into the account, grouped by payer, with how many of the months they paid in.
 *  "Regular" = paid in at least 2 different months: tenants, an operator, a distributor. One-off deposits aren't. */
export function depositors(transactions: any[], accountId: string) {
  const by = new Map<string, { name: string; months: Set<string>; cents: number; deposits: number }>();
  for (const t of transactions) {
    if (String(t?.accountId) !== String(accountId)) continue;
    const amt = Number(t?.amount);
    if (!(amt > 0)) continue;
    if (String(t?.categorization?.category ?? "").toLowerCase().includes("transfer")) continue;
    const key = payerKey(String(t?.categorization?.normalizedPayeeName ?? t?.description ?? ""));
    if (!key) continue;
    const d = by.get(key) ?? { name: key, months: new Set<string>(), cents: 0, deposits: 0 };
    d.months.add(monthKey(Number(t.postedDate ?? t.transactionDate)));
    d.cents += Math.round(amt * 100);
    d.deposits += 1;
    by.set(key, d);
  }
  return [...by.values()].map((d) => ({ name: d.name, months: d.months.size, cents: d.cents, deposits: d.deposits, regular: d.months.size >= 2 }))
    .sort((a, b) => b.cents - a.cents);
}

/** The last complete calendar month before `now` (UTC), e.g. "2026-10" during November 2026. */
export function lastCompleteMonth(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 7);
}

/** Transactions for a configured row, from whichever provider linked it. */
const txFor = (row: Row) => (isStripeRow(row.mc_customer_id) ? fetchStripeTransactions(row.account_id!) : fetchTransactions(row.mc_customer_id));
const sourceOf = (row: Row) => (isStripeRow(row.mc_customer_id) ? "Stripe Financial Connections" : "Mastercard Open Finance");

async function fetchTransactions(customerId: string, days = 120) {
  const to = Math.floor(Date.now() / 1000), from = to - days * 86_400;
  const out: any[] = [];
  for (let start = 1; start < 20_000; start += 1000) {
    const r = await relay<any>("GET", `/customers/${customerId}/transactions?fromDate=${from}&toDate=${to}&start=${start}`);
    out.push(...(r?.transactions ?? []));
    if (!(r?.moreAvailable === true || r?.moreAvailable === "true")) break;
  }
  return out;
}

// ------------------------------------------------------------------ signing
function dataSource() {
  const k = process.env.MC_DATA_SOURCE_KEY;
  return k ? privateKeyToAccount((k.startsWith("0x") ? k : `0x${k}`) as Hex) : null;
}
export const dataSourceAddress = () => dataSource()?.address ?? null;

/** Sign the income check for `month` as the data source and submit it through the relayer. */
async function attestIncome(asset: any, kind: CheckKindId, month: string, inc: MonthIncome, evidenceURI: string, source = "Mastercard Open Finance") {
  const ds = dataSource();
  const relayKey = process.env.TREX_RELAYER_KEY;
  if (!ds || !relayKey) throw new McError(503, "The bank data source isn't configured on this server");
  const net = networkById(asset.chainId)!;
  const pc = publicFor(net);
  const saleOracle = await pc.readContract({ address: asset.deployment.sale, abi: [{ type: "function", name: "oracle", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const, functionName: "oracle" }).catch(() => null);
  const oracle = oracleForSale(net, saleOracle as string | null)?.address;
  if (!oracle) throw new McError(409, `Proof of asset isn't live on ${net.name}`);
  const token = getAddress(asset.deployment.token);
  const evidence = JSON.stringify({ assetId: asset.id, kind, month, incomeCents: inc.cents, deposits: inc.deposits, source });
  const input = {
    token, kind: kindHash(kind), result: 1, validUntil: BigInt(Math.floor(Date.now() / 1000) + CHECK_KINDS[kind].maxDays * 86_400 - 600),
    value: BigInt(inc.cents), evidenceHash: `0x${createHash("sha256").update(evidence).digest("hex")}` as Hex, evidenceURI,
  };
  const nonce = (await pc.readContract({ address: oracle, abi: ORACLE, functionName: "nonces", args: [ds.address] })) as bigint;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const digest = (await pc.readContract({ address: oracle, abi: ORACLE, functionName: "attestDigest", args: [input, nonce, deadline] })) as Hex;
  const signature = await ds.sign({ hash: digest });
  const wc = walletFor(net, relayKey);
  const { request } = await pc.simulateContract({ address: oracle, abi: ORACLE, functionName: "attestBySig", args: [ds.address, input, deadline, signature], account: wc.account! });
  const hash = await wc.writeContract(request as any);
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new McError(502, `attestation failed: ${hash}`);
  return { hash, evidence };
}

// ------------------------------------------------------------------ API
type Deps = { store: Store; requireAdmin: any; tenantId: (c: any) => string; adminAsset: (c: any, id: string) => Promise<any | null>; allDeployed: () => Promise<any[]> };

const Settings = z.object({ accountId: z.string().regex(/^(\d{1,20}|fca_[A-Za-z0-9]{6,60})$/), expectedMonthly: z.number().positive().max(1e10), payers: z.array(z.string().trim().max(80)).max(20).default([]) });

export function mountBankProof(app: Hono<any>, deps: Deps) {
  const { store } = deps;
  const get = (assetId: string) => store.getBankProof(assetId);
  const now = () => new Date().toISOString();
  const errOut = (c: any, e: any) => c.json({ error: e instanceof StripeFcError ? e.message : e instanceof McError ? (e.status === 503 ? e.message : `Mastercard: ${e.message}`) : e?.shortMessage ?? "Couldn't reach the bank data provider. Try again shortly." }, e?.status && e.status < 600 ? e.status : 502);

  async function ctx(c: any) {
    const asset = await deps.adminAsset(c, c.req.param("id"));
    if (!asset) return { err: c.json({ error: "Not found" }, 404) };
    if (asset.status !== "deployed") return { err: c.json({ error: "Deploy the offering first" }, 409) };
    const kind = incomeKindFor(asset.assetClass);
    if (!kind) return { err: c.json({ error: "Bank-backed income checks apply to real estate, energy and music offerings" }, 400) };
    return { asset, kind };
  }

  /** Run the monthly check for one offering. Signs only when the last complete month met the expectation. */
  async function check(asset: any, kind: CheckKindId, host: string | null) {
    const row = await get(asset.id);
    if (!row?.account_id || !row.expected_cents) return { signed: false, reason: "Pick the account and the expected monthly income first" };
    const month = lastCompleteMonth();
    const income = monthlyIncome(await txFor(row), row.account_id, JSON.parse(row.payers), { regularOnly: isStripeRow(row.mc_customer_id) });
    const inc = income.find((m) => m.month === month) ?? { month, cents: 0, deposits: 0 };
    if (inc.cents < row.expected_cents) {
      await store.updateBankProof(asset.id, { last_result: JSON.stringify({ month, met: false, cents: inc.cents }), updated_at: now() });
      return { signed: false, reason: `${month}: income ${(inc.cents / 100).toFixed(2)} is below the expected ${(row.expected_cents / 100).toFixed(2)}`, month, income: inc };
    }
    if (row.last_month === month) return { signed: false, reason: `${month} is already signed`, month, income: inc, tx: row.last_tx };
    const evidenceURI = `https://${host ?? "tokenize.diamondz.one"}/api/proof/bank/${asset.id}/${month}`;
    const { hash } = await attestIncome(asset, kind, month, inc, evidenceURI, sourceOf(row));
    await store.updateBankProof(asset.id, { last_month: month, last_tx: hash, last_result: JSON.stringify({ month, met: true, cents: inc.cents }), updated_at: now() });
    return { signed: true, month, income: inc, tx: hash };
  }

  app.get("/assets/:id/bank", deps.requireAdmin, async (c) => {
    const x = await ctx(c);
    if (x.err) return x.err;
    const row = await get(x.asset.id);
    const base = { stripeAvailable: stripeFcConfigured(), kind: x.kind, kindName: CHECK_KINDS[x.kind].name, maxDays: CHECK_KINDS[x.kind].maxDays, dataSource: dataSourceAddress(), lastCompleteMonth: lastCompleteMonth() };
    if (!row) return c.json({ ...base, linked: false });
    let months: MonthIncome[] | null = null;
    let found: { name: string; months: number; cents: number; regular: boolean }[] | null = null;
    let readError: string | null = null;
    if (row.account_id) {
      try {
        const txs = await txFor(row);
        months = monthlyIncome(txs, row.account_id, JSON.parse(row.payers), { regularOnly: isStripeRow(row.mc_customer_id) }).slice(0, 4);
        found = depositors(txs, row.account_id).slice(0, 12).map((d) => ({ name: d.name, months: d.months, cents: d.cents, regular: d.regular }));
      }
      catch (e: any) { readError = e?.message ?? "Couldn't read the account"; }
    }
    // Stripe: who the bank says owns the account, against the offering's owning company.
    let holder: { names: string[]; expected: string | null; match: boolean | null } | null = null;
    if (isStripeRow(row.mc_customer_id) && row.account_id) {
      const cust = row.mc_customer_id.slice(STRIPE_PREFIX.length);
      const a = await getAccount(row.account_id, cust).catch(() => null);
      const names = a ? await ownerNames(a.id, a.ownership).catch(() => []) : [];
      const expected = String(x.asset.details?.owner ?? "").trim() || null;
      holder = { names, expected, match: names.length && expected ? names.some((n) => sameCompany(n, expected)) : null };
    }
    return c.json({
      ...base, provider: isStripeRow(row.mc_customer_id) ? "stripe" : "mastercard", holder, depositors: found, linked: row.status !== "linking", accountId: row.account_id, accountLabel: row.account_label,
      expectedMonthly: row.expected_cents === null ? null : row.expected_cents / 100, payers: JSON.parse(row.payers),
      lastMonthSigned: row.last_month, lastTx: row.last_tx, lastResult: row.last_result ? JSON.parse(row.last_result) : null, months, readError,
    });
  });

  app.post("/assets/:id/bank/connect", deps.requireAdmin, async (c) => {
    const x = await ctx(c);
    if (x.err) return x.err;
    try {
      let row = await get(x.asset.id);
      if (!row) {
        const cust = await relay<{ id: string }>("POST", "/customers", { username: `tkbank_${x.asset.id}_${Date.now()}`, testing: SANDBOX });
        await store.insertBankProof({ asset_id: x.asset.id, tenant_id: deps.tenantId(c), mc_customer_id: String(cust.id), account_id: null, account_label: null, expected_cents: null, payers: "[]", status: "linking", last_month: null, last_tx: null, last_result: null, created_at: now(), updated_at: now() });
        row = (await get(x.asset.id))!;
      }
      const { link } = await relay<{ link: string }>("POST", `/customers/${row.mc_customer_id}/connect`, {});
      return c.json({ link });
    } catch (e: any) { return errOut(c, e); }
  });

  app.post("/assets/:id/bank/linked", deps.requireAdmin, async (c) => {
    const x = await ctx(c);
    if (x.err) return x.err;
    const row = await get(x.asset.id);
    if (!row) return c.json({ error: "Connect the account first" }, 409);
    try {
      const r = await relay<any>("POST", `/customers/${row.mc_customer_id}/accounts/refresh`);
      const accounts = (r?.accounts ?? []).filter((a: any) => ["checking", "savings", "moneyMarket"].includes(a?.type))
        .map((a: any) => ({ id: String(a.id), name: String(a.name ?? a.accountNickname ?? a.type), type: String(a.type), last4: String(a.realAccountNumberLast4 ?? a.accountNumberDisplay ?? "").slice(-4) }));
      await store.updateBankProof(x.asset.id, { status: "linked", updated_at: now() });
      return c.json({ accounts });
    } catch (e: any) { return errOut(c, e); }
  });

  // ---- Stripe Financial Connections (second provider)
  app.get("/stripe/fc-config", (c) => c.json({ enabled: stripeFcConfigured(), publishableKey: stripeFcConfigured() ? process.env.STRIPE_PUBLISHABLE_KEY : null }));

  app.post("/assets/:id/bank/stripe/session", deps.requireAdmin, async (c) => {
    const x = await ctx(c);
    if (x.err) return x.err;
    if (!stripeFcConfigured()) return c.json({ error: "Stripe bank linking isn't configured on this server" }, 503);
    try {
      let row = await get(x.asset.id);
      if (row && !isStripeRow(row.mc_customer_id)) return c.json({ error: "This offering's bank is linked through Mastercard. Unlink it first." }, 409);
      const spv = String(x.asset.details?.owner ?? x.asset.name);
      const host = c.req.header("host") ?? "tokenize.diamondz.one";
      const s = await startSession(row ? row.mc_customer_id.slice(STRIPE_PREFIX.length) : null, spv, x.asset.id, `https://${host}/app/assets/${x.asset.id}`);
      if (!row) {
        await store.insertBankProof({ asset_id: x.asset.id, tenant_id: deps.tenantId(c), mc_customer_id: STRIPE_PREFIX + s.customer, account_id: null, account_label: null, expected_cents: null, payers: "[]", status: "linking", last_month: null, last_tx: null, last_result: null, created_at: now(), updated_at: now() });
      }
      return c.json({ clientSecret: s.clientSecret, sessionId: s.sessionId });
    } catch (e: any) { return errOut(c, e); }
  });

  app.post("/assets/:id/bank/stripe/linked", deps.requireAdmin, async (c) => {
    const x = await ctx(c);
    if (x.err) return x.err;
    const row = await get(x.asset.id);
    if (!row || !isStripeRow(row.mc_customer_id)) return c.json({ error: "Start the Stripe bank link first" }, 409);
    const b = z.object({ sessionId: z.string().regex(/^fcsess_[A-Za-z0-9]+$/) }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "Bad request" }, 400);
    try {
      const accounts = await linkedAccounts(b.data.sessionId, row.mc_customer_id.slice(STRIPE_PREFIX.length));
      if (!accounts.length) return c.json({ error: "No checking or savings account was linked" }, 400);
      await store.updateBankProof(x.asset.id, { status: "linked", updated_at: now() });
      return c.json({ accounts: accounts.map((a) => ({ id: a.id, name: `${a.institution ? `${a.institution} ` : ""}${a.name}`, type: a.type, last4: a.last4 })) });
    } catch (e: any) { return errOut(c, e); }
  });

  app.post("/assets/:id/bank/settings", deps.requireAdmin, async (c) => {
    const x = await ctx(c);
    if (x.err) return x.err;
    const row = await get(x.asset.id);
    if (!row) return c.json({ error: "Connect the account first" }, 409);
    const p = Settings.safeParse(await c.req.json().catch(() => null));
    if (!p.success) return c.json({ error: "Pick an account and enter the expected monthly income" }, 400);
    let label: string | null = null;
    if (isStripeRow(row.mc_customer_id)) {
      const a = await getAccount(p.data.accountId, row.mc_customer_id.slice(STRIPE_PREFIX.length)).catch(() => null);
      if (!a) return c.json({ error: "That account isn't linked to this offering" }, 400);
      label = `${a.institution ? `${a.institution} ` : ""}${a.name} ending ${a.last4}`;
    } else {
      const r = await relay<any>("GET", `/customers/${row.mc_customer_id}/accounts`).catch(() => null);
      const acct = (r?.accounts ?? []).find((a: any) => String(a.id) === p.data.accountId);
      if (r && !acct) return c.json({ error: "That account isn't linked" }, 400);
      label = acct ? `${acct.name ?? acct.type} ending ${String(acct.realAccountNumberLast4 ?? acct.accountNumberDisplay ?? "").slice(-4)}` : null;
    }
    await store.updateBankProof(x.asset.id, { account_id: p.data.accountId, account_label: label, expected_cents: Math.round(p.data.expectedMonthly * 100), payers: JSON.stringify(p.data.payers.filter(Boolean)), status: "linked", updated_at: now() });
    return c.json({ ok: true });
  });

  app.post("/assets/:id/bank/check", deps.requireAdmin, async (c) => {
    const x = await ctx(c);
    if (x.err) return x.err;
    try { return c.json(await check(x.asset, x.kind, c.req.header("host") ?? null)); }
    catch (e: any) { console.error("[bank] check", x.asset.id, e?.shortMessage ?? e?.message ?? e); return errOut(c, e); }
  });

  // Public, numbers only: what the signed check is based on.
  app.get("/proof/bank/:assetId/:month", async (c) => {
    const row = await get(c.req.param("assetId"));
    const month = c.req.param("month");
    if (!row || !/^\d{4}-\d{2}$/.test(month) || !row.last_result) return c.json({ error: "Not found" }, 404);
    const last = JSON.parse(row.last_result);
    if (last.month !== month || !last.met) return c.json({ error: "Not found" }, 404);
    c.header("Cache-Control", "public, max-age=3600");
    return c.json({ assetId: row.asset_id, month, incomeCents: last.cents, expectedCents: row.expected_cents, source: sourceOf(row), account: row.account_label });
  });

  // Daily: sign last month for every configured offering once its income is in (Temporal schedule in production).
  registerJob("bank-daily", async () => {
    let signed = 0, notYet = 0, failed = 0;
    const deployed = await deps.allDeployed();
    for (const r of await store.bankProofsConfigured()) {
      if (r.last_month === lastCompleteMonth()) continue;
      const asset = deployed.find((a: any) => a.id === r.asset_id);
      const kind = asset && incomeKindFor(asset.assetClass);
      if (!asset || !kind) continue;
      await check(asset, kind, null).then((x) => (x.signed ? signed++ : notYet++), (e) => { failed++; console.error("[bank] daily", r.asset_id, e?.shortMessage ?? e?.message ?? e); });
    }
    return { signed, notYet, failed };
  }, 24 * 3600_000, 60_000, process.env.BANK_PROOF_TICK !== "0");
}
