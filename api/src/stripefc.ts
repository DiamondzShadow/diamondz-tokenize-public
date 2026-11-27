// Stripe Financial Connections: the second source for bank-proven income (2026-11-20), used beside Mastercard Open
// Finance. The issuer links the SPV's operating account in Stripe's window; we read its posted transactions and the
// account holder's name. Raw transactions are read on demand and never stored; only monthly totals are.
//
// A bank_proof row uses Stripe when its customer id starts with "stripe:" (mc_customer_id = "stripe:cus_…").
const BASE = () => process.env.STRIPE_BASE || "https://api.stripe.com";
export const stripeFcConfigured = () => !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PUBLISHABLE_KEY);
export const STRIPE_PREFIX = "stripe:";
export const isStripeRow = (customerId: string) => customerId.startsWith(STRIPE_PREFIX);

export class StripeFcError extends Error { constructor(public status: number, message: string) { super(message); } }

export async function sfc<T>(method: "GET" | "POST", path: string, form: [string, string][] = []): Promise<T> {
  const body = form.length ? new URLSearchParams(form).toString() : undefined;
  const res = await fetch(BASE() + path, {
    method,
    headers: { authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    body, signal: AbortSignal.timeout(20_000),
  });
  const j = (await res.json().catch(() => null)) as any;
  // Stripe's own message is safe to show the issuer (e.g. "transactions permission not enabled for your account").
  if (!res.ok) throw new StripeFcError(res.status >= 500 ? 502 : 400, j?.error?.message ? `Stripe: ${j.error.message}` : `Stripe ${path.split("?")[0]} failed (HTTP ${res.status})`);
  return j as T;
}

/** A Financial Connections session for the issuer's SPV, as a Stripe customer named after the owning company. */
export async function startSession(existingCustomer: string | null, spvName: string, assetId: string, returnUrl: string) {
  const customer = existingCustomer ?? (await sfc<{ id: string }>("POST", "/v1/customers", [["name", spvName.slice(0, 200)], ["metadata[asset_id]", assetId], ["metadata[purpose]", "bank-proof"]])).id;
  const s = await sfc<{ id: string; client_secret: string }>("POST", "/v1/financial_connections/sessions", [
    ["account_holder[type]", "customer"], ["account_holder[customer]", customer],
    ["permissions[]", "transactions"], ["permissions[]", "ownership"], ["permissions[]", "balances"],
    ["filters[country]", "US"], ["return_url", returnUrl],
  ]);
  return { customer, sessionId: s.id, clientSecret: s.client_secret };
}

export interface FcAccount { id: string; name: string; type: string; last4: string; institution: string }
const toAccount = (a: any): FcAccount => ({ id: a.id, name: a.display_name ?? a.subcategory ?? "Account", type: a.subcategory ?? a.category ?? "", last4: a.last4 ?? "", institution: a.institution_name ?? "" });

/** Accounts linked in a finished session; each is subscribed to daily transaction refreshes. */
export async function linkedAccounts(sessionId: string, customer: string): Promise<FcAccount[]> {
  const s = await sfc<any>("GET", `/v1/financial_connections/sessions/${encodeURIComponent(sessionId)}`);
  if (s?.account_holder?.customer !== customer) throw new StripeFcError(400, "That bank link belongs to a different offering");
  const accts = (s?.accounts?.data ?? []).filter((a: any) => a.category === "cash");
  for (const a of accts) {
    await sfc("POST", `/v1/financial_connections/accounts/${a.id}/subscribe`, [["features[]", "transactions"]]).catch(() => null);
    await sfc("POST", `/v1/financial_connections/accounts/${a.id}/refresh`, [["features[]", "ownership"]]).catch(() => null);
  }
  return accts.map(toAccount);
}

export async function getAccount(id: string, customer: string) {
  const a = await sfc<any>("GET", `/v1/financial_connections/accounts/${encodeURIComponent(id)}`);
  if (a?.account_holder?.customer !== customer) return null;
  return { ...toAccount(a), ownership: typeof a.ownership === "string" ? a.ownership : a.ownership?.id ?? null, refresh: a.transaction_refresh?.status ?? null };
}

/** Account holder names Stripe returned (empty until the ownership refresh finishes). */
export async function ownerNames(accountId: string, ownership: string | null) {
  if (!ownership) return [];
  const r = await sfc<any>("GET", `/v1/financial_connections/accounts/${encodeURIComponent(accountId)}/owners?ownership=${encodeURIComponent(ownership)}&limit=10`);
  return (r?.data ?? []).map((o: any) => String(o.name ?? "")).filter(Boolean) as string[];
}

/** Posted transactions for the last `days`, in the shape monthlyIncome() reads (amounts in dollars, epoch seconds). */
export async function fetchStripeTransactions(accountId: string, days = 120) {
  const since = Math.floor(Date.now() / 1000) - days * 86_400;
  const out: any[] = [];
  let after = "";
  for (let i = 0; i < 50; i++) {
    const r = await sfc<any>("GET", `/v1/financial_connections/transactions?account=${encodeURIComponent(accountId)}&transacted_at[gte]=${since}&limit=100${after ? `&starting_after=${after}` : ""}`);
    for (const t of r?.data ?? []) {
      if (t.status !== "posted") continue;
      const desc = String(t.description ?? "");
      out.push({ accountId, amount: Number(t.amount) / 100, postedDate: t.transacted_at, description: desc,
        // Stripe has no categories: anything that reads as a transfer between accounts never counts as income.
        categorization: { category: /transfer|xfer|from (sav|chk|checking|savings)/i.test(desc) ? "transfer" : "deposit income", normalizedPayeeName: desc } });
    }
    if (!r?.has_more || !r.data?.length) break;
    after = r.data[r.data.length - 1].id;
  }
  return out;
}

/** Loose company-name match: ignores case, punctuation and LLC/Inc/Corp/LP/Ltd suffixes. */
export function sameCompany(a: string, b: string) {
  const n = (s: string) => s.toLowerCase().replace(/[.,'"&]/g, " ").replace(/\b(llc|l l c|inc|incorporated|corp|corporation|co|company|lp|llp|ltd|limited|the)\b/g, " ").replace(/\s+/g, " ").trim();
  return !!n(a) && n(a) === n(b);
}
