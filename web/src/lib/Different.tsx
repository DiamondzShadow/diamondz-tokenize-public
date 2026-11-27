// "What's different": the platform's verifiable differentiators, stated plainly (no "first" or "only" claims).
export default function Different() {
  const items: [string, string][] = [
    ["Sales stop when the proof does", "Every sale checks an on-chain record of independent title, valuation and insurance checks. If one lapses or fails, new sales pause on their own. Issuers can't vouch for their own assets."],
    ["Income proven from the bank", "Rent and royalties are read from the SPV's bank account through Mastercard Open Finance and signed on chain each month, not taken from a PDF."],
    ["Accreditation without keeping your data", "Investors link accounts with Mastercard and the issuer reviews the report. We keep the decision and a numbers-only summary, never your name or date of birth."],
    ["You own every contract", "The token, the sale and the investor registry belong to the issuer's wallet. On ERC-3643 offerings the platform can't mint, forge a KYC claim or, by default, change the code."],
  ];
  return (
    <section className="wrap" style={{ paddingTop: 48, paddingBottom: 8 }} aria-labelledby="different">
      <div style={{ borderTop: "1px solid var(--line)", paddingTop: 32, display: "flex", flexDirection: "column", gap: 22 }}>
        <span id="different" className="eyebrow">What's different</span>
        <div className="different">
          {items.map(([t, d]) => (
            <div key={t} style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 16, borderTop: "1px solid var(--text)" }}>
              <b style={{ fontSize: 17, fontFamily: "var(--font-display)", fontWeight: 500 }}>{t}</b>
              <span className="muted" style={{ fontSize: 14, lineHeight: 1.55 }}>{d}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
