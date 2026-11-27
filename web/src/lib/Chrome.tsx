// Shared page chrome (mobile design M1–M7): one header for every public page, a full-screen menu on phones,
// bottom sheets, and the investor tab bar. Desktop keeps the full nav; phone-only pieces are hidden above 720px.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useTenant } from "./tenant";
import { useConnectedAccount } from "./wallet";
import { DEFAULT_CHAIN_ID } from "./chains";
import Connect from "./Connect";
import { BuildingIcon, ChevronIcon, CloseIcon, GridIcon, IncomeIcon, MenuIcon, TagIcon, WalletIcon, BookIcon, UsersIcon, PlusIcon } from "./Icons";
import { Logo } from "../pages/Landing";

/** Lock page scroll while an overlay is open. */
function useScrollLock(on: boolean) {
  useEffect(() => {
    if (!on) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [on]);
}

/** Bottom sheet over a scrim. Closes on scrim tap and Escape. */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useScrollLock(open);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="sheet-wrap">
      <button className="scrim" aria-label="Close" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="grab" />
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
          <h2 style={{ fontSize: 22 }}>{title}</h2>
          <button className="iconbtn" aria-label="Close" onClick={onClose}><CloseIcon /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Connected wallet pill (full address, per policy) or a compact Wallet button. */
function WalletPill({ onOpen }: { onOpen: () => void }) {
  const account = useConnectedAccount();
  return (
    <button className="pillbtn" onClick={onOpen} aria-label={account ? `Wallet ${account}` : "Connect wallet"}>
      <span className="dot" style={account ? undefined : { background: "var(--muted)" }} />
      Wallet
    </button>
  );
}

export function WalletSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const account = useConnectedAccount();
  return (
    <Sheet open={open} onClose={onClose} title="Wallet">
      {account && (
        <div className="li" style={{ alignItems: "flex-start" }}>
          <span className="muted">Connected</span>
          <span className="addr" style={{ color: "var(--text)", textAlign: "right" }}>{account}</span>
        </div>
      )}
      <Connect chainId={DEFAULT_CHAIN_ID} label="Connect wallet" />
      <Link to="/portfolio" className="btn ghost" onClick={onClose} style={{ justifyContent: "center" }}>Your income</Link>
    </Sheet>
  );
}

/**
 * The one header for every public page. Desktop: logo, links, `actions`. Phone: logo (or a back button + title),
 * wallet pill, menu button that opens a full-screen menu.
 */
export function SiteHeader({ links, actions, back, title }: { links?: ReactNode; actions?: ReactNode; back?: string; title?: string }) {
  const { tenant } = useTenant();
  const [menu, setMenu] = useState(false);
  const [wallet, setWallet] = useState(false);
  const loc = useLocation();
  useEffect(() => setMenu(false), [loc.pathname]);
  useScrollLock(menu);
  const name = tenant?.name ?? "Diamondz Tokenize";
  // The main platform site offers self-serve sign-up; white-label sites keep their own issuer sign-in.
  const platform = !tenant || tenant.id === "diamondz";
  const account = useConnectedAccount();
  return (
    <>
      <nav className="wrap nav site-nav">
        {back ? (
          <Link to={back} className="iconbtn mobile-flex" aria-label="Back"><BackIconInline /></Link>
        ) : null}
        <Link to="/" className={back ? "desktop-only" : ""}><Logo name={name} logoUrl={tenant?.brand.logoUrl} /></Link>
        {back && title && <span className="mobile-flex nav-title">{title}</span>}
        <div className="links">{links ?? (platform ? <PlatformLinks /> : <><Link to="/market">Marketplace</Link><Link to="/portfolio">Your income</Link><Link to="/pricing">Pricing</Link></>)}</div>
        <div className="row desktop-only">{actions ?? (platform
          ? <PlatformActions />
          : <Link className="btn ghost sm" to="/app">Issuer sign in</Link>)}</div>
        <div className="mobile-flex nav-right">
          {(!platform || account) && <WalletPill onOpen={() => setWallet(true)} />}
          <button className="iconbtn" aria-label="Open menu" aria-expanded={menu} onClick={() => setMenu(true)}><MenuIcon /></button>
        </div>
      </nav>
      {menu && (
        <div className="mmenu" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="nav mmenu-top">
            <Link to="/" onClick={() => setMenu(false)}><Logo name={name} logoUrl={tenant?.brand.logoUrl} /></Link>
            <button className="iconbtn" aria-label="Close menu" onClick={() => setMenu(false)}><CloseIcon /></button>
          </div>
          {platform ? <PhoneMenuSplit /> : (<>
          <nav aria-label="Main" className="mmenu-items">
            <Link to="/market"><GridIcon />Marketplace<ChevronIcon size={18} /></Link>
            <Link to="/portfolio"><IncomeIcon />Your income<ChevronIcon size={18} /></Link>
            <Link to="/pricing"><TagIcon />Pricing<ChevronIcon size={18} /></Link>
            <Link to="/app"><BuildingIcon />For issuers<ChevronIcon size={18} /></Link>
          </nav>
          <div className="mmenu-foot">
            <Connect chainId={DEFAULT_CHAIN_ID} label="Connect wallet" />
            <Link to="/app" className="btn ghost" style={{ justifyContent: "center" }}>Issuer sign in</Link>
            <p className="muted" style={{ fontSize: 12, textAlign: "center" }}>Software only. Offerings are made by issuers under their own exemptions.</p>
          </div>
          </>)}
        </div>
      )}
      <WalletSheet open={wallet} onClose={() => setWallet(false)} />
    </>
  );
}
const BackIconInline = () => <svg viewBox="0 0 24 24" width={22} height={22} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>;

