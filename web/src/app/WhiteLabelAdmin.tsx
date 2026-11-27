// Platform admin › White-label sites (design W6, approved 2026-11-27): every white-label customer's domain,
// certificate, email and legal-page status, the Cloudflare for SaaS connection, and a recheck.
import { useEffect, useState } from "react";
import { api, type WlAdmin } from "../lib/api";

const certTag = (s: WlAdmin["sites"][number]): [string, string] => {
  const d = s.domain;
  if (!d) return ["", "No domain"];
  if (d.cfStatus === "active" && d.ssl === "active") return ["g", d.answers ? "Active" : "Active · site not answering"];
  if (!d.cname.found) return ["", "DNS points elsewhere"];
  return ["y", "Being issued"];
};

export default function WhiteLabelAdmin() {
  const [d, setD] = useState<WlAdmin | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const load = () => api.platformWhitelabel().then(setD, (e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const run = async (k: string, fn: () => Promise<unknown>) => { setBusy(k); setErr(""); try { await fn(); await load(); } catch (e) { setErr((e as Error).message); } finally { setBusy(""); } };
  const fallbackOk = d?.fallback?.status === "active";
  return (
    <>
      <div className="topbar"><h1>White-label sites</h1></div>
      <div className="content">
        <div className="es-conn">
          <span className={`es-dot ${d?.cfConnected && fallbackOk ? "ok" : ""}`} />
          {!d ? "Checking Cloudflare…" : !d.cfConnected ? "Cloudflare for SaaS isn't connected: add CF_API_TOKEN and CF_ZONE_ID to the server" : fallbackOk ? `Cloudflare for SaaS connected · ${d.target} · ${d.sites.filter((s) => s.domain).length} custom domains` : `Cloudflare connected · fallback origin ${d.fallback ? d.fallback.status : "not set"}`}
          {d?.cfConnected && !fallbackOk && <button className="btn primary sm" disabled={!!busy} onClick={() => run("setup", api.wlSetup)}>{busy === "setup" ? "Setting up…" : `Set up ${d.target}`}</button>}
        </div>
        {err && <div className="notice err" role="alert">{err}</div>}
        <div className="panel" style={{ padding: 0, overflowX: "auto" }}>
          <table className="es-table">
            <thead><tr><th>Customer</th><th>Domain</th><th>Certificate</th><th>Email</th><th>Legal pages</th><th>Setup</th><th>Site</th></tr></thead>
            <tbody>
              {!d ? <tr><td colSpan={7} className="muted">Loading…</td></tr> : !d.sites.length ? <tr><td colSpan={7} className="muted">No white-label customers yet.</td></tr> : d.sites.map((s) => {
                const [cc, cl] = certTag(s);
                const recs = s.email?.records ?? [];
                return (
                  <tr key={s.tenantId}>
                    <td>{s.name}<br /><span className="muted" style={{ fontSize: 12 }}>{s.plan === "whitelabel" ? "White-label plan" : `${s.plan} plan`}</span></td>
                    <td>{s.domain?.name ?? <span className="muted">—</span>}</td>
                    <td><span className={`tag ${cc} es-tag`}>{cl}</span></td>
                    <td>{!s.email ? <span className="muted">Not started</span> : s.email.status === "verified" ? <span className="tag g es-tag">Verified</span> : <span className="tag y es-tag">{recs.filter((r) => r.status === "verified").length} of {recs.length} records</span>}</td>
                    <td>{s.legal.filter((p) => p.published).length} live</td>
                    <td>{s.done} of {s.total}</td>
                    <td>{s.live && s.domain ? <a href={`https://${s.domain.name}`} target="_blank" rel="noreferrer">Live ↗</a> : <span className="muted">Preview only</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <button type="button" className="btn ghost sm" disabled={!!busy} onClick={() => run("recheck", api.wlRecheck)}>{busy === "recheck" ? "Rechecking…" : "Recheck all domains"}</button>
          <span className="muted" style={{ fontSize: 13 }}>Customers on the White-label plan see the setup page. Change a plan in each workspace's Plan &amp; billing.</span>
        </div>
      </div>
    </>
  );
}
