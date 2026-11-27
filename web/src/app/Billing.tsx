import { useEffect, useState } from "react";
import { api, type Asset, type PlanRequest } from "../lib/api";
import { FREE_PLAN, PLANS, planById } from "../lib/pricing";
import { useTenant } from "../lib/tenant";
import { BillingToggle, PlanCards } from "../pages/Pricing";
import { PageHelp } from "./onboarding";

export default function Billing() {
  const { tenant } = useTenant();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [annual, setAnnual] = useState(false);
  const [req, setReq] = useState<PlanRequest | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    api.assets().then(setAssets, () => {});
    api.planRequest().then((r) => { setReq(r.planRequest); if (r.planRequest) setAnnual(r.planRequest.annual); }, () => {});
  }, []);
  const ask = async (plan: string) => {
    setBusy(plan); setErr("");
    try { setReq((await api.requestPlan(plan, annual)).planRequest); } catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  };
  const cancel = async () => {
    setBusy("cancel"); setErr("");
    try { await api.cancelPlanRequest(); setReq(null); } catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  };
  if (!tenant) return null;
  const plan = tenant.plan;
  const live = assets.filter((a) => a.status === "deployed" && a.deployment?.feeTx).length;

  return (
    <>
      <div className="topbar"><h1>Plan &amp; billing</h1></div>
      <div className="content">
        <PageHelp
          id="billing"
          what="Your plan, what it costs, and how many live offerings you have. We never take a percentage of what you raise."
          next="Pick monthly or yearly, then choose a plan to request the switch. We confirm by email and switch it, usually within one business day."
        />
        <div className="panel">
          <h3>Current plan: {plan.name}</h3>
          <div className="li"><span className="muted">Monthly</span><span>${plan.monthlyUsd.toLocaleString()}</span></div>
          <div className="li"><span className="muted">One-time setup</span><span>${plan.setupUsd.toLocaleString()}</span></div>
          <div className="li"><span className="muted">Per mainnet offering</span><span>${plan.offeringFeeUsd.toLocaleString()} (paid on-chain at deploy)</span></div>
          <div className="li"><span className="muted">Live mainnet offerings</span><span>{live} of {plan.liveOfferings ?? "unlimited"}</span></div>
          <div className="notice">Card billing for the monthly and setup fees is coming soon. Until then we invoice you directly.</div>
        </div>
        {req && (
          <div className="notice">
            You asked to switch to <b>{planById(req.plan).name}</b>, billed {req.annual ? "yearly" : "monthly"}, on {new Date(req.at).toLocaleDateString()}. We'll confirm by email.{" "}
            <button className="btn link" style={{ padding: 0, height: "auto", display: "inline" }} disabled={busy === "cancel"} onClick={cancel}>Cancel request</button>
          </div>
        )}
        {err && <div className="notice err">{err}</div>}
        <BillingToggle annual={annual} onChange={setAnnual} />
        <PlanCards annual={annual} current={plan.id} plans={plan.testnetOnly ? [FREE_PLAN, ...PLANS] : PLANS} cta={(p) =>
          p.id === plan.id ? <span className="plan-status">You're on this plan</span>
            : req?.plan === p.id && req.annual === annual ? <span className="plan-status">Requested · we'll confirm by email</span>
              : <button className={`btn sm ${p.monthlyUsd > plan.monthlyUsd ? "primary" : "ghost"}`} style={{ justifyContent: "center" }} disabled={!!busy} onClick={() => ask(p.id)}>
                  {busy === p.id ? "Sending…" : `${p.monthlyUsd > plan.monthlyUsd ? "Upgrade" : "Switch"} to ${p.name}`}
                </button>} />
      </div>
    </>
  );
}
