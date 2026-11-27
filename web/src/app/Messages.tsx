// Console › Messages: what visitors sent through this site's contact form, plus who gets an email when one arrives.
// Each tenant sees only its own messages. Opening a message marks it read; Reply opens the admin's mail app.
import { useEffect, useState } from "react";
import { api, type Message, type MessageSettings } from "../lib/api";
import { ArchiveIcon, MailIcon } from "../lib/Icons";

const when = (iso: string) => {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
};

export default function Messages() {
  const [box, setBox] = useState<"inbox" | "archive">("inbox");
  const [list, setList] = useState<Message[] | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const load = () => api.messages(box === "archive").then((r) => { setList(r.messages); setErr(""); }, (e) => setErr(e.message));
  useEffect(() => { setList(null); setOpen(null); load(); }, [box]);

  const patch = async (m: Message, body: { read?: boolean; archived?: boolean }) => {
    try {
      await api.updateMessage(m.id, body);
      window.dispatchEvent(new Event("messages-changed"));
      if (body.archived !== undefined) { setList((l) => l?.filter((x) => x.id !== m.id) ?? null); setOpen(null); }
      else setList((l) => l?.map((x) => (x.id === m.id ? { ...x, readAt: body.read ? new Date().toISOString() : null } : x)) ?? null);
    } catch (e) { setErr((e as Error).message); }
  };
  const toggle = (m: Message) => {
    const next = open === m.id ? null : m.id;
    setOpen(next);
    if (next && !m.readAt) patch(m, { read: true });
  };

  return (
    <>
      <div className="topbar"><h1>Messages</h1></div>
      <div className="content">
        <p className="muted" style={{ fontSize: 14, margin: 0 }}>Messages people send through your site's contact form. Only you and your team can see them.</p>
        <div className="msg-tabs" role="tablist" aria-label="Messages">
          {(["inbox", "archive"] as const).map((b) => (
            <button key={b} role="tab" aria-selected={box === b} className={box === b ? "on" : ""} onClick={() => setBox(b)}>{b === "inbox" ? "Inbox" : "Archive"}</button>
          ))}
        </div>
        {err && <div className="notice err">{err}</div>}
        {list === null ? <span className="muted">Loading…</span> : list.length === 0 ? (
          <div className="msg-empty">
            <MailIcon size={28} />
            <b>{box === "inbox" ? "No messages yet" : "Nothing archived"}</b>
            <span className="muted">{box === "inbox" ? "When someone uses the contact form on your site, it shows up here." : "Messages you archive move here. You can bring them back any time."}</span>
          </div>
        ) : (
          <div className="msg-list">
            {list.map((m) => {
              const isOpen = open === m.id;
              return (
                <div key={m.id} className={`msg${m.readAt ? "" : " unread"}${isOpen ? " open" : ""}`}>
                  <button className="msg-head" aria-expanded={isOpen} onClick={() => toggle(m)}>
                    <span className="msg-dot" aria-label={m.readAt ? undefined : "Unread"} />
                    <span className="msg-who">
                      <b>{m.name}</b>
                      <span className="muted">{[m.company, m.email].filter(Boolean).join(" · ")}</span>
                    </span>
                    <span className="msg-when muted">{when(m.createdAt)}</span>
                    {!isOpen && <span className="msg-preview muted">{m.message || "No message, just their contact details."}</span>}
                  </button>
                  {isOpen && (
                    <div className="msg-body">
                      <p>{m.message || <span className="muted">They didn't write a message, only left their contact details.</span>}</p>
                      <span className="muted" style={{ fontSize: 12 }}>Received {new Date(m.createdAt).toLocaleString()}</span>
                      <div className="msg-actions">
                        <a className="btn primary sm" href={`mailto:${m.email}?subject=${encodeURIComponent("Re: your message")}`}><MailIcon size={16} />Reply</a>
                        <button className="btn ghost sm" onClick={() => patch(m, { read: false })}>Mark unread</button>
                        <button className="btn ghost sm" onClick={() => patch(m, { archived: box === "inbox" })}><ArchiveIcon size={16} />{box === "inbox" ? "Archive" : "Move to inbox"}</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <AlertSettings />
      </div>
    </>
  );
}

function AlertSettings() {
  const [s, setS] = useState<MessageSettings | null>(null);
  const [text, setText] = useState("");
  const [state, setState] = useState<{ busy?: boolean; ok?: string; err?: string }>({});
  useEffect(() => { api.messageSettings().then((r) => { setS(r); setText(r.notifyEmails.join(", ")); }, () => {}); }, []);
  if (!s) return null;
  const save = async () => {
    const emails = text.split(/[,\s]+/).map((e) => e.trim()).filter(Boolean);
    setState({ busy: true });
    try { const r = await api.saveMessageSettings(emails); setS({ ...s, ...r, platformFallback: false }); setText(r.notifyEmails.join(", ")); setState({ ok: "Saved" }); }
    catch (e) { setState({ err: (e as Error).message }); }
  };
  return (
    <section className="panel" aria-labelledby="alerts-h">
      <h3 id="alerts-h">Email alerts</h3>
      <p className="muted" style={{ fontSize: 14, margin: 0 }}>We email these addresses when a new message arrives. Replying to the alert answers the person who wrote. Up to 5 addresses.</p>
      {!s.emailConfigured && <div className="notice">Email alerts aren't switched on for this platform yet. Messages still arrive here.</div>}
      {s.platformFallback && <div className="notice">Alerts currently go to the platform's default address. Add your own to replace it.</div>}
      <label className="field">Send alerts to
        <input className="input" value={text} onChange={(e) => { setText(e.target.value); setState({}); }} placeholder="you@company.com, team@company.com" inputMode="email" autoComplete="off" />
      </label>
      <div className="row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn primary sm" disabled={state.busy} onClick={save}>{state.busy ? "Saving…" : "Save"}</button>
        {state.ok && <span style={{ color: "var(--ok)", fontSize: 14 }}>{state.ok}</span>}
        {state.err && <span style={{ color: "var(--bad)", fontSize: 14 }}>{state.err}</span>}
      </div>
    </section>
  );
}
