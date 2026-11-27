import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Sheet } from "../lib/Chrome";
import { LockIcon, BookIcon, BrushIcon, CardIcon, IncomeIcon, DashboardIcon, LogoutIcon, MailIcon, MoreIcon, PlusIcon, ReceiptIcon, StoreIcon, UsersIcon } from "../lib/Icons";
import { api, type AccountState, type Me, type MfaState, type Tenant } from "../lib/api";
import { MfaPrompt } from "./Security";
import { TenantOverride, useTenant } from "../lib/tenant";
import { Logo } from "../pages/Landing";
import Connect from "../lib/Connect";
import { DEFAULT_CHAIN_ID } from "../lib/chains";

const NAV = [
  { to: "/app", label: "Dashboard", Icon: DashboardIcon, tab: true },
  { to: "/app/new", label: "New issuance", short: "New", Icon: PlusIcon, tab: true },
  { to: "/app/investors", label: "Investors", Icon: UsersIcon, tab: true },
  { to: "/app/payouts", label: "Payouts", Icon: IncomeIcon, tab: true },
  { to: "/app/messages", label: "Messages", Icon: MailIcon },
  { to: "/app/payments", label: "Payment settings", Icon: CardIcon },
  { to: "/app/branding", label: "Branding", Icon: BrushIcon },
  { to: "/app/clients", label: "Clients", Icon: IncomeIcon },
  { to: "/app/reviews", label: "Go-live reviews", Icon: BookIcon },
  { to: "/app/signing", label: "Signing log", Icon: BookIcon },
  { to: "/app/team", label: "Team", Icon: UsersIcon },
  { to: "/app/security", label: "Security", Icon: LockIcon },
  { to: "/app/billing", label: "Plan & billing", Icon: ReceiptIcon },
  { to: "/app/guide", label: "Guide", Icon: BookIcon },
  { to: "/market", label: "Marketplace ↗", Icon: StoreIcon },
] as const;

export default function Layout() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [ws, setWs] = useState<{ tenant: Tenant; account: AccountState } | null>(null);
  const [needsMfa, setNeedsMfa] = useState(false);
  const [boot, setBoot] = useState(0);
  const navigate = useNavigate();

  useEffect(() => {
    api.me().then((m) => { setNeedsMfa(false); setMe(m); }, (e: { status?: number; data?: { needsWorkspace?: boolean; needsMfa?: boolean } }) => {
      // Signed in with an issuer account but no workspace yet → set one up (design S3).
      if (e?.status === 403 && e.data?.needsWorkspace) navigate("/start/workspace", { replace: true });
      else if (e?.status === 401 && e.data?.needsMfa) setNeedsMfa(true);
      else setMe(null);
    });
  }, [navigate, boot]);
  // Account sign-ins act on their workspace, not the website's tenant.
  useEffect(() => {
    if (!me?.account) { setWs(null); return; }
    Promise.all([api.workspace(), api.account()]).then(([tenant, account]) => setWs({ tenant, account }), () => setWs(null));
  }, [me?.account]);

  if (needsMfa) return <MfaPrompt onOk={() => setBoot((b) => b + 1)} onSignOut={() => api.signOut().finally(() => { setNeedsMfa(false); setMe(null); })} />;
  if (me && me.account && !ws) return null;
  const shell = <ConsoleShell me={me} setMe={setMe} ws={ws} />;
  return ws ? <TenantOverride tenant={ws.tenant}>{shell}</TenantOverride> : shell;
}

