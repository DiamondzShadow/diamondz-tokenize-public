// White-label custom domain that hasn't gone live yet (W1 "Go live"): visitors see an opening-soon page; people with
// the workspace's preview link (?preview=<key>, remembered for this browser tab) see the whole site. Legal pages
// stay readable either way.
import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { api } from "./api";
import { useTenant } from "./tenant";

const KEY = "dt_site_preview";

export default function SiteGate({ children }: { children: ReactNode }) {
  const { tenant } = useTenant();
  const { pathname, search } = useLocation();
  const [ok, setOk] = useState<boolean | null>(() => { try { return sessionStorage.getItem(KEY) === "1" ? true : null; } catch { return null; } });
  const closed = !!tenant?.site && !tenant.site.live;
  useEffect(() => {
    if (!closed || ok) return;
    const k = new URLSearchParams(search).get("preview");
    if (!k) { setOk(false); return; }
    api.sitePreview(k).then((r) => { setOk(r.ok); if (r.ok) { try { sessionStorage.setItem(KEY, "1"); } catch { /* private mode */ } } }, () => setOk(false));
  }, [closed, ok, search]);
  if (!closed || ok || pathname.startsWith("/legal/")) return <>{children}</>;
  if (ok === null) return null;
  return (
    <div className="page opening-soon">
      <main className="wrap">
        {tenant?.brand.logoUrl ? <img src={tenant.brand.logoUrl} alt={tenant.name} style={{ maxHeight: 56 }} /> : <b className="display" style={{ fontSize: 28 }}>{tenant?.name}</b>}
        <h1 className="display">Opening soon</h1>
        <p className="muted">{tenant?.name} is preparing this site. Please check back shortly.</p>
      </main>
    </div>
  );
}
