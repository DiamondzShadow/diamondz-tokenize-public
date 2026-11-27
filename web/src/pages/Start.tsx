// /start — issuer sign-up = sign-in (designs S2 desktop, S6 phone; approved 2026-11-18) and
// /start/workspace — set up your workspace (S3). thirdweb login, no wallet anywhere.
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { ASSET_CLASSES } from "../lib/catalog";
import { useTenant } from "../lib/tenant";
import { TRIAL_DAYS } from "../lib/pricing";
import { sendEmailCode, signInWithThirdweb, type LoginWith } from "../lib/accountLogin";
import { Mark } from "./Landing";

const GoogleG = () => (
  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z" /><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.6 5.9c4.4-4.1 7-10.1 7-17.6z" /><path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z" /><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.2 0-11.5-4.1-13.4-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z" /></svg>
);
const AppleA = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.4 12.6c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3.1-2-3.7-2-1.6-.2-3.1.9-3.9.9-.8 0-2-.9-3.3-.9-1.7 0-3.3 1-4.2 2.5-1.8 3.1-.5 7.7 1.3 10.2.8 1.2 1.8 2.6 3.1 2.5 1.2 0 1.7-.8 3.2-.8s1.9.8 3.2.8c1.3 0 2.2-1.2 3-2.4.9-1.4 1.3-2.7 1.3-2.8 0 0-2.4-1-2.4-4.1zM14 5c.7-.8 1.1-1.9 1-3-1 0-2.1.7-2.8 1.5-.6.7-1.2 1.8-1 2.9 1.1.1 2.1-.6 2.8-1.4z" /></svg>
);

function StartHeader({ right }: { right: React.ReactNode }) {
  return (
    <header className="start-hdr">
      <div className="wrap start-hdr-in">
        <Link to="/" className="logo"><Mark /><span className="wm"><b>Diamondz</b><span>Tokenize</span></span></Link>
        <span style={{ flex: 1 }} />
        {right}
      </div>
    </header>
  );
}

export default function Start() {
  const { tenant } = useTenant();
  const nav = useNavigate();
  const clientId = tenant?.auth.thirdwebClientId ?? null;
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState<"" | "google" | "apple" | "send" | "email">("");
  const [err, setErr] = useState("");

  // Team invite (/start/join → /start?join=…): after sign-in, accept it and open that workspace.
  const join = new URLSearchParams(location.search).get("join");
  const acceptAndGo = async () => { await api.acceptInvite(join!); location.assign("/app"); };
  // Already signed in with a workspace? Straight to the console (or accept the invite first).
  useEffect(() => {
    api.account().then((a) => { if (join) acceptAndGo().catch((e) => setErr((e as Error).message)); else if (a.active) nav("/app", { replace: true }); }, () => {});
  }, [nav]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = async (how: LoginWith, key: typeof busy) => {
    if (!clientId) return;
    setErr(""); setBusy(key);
    try {
      const r = await signInWithThirdweb(clientId, how);
      if (join) { await acceptAndGo(); return; }
      nav(r.active ? "/app" : "/start/workspace");
    } catch (e) {
      const m = (e as Error).message ?? "";
      setErr(/closed|cancel/i.test(m) ? "Sign-in was closed before it finished. Try again." : m || "Sign-in didn't work. Try again.");
    } finally { setBusy(""); }
  };
  const send = async () => {
    if (!clientId || !/^\S+@\S+\.\S+$/.test(email)) { setErr("Enter a valid email address"); return; }
    setErr(""); setBusy("send");
    try { await sendEmailCode(clientId, email.trim()); setSent(true); } catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  };

  const platform = tenant ? tenant.id === "diamondz" : true;
  return (
    <div className="page start">
      <StartHeader right={<Link to="/market" className="muted start-alt">Want to invest instead? Browse offerings →</Link>} />
      <section className="wrap start-grid">
        <div className="start-copy">
          <span className="eyebrow">For issuers</span>
          <h1>Start tokenizing for free</h1>
          <p className="start-lead">Your account comes with a workspace you can use right away.</p>
          <div className="start-facts">
            <div><b>Free forever on test networks</b><span>Create, deploy and run demo offerings with test tokens. No card needed.</span></div>
            <div><b>{TRIAL_DAYS} days of Growth</b><span>Your logo, colors and theme while you try it out.</span></div>
            <div><b>Go live when you're ready</b><span>Pick a plan to deploy on a real network, once your counsel signs off.</span></div>
          </div>
        </div>

        <div className="panel start-card">
          {join
            ? <div><h2>Sign in to join your team</h2><p className="muted" style={{ fontSize: 14, margin: "6px 0 0" }}>Use the email your invite was sent to. You'll land in the workspace right after.</p></div>
            : <div><h2>Create your account</h2><p className="muted" style={{ fontSize: 14, margin: "6px 0 0" }}>Or sign in, if you already have one. Same buttons.</p></div>}
          {!platform ? (
            <div className="notice">Issuer accounts are created on the main Diamondz Tokenize site.</div>
          ) : !clientId ? (
            <div className="notice err">Sign-in isn't configured yet.</div>
          ) : (
            <div className="auth">
              <button type="button" className="authbtn" disabled={!!busy} onClick={() => go({ strategy: "google" }, "google")}><GoogleG />{busy === "google" ? "Opening Google…" : "Continue with Google"}</button>
              <button type="button" className="authbtn" disabled={!!busy} onClick={() => go({ strategy: "apple" }, "apple")}><AppleA />{busy === "apple" ? "Opening Apple…" : "Continue with Apple"}</button>
              <div className="or">or</div>
              {!sent ? (
                <form onSubmit={(e) => { e.preventDefault(); send(); }} className="auth">
                  <label className="field">Work email<input className="input" type="email" autoComplete="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
                  <button className="btn primary" disabled={!!busy} style={{ justifyContent: "center" }}>{busy === "send" ? "Sending…" : "Email me a sign-in code"}</button>
                </form>
              ) : (
                <form onSubmit={(e) => { e.preventDefault(); go({ strategy: "email", email: email.trim(), code: code.trim() }, "email"); }} className="auth">
                  <label className="field">Code we sent to {email}<input className="input" inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} /></label>
                  <button className="btn primary" disabled={!!busy || code.length < 6} style={{ justifyContent: "center" }}>{busy === "email" ? "Signing in…" : "Continue"}</button>
                  <button type="button" className="btn link" onClick={() => { setSent(false); setCode(""); }}>Use a different email</button>
                </form>
              )}
            </div>
          )}
          {err && <div className="notice err">{err}</div>}
          <p className="muted" style={{ fontSize: 13, lineHeight: 1.55, margin: 0 }}>
            Sign-in is handled securely by thirdweb. No wallet, seed phrase or crypto is needed to use the console. By continuing you agree to our{" "}
            <Link to="/legal/terms" className="lnk">Terms</Link> and <Link to="/legal/privacy" className="lnk">Privacy Policy</Link>.
          </p>
        </div>
        <Link to="/market" className="start-alt-m">Want to invest instead? Browse offerings →</Link>
      </section>
    </div>
  );
}

