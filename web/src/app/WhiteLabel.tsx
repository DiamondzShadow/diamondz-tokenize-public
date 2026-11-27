// Console › Your white-label site (designs W1–W5, canvas Kkq7dLzdNRZn5oUVJ5KEuz, approved 2026-11-27).
// /app/white-label           checklist + Go live
// /app/white-label/domain    connect a custom domain (Cloudflare for SaaS: CNAME + ownership TXT, live status)
// /app/white-label/email     send email from the customer's domain (DKIM / SPF / bounce MX through Resend)
// /app/white-label/legal     the customer's own terms, privacy policy and disclosures (versioned, or a PDF)
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type WhiteLabel, type WlLegalPage, type WlRecord } from "../lib/api";

const ago = (iso: string | null) => {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s} seconds ago` : s < 3600 ? `${Math.round(s / 60)} minutes ago` : new Date(iso).toLocaleString();
};

function Copy({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return <button type="button" className="wl-copy" aria-label="Copy value" onClick={() => navigator.clipboard?.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); })}>{done ? "Copied" : "Copy"}</button>;
}

function Records({ rows, statusOf }: { rows: WlRecord[]; statusOf: (r: WlRecord) => [string, string] }) {
  return (
    <>
      <div className="wl-table-wrap">
        <table className="wl-table">
          <thead><tr><th>Type</th><th>Name</th><th>Value</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const [cls, label] = statusOf(r);
              return (
                <tr key={`${r.type}${r.name}`}>
                  <td><b>{r.type}</b></td>
                  <td className="mono">{r.name}</td>
                  <td><span className="mono">{r.value}{r.priority != null ? ` · priority ${r.priority}` : ""}</span> <Copy value={r.value} /></td>
                  <td><span className={`tag ${cls}`}>{label}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="wl-cards">
        {rows.map((r) => {
          const [cls, label] = statusOf(r);
          return (
            <div className="wl-card" key={`${r.type}${r.name}`}>
              <div className="row" style={{ justifyContent: "space-between" }}><b>{r.type}</b><span className={`tag ${cls}`}>{label}</span></div>
              <div><span className="muted">Name</span><span className="mono">{r.name}</span></div>
              <div><span className="muted">Value</span><span className="mono">{r.value}{r.priority != null ? ` · priority ${r.priority}` : ""}</span></div>
              <Copy value={r.value} />
            </div>
          );
        })}
      </div>
    </>
  );
}

export default function WhiteLabelPage() {
  const { section } = useParams();
  const [d, setD] = useState<WhiteLabel | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const load = useCallback(() => api.whitelabel().then(setD, (e) => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const run = async (k: string, fn: () => Promise<WhiteLabel | unknown>) => {
    setBusy(k); setErr("");
    try { const r = await fn(); if (r && typeof r === "object" && "steps" in (r as object)) setD(r as WhiteLabel); else await load(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  };

  if (!d) return <><div className="topbar"><h1>Your white-label site</h1></div><div className="content">{err ? <div className="notice err">{err}</div> : <p className="muted">Loading…</p>}</div></>;
  if (!d.whitelabel) return (
    <>
      <div className="topbar"><h1>Your white-label site</h1></div>
      <div className="content"><div className="panel" style={{ maxWidth: 640 }}>
        <h3 style={{ fontSize: 20 }}>Run Diamondz Tokenize as your own site</h3>
        <p className="muted" style={{ margin: 0 }}>Your domain, your brand, email from your address and your own legal pages come with the White-label plan.</p>
        <Link className="btn primary sm" to="/app/billing" style={{ alignSelf: "flex-start" }}>See plans</Link>
      </div></div>
    </>
  );
  const props = { d, run, busy, err };
  return section === "domain" ? <Domain {...props} /> : section === "email" ? <Email {...props} /> : section === "legal" ? <Legal {...props} /> : <Checklist {...props} />;
}

type P = { d: WhiteLabel; run: (k: string, fn: () => Promise<WhiteLabel | unknown>) => Promise<void>; busy: string; err: string };

function Step({ n, done, title, body, to, action, current }: { n: number; done: boolean; title: string; body: string; to: string; action: string; current?: boolean }) {
  return (
    <li className={`wl-step ${current ? "cur" : ""}`}>
      <span className={`wl-num ${done ? "ok" : ""}`} aria-hidden="true">{done ? "✓" : n}</span>
      <div style={{ flex: "1 1 280px", minWidth: 0 }}><b>{title}</b><div className="muted" style={{ fontSize: 13 }}>{body}</div></div>
      {done ? <><span className="wl-done">Done</span><Link to={to} className="wl-link">{action === "Set up" ? "Edit" : action}</Link></> : <Link to={to} className={`btn sm ${current ? "primary" : "ghost"}`}>{current ? "Continue" : action}</Link>}
    </li>
  );
}

function Checklist({ d, run, busy, err }: P) {
  const s = d.steps;
  const order: [keyof WhiteLabel["steps"], string, string, string, string][] = [
    ["brand", "Brand", "Name, logo, colors and which asset types you offer", "/app/branding", "Set up"],
    ["domain", "Your domain", d.domain ? `${d.domain.name} · ${s.domain ? "live" : d.domain.ssl === "active" ? "checking your site" : "waiting for DNS and the certificate"}` : "Investors reach your site at your own address", "/app/white-label/domain", "Set up"],
    ["team", "Team sign-in", "Teammates use this console with two-step sign-in", "/app/team", "Manage team"],
    ["email", "Email from your domain", d.email ? `From ${d.email.address}` : "Investor and lawyer emails come from your address", "/app/white-label/email", "Set up"],
    ["identity", "Identity checks", "Investors verify through the platform's identity provider, labeled with your name", "/app/investors", "Review"],
    ["legal", "Your legal pages", "Terms, privacy policy and risk disclosures in your own words", "/app/white-label/legal", "Set up"],
    ["footer", "\"Powered by Diamondz\" footer", s.footer ? "Hidden on your site" : "Shown on your site; hide it in Branding", "/app/branding", "Change"],
  ];
  const firstOpen = order.find(([k]) => !s[k])?.[0];
  return (
    <>
      <div className="topbar"><h1>Your white-label site</h1></div>
      <div className="content wl">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap" }}>
          <p className="muted" style={{ margin: 0, maxWidth: 620, fontSize: 15, lineHeight: 1.5 }}>Your investors see your brand, your domain, your emails and your legal pages. Your team keeps running everything from this console.</p>
          <div className="wl-progress"><span className="muted">{d.done} of {d.total} done</span><div role="progressbar" aria-valuenow={d.done} aria-valuemin={0} aria-valuemax={d.total} aria-label="Setup progress"><i style={{ width: `${(d.done / d.total) * 100}%` }} /></div></div>
        </div>
        {err && <div className="notice err" role="alert">{err}</div>}
        <ol className="wl-steps">
          {order.map(([k, title, body, to, action], i) => <Step key={k} n={i + 1} done={s[k]} title={title} body={body} to={to} action={action} current={k === firstOpen} />)}
        </ol>
        <div className="panel wl-golive">
          <div style={{ flex: "1 1 320px" }}>
            <b>{d.live ? `Live on ${d.domain?.name}` : `Go live${d.domain ? ` on ${d.domain.name}` : ""}`}</b>
            <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>{d.live ? `Opened ${new Date(d.live.at).toLocaleString()}.` : "Opens once your domain, email and legal pages are ready. Until then the site shows only to people with your preview link."}</div>
          </div>
          {d.live
            ? <button type="button" className="btn ghost sm" disabled={!!busy} onClick={() => confirm("Take the site offline? Visitors will see the opening-soon page.") && run("live", () => api.wlLive(false))}>Take offline</button>
            : <button type="button" className="btn primary sm" disabled={!d.ready || !!busy} onClick={() => run("live", () => api.wlLive(true))}>{busy === "live" ? "Opening…" : "Go live"}</button>}
          {d.preview && <a className="wl-link" href={d.preview} target="_blank" rel="noreferrer">Preview as an investor ↗</a>}
        </div>
      </div>
    </>
  );
}

function Back({ step, title, intro }: { step: number; title: string; intro: string }) {
  return (
    <div className="col" style={{ gap: 6 }}>
      <Link to="/app/white-label" className="wl-link" style={{ fontSize: 13 }}>← Your white-label site</Link>
      <span className="es-kicker">Step {step} of 7</span>
      <h2 className="es-h2" style={{ fontSize: 28 }}>{title}</h2>
      <p className="muted" style={{ margin: 0, maxWidth: 680, fontSize: 15, lineHeight: 1.5 }}>{intro}</p>
    </div>
  );
}

function Domain({ d, run, busy, err }: P) {
  const [name, setName] = useState(d.domain?.name ?? "");
  const dm = d.domain;
  // While anything is still pending, re-check every minute (the server also checks every 5 minutes).
  useEffect(() => {
    if (!dm || (dm.cfStatus === "active" && dm.ssl === "active" && dm.answers)) return;
    const t = setInterval(() => run("auto", api.wlCheck), 60_000);
    return () => clearInterval(t);
  }, [dm, run]);
  const submit = (e: FormEvent) => { e.preventDefault(); run("domain", () => api.wlDomain(name.trim())); };
  const rows: WlRecord[] = dm ? [dm.cname, ...(dm.txt ? [dm.txt] : [])] : [];
  const checks: [boolean, string, string | null][] = dm ? [
    [!!dm.cname.found, `DNS points to Diamondz`, null],
    [!!dm.txt?.found || dm.cfStatus === "active", "You own the domain (TXT record verified)", null],
    [dm.ssl === "active", "Security certificate (HTTPS)", dm.ssl && dm.ssl !== "active" ? "being issued, usually under 15 minutes" : null],
    [dm.answers, `Your site answers at https://${dm.name}`, null],
  ] : [];
  const mailto = dm ? `mailto:?subject=${encodeURIComponent(`DNS records for ${dm.name}`)}&body=${encodeURIComponent(`Please add these DNS records:\n\n${rows.map((r) => `${r.type}  ${r.name}  ${r.value}`).join("\n")}\n\nIf the domain is on Cloudflare, set the CNAME to "DNS only".`)}` : "";
  return (
    <>
      <div className="topbar"><h1>Your white-label site</h1></div>
      <div className="content wl">
        <Back step={2} title="Connect your domain" intro="Investors will reach your site at your own address. Use a subdomain you own, like invest.yourfirm.com. Your main website stays where it is." />
        {!d.cfConnected && <div className="notice warn">Custom domains are being connected on the platform. You can add yours now; it goes live as soon as that's done.</div>}
        {err && <div className="notice err" role="alert">{err}</div>}
        <div className="wl-grid">
          <section className="wl-main">
            <form className="panel wl-row" onSubmit={submit}>
              <label className="field" style={{ flex: "1 1 320px" }}>Your site's address<input value={name} onChange={(e) => setName(e.target.value)} placeholder="invest.yourfirm.com" autoComplete="off" /></label>
              <button className={`btn sm ${dm ? "ghost" : "primary"}`} disabled={!!busy || !name.trim() || name.trim() === dm?.name}>{busy === "domain" ? "Saving…" : dm ? "Change" : "Connect"}</button>
            </form>
            {dm && (
              <div className="panel">
                <div><b style={{ fontSize: 16 }}>Add {rows.length === 1 ? "this record" : `these ${rows.length} records`} where you manage DNS</b>
                  <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>At your domain host (GoDaddy, Cloudflare, Google Domains, Route 53…), open DNS settings and add:</p></div>
                <Records rows={rows} statusOf={(r) => (r.found ? ["g", "Found"] : ["y", "Not found yet"])} />
                <p className="muted" style={{ margin: 0, fontSize: 12 }}>If your domain is on Cloudflare, set the CNAME to "DNS only" (gray cloud). DNS changes usually show up within minutes and can take up to 24 hours.</p>
              </div>
            )}
            {dm && (
              <div className="panel">
                <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}><b style={{ fontSize: 16 }}>Live status</b><span className="muted" style={{ fontSize: 12 }}>Checked {ago(dm.checkedAt) || "just now"} · checks every minute</span></div>
                <ol className="wl-checks">
                  {checks.map(([ok, label, note], i) => <li key={i} className={ok ? "ok" : note ? "wait" : ""}><i aria-hidden="true">{ok ? "✓" : ""}</i>{label}{note && <span className="wl-wait"> {note}</span>}</li>)}
                </ol>
                {dm.errors.length > 0 && <div className="notice">{dm.errors.join(" · ")}</div>}
                <div className="row" style={{ flexWrap: "wrap" }}>
                  <button type="button" className="btn primary sm" disabled={!!busy} onClick={() => run("check", api.wlCheck)}>{busy === "check" ? "Checking…" : "Check now"}</button>
                  <a className="btn ghost sm" href={mailto}>Email these steps to my IT team</a>
                  <button type="button" className="btn ghost sm es-danger" disabled={!!busy} onClick={() => confirm(`Disconnect ${dm.name}? Your site stops answering there.`) && run("rm", api.wlRemoveDomain)}>Disconnect</button>
                </div>
              </div>
            )}
          </section>
          <aside className="wl-aside">
            <div className="panel" style={{ gap: 10, fontSize: 14, lineHeight: 1.5 }}>
              <span className="es-kicker">What your domain shows</span>
              <span>Your home page, marketplace and offering pages, in your brand.</span>
              <span>Investor sign-in, identity checks, purchases and payouts.</span>
              <span>Your team signs in to this console at tokenize.diamondz.one.</span>
            </div>
            <div className="es-note">The certificate renews by itself. Remove the CNAME any time to take the site off your domain.</div>
          </aside>
        </div>
      </div>
    </>
  );
}

