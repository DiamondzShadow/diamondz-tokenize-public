// Proof of asset UI (Figma "Verified panel" frames 07–11): status card, full panel, marketplace badge.
// Data: GET /api/proof/:assetId (refreshed server-side every ~2 minutes; we poll every 60s while the page is open).
import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { api, type Proof, type ProofCheck, type ProofFeed } from "./api";
import { addrUrl, networkById, txUrl } from "./chains";
import { CLASS_CHECKS } from "./verification";
import type { AssetClassId } from "./catalog";

export type ProofState = "ok" | "warn" | "bad" | "none" | "off";

export function useProof(assetId: string | undefined, pollMs = 60_000) {
  const [proof, setProof] = useState<Proof | null>(null);
  useEffect(() => {
    if (!assetId) return;
    let live = true;
    const load = () => api.proof(assetId).then((p) => live && setProof(p), () => {});
    load();
    const t = pollMs ? setInterval(load, pollMs) : undefined;
    return () => {
      live = false;
      if (t) clearInterval(t);
    };
  }, [assetId, pollMs]);
  return proof;
}

/** Overall state: ok = verified · bad = a check failed · warn = something expired/missing · none = no checks signed yet · off = not on this network. */
export function proofState(p: Proof | null): ProofState {
  if (!p || !p.oracle) return "off";
  if (p.verified) return "ok";
  if (p.checks.some((c) => c.status === "failed")) return "bad";
  if (!p.registered || p.checks.every((c) => c.status === "missing")) return "none";
  return "warn";
}