function ConsoleShell({ me, setMe, ws }: { me: Me | null | undefined; setMe: (m: Me | null) => void; ws: { tenant: Tenant; account: AccountState } | null }) {
  const { tenant } = useTenant();

  const loc = useLocation();
  const [more, setMore] = useState(false);
  useEffect(() => setMore(false), [loc.pathname]);
  // Unread contact-form messages: refreshed on navigation and whenever the Messages page changes one.
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    if (!me) return;
    const pull = () => api.unreadMessages().then((r) => setUnread(r.unread), () => {});
    pull();
    window.addEventListener("messages-changed", pull);
    return () => window.removeEventListener("messages-changed", pull);
  }, [me, loc.pathname]);
  const badge = (to: string) => (to === "/app/messages" && unread > 0 ? <span className="nav-count" aria-label={`${unread} unread`}>{unread > 99 ? "99+" : unread}</span> : null);
  if (me === undefined) return null;
  if (me === null) return <SignIn onOk={setMe} />;

  return (
    <div className="app-shell">
      <aside className="side">
        <NavLink to="/" style={{ padding: 0 }}><Logo name={ws ? "Diamondz Tokenize" : tenant?.name ?? "Diamondz Tokenize"} logoUrl={ws ? undefined : tenant?.brand.logoUrl} /></NavLink>
        {ws && <WorkspaceBox ws={ws} />}
        {NAV.filter((n) => ((n.to === "/app/reviews" || n.to === "/app/signing") ? (ws ? ws.tenant.id : tenant?.id) === "diamondz" && (me?.role === "owner" || me?.role === "admin" || !me?.account) : !["/app/team", "/app/security", "/app/clients"].includes(n.to) || ws)).map(({ to, label, Icon }) => (
          <NavLink key={to} to={to} end={to === "/app"} className={({ isActive }) => (isActive ? "active" : "")}>
            <Icon size={18} /> {label}{badge(to)}
          </NavLink>
        ))}
        <a onClick={() => api.signOut().finally(() => setMe(null))}><LogoutIcon size={18} /> Sign out</a>
        {/* Self-serve accounts: no wallet in the sidebar (design S4) — it's asked for at the moment of an on-chain action. */}
        {!ws && (
          <div style={{ marginTop: "auto", paddingTop: 12 }}>
            <span className="muted" style={{ fontSize: 12, display: "block", marginBottom: 6 }}>Wallet</span>
            <Connect chainId={DEFAULT_CHAIN_ID} compact />
          </div>
        )}
        <div className="tenant-sw" style={{ marginTop: ws ? "auto" : 12 }}>
          <span className="muted">Signed in</span>
          <br />
          <b style={{ wordBreak: "break-all" }}>{ws ? ws.account.account.email ?? me.email : me.name ?? me.email}</b>
        </div>
      </aside>
      <main className="main">
        {ws && <MfaBanner />}
        {ws && <TrialBanner tenant={ws.tenant} />}
        <Outlet />
      </main>
      <nav className="tabbar console-tabs" aria-label="Console">
        {NAV.filter((n) => "tab" in n && n.tab).map(({ to, label, Icon, ...n }) => (
          <NavLink key={to} to={to} end={to === "/app"} className={({ isActive }) => (isActive ? "on" : "")}><Icon />{"short" in n ? n.short : label}</NavLink>
        ))}
        <button onClick={() => setMore(true)} className="more-btn"><MoreIcon />More{unread > 0 && <span className="nav-dot" aria-label={`${unread} unread messages`} />}</button>
      </nav>
      <Sheet open={more} onClose={() => setMore(false)} title="More">
        <nav className="mmenu-items" aria-label="More" style={{ paddingTop: 0 }}>
          {NAV.filter((n) => !("tab" in n) && (((n.to === "/app/reviews" || n.to === "/app/signing") ? (ws ? ws.tenant.id : tenant?.id) === "diamondz" && (me?.role === "owner" || me?.role === "admin" || !me?.account) : !["/app/team", "/app/security", "/app/clients"].includes(n.to) || ws))).map(({ to, label, Icon }) => <NavLink key={to} to={to}><Icon />{label}{badge(to)}</NavLink>)}
          <a onClick={() => api.signOut().finally(() => setMe(null))} style={{ cursor: "pointer" }}><LogoutIcon />Sign out</a>
        </nav>
        {ws ? <WorkspaceBox ws={ws} /> : (<><span className="muted" style={{ fontSize: 12 }}>Wallet</span><Connect chainId={DEFAULT_CHAIN_ID} /></>)}
        <span className="muted" style={{ fontSize: 12, wordBreak: "break-all" }}>Signed in as {ws ? ws.account.account.email ?? me.email : me.name ?? me.email}</span>
      </Sheet>
    </div>
  );
}

