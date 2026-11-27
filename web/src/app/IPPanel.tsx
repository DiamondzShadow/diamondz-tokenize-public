// Offering page › IP registry (designs F4 register + F5 licensing, approved 2026-11-19).
// Registers the offering's asset on the network's AssetRegistry (asset NFT to the issuer), publishes license types
// from counsel templates (licensable classes), then manages licensee requests, offers, licenses and revocations.
// The connected wallet must be the token's admin (registration) and then the asset NFT's holder (everything else).
// On mainnet the NFT goes to the treasury multisig, so later steps are prepared as Safe transactions.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { encodeFunctionData, formatUnits, parseUnits, type Address, type Hex } from "viem";
import type { Asset } from "../lib/api";
import type { Network } from "../lib/chains";
import { ART, connectWallet, ensureChain, publicClientFor, send, walletError } from "../lib/wallet";
import { useTenant } from "../lib/tenant";
import { classHash } from "../lib/verification";
import { manifestHash } from "../lib/rules";
import Connect from "../lib/Connect";
import {
  ID_FIELDS, SUGGESTED_TYPES, ipApi, isLicensable, termsHash, type IpPage, type LicenseRequest, type LicenseTypeDraft,
} from "../lib/ip";
import type { AssetClassId } from "../lib/catalog";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
type Draft = { imageUrl: string; summary: string; identifiers: Record<string, string>; holdersPct: number; licenseTypes: LicenseTypeDraft[] };

function initialDraft(asset: Asset): Draft {
  const ip = (asset as any).ip ?? {};
  const d = (asset.details ?? {}) as Record<string, unknown>;
  const holders = asset.assetClass === "film" ? Number(d.holderPct ?? 0) : asset.assetClass === "music-ip" ? Number(d.royaltyPct ?? 0) : 0;
  return {
    imageUrl: ip.imageUrl ?? asset.imageUrl ?? "",
    summary: ip.summary ?? asset.description ?? "",
    identifiers: ip.identifiers ?? {},
    holdersPct: ip.holdersPct ?? (Number.isFinite(holders) ? holders : 0),
    licenseTypes: ip.licenseTypes ?? (SUGGESTED_TYPES[asset.assetClass as AssetClassId] ?? []).map((t) => ({ ...t, active: true, termsName: `${t.name} v1.0`, termsText: "" })),
  };
}