export function StartWorkspace() {
  const nav = useNavigate();
  const [email, setEmail] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // "+ New workspace" from the console (?new=1) may create another; otherwise someone with a workspace goes to it.
  const another = new URLSearchParams(location.search).get("new") === "1";
  useEffect(() => {
    api.account().then((a) => { if (a.active && !another) nav("/app", { replace: true }); else setEmail(a.account.email ?? a.account.address); }, () => nav("/start", { replace: true }));
  }, [nav, another]);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const create = async () => {
    if (name.trim().length < 2) { setErr("Enter your company name"); return; }
    setErr(""); setBusy(true);
    try { await api.createWorkspace({ name: name.trim(), ...(role.trim() ? { role: role.trim() } : {}), ...(picked.length ? { offerings: picked } : {}) }); location.assign("/app"); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  if (!email) return null;
  return (
    <div className="page start">
      <StartHeader right={<span className="muted start-alt">Signed in as {email}</span>} />
      <section className="wrap start-ws">
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}><span className="eyebrow">{another ? "New workspace" : "Step 2 of 2"}</span><h1>Set up your workspace</h1><p className="muted" style={{ margin: 0 }}>You can change all of this later in Branding.</p></div>
        <form className="panel start-ws-card" onSubmit={(e) => { e.preventDefault(); create(); }}>
          <label className="field">Company name<input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoComplete="organization" required /></label>
          <label className="field">Your role<input className="input" value={role} onChange={(e) => setRole(e.target.value)} maxLength={80} autoComplete="organization-title" /></label>
          <fieldset className="start-classes">
            <legend>What do you want to tokenize? Pick any.</legend>
            <div className="chips">{ASSET_CLASSES.map((c) => <button type="button" key={c.id} className={`chip ${picked.includes(c.id) ? "on" : ""}`} aria-pressed={picked.includes(c.id)} onClick={() => toggle(c.id)}>{c.name}</button>)}</div>
          </fieldset>
          <div className="start-trial"><span className="status ok">Free plan</span><span>Test networks, free forever, plus <b>{TRIAL_DAYS} days of Growth</b> features. No card needed.</span></div>
          {err && <div className="notice err">{err}</div>}
          <button className="btn primary" disabled={busy} style={{ alignSelf: "flex-start" }}>{busy ? "Creating…" : "Create workspace"}</button>
        </form>
      </section>
    </div>
  );
}

/** /start/join?t=… — a team invite link (design 2). Shows whose workspace it is, then sign-in accepts it. */
export function StartJoin() {
  const t = new URLSearchParams(location.search).get("t") ?? "";
  const [inv, setInv] = useState<{ workspace: string; role: string; email: string; state: "open" | "used" | "expired" } | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { api.invite(t).then(setInv, (e) => setErr((e as Error).message)); }, [t]);
  const role = inv ? inv.role[0]!.toUpperCase() + inv.role.slice(1) : "";
  return (
    <div className="page start">
      <StartHeader right={<span />} />
      <section className="wrap start-ws">
        <div className="panel start-ws-card" style={{ maxWidth: 560 }}>
          {err ? <div className="notice err">{err}</div> : !inv ? <p className="muted">Loading invite…</p> : <>
            <span className="eyebrow">Team invite</span>
            <h1 style={{ fontSize: 34, margin: 0 }}>Join {inv.workspace}</h1>
            <p className="muted" style={{ margin: 0 }}>You've been invited as <b>{role}</b>, at {inv.email}.</p>
            {inv.state === "open"
              ? <Link className="btn primary" to={`/start?join=${encodeURIComponent(t)}`} style={{ justifyContent: "center" }}>Sign in to accept</Link>
              : <div className="notice err">{inv.state === "used" ? "This invite was already used. Sign in to open the workspace." : "This invite expired. Ask the workspace owner for a new one."}</div>}
            {inv.state !== "open" && <Link className="btn ghost" to="/start" style={{ justifyContent: "center" }}>Sign in</Link>}
          </>}
        </div>
      </section>
    </div>
  );
}
