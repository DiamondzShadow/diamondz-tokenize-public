import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type Tenant } from "./api";

interface Ctx {
  tenant: Tenant | null;
  error: string | null;
  setTenant: (t: Tenant) => void;
}
const TenantCtx = createContext<Ctx>({ tenant: null, error: null, setTenant: () => {} });

/** Pick dark text or light text for a brand color so buttons stay readable. */
function onColor(hex: string): string {
  const m = hex.replace("#", "");
  if (m.length !== 6) return "#04121A";
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.4 ? "#04121A" : "#FFFFFF";
}

/** Light is the default look; a white-label tenant may choose the dark theme. */
export function applyBrand(t: Tenant) {
  const root = document.documentElement;
  if (t.brand.theme === "dark") root.dataset.theme = "dark";
  else delete root.dataset.theme;
  root.style.setProperty("--brand", t.brand.primary);
  root.style.setProperty("--brand2", t.brand.primary);
  root.style.setProperty("--on-brand", onColor(t.brand.primary));
  document.title = t.name;
  // Installed-app title bar / phone status bar follow the site's theme.
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t.brand.theme === "dark" ? "#0B0D10" : "#FBFAF7");
}

export function TenantProvider({ children }: { children: ReactNode }) {
  const [tenant, setTenantState] = useState<Tenant | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.tenant().then(
      (t) => {
        setTenantState(t);
        applyBrand(t);
      },
      (e) => setError(String(e.message ?? e)),
    );
  }, []);

  const setTenant = (t: Tenant) => {
    setTenantState(t);
    applyBrand(t);
  };

  return <TenantCtx.Provider value={{ tenant, error, setTenant }}>{children}</TenantCtx.Provider>;
}

export const useTenant = () => useContext(TenantCtx);

/** Console for a self-serve workspace: everything inside sees the WORKSPACE (name, plan, settings, brand) instead of
 *  the website's tenant. Restores the site's brand when the console unmounts. */
export function TenantOverride({ tenant, children }: { tenant: Tenant; children: ReactNode }) {
  const site = useContext(TenantCtx);
  const [t, setT] = useState(tenant);
  useEffect(() => setT(tenant), [tenant]);
  useEffect(() => { applyBrand(t); return () => { if (site.tenant) applyBrand(site.tenant); }; }, [t, site.tenant]);
  return <TenantCtx.Provider value={{ tenant: t, error: site.error, setTenant: setT }}>{children}</TenantCtx.Provider>;
}