const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");
export function ago(iso: string) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} days ago`;
}
const daysLeft = (iso?: string) => (iso ? Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000) : 0);
const isHttp = (u?: string) => !!u && /^https:\/\//.test(u);

const STATUS: Record<ProofCheck["status"], { cls: string; icon: string; label: string }> = {
  current: { cls: "ok", icon: "✓", label: "CURRENT" },
  expiring: { cls: "warn", icon: "!", label: "EXPIRING" },
  expired: { cls: "warn", icon: "!", label: "EXPIRED" },
  failed: { cls: "bad", icon: "✕", label: "FAILED" },
  missing: { cls: "no", icon: "–", label: "NOT SIGNED" },
  "verifier-removed": { cls: "warn", icon: "!", label: "VERIFIER REMOVED" },
};

function checkValue(c: ProofCheck) {
  if (!c.value) return "";
  if (c.valueUnit === "usd-cents") return `$${Number(BigInt(c.value) / 100n).toLocaleString()}`;
  return Number(c.value).toLocaleString();
}

export function feedValue(f: ProofFeed) {
  const n = Number(formatUnits(BigInt(f.value), f.decimals));
  if (f.unit === "usd") return `$${n.toLocaleString(undefined, { maximumFractionDigits: n >= 1000 ? 0 : 2 })}`;
  if (f.unit === "bps") return `${(n / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
  return n.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

/** Headline for the current state (shared by the panel and the right-hand card). */
function headline(p: Proof, state: ProofState, required: number) {
  const current = p.checks.filter((c) => c.status === "current" || c.status === "expiring").length;
  const failed = p.checks.find((c) => c.status === "failed");
  const lapsed = p.checks.find((c) => c.status === "expired" || c.status === "verifier-removed" || c.status === "missing");
  const sales = p.gated;
  switch (state) {
    case "ok":
      return { title: "Verified", body: `All ${required} independent checks are current.${sales ? " Sales are open." : ""}`, short: `Verified · ${current} of ${required} checks current` };
    case "bad":
      return {
        title: sales ? "Check failed: sales stopped" : "Check failed",
        body: `${failed!.verifier?.name ?? "A verifier"} reported a problem with ${failed!.name.toLowerCase()} on ${fmtDate(failed!.attestedAt)}. Only that verifier can clear it.`,
        short: `Check failed · ${failed!.name.toLowerCase()}`,
      };
    case "warn":
      return {
        title: sales ? "Sales paused: a check isn't current" : "Not fully verified",
        body: lapsed?.status === "expired"
          ? `${lapsed.name} expired on ${fmtDate(lapsed.validUntil)}.${sales ? " Purchases reopen when an approved verifier signs a new one." : ""}`
          : `${lapsed?.name ?? "A check"} needs a current signature from an approved verifier.${sales ? " Purchases reopen once it's signed." : ""}`,
        short: sales ? `Sales paused · ${lapsed?.name.toLowerCase() ?? "check"} ${lapsed?.status === "expired" ? "expired" : "pending"}` : `${current} of ${required} checks current`,
      };
    case "none":
      return {
        title: p.registered ? "Awaiting independent checks" : "Not registered for independent checks",
        body: p.registered
          ? `None of the ${required} required checks has been signed yet.${sales ? " Sales open once all of them are current." : ""}`
          : "This offering was deployed before proof of asset and isn't registered for independent checks. On-chain checks below still run.",
        short: p.registered ? `Awaiting checks · 0 of ${required}` : "Not registered for checks",
      };
    default:
      return { title: "Proof of asset", body: p.error ?? "Not available on this network yet.", short: "Proof of asset not live on this network" };
  }
}

const ICON: Record<ProofState, string> = { ok: "✓", warn: "!", bad: "✕", none: "–", off: "–" };

/** Small card for the top of the right column, and the reason Buy is locked. */
export function VerifiedCard({ proof, assetClass }: { proof: Proof | null; assetClass: AssetClassId }) {
  if (!proof) return null;
  const state = proofState(proof);
  const h = headline(proof, state, CLASS_CHECKS[assetClass]?.length ?? proof.checks.length);
  return (
    <div className="panel">
      <span className={`vb ${state}`}>{ICON[state]} {h.short}</span>
      <span className="muted" style={{ fontSize: 13 }}>
        {proof.gated
          ? "Sales on this offering only run while every required independent check is current."
          : proof.oracle
            ? "Shown for information: this offering's sale isn't gated by verification."
            : h.body}{" "}
        <a href="#proof" className="lnk">See proof of asset</a>
      </span>
    </div>
  );
}

/** Why Buy is locked, or "" when verification isn't blocking it. */
export function lockReason(proof: Proof | null): string {
  if (!proof?.gated || proof.verified) return "";
  const state = proofState(proof);
  if (state === "bad") return "Purchases are stopped while a verifier-reported problem is open. Tokens you already hold aren't affected.";
  if (state === "none") return "Purchases open once every required independent check has been signed.";
  return "Purchases are paused until every required check is current again.";
}

export function ProofBadge({ proof, assetClass }: { proof: Proof | null; assetClass: AssetClassId }) {
  if (!proof) return <span className="vb none">Checking…</span>;
  const state = proofState(proof);
  if (state === "off") return null;
  const required = CLASS_CHECKS[assetClass]?.length ?? proof.checks.length;
  const current = proof.checks.filter((c) => c.status === "current" || c.status === "expiring").length;
  const label =
    state === "ok" ? `Verified · ${current}/${required}` :
    state === "bad" ? "Failed" :
    state === "none" ? (proof.registered ? `Awaiting checks · 0/${required}` : "Not registered") :
    proof.gated ? `Paused · ${current}/${required}` : `${current}/${required} current`;
  return <span className={`vb ${state}`}>{ICON[state]} {label}</span>;
}

export function ProofPanel({ proof, assetClass, className }: { proof: Proof | null; assetClass: AssetClassId; className?: string }) {
  if (!proof) return <div className={`panel ${className ?? ""}`} id="proof"><h3 style={{ fontSize: 20 }}>Proof of asset</h3><span className="muted">Reading the chain…</span></div>;
  const net = networkById(proof.chainId);
  const state = proofState(proof);
  const required = CLASS_CHECKS[assetClass]?.length ?? proof.checks.length;
  const h = headline(proof, state, required);
  return (
    <div className={`panel proof ${className ?? ""}`} id="proof">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
        <h3 style={{ fontSize: 20 }}>Proof of asset</h3>
        <span className="muted" style={{ fontSize: 13 }}>What independent parties have confirmed, recorded on chain</span>
      </div>

      <div className={`vstat ${state}`}>
        <div className="vbadge">{ICON[state]}</div>
        <div><b>{h.title}</b><span>{h.body}</span></div>
        <div className="r">Checked on chain<br />{ago(proof.checkedAt)}</div>
      </div>

      {proof.oracle && proof.checks.length > 0 && (
        <>
          <div className="sub">Independent checks · {required} required</div>
          <div>
            {proof.checks.map((c) => {
              const s = STATUS[c.status];
              const days = daysLeft(c.validUntil);
              const val = checkValue(c);
              return (
                <div className="chk" key={c.kind}>
                  <div className={`ci ${s.cls}`}>{s.icon}</div>
                  <div style={{ minWidth: 0 }}>
                    <b>{c.name}</b>
                    <p>{c.confirms}{val ? ` Value: ${val}.` : ""}</p>
                    {c.verifier
                      ? <div className="who">Signed by <em>{c.verifier.name}</em> <a className="addr" href={net ? addrUrl(net, c.verifier.address) : undefined} target="_blank" rel="noreferrer">{c.verifier.address}</a></div>
                      : <div className="who muted">No approved verifier has signed this yet</div>}
                  </div>
                  <div className="meta">
                    <span className={`st ${s.cls}`}>{s.label}</span>
                    {c.attestedAt && <span>Signed {fmtDate(c.attestedAt)}</span>}
                    {c.validUntil && (
                      <span>{c.status === "failed" ? `Stands until ${fmtDate(c.validUntil)}` : days < 0 ? `Expired ${fmtDate(c.validUntil)}` : days <= 14 ? `Expires in ${days} day${days === 1 ? "" : "s"}` : `Valid until ${fmtDate(c.validUntil)}`}</span>
                    )}
                    {isHttp(c.evidenceURI) && <a className="lnk" href={c.evidenceURI} target="_blank" rel="noreferrer">Evidence ↗</a>}
                    {c.tx && net && <a className="lnk" href={txUrl(net, c.tx)} target="_blank" rel="noreferrer">Transaction ↗</a>}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {proof.feeds.length > 0 && (
        <>
          <div className="sub">Live market data <span className="cl"><i />Chainlink</span></div>
          <div className="feeds">
            {proof.feeds.map((f) => (
              <div className="feed" key={f.metric}>
                <span>{f.label}</span>
                <b>{feedValue(f)}</b>
                <small>{ago(f.observedAt)}</small>
                <span className="cl"><i />Chainlink CRE</span>
              </div>
            ))}
          </div>
          <p className="note">Market data shows how comparable assets are moving. It doesn't replace the independent checks.</p>
        </>
      )}

      {proof.live.length > 0 && (
        <>
          <div className="sub">On-chain checks · every 2 minutes</div>
          <div>
            {proof.live.map((l) => (
              <div className="lv" key={l.id}>
                <span>{l.label}</span>
                <span className={l.ok === true ? "y" : l.ok === false ? "n" : ""} style={{ textAlign: "right" }}>{l.ok === true ? "✓ " : l.ok === false ? "✕ " : ""}{l.detail}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {net && (proof.oracle || net.creFeed) && (
        <div className="mini">
          {proof.oracle && <a className="addr" href={addrUrl(net, proof.oracle)} target="_blank" rel="noreferrer">Proof-of-asset oracle {proof.oracle}</a>}
          {net.creFeed && <a className="addr" href={addrUrl(net, net.creFeed)} target="_blank" rel="noreferrer">Chainlink feed receiver {net.creFeed}</a>}
        </div>
      )}
    </div>
  );
}
