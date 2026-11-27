// Console › Security: two-step sign-in with an authenticator app (2026-11-20). Required for owners and admins before
// they can change anything; optional, and then enforced, for everyone else. Also the code prompt a session shows when
// two-step sign-in is on but this session hasn't entered a code yet.
import { useEffect, useMemo, useState, type FormEvent } from "react";
import qrcode from "qrcode-generator";
import { api, type MfaState } from "../lib/api";

export default function Security() {
  const [s, setS] = useState<MfaState | null>(null);
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => api.mfa().then(setS, (e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const qr = useMemo(() => {
    if (!setup) return "";
    const q = qrcode(0, "M"); q.addData(setup.uri); q.make();
    return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [setup]);

  const run = async (fn: () => Promise<void>) => { setBusy(true); setErr(""); try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const start = () => run(async () => { setSetup(await api.mfaSetup()); setCode(""); });
  const enable = (e: FormEvent) => { e.preventDefault(); run(async () => { setCodes((await api.mfaEnable(code.trim())).recoveryCodes); setSetup(null); setCode(""); await load(); }); };
  const disable = (e: FormEvent) => { e.preventDefault(); if (!confirm("Turn off two-step sign-in?")) return; run(async () => { await api.mfaDisable(code.trim()); setCode(""); await load(); }); };

  return (
    <>
      <div className="topbar"><h1>Security</h1></div>
      <div className="content" style={{ maxWidth: 760 }}>
        {err && <div className="notice err">{err}</div>}
        {!s ? <p className="muted">Loading…</p> : (
          <section className="panel">
            <div className="row between"><h3>Two-step sign-in</h3><span className={`role-chip ${s.enabled ? "r-compliance" : "r-operations"}`}>{s.enabled ? "On" : "Off"}</span></div>
            <p className="muted" style={{ margin: 0, fontSize: 14, lineHeight: 1.55 }}>
              After you sign in, the console also asks for a 6-digit code from an authenticator app such as Google Authenticator, Microsoft Authenticator or 1Password.
              {s.required && !s.enabled && " Owners and admins must turn this on before they can change anything."}
            </p>
            {!s.available && <div className="notice err">Two-step sign-in isn't configured on this server yet.</div>}

            {codes && (
              <div className="notice ok" style={{ display: "flex", flexDirection: "column", gap: 8, color: "var(--text)" }}>
                <b>Save your recovery codes now</b>
                <span style={{ fontSize: 13 }}>Each one works once if you lose your phone. They won't be shown again.</span>
                <code className="rec-codes">{codes.join("\n")}</code>
                <button type="button" className="btn ghost sm" onClick={() => navigator.clipboard.writeText(codes.join("\n"))}>Copy codes</button>
              </div>
            )}

            {!s.enabled && !setup && s.available && <button className="btn primary" disabled={busy} onClick={start} style={{ alignSelf: "flex-start" }}>Turn on two-step sign-in</button>}

            {setup && (
              <form onSubmit={enable} className="mfa-setup">
                <div className="mfa-qr" aria-label="QR code for your authenticator app" role="img" dangerouslySetInnerHTML={{ __html: qr }} />
                <div className="col" style={{ gap: 10 }}>
                  <span style={{ fontSize: 14 }}>1. Scan this code with your authenticator app.</span>
                  <span className="muted" style={{ fontSize: 13 }}>Can't scan? Enter this key: <code style={{ wordBreak: "break-all" }}>{setup.secret}</code></span>
                  <label className="field">2. Enter the 6-digit code it shows<input className="input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} /></label>
                  <button className="btn primary" disabled={busy || code.length !== 6} style={{ justifyContent: "center" }}>{busy ? "Checking…" : "Turn on"}</button>
                </div>
              </form>
            )}

            {s.enabled && (
              <form onSubmit={disable} className="col" style={{ gap: 10 }}>
                <span className="muted" style={{ fontSize: 13 }}>{s.recoveryLeft} recovery codes left.</span>
                {s.required
                  ? <span className="muted" style={{ fontSize: 13 }}>As an owner or admin you can turn it off, but you won't be able to change anything until it's back on.</span>
                  : null}
                <label className="field">Current code, to turn it off<input className="input" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} style={{ maxWidth: 200 }} /></label>
                <button className="btn ghost sm" disabled={busy || code.length !== 6} style={{ alignSelf: "flex-start" }}>Turn off</button>
              </form>
            )}
          </section>
        )}
      </div>
    </>
  );
}

/** Shown instead of the console when this session still needs a code. */
export function MfaPrompt({ onOk, onSignOut }: { onOk: () => void; onSignOut: () => void }) {
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr("");
    try { await api.mfaVerify(code.trim()); onOk(); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="page start">
      <section className="wrap start-ws">
        <form className="panel start-ws-card" style={{ maxWidth: 440 }} onSubmit={submit}>
          <span className="eyebrow">Two-step sign-in</span>
          <h1 style={{ fontSize: 30, margin: 0 }}>Enter your code</h1>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>{useRecovery ? "Enter one of your recovery codes. Each works once." : "Open your authenticator app and enter the 6-digit code for Diamondz Tokenize."}</p>
          <label className="field">{useRecovery ? "Recovery code" : "Code"}
            <input className="input" autoFocus inputMode={useRecovery ? "text" : "numeric"} autoComplete="one-time-code" value={code}
              onChange={(e) => setCode(useRecovery ? e.target.value.slice(0, 20) : e.target.value.replace(/\D/g, "").slice(0, 6))} />
          </label>
          {err && <div className="notice err">{err}</div>}
          <button className="btn primary" disabled={busy || (!useRecovery && code.length !== 6) || (useRecovery && code.length < 8)} style={{ justifyContent: "center" }}>{busy ? "Checking…" : "Continue"}</button>
          <div className="row between">
            <button type="button" className="btn link sm" onClick={() => { setUseRecovery(!useRecovery); setCode(""); setErr(""); }}>{useRecovery ? "Use the app code" : "Use a recovery code"}</button>
            <button type="button" className="btn link sm" onClick={onSignOut}>Sign out</button>
          </div>
        </form>
      </section>
    </div>
  );
}