/** Which workspace the console acts on; a switcher when the account belongs to several (design S4). */
function WorkspaceBox({ ws }: { ws: { tenant: Tenant; account: AccountState } }) {
  const [busy, setBusy] = useState(false);
  const list = ws.account.workspaces;
  return (
    <div className="ws-box">
      <span className="muted">Workspace</span>
      {list.length > 1 ? (
        <select className="ws-select" value={ws.tenant.id} disabled={busy} aria-label="Switch workspace"
          onChange={(e) => { setBusy(true); api.switchWorkspace(e.target.value).then(() => location.assign("/app"), () => setBusy(false)); }}>
          {list.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      ) : <b>{ws.tenant.name}</b>}
      <NavLink to="/start/workspace?new=1" className="ws-new">+ New workspace</NavLink>
    </div>
  );
}

/** Free plan: Growth trial countdown, then a reminder that it runs on test networks only (design S4). */
function TrialBanner({ tenant }: { tenant: Tenant }) {
  if (tenant.plan.id !== "free") return null;
  const left = tenant.trialEndsAt ? Math.ceil((Date.parse(tenant.trialEndsAt) - Date.now()) / 86_400_000) : 0;
  return (
    <div className="trial-banner" role="status">
      <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
        {left > 0 ? <span className="status warn">Growth trial · {left} {left === 1 ? "day" : "days"} left</span> : <span className="status no">Free plan</span>}
        <span>{left > 0 ? "After the trial you stay on the Free plan: test networks, Diamondz branding." : "Test networks only. Choose a plan to take an offering live."}</span>
      </div>
      <NavLink to="/app/billing" className="btn primary sm">See plans</NavLink>
    </div>
  );
}

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (o: { client_id: string; callback: (r: { credential: string }) => void; hd?: string; ux_mode?: string }) => void;
          renderButton: (el: HTMLElement, o: Record<string, unknown>) => void;
        };
      };
    };
  }
}

let gsiLoading: Promise<void> | null = null;
function loadGsi(): Promise<void> {
  if (window.google?.accounts) return Promise.resolve();
  gsiLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Couldn't load Google sign-in"));
    document.head.appendChild(s);
  });
  return gsiLoading;
}

function SignIn({ onOk }: { onOk: (m: Me) => void }) {
  const { tenant } = useTenant();
  const btn = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState("");
  const clientId = tenant?.auth.googleClientId;
  const domains = tenant?.auth.domains ?? [];

  useEffect(() => {
    if (!clientId || !btn.current) return;
    let canceled = false;
    loadGsi().then(
      () => {
        if (canceled || !btn.current || !window.google) return;
        window.google.accounts.id.initialize({
          client_id: clientId,
          // Hint Google to show only accounts from the allowed Workspace domain. The server enforces it.
          hd: domains.length === 1 ? domains[0] : undefined,
          callback: ({ credential }) => {
            setErr("");
            api.signInWithGoogle(credential).then(onOk, (e) => setErr(e.message));
          },
        });
        window.google.accounts.id.renderButton(btn.current, { theme: "filled_black", size: "large", shape: "pill", text: "signin_with", width: 300 });
      },
      (e) => setErr(e.message),
    );
    return () => {
      canceled = true;
    };
  }, [clientId, domains.join(","), onOk]);

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16 }}>
      <div className="panel" style={{ width: "100%", maxWidth: 420, alignItems: "center", textAlign: "center" }}>
        <Logo name={tenant?.name ?? "Diamondz Tokenize"} logoUrl={tenant?.brand.logoUrl} />
        <h3>Issuer console</h3>
        {tenant?.id === "diamondz" && (
          <>
            <p className="muted" style={{ fontSize: 14, margin: 0 }}>Sign in with Google, Apple or your email. New here? The same button creates your free account.</p>
            <Link className="btn primary" to="/start" style={{ justifyContent: "center", alignSelf: "stretch" }}>Sign in or start free</Link>
            <div className="or" style={{ alignSelf: "stretch" }}>Diamondz team</div>
          </>
        )}
        <p className="muted" style={{ fontSize: 14 }}>
          Sign in with your {domains.length ? domains.map((d) => `@${d}`).join(" or ") : "company"} Google Workspace account.
        </p>
        {clientId ? <div ref={btn} style={{ minHeight: 44 }} /> : <div className="notice err">Google sign-in isn't configured yet.</div>}
        {err && <div className="notice err">{err}</div>}
      </div>
    </div>
  );
}

/** Owners and admins without two-step sign-in: say why changes are blocked and where to fix it. */
function MfaBanner() {
  const [s, setS] = useState<MfaState | null>(null);
  const loc = useLocation();
  useEffect(() => { api.mfa().then(setS, () => setS(null)); }, [loc.pathname]);
  if (!s || s.enabled || !s.required || !s.available || loc.pathname === "/app/security") return null;
  return <div className="mfa-banner" role="status"><span><b>Turn on two-step sign-in.</b> Owners and admins need it before they can change anything.</span><Link className="btn primary sm" to="/app/security">Set it up</Link></div>;
}
