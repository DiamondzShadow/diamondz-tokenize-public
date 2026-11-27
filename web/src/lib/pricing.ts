// Platform pricing (shared by the web app and the API). DRAFT numbers: change here, both sides follow.
// No fee is a percentage of money raised: a % of securities sales is transaction-based compensation,
// which points to broker-dealer activity. Monthly + setup + a flat per-offering fee avoids that.

export type PlanId = "free" | "launch" | "growth" | "whitelabel";

export interface Plan {
  id: PlanId;
  name: string;
  forWho: string;
  setupUsd: number;
  monthlyUsd: number;
  /** Flat fee per offering deployed to a mainnet, paid on-chain to the platform Safe. Testnets are free. */
  offeringFeeUsd: number;
  liveOfferings: number | null; // null = unlimited
  features: string[];
  /** Free plan: test networks only; real networks need a paid plan. */
  testnetOnly?: boolean;
}

export const ANNUAL_DISCOUNT = 0.15; // pay yearly: 15% off the monthly price

export const PLANS: Plan[] = [
  {
    id: "launch",
    name: "Launch",
    forWho: "A single issuer bringing its first asset on chain",
    setupUsd: 1_500,
    monthlyUsd: 299,
    offeringFeeUsd: 1_000,
    liveOfferings: 2,
    features: ["Investor site on our domain", "Every network and token standard", "Marketplace listing", "Unlimited testnet practice", "Email support"],
  },
  {
    id: "growth",
    name: "Growth",
    forWho: "Issuers and sponsors running several offerings",
    setupUsd: 5_000,
    monthlyUsd: 999,
    offeringFeeUsd: 750,
    liveOfferings: 10,
    features: ["Everything in Launch", "Your logo, colors and theme", "25% off each offering fee", "Priority support"],
  },
  {
    id: "whitelabel",
    name: "White-label",
    forWho: "Platforms, brokers and funds reselling tokenization under their own brand",
    setupUsd: 15_000,
    monthlyUsd: 2_999,
    offeringFeeUsd: 500,
    liveOfferings: null,
    features: ["Everything in Growth", "Your own domain", "Hide “Powered by Diamondz”", "50% off each offering fee", "Unlimited offerings", "Dedicated onboarding"],
  },
];

/** Self-serve sign-ups start here (owner decision 2026-11-18): free forever on test networks, plus a 14-day Growth trial.
 *  Not in PLANS (the paid list) until the sign-up screens ship. */
export const FREE_PLAN: Plan = {
  id: "free",
  name: "Free",
  forWho: "Try everything on test networks",
  setupUsd: 0,
  monthlyUsd: 0,
  offeringFeeUsd: 0,
  liveOfferings: 0,
  features: ["Full console on test networks", "Unlimited demo offerings", "14 days of Growth features", "Upgrade any time to go live"],
  testnetOnly: true,
};
export const TRIAL_DAYS = 14;

// Unknown or missing plan ids fall back to Launch, as before (existing tenants were created on Launch).
export const planById = (id: string | undefined) => (id === "free" ? FREE_PLAN : PLANS.find((p) => p.id === id) ?? PLANS[0]!);
