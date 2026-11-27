// Platform admin › Signing log (design E7, approved 2026-11-27). Every Adobe Acrobat Sign request across offerings,
// the Adobe connection, the approved verifier firms, and a retry for signed letters not yet recorded on chain.
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, type EsignPlatform } from "../lib/api";
import { networkById, txUrl } from "../lib/chains";
import { STATUS_TAG } from "./Esign";

const FILTERS = [
  ["all", "All"], ["open", "Out for signature"], ["unrecorded", "Signed, not yet on chain"], ["closed", "Declined or expired"],
] as const;
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");

export default function Signing() {
  const [d, setD] = useState<EsignPlatform | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>("all");
  const [firm, setFirm] = useState({ name: "", domain: "", kinds: [] as string[] });
  const load = () => api.platformEsign().then(setD, (e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const run = async (k: string, fn: () => Promise<unknown>) => { setBusy(k); setErr(""); try { await fn(); await load(); } catch (e) { setErr((e as Error).message); } finally { setBusy(""); } };
  const rows = useMemo(() => (d?.requests ?? []).filter((r) =>
    filter === "all" ? true : filter === "open" ? ["sent", "opened", "identity"].includes(r.status) : filter === "unrecorded" ? r.status === "signed" : ["declined", "expired", "canceled"].includes(r.status)), [d, filter]);
  const addFirm = (e: FormEvent) => { e.preventDefault(); run("firm", async () => { await api.esignAddFirm(firm); setFirm({ name: "", domain: "", kinds: [] }); }); };

  return (
    <>
      <div className="topbar"><h1>Signing log</h1></div>
      <div className="content">
        <div className="es-conn">
          <span className={`es-dot ${d?.configured && d.webhook ? "ok" : ""}`} />
          {!d ? "Checking Adobe Acrobat Sign…" : !d.configured ? "Adobe Acrobat Sign isn't connected: add the integration key to the server" : d.webhook ? `Adobe Acrobat Sign connected · Diamondz account · notifications registered ${fmt(d.webhook.at)}` : "Adobe Acrobat Sign connected · notifications not registered yet"}
          {d?.configured && !d.webhook && <button className="btn primary sm" disabled={!!busy} onClick={() => run("setup", api.esignSetup)}>{busy === "setup" ? "Registering…" : "Register notifications"}</button>}
        </div>
        {d && !d.attester && <div className="notice warn">The e-sign attester key isn't set on the server, so signed letters can't be recorded on chain yet.</div>}
        {err && <div className="notice err" role="alert">{err}</div>}

        <div className="row" role="group" aria-label="Filter" style={{ flexWrap: "wrap", gap: 8 }}>
          {FILTERS.map(([k, label]) => <button key={k} type="button" aria-pressed={filter === k} className={`es-chip ${filter === k ? "on" : ""}`} onClick={() => setFilter(k)}>{label}</button>)}
        </div>
        <div className="panel" style={{ padding: 0, overflowX: "auto" }}>
          <table className="es-table">
            <thead><tr><th>Offering</th><th>Document</th><th>Signer</th><th>Identity</th><th>Status</th><th>On chain</th><th><span className="sr">Actions</span></th></tr></thead>
            <tbody>
              {!d ? <tr><td colSpan={7} className="muted">Loading…</td></tr> : !rows.length ? <tr><td colSpan={7} className="muted">No signing requests here yet.</td></tr> : rows.map((r) => {
                const [cls, label] = STATUS_TAG[r.status] ?? ["", r.status];
                const net = networkById(r.chainId);
                return (
                  <tr key={r.id}>
                    <td>{r.offering}</td>
                    <td>{r.kindName} attestation</td>
                    <td>{r.signerName}<br /><span className="muted" style={{ fontSize: 12 }}>{r.firmName} · {r.signerEmail}</span></td>
                    <td>{r.idMethod === "GOV_ID" ? "Government ID" : "Phone code"}</td>
                    <td><span className={`tag ${cls} es-tag`}>{r.status === "declined" ? "Declined" : label}</span><br /><span className="muted" style={{ fontSize: 12 }}>{r.status === "declined" && r.declineReason ? r.declineReason : r.signedAt ? `Signed ${fmt(r.signedAt)}` : `Sent ${fmt(r.sentAt)}`}</span></td>
                    <td>{r.tx && net ? <a href={txUrl(net, r.tx)} target="_blank" rel="noreferrer">Recorded</a> : r.recordError ? <span className="muted" title={r.recordError}>Waiting: {r.recordError.slice(0, 60)}</span> : <span className="muted">—</span>}</td>
                    <td className="es-actions">
                      {r.hasFiles && <a href={`/api/esign/${r.id}/audit.pdf`} target="_blank" rel="noreferrer">Audit report</a>}
                      {r.status === "signed" && <button className="btn link sm" type="button" disabled={!!busy} onClick={() => run(r.id, () => api.esignRecord(r.id))}>{busy === r.id ? "Retrying…" : "Record on chain"}</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <section className="panel">
          <h3 style={{ fontSize: 18 }}>Approved verifier firms</h3>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>Issuers can only send checks to these firms, and only to a signer whose email is at the firm's domain.</p>
          {d && (d.firms.length ? (
            <ul className="es-firms">
              {d.firms.map((f) => (
                <li key={f.id}>
                  <span><b>{f.name}</b> <span className="muted">· {f.domain}</span><br /><span className="muted" style={{ fontSize: 12 }}>{f.kinds.map((k) => d.kinds.find((x) => x.id === k)?.name ?? k).join(", ")}</span></span>
                  <button className="btn ghost sm" type="button" disabled={!!busy} onClick={() => confirm(`Remove ${f.name}? Open requests stay open.`) && run(f.id, () => api.esignRemoveFirm(f.id))}>Remove</button>
                </li>
              ))}
            </ul>
          ) : <p className="muted" style={{ margin: 0 }}>No firms yet.</p>)}
          {d && (
            <form onSubmit={addFirm} className="es-firmform">
              <label className="field">Firm name<input required value={firm.name} onChange={(e) => setFirm({ ...firm, name: e.target.value })} placeholder="Acme Title Insurance Co." /></label>
              <label className="field">Email domain<input required value={firm.domain} onChange={(e) => setFirm({ ...firm, domain: e.target.value.trim().toLowerCase() })} placeholder="acmetitle.com" /></label>
              <fieldset className="es-kinds">
                <legend>Checks they may sign</legend>
                {d.kinds.map((k) => (
                  <label key={k.id}><input type="checkbox" checked={firm.kinds.includes(k.id)} onChange={(e) => setFirm({ ...firm, kinds: e.target.checked ? [...firm.kinds, k.id] : firm.kinds.filter((x) => x !== k.id) })} /> {k.name}</label>
                ))}
              </fieldset>
              <button className="btn primary sm" type="submit" disabled={!!busy || !firm.kinds.length}>{busy === "firm" ? "Adding…" : "Approve firm"}</button>
            </form>
          )}
        </section>
        <p className="muted" style={{ fontSize: 13, maxWidth: 760, margin: 0 }}>Every request goes out from the Diamondz Adobe account. Signed letters and audit reports are kept with each offering's records; only the fingerprint is public on chain.</p>
      </div>
    </>
  );
}
