// Landing-page aside: the live Chainlink prices from GET /api/markets (same data as /markets).
import { useEffect, useState } from "react";

interface LiveFeed { key: string; label: string; unit: "usd" | "index"; value: number; updatedAt: string }

export default function MarketsStrip() {
  const [live, setLive] = useState<LiveFeed[] | null>(null);
  useEffect(() => {
    fetch("/api/markets").then((r) => (r.ok ? r.json() : Promise.reject())).then((d) => setLive(d.live ?? [])).catch(() => setLive([]));
  }, []);
  if (!live?.length) return <div className="mk-strip" aria-busy={live === null} />;
  return (
    <div className="mk-strip">
      {live.map((f, i) => (
        <div className={`mk-stat ${i === live.length - 1 && live.length % 2 ? "wide" : ""}`} key={f.key}>
          <span className="mk-label">{f.label}</span>
          <b>{f.unit === "usd" ? `$${f.value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : f.value.toLocaleString("en-US", { maximumFractionDigits: 2 })}</b>
          <span className="mk-meta">Chainlink price feed</span>
        </div>
      ))}
    </div>
  );
}
