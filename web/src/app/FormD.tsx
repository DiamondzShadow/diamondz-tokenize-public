// Issuer: find the offering's Form D on SEC EDGAR and attach it (design canvas Bzws9rhX8gBzhFXW8pV2eW, F1 + F2).
// Searches cost paid-API calls, so they only run when the issuer presses Search; results are cached server-side.
// Only filings the search returned can be attached; the listing then shows it with a link to SEC.gov.
import { useEffect, useState, type FormEvent } from "react";
import { api, type Asset, type EdgarStatus, type FormDFiling } from "../lib/api";

const usd = (n: number) => n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
export const dayOn = (ymd: string | null) => (ymd ? new Date(`${ymd}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—");
// SEC EDGAR gives filing dates as YYYY-MM-DD (no time): show them as that calendar day in every time zone.
export const filedOn = (iso: string) => (!iso ? "—" : /^\d{4}-\d{2}-\d{2}$/.test(iso) ? dayOn(iso) : new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }));
export const formName = (f: FormDFiling) => (f.form === "D/A" ? "Form D/A" : `Form ${f.form}`);
export const exemptionText = (f: FormDFiling) => f.exemptions.map((e) => e.label).join(", ") || "Not stated";
const titleCase = (s: string) => s.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase());
const sold = (f: FormDFiling) =>
  f.totalAmountSold === null ? "—" : `${usd(f.totalAmountSold)} ${f.totalOfferingAmount === null ? "of an open-ended offering" : `of ${usd(f.totalOfferingAmount)}`}`;
const investors = (f: FormDFiling) =>
  f.investors === null ? "—" : `${f.investors}${f.hasNonAccredited === false ? ", all accredited" : f.hasNonAccredited ? ", some not accredited" : ""}`;

export default function FormDPanel({ asset, onChange }: { asset: Asset; onChange: (a: Asset) => void }) {
  const [status, setStatus] = useState<EdgarStatus | null>(null);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ query: string; results: FormDFiling[] } | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const f = asset.formD;

  useEffect(() => { api.edgarStatus().then(setStatus, () => setStatus(null)); }, []);

  async function search(q: string, fresh = false) {
    setBusy(fresh ? "fresh" : "search");
    setErr("");
    try {
      const r = await api.formDSearch(asset.id, q, fresh);
      setFound({ query: q, results: r.results });
      setStatus((s) => (s ? { ...s, searchesLeftToday: r.searchesLeftToday } : s));
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(""); }
  }
  const onSearch = (e: FormEvent) => { e.preventDefault(); if (query.trim()) search(query.trim()); };

  async function attach(acc: string) {
    setBusy(acc);
    setErr("");
    try { onChange(await api.formDAttach(asset.id, acc)); setFound(null); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(""); }
  }
  async function remove() {
    if (!confirm("Remove the Form D from this offering? The listing stops showing it.")) return;
    setBusy("remove");
    setErr("");
    try { onChange(await api.formDRemove(asset.id)); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(""); }
  }

  const disabled = status !== null && !status.enabled;
  const listingMin = Number(asset.minInvestment);
  const minMismatch = f && f.minimumInvestment !== null && Number.isFinite(listingMin) && listingMin > 0 && listingMin !== f.minimumInvestment;
  // Providers format filedAt differently (date vs timestamp): compare the day, then the accession sequence.
  const order = (x: FormDFiling) => x.filedAt.slice(0, 10) + x.accessionNo;
  const newer = f && found?.results.find((r) => r.cik === f.cik && r.accessionNo !== f.accessionNo && order(r) > order(f));

  return (
    <div className="panel" id="sec-filing">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap" }}>
        <h3>SEC filing (Form D)</h3>
        {f ? <span className="tag g">Attached</span> : <span className="tag y">Not attached</span>}
      </div>

      {f ? (
        <>
          <p className="muted" style={{ fontSize: 14 }}>Shown on the listing with a link to SEC.gov. Figures are as filed; they don't update from your sales.</p>
          <div className="formd-grid">
            <div>
              <div className="li"><span className="muted">Filing</span><span>{formName(f)}{f.form === "D/A" ? " (amendment)" : ""} · filed {filedOn(f.filedAt)}</span></div>
              <div className="li"><span className="muted">Issuer</span><span>{f.entityName}</span></div>
              <div className="li"><span className="muted">SEC CIK</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{f.cik}</span></div>
              <div className="li"><span className="muted">Exemption</span><span>{exemptionText(f)}</span></div>
            </div>
            <div>
              <div className="li"><span className="muted">First sale</span><span>{dayOn(f.dateOfFirstSale)}</span></div>
              <div className="li"><span className="muted">Sold, as filed</span><span>{sold(f)}</span></div>
              <div className="li"><span className="muted">Investors, as filed</span><span>{investors(f)}</span></div>
              <div className="li"><span className="muted">Minimum accepted</span><span>{f.minimumInvestment === null ? "—" : usd(f.minimumInvestment)}</span></div>
            </div>
          </div>
          <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
            <div className="row" style={{ flexWrap: "wrap", gap: 12 }}>
              <a className="btn ghost sm" href={f.url} target="_blank" rel="noreferrer">View on SEC.gov ↗</a>
              <button className="btn ghost sm" disabled={!!busy || disabled} onClick={() => search(f.cik, true)}>{busy === "fresh" ? "Checking SEC…" : "Check for amendments"}</button>
            </div>
            <div className="row" style={{ gap: 12 }}>
              {f.checkedAt && <small className="muted">Checked {filedOn(f.checkedAt)}</small>}
              <button className="btn ghost sm formd-remove" disabled={!!busy} onClick={remove}>{busy === "remove" ? "Removing…" : "Remove"}</button>
            </div>
          </div>
          {minMismatch && (
            <div className="notice warn">
              <b>This offering's minimum is {usd(listingMin)}, the filing says {usd(f.minimumInvestment!)}</b>
              <div style={{ fontSize: 13, marginTop: 4 }}>Check with your counsel before selling.</div>
            </div>
          )}
          {found && !newer && <div className="notice ok">No newer filing on EDGAR. This is the latest.</div>}
        </>
      ) : (
        <>
          <p className="muted" style={{ fontSize: 14 }}>
            Issuers relying on Regulation D file a Form D with the SEC within 15 days after the first sale. Find yours and attach it, and investors see it on the listing with a link to SEC.gov.
          </p>
          {disabled ? (
            <div className="notice">SEC lookups aren't set up on this site yet.</div>
          ) : (
            <>
              <form className="formd-search" onSubmit={onSearch}>
                <label className="field" style={{ flex: 1 }}>Issuer's legal name or SEC CIK number
                  <input className="input" value={query} maxLength={120} placeholder="e.g. Harbor Lofts SPV, LLC" aria-describedby="formd-hint" onChange={(e) => setQuery(e.target.value)} />
                </label>
                <button className="btn primary sm" type="submit" disabled={!!busy || query.trim().length < 3}>{busy === "search" ? "Searching SEC…" : "Search SEC"}</button>
              </form>
              <small id="formd-hint" className="muted">
                Use the name exactly as filed, for example the SPV that sells the tokens. Results are kept for {status?.cacheDays ?? 7} days.
                {status && status.searchesLeftToday !== null ? ` ${status.searchesLeftToday} of ${status.tenantDaily} searches left today.` : ""}
              </small>
            </>
          )}
        </>
      )}

      {err && <div className="notice err">{err}</div>}

      {found && (found.results.length === 0 ? (
        <div className="notice">
          No Form D found for “{found.query}”. Check the spelling against your filing, or search by CIK. If you haven't filed yet, your counsel files it on EDGAR; come back and attach it once it's accepted.
        </div>
      ) : (!f || newer) && (
        <>
          <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
            <small className="muted" style={{ fontWeight: 600, textTransform: "uppercase", letterSpacing: ".06em" }}>{found.results.length} filing{found.results.length === 1 ? "" : "s"} found</small>
            <small className="muted">{newer ? "A newer filing is on EDGAR. Attach it to replace the current one." : "Newest first. Attach the latest one; amendments replace the original."}</small>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="tbl formd-tbl">
              <thead><tr><th>Filing</th><th>Issuer</th><th>Exemption</th><th>Sold so far</th><th aria-label="Actions" /></tr></thead>
              <tbody>
                {found.results.map((r, i) => (
                  <tr key={r.accessionNo}>
                    <td><b>{formName(r)}</b> <small className="muted">{r.form === "D/A" ? "amendment" : "original"}</small><div className="muted" style={{ fontSize: 13 }}>Filed {filedOn(r.filedAt)}</div></td>
                    <td>{r.entityName}<div className="muted" style={{ fontSize: 13 }}>CIK {r.cik}{r.city ? ` · ${titleCase(r.city)}${r.state ? `, ${r.state}` : ""}` : ""}</div></td>
                    <td>{exemptionText(r)}</td>
                    <td>{sold(r)}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {f?.accessionNo === r.accessionNo ? <span className="tag g">Attached</span> : (
                        <button className={`btn ${i === 0 ? "primary" : "ghost"} sm`} disabled={!!busy} onClick={() => attach(r.accessionNo)}>{busy === r.accessionNo ? "Attaching…" : "Attach"}</button>
                      )}
                      <div><a className="formd-link" href={r.url} target="_blank" rel="noreferrer">View on SEC.gov ↗</a></div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ))}
    </div>
  );
}