function Email({ d, run, busy, err }: P) {
  const e = d.email;
  const [f, setF] = useState({ name: e?.name ?? "", address: e?.address ?? (d.domain ? `notify@${d.domain.name}` : ""), replyTo: e?.replyTo ?? "" });
  const [sent, setSent] = useState("");
  const save = (ev: FormEvent) => { ev.preventDefault(); run("save", () => api.wlEmail({ name: f.name.trim(), address: f.address.trim(), replyTo: f.replyTo.trim() || null })); };
  const verified = e?.status === "verified";
  return (
    <>
      <div className="topbar"><h1>Your white-label site</h1></div>
      <div className="content wl">
        <Back step={4} title="Send email from your domain" intro="Sign-in codes, lawyer sign-off links and client invitations go out under your name and address." />
        {!d.emailConnected && <div className="notice warn">Email isn't set up on the platform yet.</div>}
        {err && <div className="notice err" role="alert">{err}</div>}
        {sent && <div className="notice ok">Test email sent to {sent}.</div>}
        <div className="wl-grid">
          <section className="wl-main">
            <form className="panel wl-form" onSubmit={save}>
              <label className="field">Sender name<input required value={f.name} onChange={(x) => setF({ ...f, name: x.target.value })} placeholder="Your firm" /></label>
              <label className="field">Sender address<input required type="email" value={f.address} onChange={(x) => setF({ ...f, address: x.target.value })} placeholder="notify@invest.yourfirm.com" /></label>
              <label className="field wl-span">Replies go to <span className="muted">(optional)</span><input type="email" value={f.replyTo} onChange={(x) => setF({ ...f, replyTo: x.target.value })} placeholder="investors@yourfirm.com" /></label>
              <button className="btn primary sm" disabled={!!busy} style={{ justifySelf: "start" }}>{busy === "save" ? "Saving…" : e ? "Save" : "Get the DNS records"}</button>
            </form>
            {e && (
              <div className="panel">
                <div><b style={{ fontSize: 16 }}>Add these {e.records.length} records for {e.domain}</b>
                  <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>They let mail servers trust email sent in your name, so it lands in the inbox.</p></div>
                <Records rows={e.records} statusOf={(r) => (r.status === "verified" ? ["g", "Verified"] : r.status === "failed" ? ["", "Check the value"] : ["y", "Not found yet"])} />
                <div className="row" style={{ flexWrap: "wrap" }}>
                  <button type="button" className="btn primary sm" disabled={!!busy} onClick={() => run("verify", api.wlEmailVerify)}>{busy === "verify" ? "Checking…" : "Check now"}</button>
                  <button type="button" className="btn ghost sm" disabled={!verified || !!busy} onClick={async () => { setSent(""); await run("test", async () => { const r = await api.wlEmailTest(); setSent(r.to); return null; }); }}>Send me a test email</button>
                </div>
              </div>
            )}
          </section>
          <aside className="wl-aside">
            <div className="panel" style={{ gap: 10 }}>
              <span className="es-kicker">Preview</span>
              <div className="wl-mail">
                <span><b>{f.name || "Your firm"}</b> <span className="muted">&lt;{f.address || "notify@yourdomain.com"}&gt;</span></span>
                <span className="muted">Your sign-off code</span>
                <span className="wl-mail-body">Your code is <b>481 920</b>. It expires in 10 minutes.</span>
              </div>
            </div>
            <div className="es-note">{verified ? "Verified: your emails now go out from your address." : "Until these records verify, emails go out from Diamondz Tokenize with your name in the message."}</div>
          </aside>
        </div>
      </div>
    </>
  );
}

function Legal({ err: outerErr }: P) {
  const [pages, setPages] = useState<WlLegalPage[] | null>(null);
  const [cur, setCur] = useState("terms");
  const [f, setF] = useState({ title: "", text: "" });
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState("");
  const load = useCallback(() => api.wlLegal().then((r) => { setPages(r.pages); return r.pages; }, (e) => { setErr(e.message); return null; }), []);
  useEffect(() => { load(); }, [load]);
  const page = pages?.find((p) => p.slug === cur) ?? null;
  useEffect(() => { if (page) setF({ title: page.title, text: page.draft || page.published?.text || "" }); }, [cur, pages]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (k: string, fn: () => Promise<unknown>, done: string) => { setBusy(k); setErr(""); setMsg(""); try { await fn(); await load(); setMsg(done); } catch (e) { setErr((e as Error).message); } finally { setBusy(""); } };
  const save = () => act("save", () => api.wlLegalSave(cur, { title: f.title.trim(), text: f.text }), "Draft saved.");
  const publish = () => act("publish", async () => { await api.wlLegalSave(cur, { title: f.title.trim(), text: f.text }); await api.wlLegalPublish(cur); }, "Published.");
  const addPage = () => {
    const title = prompt("Name of the new page (for example: Offering disclosures)")?.trim();
    if (!title) return;
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "page";
    act("add", () => api.wlLegalSave(/^[a-z]/.test(slug) ? slug : `p-${slug}`, { title, text: "" }), "Page added.").then(() => setCur(/^[a-z]/.test(slug) ? slug : `p-${slug}`));
  };
  const state = (p: WlLegalPage): [string, string, string] => p.published || p.pdf
    ? ["g", "Live", p.published ? `Published ${new Date(p.published.at).toLocaleDateString()}` : "PDF uploaded"]
    : p.draft ? ["y", "Draft", p.draftAt ? `Edited ${new Date(p.draftAt).toLocaleDateString()}` : "Draft"] : ["", "Empty", "Not started"];
  return (
    <>
      <div className="topbar"><h1>Your white-label site</h1></div>
      <div className="content wl">
        <Back step={6} title="Your legal pages" intro="Your site links these in the footer and at sign-up. Write them with your counsel; each published version is kept with its date." />
        {(err || outerErr) && <div className="notice err" role="alert">{err || outerErr}</div>}
        {msg && <div className="notice ok">{msg}</div>}
        {!pages ? <p className="muted">Loading…</p> : (
          <div className="wl-grid">
            <nav className="wl-pages" aria-label="Legal pages">
              {pages.map((p) => { const [cls, label, sub] = state(p); return (
                <button key={p.slug} type="button" className={p.slug === cur ? "on" : ""} aria-current={p.slug === cur ? "page" : undefined} onClick={() => setCur(p.slug)}>
                  <span><b>{p.title}</b><br /><span className="muted" style={{ fontSize: 12 }}>{sub}</span></span><span className={`tag ${cls}`}>{label}</span>
                </button>
              ); })}
              <button type="button" className="wl-add" disabled={!!busy} onClick={addPage}>Add a page</button>
            </nav>
            {page && (
              <section className="panel wl-main">
                <div className="wl-row">
                  <label className="field" style={{ flex: "1 1 260px" }}>Page title<input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
                  <span className="muted" style={{ fontSize: 13 }}>/legal/{page.slug}</span>
                </div>
                <label className="field">Page text <span className="muted">(## for a heading, - for a list, **bold**, [link](https://…))</span>
                  <textarea rows={16} value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} placeholder={"## 1. Who we are\n[Your firm] operates this site…"} />
                </label>
                <div className="row" style={{ flexWrap: "wrap" }}>
                  <button type="button" className="btn primary sm" disabled={!!busy || f.title.trim().length < 2 || !f.text.trim()} onClick={publish}>{busy === "publish" ? "Publishing…" : "Publish"}</button>
                  <button type="button" className="btn ghost sm" disabled={!!busy || f.title.trim().length < 2} onClick={save}>{busy === "save" ? "Saving…" : "Save draft"}</button>
                  <label className="btn ghost sm" style={{ cursor: "pointer" }}>Upload a PDF instead<input type="file" accept="application/pdf" hidden onChange={(e) => { const file = e.target.files?.[0]; if (file) act("pdf", () => api.wlLegalPdf(cur, file), "PDF uploaded."); }} /></label>
                  {(page.published || page.pdf) && <a className="wl-link" href={`/legal/${page.slug}`} target="_blank" rel="noreferrer">View ↗</a>}
                  <span className="muted" style={{ fontSize: 12, marginLeft: "auto" }}>{page.versions.length ? `Version history: ${page.versions.length} earlier version${page.versions.length === 1 ? "" : "s"}` : ""}{page.pdf ? ` · PDF ${(page.pdf.bytes / 1024).toFixed(0)} KB` : ""}</span>
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </>
  );
}