export function IpRegisterPanel({ asset, net, onChange }: { asset: Asset; net: Network; onChange: (a: Asset) => void }) {
  const { tenant } = useTenant();
  const ip = (asset as any).ip ?? {};
  const registered = ip.registered as { assetId: string; types: Record<string, string> } | undefined;
  const [d, setD] = useState<Draft>(() => initialDraft(asset));
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err" | ""; text: string } | null>(null);
  const [safeTxs, setSafeTxs] = useState<{ to: Address; data: Hex; why: string }[] | null>(null);
  const licensable = isLicensable(asset.assetClass);
  const fields = ID_FIELDS[asset.assetClass as AssetClassId] ?? [];
  const dep = asset.deployment!;
  const regs = net.ip!;
  const payDecimals = net.stable?.decimals ?? 6;
  const feeToken = (net.stable?.address ?? dep.payToken) as Address;
  const treasury = tenant?.payments.treasury as Address | undefined;
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const setType = (i: number, p: Partial<LicenseTypeDraft>) => setD((x) => ({ ...x, licenseTypes: x.licenseTypes.map((t, j) => (j === i ? { ...t, ...p } : t)) }));
  const unpublished = d.licenseTypes.filter((t) => t.active && !registered?.types?.[t.key]);

  async function run() {
    setMsg(null);
    setSafeTxs(null);
    try {
      setBusy("Saving your record and templates…");
      const types = licensable ? d.licenseTypes.filter((t) => t.active) : [];
      for (const t of types) if (t.termsText.trim().length < 50) throw new Error(`Paste the full template text for "${t.name}" (from your counsel).`);
      const saved = await ipApi.save(asset.id, { ...d, licenseTypes: licensable ? d.licenseTypes : [] });
      const hashes = Object.fromEntries(saved.licenseTypes.map((t) => [t.key, t.termsHash as Hex]));

      const me = await connectWallet();
      await ensureChain(net.id);
      const pc = publicClientFor(net.id);
      const A = ART.AssetRegistry.abi, L = ART.LicenseRegistry.abi;
      // The asset NFT goes to the treasury multisig on mainnet, the connected wallet on testnets.
      const holder = (!net.testnet && treasury ? treasury : me) as Address;
      let assetId = registered ? BigInt(registered.assetId) : ((await pc.readContract({ address: regs.assets, abi: A, functionName: "assetOf", args: [dep.token] })) as bigint);
      if (!assetId) {
        const docs = asset.documents?.length ? (`0x${await manifestHash(asset.documents)}` as Hex) : (`0x${"0".repeat(64)}` as Hex);
        const keys = Object.keys(d.identifiers).filter((k) => d.identifiers[k]?.trim());
        const regArgs = [{
          offering: dep.token, assetClass: classHash(asset.assetClass), uri: `${location.origin}/api/ip/${asset.id}/meta`, docsManifest: docs,
          payee: (treasury ?? me) as Address, holdersBps: Math.round(d.holdersPct * 100), to: holder,
          idKeys: keys, idValues: keys.map((k) => d.identifiers[k]!.trim()),
        }];
        const isAdmin = (await pc.readContract({ address: regs.assets, abi: A, functionName: "isOfferingAdmin", args: [dep.token, me] })) as boolean;
        if (!isAdmin) {
          // Mainnet after the handover: the treasury Safe administers the token, so it registers.
          setSafeTxs([{ to: regs.assets, data: encodeFunctionData({ abi: A, functionName: "register", args: regArgs }), why: "Create the asset page (from the Safe that administers the token)" }]);
          setMsg({ kind: "ok", text: "Your connected wallet doesn't administer this token. Send the transaction below from your treasury Safe, then press Create asset page again." });
          return;
        }
        setBusy("Creating the asset page (confirm in your wallet)…");
        await send(net.id, me, regs.assets, A, "register", regArgs);
        assetId = (await pc.readContract({ address: regs.assets, abi: A, functionName: "assetOf", args: [dep.token] })) as bigint;
      }
      const owner = (await pc.readContract({ address: regs.assets, abi: A, functionName: "ownerOf", args: [assetId] })) as Address;
      const newTypes: Record<string, string> = {};
      const todo = types.filter((t) => !registered?.types?.[t.key]);
      const calls = todo.map((t) => ({
        key: t.key, why: `Publish "${t.name}"`,
        args: [{
          assetId, termsHash: hashes[t.key]!, feeToken, fee: parseUnits(t.fee || "0", payDecimals), revShareBps: Math.round(t.revSharePct * 100),
          durationDays: t.durationDays, byRequest: t.byRequest, active: true, name: t.name, territory: t.territory,
          termsURI: `${location.origin}/api/ip/${asset.id}/terms/${t.key}`,
        }],
      }));
      if (owner.toLowerCase() !== me.toLowerCase()) {
        // Mainnet: the treasury Safe holds the asset; hand over the calls to send from it.
        setSafeTxs(calls.map((c) => ({ to: regs.licenses, data: encodeFunctionData({ abi: L, functionName: "publishType", args: c.args }), why: c.why })));
        await ipApi.registered(asset.id, { assetId: assetId.toString(), types: {} });
        setMsg({ kind: "ok", text: "Asset page created. Send the license publications below from your treasury Safe, then press the button again to record them." });
        return;
      }
      for (const c of calls) {
        setBusy(`${c.why} (confirm in your wallet)…`);
        await send(net.id, me, regs.licenses, L, "publishType", c.args);
        newTypes[c.key] = ((await pc.readContract({ address: regs.licenses, abi: L, functionName: "typeCount" })) as bigint).toString();
      }
      setBusy("Checking everything on chain…");
      await ipApi.registered(asset.id, { assetId: assetId.toString(), types: newTypes });
      onChange({ ...(asset as any), ip: { ...ip, ...d, registered: { assetId: assetId.toString(), types: { ...(registered?.types ?? {}), ...newTypes } } } });
      setMsg({ kind: "ok", text: "Done. Your public asset page is live." });
    } catch (e) {
      setMsg({ kind: "err", text: walletError(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="panel" id="ip">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
        <h3>{registered ? "Public asset page" : `Public asset page${licensable ? " & licensing" : ""} (optional)`}</h3>
        {registered && <Link className="btn ghost sm" to={`/ip/${asset.id}`}>View public page ↗</Link>}
      </div>
      <p className="muted" style={{ fontSize: 14 }}>
        {registered
          ? `Live as asset #${registered.assetId} on ${net.name}.`
          : `Optional, and separate from your investor registry. Gives your ${asset.assetClass === "film" ? "film" : "asset"} a public page and an asset NFT (a deed for the asset) held by your ${net.testnet ? "wallet" : "treasury"}${licensable ? ", and opens it for licensing" : ""}. Your offering's token, sale and investors stay exactly as they are.`}
      </p>

      {!registered && (
        <div className="form3">
          <label className="field">Cover or poster image (https URL)<input className="input" value={d.imageUrl} onChange={(e) => set({ imageUrl: e.target.value.trim() })} placeholder="https://…" /></label>
          {fields.map(([k, label, hint]) => (
            <label className="field" key={k}>{label}<input className="input" value={d.identifiers[k] ?? ""} placeholder={hint} onChange={(e) => set({ identifiers: { ...d.identifiers, [k]: e.target.value } })} /></label>
          ))}
          {licensable && <label className="field">Token holders' share of license revenue (%)<input className="input" inputMode="decimal" value={d.holdersPct || ""} onChange={(e) => set({ holdersPct: Math.min(100, Number(e.target.value.replace(/[^0-9.]/g, "")) || 0) })} /></label>}
        </div>
      )}

      {licensable && (
        <>
          <h4 style={{ margin: "8px 0 0" }}>License types</h4>
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>Each type uses a template from your counsel. Licensees sign its fingerprint, so a published template never changes: publish a new type for new terms.</p>
          {d.licenseTypes.map((t, i) => {
            const live = !!registered?.types?.[t.key];
            return (
              <details key={t.key} className="panel" style={{ padding: 14 }} open={!live && !t.termsText}>
                <summary className="row" style={{ justifyContent: "space-between", cursor: "pointer", flexWrap: "wrap" }}>
                  <b>{t.name}</b>
                  <span className="muted" style={{ fontSize: 13 }}>{t.byRequest ? "By request" : `$${t.fee}${t.revSharePct ? ` + ${t.revSharePct}%` : ""}`} · {live ? "Published ✓" : t.active ? "Will publish" : "Off"}</span>
                </summary>
                <div className="form3" style={{ marginTop: 10 }}>
                  <label className="field">Name<input className="input" disabled={live} value={t.name} onChange={(e) => setType(i, { name: e.target.value })} /></label>
                  {!t.byRequest && <label className="field">Fee (USD, paid in {net.stable?.symbol ?? "Test USD"})<input className="input" disabled={live} inputMode="decimal" value={t.fee} onChange={(e) => setType(i, { fee: e.target.value.replace(/[^0-9.]/g, "") || "0" })} /></label>}
                  <label className="field">Revenue share (%)<input className="input" disabled={live} inputMode="decimal" value={t.revSharePct || ""} onChange={(e) => setType(i, { revSharePct: Math.min(100, Number(e.target.value.replace(/[^0-9.]/g, "")) || 0) })} /></label>
                  <label className="field">Term (days, 0 = perpetual)<input className="input" disabled={live} inputMode="numeric" value={t.durationDays} onChange={(e) => setType(i, { durationDays: Number(e.target.value.replace(/\D/g, "")) || 0 })} /></label>
                  <label className="field">Territory<input className="input" disabled={live} value={t.territory} onChange={(e) => setType(i, { territory: e.target.value })} /></label>
                  <label className="field">Offer this license
                    <select className="input" disabled={live} value={t.active ? "y" : "n"} onChange={(e) => setType(i, { active: e.target.value === "y" })}><option value="y">Yes</option><option value="n">No</option></select>
                  </label>
                </div>
                <label className="field">What it allows (shown on the license card)<input className="input" disabled={live} value={t.scope} onChange={(e) => setType(i, { scope: e.target.value })} /></label>
                <label className="field">Template name and version<input className="input" disabled={live} value={t.termsName} onChange={(e) => setType(i, { termsName: e.target.value })} /></label>
                <label className="field">Template text (from your counsel; published as is)
                  <textarea className="input" disabled={live} rows={6} value={t.termsText} placeholder="Paste the full license text here." onChange={(e) => setType(i, { termsText: e.target.value })} />
                </label>
                <TermsFingerprint text={t.termsText} />
              </details>
            );
          })}
        </>
      )}

      <div style={{ maxWidth: 320 }}><Connect chainId={net.id} /></div>
      {msg && <div className={`notice ${msg.kind === "err" ? "err" : ""}`}>{msg.text}</div>}
      {safeTxs && safeTxs.length > 0 && (
        <div className="notice">
          <b>Send from your treasury Safe ({net.name}):</b>
          {safeTxs.map((t) => <div key={t.why} style={{ marginTop: 8 }}>{t.why} → <span className="addr">{t.to}</span><br /><span className="addr" style={{ wordBreak: "break-all" }}>{t.data}</span></div>)}
        </div>
      )}
      {(!registered || unpublished.length > 0) && (
        <button className="btn primary sm" disabled={!!busy} onClick={run}>{busy ?? (registered ? `Publish ${unpublished.length} license type${unpublished.length === 1 ? "" : "s"}` : "Create asset page")}</button>
      )}
    </div>
  );
}

function TermsFingerprint({ text }: { text: string }) {
  const [h, setH] = useState("");
  useEffect(() => { let on = true; if (text) termsHash(text).then((x) => on && setH(x)); else setH(""); return () => { on = false; }; }, [text]);
  return h ? <span className="muted addr" style={{ fontSize: 12 }}>Fingerprint (sha256) {h}</span> : null;
}

// ------------------------------------------------------------------ F5 licensing dashboard

export function IpLicensingPanel({ asset, net }: { asset: Asset; net: Network }) {
  const reg = (asset as any).ip?.registered as { assetId: string } | undefined;
  const [page, setPage] = useState<IpPage | null>(null);
  const [reqs, setReqs] = useState<LicenseRequest[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [offerFor, setOfferFor] = useState<LicenseRequest | null>(null);
  const [offer, setOffer] = useState({ typeKey: "", fee: "", revSharePct: 0, durationDays: 730, territory: "", expiresDays: 14 });
  const [cfg, setCfg] = useState<{ kyb: boolean; verifier: Address | null } | null>(null);
  const [autoOn, setAutoOn] = useState<boolean | null>(null);
  const L = ART.LicenseRegistry.abi;
  const dec = net.stable?.decimals ?? 6;
  const load = useCallback(async () => {
    const [p, r] = await Promise.all([ipApi.page(asset.id).catch(() => null), ipApi.requests(asset.id).catch(() => [])]);
    setPage(p);
    setReqs(r);
  }, [asset.id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    ipApi.config().then(async (c) => {
      setCfg(c);
      if (c.verifier && reg) setAutoOn((await publicClientFor(net.id).readContract({ address: net.ip!.licenses, abi: ART.LicenseRegistry.abi, functionName: "verifier", args: [BigInt(reg.assetId), c.verifier] })) as boolean);
    }, () => setCfg(null));
  }, [net.id, net.ip, reg]);
  if (!reg) return null;
  const assetId = BigInt(reg.assetId);
  const usd = (v: string) => `$${Number(formatUnits(BigInt(v || "0"), dec)).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

  async function tx(label: string, fn: string, args: unknown[]) {
    setMsg(null);
    setBusy(label);
    try {
      const me = await connectWallet();
      await ensureChain(net.id);
      await send(net.id, me, net.ip!.licenses, L, fn, args);
      setMsg({ kind: "ok", text: `${label}: done.` });
      await load();
    } catch (e) {
      setMsg({ kind: "err", text: walletError(e) });
    } finally {
      setBusy(null);
    }
  }
  const verify = (r: LicenseRequest) => tx(`Verified ${r.company}`, "verifyLicensee", [assetId, r.wallet, BigInt(Math.floor(Date.now() / 1000) + 365 * 86_400)]);
  async function sendOffer() {
    if (!offerFor || !page) return;
    const t = page.licenseTypes.find((x) => x.key === offer.typeKey);
    if (!t) return setMsg({ kind: "err", text: "Choose a license type" });
    await tx(`Offer sent to ${offerFor.company}`, "makeOffer", [BigInt(t.typeId), {
      typeId: 0n, licensee: offerFor.wallet, fee: parseUnits(offer.fee || "0", dec), revShareBps: Math.round(offer.revSharePct * 100),
      durationDays: offer.durationDays, termsHash: t.termsHash, expiresAt: BigInt(Math.floor(Date.now() / 1000) + offer.expiresDays * 86_400),
      used: false, territory: offer.territory || t.territory,
    }]);
    setOfferFor(null);
  }

  return (
    <div className="panel" id="licensing">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}><h3>Licensing</h3><Link className="btn ghost sm" to={`/ip/${asset.id}`}>View public page ↗</Link></div>
      {page && (
        <div className="kpis">
          <div className="kpi"><span className="muted">Active licenses</span><b>{page.licenses.filter((l) => l.status === "active").length}</b></div>
          <div className="kpi"><span className="muted">Fees received</span><b>{usd(page.royalties.fees)}</b></div>
          <div className="kpi"><span className="muted">Revenue shares received</span><b>{usd(page.royalties.revenueShares)}</b></div>
          <div className="kpi"><span className="muted">Owed to token holders ({page.holdersBps / 100}%)</span><b>{usd(page.royalties.holdersOwed)}</b><Link to="/app/payouts" style={{ fontSize: 13 }}>Send from Payouts →</Link></div>
        </div>
      )}
      {cfg?.verifier && (
        <div className="notice">
          <b>Platform verifier (automatic verification + card payments):</b> {autoOn ? "on" : "off"}. {cfg.kyb ? "When a licensee passes Sumsub (business verification or ID check), the platform records it on chain for this asset." : "Sumsub isn't switched on for the platform yet; until it is, you verify licensees yourself."}
          <div style={{ marginTop: 8 }}>
            <button className="btn ghost sm" disabled={!!busy || autoOn === null} onClick={() => tx(autoOn ? "Automatic verification off" : "Automatic verification on", "setVerifier", [assetId, cfg.verifier, !autoOn]).then(() => setAutoOn(!autoOn))}>{autoOn ? "Turn off" : "Allow the platform to verify licensees and confirm card payments"}</button>
          </div>
        </div>
      )}
      <h4 style={{ margin: "8px 0 0" }}>Requests</h4>
      {reqs.length === 0 && <p className="muted" style={{ fontSize: 14 }}>No requests yet. Licensees ask from your public IP page.</p>}
      {reqs.map((r) => (
        <div key={r.id} className="notice">
          <div><b>{r.company}</b> ({r.kind}, {r.jurisdiction}) · {r.email} · <span className="addr">{r.wallet}</span></div>
          <div style={{ fontSize: 13 }}>Sumsub check: <b>{r.check === "approved" ? "passed ✓" : r.check === "pending" ? "being reviewed" : r.check === "rejected" ? "rejected" : r.check === "retry" ? "needs a retry" : r.check === "init" ? "started" : "not started"}</b></div>
          <div className="muted" style={{ fontSize: 13 }}>{r.typeKey ? `Wants: ${page?.licenseTypes.find((t) => t.key === r.typeKey)?.name ?? r.typeKey}` : "Verification"}{r.work ? ` · for "${r.work}"` : ""}{r.message ? ` · "${r.message}"` : ""}</div>
          <div className="row" style={{ marginTop: 8, flexWrap: "wrap" }}>
            <button className="btn ghost sm" disabled={!!busy} onClick={() => verify(r)}>Verify licensee (after your checks)</button>
            <button className="btn ghost sm" disabled={!!busy} onClick={() => { setOfferFor(r); setOffer((o) => ({ ...o, typeKey: r.typeKey ?? "" })); }}>Make an offer</button>
          </div>
        </div>
      ))}
      {offerFor && page && (
        <div className="panel" style={{ padding: 14 }}>
          <b>Offer to {offerFor.company}</b>
          <div className="form3">
            <label className="field">License type<select className="input" value={offer.typeKey} onChange={(e) => setOffer({ ...offer, typeKey: e.target.value })}><option value="">Choose…</option>{page.licenseTypes.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}</select></label>
            <label className="field">Fee (USD)<input className="input" inputMode="decimal" value={offer.fee} onChange={(e) => setOffer({ ...offer, fee: e.target.value.replace(/[^0-9.]/g, "") })} /></label>
            <label className="field">Revenue share (%)<input className="input" inputMode="decimal" value={offer.revSharePct || ""} onChange={(e) => setOffer({ ...offer, revSharePct: Number(e.target.value.replace(/[^0-9.]/g, "")) || 0 })} /></label>
            <label className="field">Term (days)<input className="input" inputMode="numeric" value={offer.durationDays} onChange={(e) => setOffer({ ...offer, durationDays: Number(e.target.value.replace(/\D/g, "")) || 0 })} /></label>
            <label className="field">Territory<input className="input" value={offer.territory} onChange={(e) => setOffer({ ...offer, territory: e.target.value })} /></label>
            <label className="field">Offer valid for (days)<input className="input" inputMode="numeric" value={offer.expiresDays} onChange={(e) => setOffer({ ...offer, expiresDays: Number(e.target.value.replace(/\D/g, "")) || 1 })} /></label>
          </div>
          <p className="muted" style={{ fontSize: 13 }}>The licensee signs this type's published template. Remember to verify them first.</p>
          <div className="row"><button className="btn primary sm" disabled={!!busy} onClick={sendOffer}>Send offer</button><button className="btn ghost sm" onClick={() => setOfferFor(null)}>Cancel</button></div>
        </div>
      )}
      <h4 style={{ margin: "8px 0 0" }}>Licenses</h4>
      {page && page.licenses.length === 0 && <p className="muted" style={{ fontSize: 14 }}>None yet.</p>}
      {page && page.licenses.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table className="tbl">
            <thead><tr><th>License</th><th>Licensee</th><th>Type</th><th>Term</th><th>Paid</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {page.licenses.map((l) => (
                <tr key={l.licenseId}>
                  <td><Link to={`/license/${asset.chainId}/${l.licenseId}`}>#{l.licenseId}</Link><br /><span className="muted">{l.work}</span></td>
                  <td className="addr">{l.licensee}</td>
                  <td>{page.licenseTypes.find((t) => t.typeId === l.typeId)?.name ?? `Type ${l.typeId}`}{l.revShareBps ? ` · ${l.revShareBps / 100}%` : ""}</td>
                  <td>{l.end ? `to ${new Date(l.end * 1000).toLocaleDateString()}` : "Perpetual"}</td>
                  <td>{usd(l.feePaid)}</td>
                  <td>{l.status}</td>
                  <td>{l.status === "active" && <button className="btn ghost sm" disabled={!!busy} onClick={() => { const why = prompt("Reason for revoking (recorded on chain, no personal data):"); if (why) tx(`License #${l.licenseId} revoked`, "revoke", [BigInt(l.licenseId), why]); }}>Revoke</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {busy && <div className="notice">{busy} Confirm in your wallet…</div>}
      {msg && <div className={`notice ${msg.kind === "err" ? "err" : ""}`}>{msg.text}</div>}
    </div>
  );
}

export const ipAvailable = (asset: Asset, net: Network | undefined) => asset.status === "deployed" && !!net?.ip && !!asset.deployment && asset.deployment.token !== ZERO;
