// Console › Clients (design 4, canvas 15R3n8ALvMUcS7iPxWEPTj, approved 2026-11-20): for wealth managers and advisors.
// Each client keeps their own wallet; the firm sees verification status and holdings, proposes allocations, and every
// client approves and buys from their own wallet. The firm never holds client money or keys.
import { useEffect, useState, type FormEvent } from "react";
import { api, type AdvisorClient, type ClientProposal } from "../lib/api";

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
type Offering = { id: string; name: string; issuer: string; minInvestment: string; exemption: string | null };

export default function Clients() {
  const [list, setList] = useState<AdvisorClient[] | null>(null);
  const [offerings, setOfferings] = useState<Offering[]>([]);
  const [props, setProps] = useState<ClientProposal[]>([]);
  const [err, setErr] = useState("");
  const [inv, setInv] = useState({ name: "", email: "", kind: "individual" as "individual" | "trust" | "company" });
  const [link, setLink] = useState<{ name: string; url: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [asset, setAsset] = useState("");
  const [elig, setElig] = useState<Awaited<ReturnType<typeof api.clientEligibility>> | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [ok, setOk] = useState("");

  const load = () => {
    api.clients().then((r) => { setList(r.clients); setOfferings(r.offerings); setErr(""); }, (e) => setErr(e.message));
    api.proposals().then((r) => setProps(r.proposals), () => {});
  };
  useEffect(load, []);
  useEffect(() => { setElig(null); setAmounts({}); if (asset) api.clientEligibility(asset).then(setElig, (e) => setErr(e.message)); }, [asset]);

  const invite = async (e: FormEvent) => {
    e.preventDefault(); setBusy("invite"); setErr(""); setLink(null);
    try {
      const r = await api.addClient({ ...inv, name: inv.name.trim(), email: inv.email.trim() });
      if (r.link) setLink({ name: inv.name.trim(), url: r.link });
      setInv({ name: "", email: "", kind: "individual" }); load();
    } catch (x) { setErr((x as Error).message); } finally { setBusy(""); }
  };
  const propose = async (e: FormEvent) => {
    e.preventDefault(); setBusy("propose"); setErr(""); setOk("");
    try {
      const items = Object.entries(amounts).map(([clientId, v]) => ({ clientId, amountUsd: Number(v.replace(/[^\d.]/g, "")) })).filter((i) => i.amountUsd > 0);
      if (!items.length) throw new Error("Enter an amount for at least one client");
      const r = await api.propose(asset, items);
      setOk(`Sent ${r.proposals.length} proposal${r.proposals.length === 1 ? "" : "s"} for client approval.`);
      setAmounts({}); load();
    } catch (x) { setErr((x as Error).message); } finally { setBusy(""); }
  };

  const held = (list ?? []).reduce((s, c) => s + c.holdings.reduce((t, h) => t + h.valueUsd, 0), 0);
  const linked = (list ?? []).filter((c) => c.wallet).length;
  const waiting = props.filter((p) => p.status === "proposed").length;
  const nameOf = (id: string) => list?.find((c) => c.id === id)?.name ?? "Client";

  return (
    <>
      <div className="topbar"><h1>Clients</h1></div>
      <div className="content">
        <p className="muted" style={{ fontSize: 14, margin: 0 }}>Every client is verified as themselves and holds in their own wallet. You see it all here, propose allocations, and each client approves their own purchase.</p>
        {err && <div className="notice err">{err}</div>}
        <div className="uc-facts" style={{ gridTemplateColumns: "repeat(4,minmax(0,1fr))" }}>
          <div><b>{list?.length ?? "–"}</b><span>clients, {linked} with a connected wallet</span></div>
          <div><b>{usd(held)}</b><span>held across listed offerings, at offering price</span></div>
          <div><b>{props.filter((p) => p.status === "approved").length}</b><span>proposals approved by clients</span></div>
          <div><b>{waiting}</b><span>waiting for client approval</span></div>
        </div>
        <div className="team-grid">
          <section className="panel" style={{ padding: 0, overflow: "hidden" }}>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th scope="col">Client</th><th scope="col">Wallet</th><th scope="col">Verified with</th><th scope="col">Holdings</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {list === null ? <tr><td colSpan={5} className="muted">Loading…</td></tr> : !list.length ? <tr><td colSpan={5} className="muted">No clients yet. Invite your first one.</td></tr> : list.map((c) => (
                    <tr key={c.id}>
                      <td><b>{c.name}</b><br /><span className="muted" style={{ fontSize: 12 }}>{c.kind[0]!.toUpperCase() + c.kind.slice(1)} · {c.email}</span></td>
                      <td>{c.wallet ? <span className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>{c.wallet}</span> : <span style={{ color: "var(--warn)" }}>Invite sent</span>}</td>
                      <td>{c.wallet ? `${c.verifiedWith} issuer${c.verifiedWith === 1 ? "" : "s"}` : "–"}</td>
                      <td>{c.holdings.length ? c.holdings.map((h) => <div key={h.assetId} style={{ fontSize: 13 }}>{h.name}: {usd(h.valueUsd)}</div>) : "–"}</td>
                      <td><button className="btn link sm" onClick={() => confirm(`Remove ${c.name}? Their wallet and holdings are untouched; you just stop seeing them.`) && api.removeClient(c.id).then(load, (e) => setErr(e.message))}>Remove</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <aside className="col" style={{ gap: 16 }}>
            <form className="panel" onSubmit={invite}>
              <h3>Invite a client</h3>
              <label className="field">Name<input className="input" required value={inv.name} onChange={(e) => setInv({ ...inv, name: e.target.value })} /></label>
              <label className="field">Email<input className="input" type="email" required value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} /></label>
              <label className="field">Type<select className="input" value={inv.kind} onChange={(e) => setInv({ ...inv, kind: e.target.value as typeof inv.kind })}><option value="individual">Individual</option><option value="trust">Trust</option><option value="company">Company or fund</option></select></label>
              <button className="btn primary" disabled={busy === "invite"} style={{ justifyContent: "center" }}>{busy === "invite" ? "Inviting…" : "Invite client"}</button>
              {link && <div className="notice" style={{ display: "flex", flexDirection: "column", gap: 8 }}><span>Send {link.name} their private link:</span><code style={{ wordBreak: "break-all", fontSize: 12 }}>{link.url}</code><button type="button" className="btn ghost sm" onClick={() => navigator.clipboard.writeText(link.url)}>Copy link</button></div>}
              <small className="muted">They open it, connect their own wallet and agree to share their holdings with you.</small>
            </form>
          </aside>
        </div>

        <form className="panel" onSubmit={propose}>
          <h3>Allocate to an offering</h3>
          <label className="field">Offering
            <select className="input" value={asset} onChange={(e) => setAsset(e.target.value)}>
              <option value="">Choose an open offering…</option>
              {offerings.map((o) => <option key={o.id} value={o.id}>{o.name} · {o.issuer}{o.exemption === "506c" ? " · accredited only" : ""}</option>)}
            </select>
          </label>
          {asset && !elig && <span className="muted">Checking each client against this offering's rules…</span>}
          {elig && (list ?? []).map((c) => {
            const e = elig.clients[c.id];
            return (
              <div key={c.id} className="row between alloc-row">
                <span><b>{c.name}</b>{!e?.eligible && <span className="muted" style={{ fontSize: 12 }}> · {!e?.wallet ? "no wallet yet" : e.identity !== "verified" ? `identity ${e.identity}` : `accreditation ${e.accredited}`}</span>}</span>
                <input className="input sm" style={{ width: 140, textAlign: "right" }} inputMode="decimal" aria-label={`Amount for ${c.name}`} placeholder={elig.minInvestment ? `min ${usd(elig.minInvestment)}` : "$"} disabled={!e?.eligible} value={amounts[c.id] ?? ""} onChange={(ev) => setAmounts({ ...amounts, [c.id]: ev.target.value })} />
              </div>
            );
          })}
          {ok && <div className="notice ok">{ok}</div>}
          <button className="btn primary" disabled={!asset || busy === "propose"} style={{ alignSelf: "flex-start" }}>{busy === "propose" ? "Sending…" : "Send for client approval"}</button>
          <small className="muted">Only clients who've passed this offering's identity and accreditation checks can be picked. Each client reviews the offering and buys from their own wallet.</small>
        </form>

        {props.length > 0 && (
          <section className="panel" style={{ padding: 0, overflow: "hidden" }}>
            <h3 style={{ padding: "16px 16px 0" }}>Proposals</h3>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th scope="col">Client</th><th scope="col">Offering</th><th scope="col">Amount</th><th scope="col">Status</th></tr></thead>
                <tbody>{props.map((p) => <tr key={p.id}><td>{nameOf(p.clientId)}</td><td>{p.assetName}</td><td>{usd(p.amountUsd)}</td><td><span className={`role-chip ${p.status === "approved" ? "r-compliance" : p.status === "declined" ? "" : "r-operations"}`}>{p.status === "proposed" ? "Waiting for client" : p.status === "approved" ? "Approved by client" : "Declined"}</span></td></tr>)}</tbody>
              </table>
            </div>
          </section>
        )}

        <div className="team-grid" style={{ gridTemplateColumns: "repeat(2,minmax(0,1fr))" }}>
          <div className="panel" style={{ borderColor: "var(--brand)", background: "var(--brand-soft)" }}><b>Client wallets (in use)</b><span className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>Each client holds in their own wallet, which can be created from their email. The issuer sees every real holder, and income goes straight to each client.</span></div>
          <div className="panel"><b>Omnibus (nominee) wallet</b><span className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>Holding for clients in one firm wallet needs the issuer's approval and your counsel's sign-off, so it isn't offered here. Contact us if you need it.</span></div>
        </div>
      </div>
    </>
  );
}
