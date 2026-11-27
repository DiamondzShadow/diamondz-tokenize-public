import { useState } from "react";
import { Link } from "react-router-dom";
import { ANNUAL_DISCOUNT, FREE_PLAN, PLANS, TRIAL_DAYS, type Plan } from "../lib/pricing";
import { useTenant } from "../lib/tenant";
import { SiteHeader } from "../lib/Chrome";

const usd = (n: number) => `$${Math.round(n).toLocaleString()}`;

export function PlanCards({ annual, current, cta, plans = PLANS }: { annual: boolean; current?: string; cta?: (p: Plan) => React.ReactNode; plans?: Plan[] }) {
  return (
    <div className="pay-grid" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${plans.length > 3 ? 230 : 260}px, 1fr))` }}>
      {plans.map((p) => {
        const monthly = annual ? p.monthlyUsd * (1 - ANNUAL_DISCOUNT) : p.monthlyUsd;
        const off = p.testnetOnly ? 0 : Math.round((1 - p.offeringFeeUsd / PLANS[0]!.offeringFeeUsd) * 100);
        return (
          <div key={p.id} className="pay" style={p.id === "growth" ? { borderColor: "var(--brand)" } : undefined}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h3>{p.name}</h3>
              {current === p.id ? <span className="tag g">Your plan</span> : p.id === "growth" ? <span className="tag">Popular</span> : null}
            </div>
            <p>{p.forWho}</p>
            <div>
              <b style={{ fontFamily: "var(--font-display)", fontSize: 36 }}>{usd(monthly)}</b>
              <span className="muted">{p.testnetOnly ? " forever" : ` / month${annual ? ", billed yearly" : ""}`}</span>
            </div>
            {p.testnetOnly ? (
              <>
                <div className="li"><span className="muted">Networks</span><span>Test only</span></div>
                <div className="li"><span className="muted">Demo offerings</span><span>Unlimited</span></div>
                <div className="li"><span className="muted">Growth trial</span><span>{TRIAL_DAYS} days</span></div>
              </>
            ) : (
              <>
                <div className="li"><span className="muted">One-time setup</span><span>{usd(p.setupUsd)}</span></div>
                <div className="li"><span className="muted">Per mainnet offering</span><span>{usd(p.offeringFeeUsd)}{off > 0 && <span className="tag g" style={{ marginLeft: 8 }}>{off}% off</span>}</span></div>
                <div className="li"><span className="muted">Live offerings</span><span>{p.liveOfferings ?? "Unlimited"}</span></div>
              </>
            )}
            <div className="checks" style={{ fontSize: 14 }}>{p.features.map((f) => <div key={f}>{f}</div>)}</div>
            {cta?.(p)}
          </div>
        );
      })}
    </div>
  );
}

export function BillingToggle({ annual, onChange }: { annual: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="bill-toggle" role="radiogroup" aria-label="Billing period">
      <button type="button" role="radio" aria-checked={!annual} className={!annual ? "on" : ""} onClick={() => onChange(false)}>Monthly</button>
      <button type="button" role="radio" aria-checked={annual} className={annual ? "on" : ""} onClick={() => onChange(true)}>Yearly · save {Math.round(ANNUAL_DISCOUNT * 100)}%</button>
    </div>
  );
}

export default function Pricing() {
  const [annual, setAnnual] = useState(false);
  const { tenant } = useTenant();
  // The main site offers the self-serve Free plan (design S5); white-label sites list the paid plans only.
  const platform = !tenant || tenant.id === "diamondz";
  return (
    <div className="page">
      <SiteHeader />
      <section className="wrap section" style={{ paddingTop: 56 }}>
        <div className="section-head">
          <span className="eyebrow">Pricing</span>
          <h2>Simple, flat pricing</h2>
          <p>{platform ? "Start free on test networks. Pay only when you take an offering live. We never take a percentage of what you raise." : "A monthly plan, a one-time setup, and a flat fee per offering you take live. We never take a percentage of what you raise. Practicing on testnets is always free."}</p>
        </div>
        <BillingToggle annual={annual} onChange={setAnnual} />
        <PlanCards annual={annual} plans={platform ? [FREE_PLAN, ...PLANS] : PLANS} cta={(p) => p.testnetOnly
          ? <Link className="btn primary sm" to="/start" style={{ justifyContent: "center" }}>Start free</Link>
          : <Link className={`btn sm ${platform ? "ghost" : p.id === "growth" ? "primary" : "ghost"}`} to={`/?plan=${p.id}&billing=${annual ? "yearly" : "monthly"}#contact`} style={{ justifyContent: "center" }}>Choose {p.name}</Link>} />
        <p className="muted" style={{ fontSize: 13 }}>
          The per-offering fee is paid in stablecoin when an offering is deployed to a live network. Network gas fees are paid by your wallet. Prices in USD, excluding taxes.
        </p>
      </section>
    </div>
  );
}
