import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, type Asset, type Tenant } from "../lib/api";
import { useTenant } from "../lib/tenant";
import { networkById } from "../lib/chains";

// ------------------------------------------------------------------ setup checklist

export interface SetupStep {
  id: string;
  title: string;
  detail: string;
  done: boolean;
  /** Where the step is done. Omitted = coming soon or a manual tick. */
  to?: string;
  cta?: string;
  manual?: boolean;
  soon?: boolean;
}

/** Steps are derived from real tenant state and assets; nothing is faked as done. */
export function setupSteps(t: Tenant, assets: Asset[], kycOn = false): SetupStep[] {
  const ob = t.onboarding ?? {};
  return [
    { id: "brand", title: "Brand your investor site", detail: "Set the name, logo, colors and which asset types you offer. This is what investors see.", done: !!ob.brandingDone, to: "/app/branding", cta: "Open branding" },
    { id: "payments", title: "Set where money goes", detail: "Add the treasury multisig that receives raises, choose payment methods and the payout currency.", done: !!ob.paymentsDone && !!t.payments.treasury, to: "/app/payments", cta: "Open payments" },
    { id: "asset", title: "Create your first asset", detail: "Pick what you're tokenizing. We recommend the token standard and you fill in the terms. It saves as a draft.", done: assets.length > 0, to: "/app/new", cta: "Start" },
    { id: "counsel", title: "Lawyer signs each offering", detail: "Before an offering goes live, your securities lawyer signs off from a private link we email them, Stripe verifies your company, and Diamondz reviews both. Start it in Go live on the offering.", done: assets.some((a) => a.status === "deployed" && networkById(a.chainId)?.testnet === false), to: assets[0] ? `/app/assets/${assets[0].id}/go-live` : "/app/new", cta: "Open Go live" },
    { id: "kyc", title: "Investor identity checks", detail: kycOn
      ? "On: investors verify their identity (photo ID and a live selfie) on the offering page before they can buy. You see the result on Investors and approve their wallet."
      : "Being switched on by the platform. Until then, verify wallets manually on the asset page.", done: kycOn, soon: !kycOn },
    { id: "deploy", title: "Deploy on testnet, then go live", detail: "Open your asset and deploy it to a test network with play money. Deploy to mainnet only after sign-off.", done: assets.some((a) => a.status === "deployed"), to: assets[0] ? `/app/assets/${assets[0].id}` : "/app/new", cta: "Deploy" },
    { id: "list", title: "List it on your marketplace", detail: "Add a description and photo, switch the listing on, verify a test investor and make a practice purchase.", done: assets.some((a) => a.status === "deployed" && a.listed), to: assets.find((a) => a.status === "deployed") ? `/app/assets/${assets.find((a) => a.status === "deployed")!.id}` : undefined, cta: "List" },
  ];
}

