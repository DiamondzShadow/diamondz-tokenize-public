// Console › Team (design 2, canvas 15R3n8ALvMUcS7iPxWEPTj, approved 2026-11-20): invite colleagues by email, give each
// a role, change or remove them. Only the owner manages the team; everyone can see who's on it and what roles can do.
// Roles limit console actions only: anything a token's admin signs still goes to the issuer's multisig.
import { useEffect, useState, type FormEvent } from "react";
import { api, type AuditEntry, type TeamRole, type TeamState } from "../lib/api";

const ROLE_INFO: { id: TeamRole; label: string }[] = [
  { id: "owner", label: "Owner" }, { id: "admin", label: "Admin" }, { id: "compliance", label: "Compliance" }, { id: "operations", label: "Operations" }, { id: "viewer", label: "Viewer" },
];
const label = (r: TeamRole) => ROLE_INFO.find((x) => x.id === r)!.label;
// Mirrors api/src/team.ts canWrite().
const CAN: [string, TeamRole[]][] = [
  ["Create and edit offerings, listings and sales", ["owner", "admin", "operations"]],
  ["Approve investors, accreditation and identity checks", ["owner", "admin", "compliance"]],
  ["Form D, documents and legal sign-off", ["owner", "admin", "compliance"]],
  ["Fund and send payouts, link bank accounts", ["owner", "admin", "operations"]],
  ["Deploy (test or real network)", ["owner", "admin"]],
  ["Branding, payment and message settings", ["owner", "admin"]],
  ["Team, plan and billing", ["owner"]],
  ["See everything", ["owner", "admin", "compliance", "operations", "viewer"]],
];
const INVITABLE: TeamRole[] = ["compliance", "operations", "admin", "viewer"];