/** Investor tab bar, phones only. Pages that show it add the `has-tabs` class to their root for bottom padding. */
export function InvestorTabs() {
  const loc = useLocation();
  const [wallet, setWallet] = useState(false);
  const { tenant } = useTenant();
  const account = useConnectedAccount();
  // Platform site: the wallet appears once an investor has one connected (from an offering's investor steps).
  const showWallet = !(!tenant || tenant.id === "diamondz") || !!account;
  const on = (p: string) => (loc.pathname.startsWith(p) ? "on" : "");
  return (
    <>
      <nav className="tabbar" aria-label="Investor">
        <Link to="/market" className={on("/market")}><GridIcon />Marketplace</Link>
        <Link to="/portfolio" className={on("/portfolio")}><IncomeIcon />Your income</Link>
        {showWallet && <button onClick={() => setWallet(true)}><WalletIcon />Wallet</button>}
      </nav>
      <WalletSheet open={wallet} onClose={() => setWallet(false)} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Header split (design 1, canvas 15R3n8ALvMUcS7iPxWEPTj, approved 2026-11-20): investors and issuers each get their
// own menu on every page, and "Sign in" asks which one you are instead of always opening issuer sign-up.

/** A header dropdown: button + panel; closes on outside click, Escape and navigation. */
function NavMenu({ label, children, wide }: { label: string; children: (close: () => void) => ReactNode; wide?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open]);
  return (
    <div className="navmenu" ref={ref}>
      <button type="button" className={`navmenu-btn${open ? " on" : ""}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {label}<svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && <div className={`navmenu-panel${wide ? " wide" : ""}`}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

function MenuItem({ to, icon, title, sub, onClick }: { to: string; icon: ReactNode; title: string; sub: string; onClick?: () => void }) {
  return <Link to={to} className="mi" onClick={onClick}><span className="mi-ic">{icon}</span><span><b>{title}</b><span>{sub}</span></span></Link>;
}

function InvestItems({ close }: { close?: () => void }) {
  return (
    <>
      <MenuItem to="/market" icon={<GridIcon size={18} />} title="Marketplace" sub="Every open offering, with its proof checks" onClick={close} />
      <MenuItem to="/portfolio" icon={<IncomeIcon size={18} />} title="Your holdings and income" sub="Tokens you own and payouts to claim" onClick={close} />
      <MenuItem to="/invest/entity" icon={<BuildingIcon size={18} />} title="Investing as a company or fund" sub="Verify an LLC, fund, trust or family office" onClick={close} />
    </>
  );
}

function IssuerItems({ close }: { close?: () => void }) {
  return (
    <>
      <MenuItem to="/start" icon={<PlusIcon size={18} />} title="Start free" sub="A workspace in a minute. No wallet needed." onClick={close} />
      <MenuItem to="/app" icon={<UsersIcon size={18} />} title="Sign in to your workspace" sub="Issuers and invited team members" onClick={close} />
      <MenuItem to="/builder" icon={<BookIcon size={18} />} title="Contract Builder" sub="See exactly what gets deployed, in plain English or code" onClick={close} />
      <MenuItem to="/use-cases" icon={<BookIcon size={18} />} title="Use cases" sub="Banks, funds, real estate, music, sports…" onClick={close} />
    </>
  );
}

function PlatformLinks() {
  return (
    <>
      <NavMenu label="Invest">{(close) => <><span className="navmenu-kicker">For investors · no account needed</span><InvestItems close={close} /></>}</NavMenu>
      <NavMenu label="For issuers">{(close) => <IssuerItems close={close} />}</NavMenu>
      <Link to="/pricing">Pricing</Link>
      <Link to="/markets">Markets</Link>
      <Link to="/technology">Technology</Link>
    </>
  );
}

/** Desktop actions on the platform site: Sign in (asks investor or issuer) + Start free. */
export function PlatformActions() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn ghost sm" onClick={() => setOpen(true)}>Sign in</button>
      <Link className="btn primary sm" to="/start">Start free</Link>
      <SignInChooser open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function SignInChooser({ open, onClose }: { open: boolean; onClose: () => void }) {
  useScrollLock(open);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="chooser-wrap">
      <button className="scrim" aria-label="Close" onClick={onClose} />
      <section className="chooser" role="dialog" aria-modal="true" aria-labelledby="chooser-h">
        <div className="row between" style={{ flexWrap: "nowrap" }}>
          <h2 id="chooser-h">Sign in as…</h2>
          <button className="iconbtn" aria-label="Close" onClick={onClose}><CloseIcon /></button>
        </div>
        <Link to="/portfolio" className="choice" onClick={onClose}>
          <span className="mi-ic solid"><WalletIcon size={18} /></span>
          <span><b>An investor</b><span>See your holdings, claim income and continue a verification. You sign in with your wallet, or with email or Google if you made your wallet that way.</span></span>
        </Link>
        <Link to="/start" className="choice" onClick={onClose}>
          <span className="mi-ic"><BuildingIcon size={18} /></span>
          <span><b>An issuer or a team member</b><span>Open your workspace to create offerings, verify investors and pay holders. Google, Apple or an email code; no wallet needed.</span></span>
        </Link>
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>Invited to a team? Use the email your invite was sent to.</p>
      </section>
    </div>
  );
}

/** Phone menu on the platform site: an "I invest" / "I issue" switch. */
function PhoneMenuSplit() {
  const [tab, setTab] = useState<"invest" | "issue">("invest");
  return (
    <>
      <div className="mm-tabs" role="tablist" aria-label="Menu for">
        <button type="button" role="tab" aria-selected={tab === "invest"} className={tab === "invest" ? "on" : ""} onClick={() => setTab("invest")}>I invest</button>
        <button type="button" role="tab" aria-selected={tab === "issue"} className={tab === "issue" ? "on" : ""} onClick={() => setTab("issue")}>I issue</button>
      </div>
      <nav aria-label="Main" className="mmenu-items">
        {tab === "invest" ? <>
          <Link to="/market"><GridIcon />Marketplace<ChevronIcon size={18} /></Link>
          <Link to="/portfolio"><IncomeIcon />Your holdings and income<ChevronIcon size={18} /></Link>
          <Link to="/invest/entity"><BuildingIcon />Investing as a company or fund<ChevronIcon size={18} /></Link>
        </> : <>
          <Link to="/start"><PlusIcon />Start free<ChevronIcon size={18} /></Link>
          <Link to="/app"><UsersIcon />Sign in to your workspace<ChevronIcon size={18} /></Link>
          <Link to="/pricing"><TagIcon />Pricing<ChevronIcon size={18} /></Link>
        </>}
        <Link to="/builder"><BookIcon />Contract Builder<ChevronIcon size={18} /></Link>
        <Link to="/use-cases"><BookIcon />Use cases<ChevronIcon size={18} /></Link>
        <Link to="/markets"><BookIcon />Markets<ChevronIcon size={18} /></Link>
        <Link to="/technology"><BookIcon />Technology<ChevronIcon size={18} /></Link>
      </nav>
      <div className="mmenu-foot">
        {tab === "invest"
          ? <Link to="/market" className="btn primary" style={{ justifyContent: "center" }}>Find an offering</Link>
          : <><Link to="/start" className="btn primary" style={{ justifyContent: "center" }}>Start free</Link><Link to="/app" className="btn ghost" style={{ justifyContent: "center" }}>Sign in to your workspace</Link></>}
        <p className="muted" style={{ fontSize: 12, textAlign: "center" }}>Software only. Offerings are made by issuers under their own exemptions.</p>
      </div>
    </>
  );
}