export function SetupChecklist({ assets, onChanged }: { assets: Asset[]; onChanged?: () => void }) {
  const { tenant, setTenant } = useTenant();
  const [busy, setBusy] = useState(false);
  if (!tenant) return null;
  const [kycOn, setKycOn] = useState(false);
  useEffect(() => { api.kycConfig().then((k) => setKycOn(!!k.enabled), () => {}); }, []);
  const steps = setupSteps(tenant, assets, kycOn);
  const doneCount = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done && !s.soon);

  async function toggleCounsel(v: boolean) {
    setBusy(true);
    try {
      setTenant(await api.updateTenant({ onboarding: { ...tenant!.onboarding, counselReady: v } }));
      onChanged?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3>Get set up</h3>
        <span className="muted" style={{ fontSize: 13 }}>{doneCount} of {steps.length} done</span>
      </div>
      <div className="setup-bar"><i style={{ width: `${(doneCount / steps.length) * 100}%` }} /></div>
      {next && <p style={{ fontSize: 14 }}><span className="muted">Next up:</span> <b>{next.title}</b></p>}
      <div>
        {steps.map((s, i) => (
          <div key={s.id} className={`setup-step ${s.done ? "done" : ""} ${next?.id === s.id ? "next" : ""}`}>
            <span className="c">{s.done ? "✓" : i + 1}</span>
            <div className="t">
              <b>{s.title}</b>
              <small>{s.detail}</small>
            </div>
            <span className="act">
              {s.soon && !s.done && <span className="soon">Coming soon</span>}
              {s.to && !s.done && <Link className={`btn sm ${next?.id === s.id ? "primary" : "ghost"}`} to={s.to}>{s.cta} →</Link>}
              {s.to && s.done && <Link className="btn ghost sm" to={s.to}>Edit</Link>}
              {s.manual && (
                <button className="btn ghost sm" disabled={busy} onClick={() => toggleCounsel(!s.done)}>
                  {s.done ? "Undo" : "Mark done"}
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ per-page help

/** "What this page is for / what's next" strip. Collapsible; the choice is remembered per browser. */
export function PageHelp({ id, what, next }: { id: string; what: ReactNode; next: ReactNode }) {
  const key = `dt_help_hidden_${id}`;
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  const set = (v: boolean) => {
    setHidden(v);
    try {
      if (v) localStorage.setItem(key, "1");
      else localStorage.removeItem(key);
    } catch {
      /* storage blocked: preference lasts for this page view */
    }
  };
  if (hidden) return <a className="help-toggle" onClick={() => set(false)}>ⓘ What is this page?</a>;
  return (
    <div className="help">
      <div><span className="lbl">What this page is for</span>{what}</div>
      <div><span className="lbl">What's next</span>{next}</div>
      <a className="x" onClick={() => set(true)} aria-label="Hide help">×</a>
    </div>
  );
}

// ------------------------------------------------------------------ welcome tour

const TOUR = [
  { icon: "🏢", title: "Turn a real asset into tokens", body: "Tokens are digital shares of something real: a building, an oil royalty, a fund, a song. Investors buy them, and income from the asset is paid to them automatically." },
  { icon: "🛡️", title: "Only verified investors can hold them", body: "Every investor passes identity checks first. The token itself refuses transfers to anyone who isn't verified, and you can freeze or recover tokens if a court or a lost wallet requires it." },
  { icon: "💸", title: "Money in, income out", body: "Investors pay by card, bank transfer or stablecoin. When the asset earns money, the platform splits it across holders and pays them out." },
  { icon: "🧭", title: "Follow the checklist", body: "Your dashboard has a setup checklist that ticks itself off as you go. Start with your branding, then where money goes, then your first asset. You can reopen this tour from the Guide anytime." },
];

const TOUR_KEY = "dt_tour_seen";
export function tourSeen(): boolean {
  try {
    return localStorage.getItem(TOUR_KEY) === "1";
  } catch {
    return true; // storage blocked: don't nag on every load
  }
}

export function WelcomeTour({ onClose }: { onClose: () => void }) {
  const [i, setI] = useState(0);
  const close = () => {
    try {
      localStorage.setItem(TOUR_KEY, "1");
    } catch {
      /* ignore */
    }
    onClose();
  };
  const s = TOUR[i]!;
  const last = i === TOUR.length - 1;
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Welcome tour" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="modal">
        <div className="dots">{TOUR.map((_, j) => <i key={j} className={j === i ? "on" : ""} />)}</div>
        <span style={{ fontSize: 44 }}>{s.icon}</span>
        <h2>{s.title}</h2>
        <p>{s.body}</p>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <button className="btn ghost sm" onClick={i === 0 ? close : () => setI(i - 1)}>{i === 0 ? "Skip" : "← Back"}</button>
          <button className="btn primary sm" onClick={last ? close : () => setI(i + 1)}>{last ? "Show me the checklist" : "Next →"}</button>
        </div>
      </div>
    </div>
  );
}