export default function Team() {
  const [t, setT] = useState<TeamState | null>(null);
  const [err, setErr] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<TeamRole>("compliance");
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [log, setLog] = useState<AuditEntry[] | null>(null);
  const load = () => {
    api.audit().then((r) => setLog(r.entries), () => setLog([]));
    return api.team().then((x) => { setT(x); setErr(""); }, (e) => setErr(e.message));
  };
  useEffect(() => { load(); }, []);
  const owner = t?.me.role === "owner";

  const invite = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(""); setLink(null); setCopied(false);
    try {
      const r = await api.inviteMember(email.trim(), role);
      if (r.link) setLink({ email: r.invite.email, url: r.link });
      setEmail("");
      await load();
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  const act = async (fn: () => Promise<unknown>) => { setErr(""); try { await fn(); await load(); } catch (x) { setErr((x as Error).message); } };

  return (
    <>
      <div className="topbar"><h1>Team</h1></div>
      <div className="content">
        <p className="muted" style={{ fontSize: 14, margin: 0 }}>Everyone here signs in with their own email. Each role sees everything but can only change what it's responsible for.</p>
        {err && <div className="notice err">{err}</div>}
        {!t ? <p className="muted">Loading…</p> : (
          <div className="team-grid">
            <div className="col" style={{ gap: 16 }}>
              <section className="panel" style={{ padding: 0, overflow: "hidden" }}>
                <div className="tbl-wrap">
                  <table className="tbl">
                    <thead><tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col">Status</th>{owner && <th scope="col"><span className="sr-only">Actions</span></th>}</tr></thead>
                    <tbody>
                      {t.members.map((m) => (
                        <tr key={m.account}>
                          <td><b>{m.you ? "You" : m.name ?? m.email ?? "Member"}</b><br /><span className="muted" style={{ fontSize: 13 }}>{m.email ?? m.account}</span></td>
                          <td>{owner && m.role !== "owner"
                            ? <select className="input sm" aria-label={`Role for ${m.email ?? m.account}`} value={m.role} onChange={(e) => act(() => api.setMemberRole(m.account, e.target.value as TeamRole))}>{INVITABLE.map((r) => <option key={r} value={r}>{label(r)}</option>)}</select>
                            : <span className={`role-chip r-${m.role}`}>{label(m.role)}</span>}</td>
                          <td>Active</td>
                          {owner && <td>{m.role !== "owner" && <button className="btn link sm" onClick={() => confirm(`Remove ${m.email ?? "this member"} from the workspace?`) && act(() => api.removeMember(m.account))}>Remove</button>}</td>}
                        </tr>
                      ))}
                      {t.invites.map((i) => (
                        <tr key={i.id}>
                          <td><b>{i.email}</b><br /><span className="muted" style={{ fontSize: 13 }}>Invited</span></td>
                          <td><span className={`role-chip r-${i.role}`}>{label(i.role)}</span></td>
                          <td style={{ color: i.expired ? "var(--bad)" : "var(--warn)" }}>{i.expired ? "Invite expired" : `Invited · expires ${new Date(i.expiresAt).toLocaleDateString([], { month: "short", day: "numeric" })}`}</td>
                          {owner && <td><button className="btn link sm" onClick={() => act(() => api.cancelInvite(i.id))}>Cancel</button></td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
              <section className="panel">
                <h3>What each role can do</h3>
                <div className="tbl-wrap">
                  <table className="tbl perm">
                    <thead><tr><th scope="col">Action</th>{ROLE_INFO.map((r) => <th scope="col" key={r.id}>{r.label}</th>)}</tr></thead>
                    <tbody>{CAN.map(([what, who]) => <tr key={what}><td>{what}</td>{ROLE_INFO.map((r) => <td key={r.id} className={who.includes(r.id) ? "yes" : "no"}>{who.includes(r.id) ? "✓" : "–"}<span className="sr-only">{who.includes(r.id) ? "allowed" : "not allowed"}</span></td>)}</tr>)}</tbody>
                  </table>
                </div>
              </section>
            </div>
            <aside className="col" style={{ gap: 16 }}>
              {owner ? (
                <form className="panel" onSubmit={invite}>
                  <h3>Invite a colleague</h3>
                  <label className="field">Work email<input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" /></label>
                  <label className="field">Role<select className="input" value={role} onChange={(e) => setRole(e.target.value as TeamRole)}>{INVITABLE.map((r) => <option key={r} value={r}>{label(r)}</option>)}</select></label>
                  <button className="btn primary" disabled={busy} style={{ justifyContent: "center" }}>{busy ? "Inviting…" : "Send invite"}</button>
                  {link && (
                    <div className="notice" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <span>Email isn't set up for this workspace, so send {link.email} this link yourself. It works once and expires in 7 days.</span>
                      <code style={{ wordBreak: "break-all", fontSize: 12 }}>{link.url}</code>
                      <button type="button" className="btn ghost sm" onClick={() => navigator.clipboard.writeText(link.url).then(() => setCopied(true))}>{copied ? "Copied" : "Copy link"}</button>
                    </div>
                  )}
                  <p className="muted" style={{ fontSize: 12, margin: 0, lineHeight: 1.5 }}>They sign in with Google, Apple or an email code and land in this workspace.{t.emailOn ? " We email them the link." : ""}</p>
                </form>
              ) : (
                <div className="panel"><h3>Your role: {label(t.me.role)}</h3><p className="muted" style={{ margin: 0, fontSize: 14 }}>Only the workspace owner can invite people or change roles.</p></div>
              )}
              <section className="panel">
                <div className="row between"><h3>Activity log</h3><a className="btn link sm" href="/api/audit?format=csv&limit=2000">Export CSV</a></div>
                {!log ? <span className="muted">Loading…</span> : !log.length ? <span className="muted" style={{ fontSize: 13 }}>No changes yet.</span> : (
                  <ul className="audit-list">
                    {log.slice(0, 12).map((e) => (
                      <li key={e.at + e.path}>
                        <span><b>{e.who}</b> <span className="muted">({label(e.role)})</span> {describe(e)}</span>
                        <span className={`muted ${e.status >= 400 ? "bad" : ""}`}>{e.status >= 400 ? `refused (${e.status}) · ` : ""}{new Date(e.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <small className="muted">Every change made in this console is recorded with who, their role and when. Nothing anyone typed is stored here.</small>
              </section>
              <div className="notice" style={{ background: "var(--brand-soft)", borderColor: "var(--brand-line)", color: "var(--text)", fontSize: 13, lineHeight: 1.55 }}>
                <b>On-chain control doesn't change.</b> Roles decide what someone can do in this console. Anything a token's admin must sign still goes to your multisig, so no single team member can move a token alone.
              </div>
            </aside>
          </div>
        )}
      </div>
    </>
  );
}

/** Plain words for an audit entry's request. */
function describe(e: AuditEntry) {
  const p = e.path;
  const verb = e.method === "DELETE" ? "removed" : e.method === "POST" ? "did" : "changed";
  if (p.startsWith("/team/invites")) return e.method === "DELETE" ? "canceled an invite" : "invited a colleague";
  if (p.startsWith("/team/members")) return e.method === "DELETE" ? "removed a team member" : "changed a team member's role";
  if (p === "/tenant") return "changed workspace settings";
  if (p === "/assets") return "created an offering";
  if (/\/formd/.test(p)) return "worked on a Form D";
  if (/\/deployment$|\/deploy$/.test(p)) return "deployed an offering";
  if (/payouts/.test(p)) return "worked on payouts";
  if (/\/bank/.test(p)) return "worked on a bank link";
  if (/^\/assets\/[^/]+$/.test(p)) return "edited an offering";
  if (/accreditation|kyc|trex\/(kyc|identity)|verify/.test(p)) return "reviewed an investor";
  if (p.startsWith("/messages")) return "updated messages";
  if (p.startsWith("/billing")) return "changed billing";
  return `${verb} ${p}`;
}
