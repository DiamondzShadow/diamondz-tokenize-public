// "Built on" strip: the third-party technology the platform uses, stated factually. Text only, no logos, and no
// partnership or endorsement claims: we use these services; we have no agreements with these companies.
//
// Chainlink's trademark guidelines forbid using its logo without written permission; the only mark we show is its
// official "Market Data secured with Chainlink" badge (chain.link/badge), unaltered, hotlinked, linking to chain.link/badge.
// 🚨 It stays OFF until the CRE workflow is deployed and live offerings are actually priced from Chainlink feeds:
// build with VITE_CHAINLINK_MARKET_DATA_BADGE=1 (deploy.sh does). Workflows deployed on CRE 2026-11-26.
const SHOW_CHAINLINK_BADGE = import.meta.env.VITE_CHAINLINK_MARKET_DATA_BADGE === "1";

export default function BuiltOn() {
  const items: [string, string][] = [
    ["Chainlink", "Runtime Environment for asset data feeds behind proof of asset"],
    ["Circle", "USDC for purchases and income payouts"],
    ["Mastercard", "Open Finance for accredited-investor checks"],
  ];
  return (
    <section className="wrap" style={{ paddingTop: 8, paddingBottom: 40 }} aria-labelledby="built-on">
      <div style={{ borderTop: "1px solid var(--line)", paddingTop: 28, display: "flex", flexDirection: "column", gap: 18 }}>
        <span id="built-on" className="eyebrow">Built on</span>
        <div className="built-on">
          {items.map(([name, what]) => (
            <div key={name} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <b style={{ fontSize: 16 }}>{name}</b>
              <span className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>{what}</span>
            </div>
          ))}
        </div>
        {SHOW_CHAINLINK_BADGE && (
          <a href="https://chain.link/badge" className="cl-badge" target="_blank" rel="noopener noreferrer">
            {/* Chainlink's "white" variant is the full-color badge (blue mark on its own light card) and reads in both themes;
                the "black" variant is a white-only outline that looks gray on a light page. */}
            <img src="https://chain.link/badge-market-data-white" alt="market data secured with chainlink" height={55} />
          </a>
        )}
        <small className="muted" style={{ fontSize: 12 }}>Chainlink, Circle, USDC and Mastercard are trademarks of their respective owners. Their use here describes technology we integrate and implies no partnership or endorsement.</small>
      </div>
    </section>
  );
}
