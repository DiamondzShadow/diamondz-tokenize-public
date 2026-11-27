import { useEffect, useState } from "react";
import { AssetClassIcon } from "../lib/Icons";
import { api, type Tenant } from "../lib/api";
import { ASSET_CLASSES } from "../lib/catalog";
import { useTenant } from "../lib/tenant";
import { PageHelp } from "./onboarding";

const SWATCHES = ["#1E3A6B", "#7CE7F0", "#8A5A1F", "#1F6F5C", "#2B4C9B", "#B83280", "#E4572E"];

export default function Branding() {
  const { tenant, setTenant } = useTenant();
  const [t, setT] = useState<Tenant | null>(tenant);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => setT(tenant), [tenant]);
  if (!t) return null;

  const toggle = (id: (typeof ASSET_CLASSES)[number]["id"]) =>
    setT({ ...t, offerings: t.offerings.includes(id) ? t.offerings.filter((x) => x !== id) : [...t.offerings, id] });

  async function publish() {
    if (!t) return;
    setSaving(true);
    setMsg(null);
    try {
      const saved = await api.updateTenant({ name: t.name, brand: t.brand, offerings: t.offerings, poweredBy: t.poweredBy, onboarding: { ...t.onboarding, brandingDone: true } });
      setTenant(saved);
      setMsg({ kind: "ok", text: "Published. Your investor site now uses this branding." });
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  const light = t.brand.theme === "light";
  const pv = light
    ? { bg: "#FAF7F0", fg: "#1C1A16", muted: "#6B6455", line: "#E7E1D3", card: "#fff" }
    : { bg: "#070A12", fg: "#EEF2FA", muted: "#8C98B3", line: "#222C44", card: "#0E1320" };

  return (
    <>
      <div className="topbar">
        <h1>Branding &amp; domain</h1>
        <div className="row">
          <button className="btn ghost sm" onClick={() => setT(tenant)}>Discard</button>
          <button className="btn primary sm" disabled={saving} onClick={publish}>{saving ? "Publishing…" : "Publish changes"}</button>
        </div>
      </div>
      <div className="content">
        <PageHelp
          id="branding"
          what="How your investor site looks: name, logo, colors, theme, and which asset types you offer. The preview on the right updates as you change things."
          next="Click Publish changes. Then set where money goes on the Payments page."
        />
        {msg && <div className={`notice ${msg.kind}`}>{msg.text}</div>}
        <div className="brand-split">
          <div className="panel">
            <h3>Identity</h3>
            <label className="field">Platform name<input className="input" value={t.name} maxLength={60} onChange={(e) => setT({ ...t, name: e.target.value })} /></label>
            <label className="field">Logo URL (https, square SVG or PNG)<input className="input" value={t.brand.logoUrl ?? ""} placeholder="https://…" onChange={(e) => setT({ ...t, brand: { ...t.brand, logoUrl: e.target.value || undefined } })} /></label>
            <div className="field">Primary color
              <div className="swatches">
                {SWATCHES.map((c) => (
                  <div key={c} className={`sw ${t.brand.primary === c ? "on" : ""}`} style={{ background: c }} onClick={() => setT({ ...t, brand: { ...t.brand, primary: c } })} />
                ))}
                <input type="color" value={t.brand.primary} onChange={(e) => setT({ ...t, brand: { ...t.brand, primary: e.target.value } })} style={{ width: 44, height: 44, border: "none", background: "none" }} aria-label="Custom color" />
              </div>
            </div>
            <label className="field">Theme
              <select className="input" value={t.brand.theme} onChange={(e) => setT({ ...t, brand: { ...t.brand, theme: e.target.value as "dark" | "light" } })}>
                <option value="dark">Dark</option><option value="light">Light</option>
              </select>
            </label>
            <h3 style={{ marginTop: 6 }}>Domain</h3>
            {t.hosts.map((h) => <div className="li" key={h}><span>{h}</span><span style={{ color: "var(--ok)" }}>Active</span></div>)}
            <p className="muted" style={{ fontSize: 13 }}>To add your own domain, point a CNAME at the platform and we'll issue the certificate. Self-serve domain setup is coming soon.</p>
            <h3 style={{ marginTop: 6 }}>Offerings</h3>
            {ASSET_CLASSES.map((c) => (
              <div className="toggle" key={c.id}><span className="row" style={{ gap: 8, flexWrap: "nowrap" }}><span className="ico-inline"><AssetClassIcon id={c.id} size={18} /></span>{c.name}</span><div className={`tg ${t.offerings.includes(c.id) ? "" : "off"}`} onClick={() => toggle(c.id)} /></div>
            ))}
            <div className="toggle"><span>Show "Powered by Diamondz"</span><div className={`tg ${t.poweredBy ? "" : "off"}`} onClick={() => setT({ ...t, poweredBy: !t.poweredBy })} /></div>
          </div>

          <div className="preview" style={{ background: pv.bg, color: pv.fg, borderColor: pv.line }}>
            <div className="pv-nav" style={{ borderColor: pv.line }}>
              <div className="pv-logo">
                {t.brand.logoUrl ? <img src={t.brand.logoUrl} alt="" width={24} height={24} style={{ borderRadius: 6 }} /> : <div className="pv-mark" style={{ background: t.brand.primary }} />}
                {t.name}
              </div>
              <span>Offerings · Portfolio · Sign in</span>
            </div>
            <div className="pv-hero">
              <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: ".12em", color: t.brand.primary }}>LIVE PREVIEW</span>
              <h2>Own a share of real assets</h2>
              <p style={{ color: pv.muted }}>Verified investors can buy tokens backed by {t.offerings.length ? ASSET_CLASSES.filter((c) => t.offerings.includes(c.id)).map((c) => c.name.toLowerCase()).slice(0, 3).join(", ") : "real assets"} and receive income on chain.</p>
              <span className="pv-btn" style={{ background: t.brand.primary, color: "#fff" }}>View offerings</span>
            </div>
            <div className="pv-cards">
              {ASSET_CLASSES.filter((c) => t.offerings.includes(c.id)).slice(0, 3).map((c) => (
                <div className="pv-card" key={c.id} style={{ background: pv.card, borderColor: pv.line }}><b>{c.name}</b><span style={{ color: pv.muted }}>{c.blurb.split(",")[0]}</span></div>
              ))}
            </div>
            <div className="pv-foot" style={{ borderColor: pv.line, color: pv.muted }}>{t.poweredBy ? "Powered by Diamondz Tokenize · " : ""}Sample preview.</div>
          </div>
        </div>
      </div>
    </>
  );
}
