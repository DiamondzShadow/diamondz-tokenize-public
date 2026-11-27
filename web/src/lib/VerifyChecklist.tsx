// "Before you can invest" (design K1): what's left before a wallet can buy, in order, each step started in place.
// Shown in the listing's Invest panel while the wallet isn't approved for the offering. Approval itself is always a
// manual issuer action.
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, type AccreditationPublic } from "./api";
import { useKycStatus } from "./kyc";
import { useTenant } from "./tenant";

type StepState = "done" | "now" | "wait" | "bad";
const accKey = (assetId: string, wallet: string) => `accredit:${assetId}:${wallet.toLowerCase()}`;

export default function VerifyChecklist({ assetId, issuerId, wallet, sanctioned, accreditationRequired = true }: { assetId: string; issuerId?: string; wallet: string; sanctioned: boolean; accreditationRequired?: boolean }) {
  const { tenant } = useTenant();
  const { status: kyc } = useKycStatus(issuerId ?? tenant?.id, wallet);
  const [kycOn, setKycOn] = useState<boolean | null>(null);
  const [acc, setAcc] = useState<AccreditationPublic | null>(null);
  useEffect(() => { api.kycConfig().then((c) => setKycOn(c.enabled), () => setKycOn(false)); }, []);
  useEffect(() => {
    let id: string | null = null;
    try { id = localStorage.getItem(accKey(assetId, wallet)); } catch { /* none */ }
    if (id) api.accreditationStatus(id, wallet).then(setAcc, () => setAcc(null)); else setAcc(null);
  }, [assetId, wallet]);

  const k = kyc?.status;
  const idState: StepState = k === "approved" ? "done" : k === "rejected" ? "bad" : "now";
  const accState: StepState = acc?.decision === "approved" ? "done" : acc?.decision === "declined" ? "bad" : acc?.status === "ready" || acc?.status === "reporting" ? "wait" : "now";
  const steps: { title: string; body: string; state: StepState; action?: ReactNode }[] = [
    { title: "Wallet connected", body: sanctioned ? "This wallet is on a sanctions list and can't invest." : "Screened against U.S. sanctions lists", state: sanctioned ? "bad" : "done" },
    {
      title: "Verify your identity",
      body: kycOn === false ? "Identity checks are being set up. The issuer can verify you directly in the meantime."
        : k === "approved" ? "Verified by Sumsub"
        : k === "pending" ? "Sumsub is checking your documents. Usually a few minutes."
        : k === "retry" ? "Sumsub needs another photo."
        : k === "rejected" ? "We couldn't verify your identity. Contact the issuer."
        : "Photo ID and a short selfie video, checked by Sumsub. About 3 minutes.",
      state: kycOn === false ? "wait" : k === "pending" ? "wait" : idState,
      action: kycOn !== false && (k === undefined || k === null || k === "init" || k === "retry")
        ? <Link className="btn primary sm" to={`/verify/${assetId}`}>{k === "retry" ? "Try again" : k === "init" ? "Continue" : "Verify identity"}</Link>
        : k === "pending" ? <Link className="btn link" to={`/verify/${assetId}`} style={{ fontSize: 13 }}>See status →</Link> : undefined,
    },
    ...(accreditationRequired ? [{
      title: "Show you're accredited",
      body: acc?.decision === "approved" ? "Approved by the issuer"
        : acc?.decision === "declined" ? "The issuer didn't accept this report."
        : acc?.status === "ready" ? "Report sent. The issuer is reviewing it."
        : acc?.status === "reporting" ? "Mastercard is preparing your report."
        : "Link your bank or brokerage through Mastercard. Required for this offering.",
      state: accState,
      action: accState === "now" ? <Link className="btn link" to={`/accredit/${assetId}`} style={{ fontSize: 14 }}>{acc ? "Continue →" : "Start now →"}</Link> : undefined,
    }] : []),
    { title: "Issuer approves your wallet", body: "Usually within 1 business day of the steps above. We'll show it here.", state: "wait" },
  ];
  const done = steps.filter((s) => s.state === "done").length;
  return (
    <div className="vcheck" aria-labelledby="vcheck-h">
      <div className="row between" style={{ alignItems: "baseline" }}>
        <h4 id="vcheck-h">Before you can invest</h4>
        <span className="muted" style={{ fontSize: 13 }}>{done} of {steps.length} done</span>
      </div>
      <p className="muted" style={{ fontSize: 13, lineHeight: 1.5, margin: 0 }}>Each offering checks who can buy. It takes about 5 minutes, and you only verify your identity once for this issuer.</p>
      <ol className="vsteps">
        {steps.map((s, i) => (
          <li key={s.title} className={`vstep ${s.state}`}>
            <span className="vdot" aria-hidden="true">{s.state === "done" ? "✓" : s.state === "bad" ? "!" : i + 1}</span>
            <div>
              <b>{s.title}</b>
              <span className="muted">{s.body}</span>
              {s.action && <div className="vact">{s.action}</div>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
