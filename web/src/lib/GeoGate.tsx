// Visitors from sanctioned regions get this page instead of the app. The API refuses them too (api/src/geo.ts), so
// this only saves them a broken page.
import { useEffect, useState, type ReactNode } from "react";

export default function GeoGate({ children }: { children: ReactNode }) {
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    fetch("/api/geo", { cache: "no-store" }).then((r) => r.json()).then((g) => setBlocked(!!g?.blocked)).catch(() => {});
  }, []);
  if (!blocked) return <>{children}</>;
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, textAlign: "center" }}>
      <div>
        <h1 style={{ fontSize: 24 }}>Not available in your region</h1>
        <p className="muted">Diamondz Tokenize doesn't serve this country or network.</p>
      </div>
    </main>
  );
}
