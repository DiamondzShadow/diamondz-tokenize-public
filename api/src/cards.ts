// Card payments for licenses (owner decision 2026-11-19, option a): each issuer connects ITS OWN Stripe account
// (Stripe Connect, Standard accounts) and is the merchant of record; the platform never holds the money. A licensee
// pays by card through Stripe Checkout as a DIRECT charge on the issuer's account; the API then confirms the payment
// with Stripe and signs an EIP-712 card receipt that the licensee takes on chain (LicenseRegistry.buyWithReceipt),
// where it only counts if the asset's holder allowed the platform verifier.
// Mastercard (Click to Pay) can sit on top of a processor later; it doesn't move money by itself.
//
// Issuer (admin):
//   POST /api/cards/connect          → { url } Stripe onboarding for the issuer's own account (creates it once)
//   GET  /api/cards/status           → { enabled, account, chargesEnabled, detailsSubmitted }
// Licensee (public):
//   POST /api/ip/:id/card-checkout   { typeKey, wallet, work } → { url } Stripe Checkout on the issuer's account
//   POST /api/ip/:id/card-receipt    { session, wallet } → { receipt } once Stripe says paid
//
// Env: STRIPE_SECRET_KEY (platform account; sk_test_… for test mode), STRIPE_BASE (tests only), IP_VERIFIER_KEY
//      (else TREX_RELAYER_KEY) signs receipts.
import type { Hono } from "hono";
import { z } from "zod";
import { getAddress, isAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { networkById } from "./chains";
import { ipFor } from "./ip";
import { publicFor } from "./trex";

const STRIPE_VERSION = "2024-06-20";
const stripeBase = () => process.env.STRIPE_BASE || "https://api.stripe.com";
export const cardsEnabled = () => !!process.env.STRIPE_SECRET_KEY;
const verifierKey = () => process.env.IP_VERIFIER_KEY || process.env.TREX_RELAYER_KEY || "";

/** Stripe REST: form-encoded body, optional connected account. */
async function stripe<T>(method: "GET" | "POST", path: string, params?: Record<string, string>, account?: string): Promise<T> {
  const body = params ? new URLSearchParams(params).toString() : undefined;
  const res = await fetch(`${stripeBase()}${path}${method === "GET" && body ? `?${body}` : ""}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      "Stripe-Version": STRIPE_VERSION,
      ...(account ? { "Stripe-Account": account } : {}),
      ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: method === "POST" ? body : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(json?.error?.message ?? `Stripe HTTP ${res.status}`);
  return json as T;
}

const licensesAbi = [
  {
    type: "function", name: "licenseType", stateMutability: "view", inputs: [{ type: "uint256" }],
    outputs: [{ type: "tuple", components: [
      { name: "assetId", type: "uint256" }, { name: "termsHash", type: "bytes32" }, { name: "feeToken", type: "address" }, { name: "fee", type: "uint256" },
      { name: "revShareBps", type: "uint16" }, { name: "durationDays", type: "uint32" }, { name: "byRequest", type: "bool" }, { name: "active", type: "bool" },
      { name: "name", type: "string" }, { name: "territory", type: "string" }, { name: "termsURI", type: "string" },
    ] }],
  },
  { type: "function", name: "verifiedUntil", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "uint64" }] },
  { type: "function", name: "verifier", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "receiptUsed", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] },
] as const;

type Deps = {
  requireAdmin: any;
  tenantConfig: (c: any) => any;
  saveTenantConfig: (c: any, cfg: any) => Promise<void>;
  /** The issuer's config by tenant id (for licensee-side calls). */
  issuerConfig: (tenantId: string) => Promise<any | null>;
  publicAsset: (c: any, id: string) => Promise<any | null>;
  origin: (c: any) => string;
  tooMany: (key: string, max: number, windowMs: number) => boolean;
  ipKey: (c: any) => string;
};

export function mountCards(app: Hono<any>, deps: Deps) {
  // ---- issuer: connect their own Stripe account
  app.post("/cards/connect", deps.requireAdmin, async (c) => {
    if (!cardsEnabled()) return c.json({ error: "Card payments aren't set up on this platform yet" }, 503);
    const cfg = deps.tenantConfig(c);
    try {
      let account = cfg.payments?.stripeAccount as string | undefined;
      if (!account) {
        const acct = await stripe<{ id: string }>("POST", "/v1/accounts", { type: "standard", "metadata[tenant]": String(cfg.id ?? "") });
        account = acct.id;
        await deps.saveTenantConfig(c, { ...cfg, payments: { ...cfg.payments, stripeAccount: account } });
      }
      const o = deps.origin(c);
      const link = await stripe<{ url: string }>("POST", "/v1/account_links", {
        account, type: "account_onboarding", refresh_url: `${o}/app/payments?stripe=refresh`, return_url: `${o}/app/payments?stripe=done`,
      });
      return c.json({ url: link.url, account });
    } catch (e: any) {
      return c.json({ error: `Stripe: ${e.message}` }, 422);
    }
  });

  app.get("/cards/status", deps.requireAdmin, async (c) => {
    const account = deps.tenantConfig(c).payments?.stripeAccount as string | undefined;
    if (!cardsEnabled() || !account) return c.json({ enabled: cardsEnabled(), account: account ?? null, chargesEnabled: false, detailsSubmitted: false });
    try {
      const a = await stripe<{ charges_enabled: boolean; details_submitted: boolean }>("GET", `/v1/accounts/${account}`);
      return c.json({ enabled: true, account, chargesEnabled: a.charges_enabled, detailsSubmitted: a.details_submitted, testMode: process.env.STRIPE_SECRET_KEY!.startsWith("sk_test") });
    } catch (e: any) {
      return c.json({ error: `Stripe: ${e.message}` }, 422);
    }
  });

  // ---- licensee: pay by card
  const Body = z.object({ typeKey: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/), wallet: z.string().refine(isAddress), work: z.string().trim().min(1).max(200) });

  /** Shared checks: registered asset, standard (not by-request) type, licensee verified on chain, issuer's Stripe live. */
  async function context(c: any, typeKey: string, wallet: Address) {
    const a = await deps.publicAsset(c, c.req.param("id"));
    if (!a?.ip?.registered) return { ok: false as const, err: c.json({ error: "Not found" }, 404) };
    const typeId = a.ip.registered.types?.[typeKey];
    if (!typeId) return { ok: false as const, err: c.json({ error: "That license type isn't published" }, 404) };
    const net = networkById(a.chainId);
    const ip = ipFor(net);
    if (!net || !ip) return { ok: false as const, err: c.json({ error: "The IP registry isn't on this network" }, 409) };
    const issuer = await deps.issuerConfig(a.tenantId);
    const account = issuer?.payments?.stripeAccount as string | undefined;
    if (!cardsEnabled() || !account) return { ok: false as const, err: c.json({ error: "This rights holder doesn't take card payments yet" }, 409) };
    const pc = publicFor(net);
    const t = await pc.readContract({ address: ip.licenses, abi: licensesAbi, functionName: "licenseType", args: [BigInt(typeId)] });
    if (!t.active || t.byRequest) return { ok: false as const, err: c.json({ error: "This license can't be bought directly" }, 409) };
    const until = Number(await pc.readContract({ address: ip.licenses, abi: licensesAbi, functionName: "verifiedUntil", args: [t.assetId, wallet] }));
    if (until < Date.now() / 1000) return { ok: false as const, err: c.json({ error: "Get verified by the rights holder first" }, 403) };
    const signer = verifierKey() ? privateKeyToAccount((verifierKey().startsWith("0x") ? verifierKey() : `0x${verifierKey()}`) as Hex) : null;
    if (!signer) return { ok: false as const, err: c.json({ error: "Card receipts aren't set up on this platform" }, 503) };
    const allowed = await pc.readContract({ address: ip.licenses, abi: licensesAbi, functionName: "verifier", args: [t.assetId, signer.address] });
    if (!allowed) return { ok: false as const, err: c.json({ error: "The rights holder hasn't switched on card payments for this asset" }, 409) };
    const dec = net.stable?.decimals ?? 6;
    // Fee token units → US cents (stablecoins are 1:1 USD).
    const cents = dec >= 2 ? t.fee / 10n ** BigInt(dec - 2) : t.fee * 10n ** BigInt(2 - dec);
    return { ok: true as const, a, net, ip, t, typeId: BigInt(typeId), account, signer, cents, dec };
  }

  app.post("/ip/:id/card-checkout", async (c) => {
    if (deps.tooMany(`cardco:${deps.ipKey(c)}`, 10, 10 * 60_000)) return c.json({ error: "Too many requests" }, 429);
    const b = Body.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "typeKey, wallet and work required" }, 400);
    const wallet = getAddress(b.data.wallet);
    try {
      const x = await context(c, b.data.typeKey, wallet);
      if (!x.ok) return x.err;
      if (x.cents < 50n) return c.json({ error: "Card payments need a fee of at least $0.50" }, 409);
      const o = deps.origin(c);
      const s = await stripe<{ id: string; url: string }>("POST", "/v1/checkout/sessions", {
        mode: "payment",
        "line_items[0][quantity]": "1",
        "line_items[0][price_data][currency]": "usd",
        "line_items[0][price_data][unit_amount]": x.cents.toString(),
        "line_items[0][price_data][product_data][name]": `${x.t.name} license: ${x.a.name}`,
        "metadata[asset]": x.a.id, "metadata[typeId]": x.typeId.toString(), "metadata[wallet]": wallet,
        "metadata[termsHash]": x.t.termsHash, "metadata[chainId]": String(x.net.id),
        "payment_intent_data[metadata][asset]": x.a.id, "payment_intent_data[metadata][wallet]": wallet,
        success_url: `${o}/ip/${x.a.id}/license/${b.data.typeKey}?paid={CHECKOUT_SESSION_ID}`,
        cancel_url: `${o}/ip/${x.a.id}/license/${b.data.typeKey}`,
      }, x.account);
      return c.json({ url: s.url });
    } catch (e: any) {
      console.error("[cards] checkout", e?.message);
      return c.json({ error: `Couldn't start card checkout: ${e?.message}` }, 422);
    }
  });

  app.post("/ip/:id/card-receipt", async (c) => {
    if (deps.tooMany(`cardrc:${deps.ipKey(c)}`, 20, 10 * 60_000)) return c.json({ error: "Too many requests" }, 429);
    const b = z.object({ session: z.string().regex(/^cs_[A-Za-z0-9_]{6,200}$/), wallet: z.string().refine(isAddress), typeKey: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/) }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "session, wallet and typeKey required" }, 400);
    const wallet = getAddress(b.data.wallet);
    try {
      const x = await context(c, b.data.typeKey, wallet);
      if (!x.ok) return x.err;
      const s = await stripe<{ id: string; payment_status: string; amount_total: number; currency: string; metadata: Record<string, string> }>("GET", `/v1/checkout/sessions/${b.data.session}`, undefined, x.account);
      const m = s.metadata ?? {};
      if (s.payment_status !== "paid") return c.json({ error: "Stripe hasn't confirmed this payment yet" }, 409);
      if (m.asset !== x.a.id || m.typeId !== x.typeId.toString() || (m.wallet ?? "").toLowerCase() !== wallet.toLowerCase() || m.termsHash !== x.t.termsHash) {
        return c.json({ error: "That payment is for a different license or wallet" }, 409);
      }
      if (s.currency !== "usd" || BigInt(s.amount_total) < x.cents) return c.json({ error: "The payment doesn't cover the fee" }, 409);
      const paymentRef = keccak256(toHex(`stripe:${x.account}:${s.id}`));
      const used = await publicFor(x.net).readContract({ address: x.ip.licenses, abi: licensesAbi, functionName: "receiptUsed", args: [paymentRef] });
      if (used) return c.json({ error: "This payment already issued a license" }, 409);
      const dec = x.dec;
      const amount = dec >= 2 ? BigInt(s.amount_total) * 10n ** BigInt(dec - 2) : BigInt(s.amount_total) / 10n ** BigInt(2 - dec);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 24 * 3600);
      const sig = await x.signer.signTypedData({
        domain: { name: "Diamondz License", version: "1", chainId: x.net.id, verifyingContract: x.ip.licenses },
        types: { CardReceipt: [
          { name: "typeId", type: "uint256" }, { name: "licensee", type: "address" }, { name: "termsHash", type: "bytes32" },
          { name: "paymentRef", type: "bytes32" }, { name: "amount", type: "uint256" }, { name: "deadline", type: "uint64" },
        ] },
        primaryType: "CardReceipt",
        message: { typeId: x.typeId, licensee: wallet, termsHash: x.t.termsHash, paymentRef, amount, deadline },
      });
      return c.json({ receipt: { paymentRef, amount: amount.toString(), deadline: deadline.toString(), sig }, typeId: x.typeId.toString(), termsHash: x.t.termsHash });
    } catch (e: any) {
      console.error("[cards] receipt", e?.message);
      return c.json({ error: `Couldn't confirm the payment: ${e?.message}` }, 422);
    }
  });
}
