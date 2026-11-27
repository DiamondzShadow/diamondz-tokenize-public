// Console payouts for one offering (design frames 12–14): history, then "Pay investors" in two steps.
import { useCallback, useEffect, useState } from "react";
import { encodeFunctionData, formatUnits, type Address, type Hex } from "viem";
import { api, type Asset, type PayoutPreview, type PayoutRow } from "../lib/api";
import { addrUrl, txUrl, type Network } from "../lib/chains";
import Connect from "../lib/Connect";
import { ART, connectWallet, ensureChain, publicClientFor, send, walletError } from "../lib/wallet";

const fmt = (v: string | bigint, d: number) => Number(formatUnits(BigInt(v), d)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const ADMIN = `0x${"0".repeat(64)}` as Hex;

export default function PayoutsPanel({ asset, net }: { asset: Asset; net: Network }) {
  const [rows, setRows] = useState<PayoutRow[] | null>(null);
  const [distributor, setDistributor] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [paying, setPaying] = useState(false);
  const load = useCallback(() => api.payouts(asset.id).then((r) => { setRows(r.payouts); setDistributor(r.distributor); }, (e) => setErr(e.message)), [asset.id]);
  useEffect(() => { load(); }, [load]);

  if (asset.standard === "erc1155" || asset.standard === "erc721")
    return (
      <div className="panel">
        <h3>Payouts</h3>
        <p className="muted" style={{ fontSize: 14 }}>Paying holders of {asset.standard === "erc721" ? "ERC-721 NFTs" : "ERC-1155 fractions"} isn't available yet. Sale proceeds still go straight to your treasury.</p>
      </div>
    );
  if (paying) return <PayInvestors asset={asset} net={net} onDone={() => { setPaying(false); load(); }} onCancel={() => setPaying(false)} />;

  const paid = (rows ?? []).reduce((s, r) => s + BigInt(r.amount), 0n);
  const claimed = (rows ?? []).reduce((s, r) => s + BigInt(r.claimedAmount ?? "0"), 0n);
  const dec = rows?.[0]?.decimals ?? net.stable?.decimals ?? 6;
  const sym = rows?.[0]?.symbol ?? net.stable?.symbol ?? "USDC";
  return (
    <div className="panel" style={{ gap: 18 }}>
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
        <h3 style={{ fontSize: 18 }}>Payouts</h3>
        {distributor && <button className="btn primary sm" onClick={() => setPaying(true)}>Pay investors</button>}
      </div>
      {err && <div className="notice err">{err}</div>}
      {!distributor && rows && <div className="notice">Payouts aren't live on {net.name} yet.</div>}
      {rows && rows.length > 0 && (
        <div className="kpis" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" }}>
          <div className="kpi"><span>Paid to holders</span><b>${fmt(paid, dec)}</b><small>{rows.length} payout{rows.length === 1 ? "" : "s"}</small></div>
          <div className="kpi"><span>Claimed</span><b>${fmt(claimed, dec)}</b><small>{paid ? `${((Number(claimed) / Number(paid)) * 100).toFixed(1)}% of paid` : ""}</small></div>
          <div className="kpi"><span>Waiting to be claimed</span><b>${fmt(paid - claimed, dec)}</b><small className="muted">delivered automatically after 7 days</small></div>
        </div>
      )}
      {rows && rows.length === 0 && distributor && <span className="muted">No payouts yet. Use “Pay investors” to send rent, royalties or interest to everyone holding {asset.symbol}.</span>}
      {rows && rows.length > 0 && (
        <div className="table" style={{ overflowX: "auto" }}>
          <div className="trp h"><span>Payout</span><span>Snapshot</span><span>Amount</span><span>Claimed</span><span>Status</span></div>
          {rows.map((r) => {
            const pct = r.claimedCount != null && r.holders ? Math.round((r.claimedCount / r.holders) * 100) : null;
            const closed = Date.parse(r.claimDeadline) < Date.now();
            return (
              <div className="trp" key={r.id}>
                <span><b>{r.memo}</b><small>Sent {day(r.sentAt)} · <a className="lnk" href={txUrl(net, r.tx)} target="_blank" rel="noreferrer">Transaction ↗</a></small></span>
                <span>{day(r.snapshotTime)}<small>{r.holders} holders{r.frozenHeld ? ` · ${r.frozenHeld} held (frozen)` : ""}</small></span>
                <span>${fmt(r.amount, r.decimals)} {r.symbol}</span>
                <span>{pct == null ? "…" : `${r.claimedCount} of ${r.holders} · ${pct}%`}{pct != null && <div className="meter"><i style={{ width: `${pct}%` }} /></div>}</span>
                <span className={`tag ${closed ? "" : pct === 100 ? "" : "g"}`}>{closed ? "Closed" : pct === 100 ? "Complete" : "Claiming"}</span>
              </div>
            );
          })}
        </div>
      )}
      {distributor && (
        <div className="li"><span className="muted">Payout contract</span><a className="addr" href={addrUrl(net, distributor)} target="_blank" rel="noreferrer">{distributor}</a></div>
      )}
      <p className="note" style={{ margin: 0 }}>Shares are pro rata to tokens held at the snapshot. Holders claim for free; anything unclaimed after 7 days is delivered to them automatically. A flat platform fee per payout is shown before you send and is never taken from holders.</p>
      {rows && rows.length > 0 && <span className="muted" style={{ fontSize: 12 }}>Total {sym} paid out across all payouts: ${fmt(paid, dec)}</span>}
    </div>
  );
}

function PayInvestors({ asset, net, onDone, onCancel }: { asset: Asset; net: Network; onDone: () => void; onCancel: () => void }) {
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [mode, setMode] = useState<"now" | "date">("now");
  const [at, setAt] = useState("");
  const [months, setMonths] = useState(12);
  const [holdFrozen, setHoldFrozen] = useState(true);
  const [preview, setPreview] = useState<PayoutPreview | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [safe, setSafe] = useState<{ to: string; data: string; note: string }[] | null>(null);
  const [done, setDone] = useState<string>("");

  async function makePreview() {
    setErr("");
    setBusy("preview");
    try {
      setPreview(await api.previewPayout(asset.id, {
        amount: amount.replace(/,/g, ""), memo, claimMonths: months, holdFrozen,
        snapshot: mode === "now" ? { mode: "now" } : { mode: "date", at: new Date(at).toISOString() },
      }));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy("");
    }
  }

  async function sendIt() {
    if (!preview) return;
    setErr("");
    setSafe(null);
    const total = BigInt(preview.amount) + BigInt(preview.fee);
    const dist = preview.call.distributor as Address;
    const a = preview.call.args;
    const createArgs = [a[0], a[1], a[2], BigInt(a[3]), BigInt(a[4]), BigInt(a[5]), a[6], BigInt(a[7])] as const;
    try {
      setBusy("connect");
      const me = await connectWallet();
      await ensureChain(net.id);
      const pc = publicClientFor(net.id);
      // Same rule as the v2 payout contract: DEFAULT_ADMIN_ROLE, or owner() for ERC-3643 (T-REX) tokens.
      const isAdmin = asset.standard === "erc3643"
        ? ((await pc.readContract({ address: preview.token as Address, abi: [{ type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const, functionName: "owner" })) as string).toLowerCase() === me.toLowerCase()
        : await pc.readContract({ address: preview.token as Address, abi: ART.PermissionedToken.abi, functionName: "hasRole", args: [ADMIN, me] });
      if (!isAdmin) {
        // Admin is a multisig: hand over the two transactions to propose in Safe.
        setSafe([
          { to: preview.payout, data: encodeFunctionData({ abi: ART.TestUSD.abi, functionName: "approve", args: [dist, total] }), note: `Allow the payout contract to take ${fmt(total, preview.payoutDecimals)} ${preview.payoutSymbol}` },
          { to: dist, data: encodeFunctionData({ abi: ART.Distributor.abi, functionName: "createDistribution", args: createArgs }), note: `Fund “${preview.memo}”` },
        ]);
        return;
      }
      const bal = (await pc.readContract({ address: preview.payout as Address, abi: ART.TestUSD.abi, functionName: "balanceOf", args: [me] })) as bigint;
      if (bal < total) throw new Error(`This wallet has ${fmt(bal, preview.payoutDecimals)} ${preview.payoutSymbol}; you need ${fmt(total, preview.payoutDecimals)} (payout + fee).`);
      const allowance = (await pc.readContract({ address: preview.payout as Address, abi: ART.TestUSD.abi, functionName: "allowance", args: [me, dist] })) as bigint;
      if (allowance < total) {
        setBusy("approve");
        await send(net.id, me, preview.payout as Address, ART.TestUSD.abi, "approve", [dist, total]);
      }
      setBusy("send");
      const tx = await send(net.id, me, dist, ART.Distributor.abi, "createDistribution", [...createArgs]);
      setBusy("record");
      await api.payoutSent(preview.id, tx);
      setDone(tx);
    } catch (e) {
      setErr(walletError(e));
    } finally {
      setBusy("");
    }
  }

  const dec = preview?.payoutDecimals ?? net.stable?.decimals ?? 6;
  const sym = preview?.payoutSymbol ?? net.stable?.symbol ?? "USDC";
  return (
    <div className="panel" style={{ gap: 18 }}>
      <h3 style={{ fontSize: 18 }}>Pay investors · {asset.name}</h3>
      <div className="stepper"><div className={preview ? "done" : "on"}>{preview ? "✓ " : "1 · "}Amount &amp; snapshot</div><div className={preview ? "on" : ""}>2 · Review &amp; send</div></div>
      {err && <div className="notice err">{err}</div>}

      {done ? (
        <>
          <div className="notice ok">Sent. Holders can claim now, and anything unclaimed is delivered to them automatically after 7 days. <a href={txUrl(net, done)} target="_blank" rel="noreferrer">View transaction ↗</a></div>
          <button className="btn primary" onClick={onDone} style={{ alignSelf: "flex-start" }}>Back to payouts</button>
        </>
      ) : !preview ? (
        <>
          <div className="form2" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
            <label className="field">Amount to holders ({sym})<input className="input" inputMode="decimal" placeholder="15000.00" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ""))} /></label>
            <label className="field">What it's for (shown to investors)<input className="input" maxLength={80} placeholder="Q1 2027 rent" value={memo} onChange={(e) => setMemo(e.target.value)} /></label>
          </div>
          <div className="field">Who gets paid
            <div className="choice-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
              <button type="button" className={`choice ${mode === "now" ? "sel" : ""}`} onClick={() => setMode("now")}><b>Holders right now</b><span>Snapshot at the latest confirmed block. Most common.</span></button>
              <button type="button" className={`choice ${mode === "date" ? "sel" : ""}`} onClick={() => setMode("date")}><b>Holders on a date</b><span>e.g. the record date in your offering documents.</span></button>
            </div>
          </div>
          {mode === "date" && <label className="field">Record date and time<input className="input" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></label>}
          <label className="field">Claim window
            <select className="input" value={months} onChange={(e) => setMonths(Number(e.target.value))}>
              {[3, 6, 12, 24].map((m) => <option key={m} value={m}>{m} months, then unclaimed funds return to you</option>)}
            </select>
          </label>
          <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={holdFrozen} onChange={(e) => setHoldFrozen(e.target.checked)} /> Hold the share of frozen wallets (recommended)</label>
          <div className="actions" style={{ display: "flex", justifyContent: "space-between" }}>
            <button className="btn ghost" onClick={onCancel}>Cancel</button>
            <button className="btn primary" disabled={!amount || !memo || (mode === "date" && !at) || !!busy} onClick={makePreview}>{busy === "preview" ? "Reading holders from the chain…" : "Preview split →"}</button>
          </div>
        </>
      ) : (
        <>
          <span className="muted" style={{ fontSize: 13 }}>Snapshot at block {Number(preview.snapshotBlock).toLocaleString()} ({new Date(preview.snapshotTime).toUTCString()}) · {preview.holders.length} holders · claim by {day(preview.claimDeadline)}</span>
          <div className="table" style={{ overflowX: "auto" }}>
            <div className="trh h"><span>Holder</span><span>Tokens</span><span>Receives</span></div>
            {preview.holders.slice(0, 50).map((h) => (
              <div className="trh" key={h.account}><span className="addr" style={{ color: "var(--text)" }}>{h.account}</span><span>{fmt(h.tokens, preview.tokenDecimals ?? 18)}</span><span>${fmt(h.amount, dec)}</span></div>
            ))}
            {preview.holders.length > 50 && <div className="trh"><span className="muted">+ {preview.holders.length - 50} more holders</span><span /><span /></div>}
          </div>
          {preview.frozen.length > 0 && (
            <div className="locked">{preview.frozen.length} frozen wallet{preview.frozen.length === 1 ? "" : "s"}: {preview.frozen.map((f) => `${f.account} ($${fmt(f.amount, dec)}${f.held ? ", held" : ", paid"})`).join("; ")}</div>
          )}
          <div className="sum">
            <div className="li"><span className="muted">To holders</span><span>${fmt(preview.amount, dec)} {sym}</span></div>
            <div className="li"><span className="muted">Platform fee (flat, per payout)</span><span>${fmt(preview.fee, dec)} {sym}</span></div>
            <div className="tot"><span>Total you send</span><span>${fmt(BigInt(preview.amount) + BigInt(preview.fee), dec)} {sym}</span></div>
          </div>
          <span className="muted" style={{ fontSize: 13 }}>Holders receive exactly the amounts listed. The fee is paid on top, never taken from them.</span>
          {safe ? (
            <div className="notice">
              <b>Your connected wallet isn't this offering's admin, so propose these two transactions in your treasury Safe (Transaction Builder), in order:</b>
              {safe.map((t, i) => (
                <div key={i} style={{ marginTop: 10 }}>
                  <div>{i + 1}. {t.note}</div>
                  <div className="addr">to: {t.to}</div>
                  <div className="addr">data: {t.data}</div>
                </div>
              ))}
              <div style={{ marginTop: 10 }}>Once it has executed, paste the transaction hash here:</div>
              <SafeTxInput onTx={async (tx) => { await api.payoutSent(preview.id, tx); setDone(tx); }} />
            </div>
          ) : (
            <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
              {/* The wallet is asked for only here, at the moment of paying (the console has no wallet otherwise). */}
              <div style={{ flexBasis: "100%", maxWidth: 320 }}><Connect chainId={net.id} label="Connect the paying wallet" /></div>
              <button className="btn ghost" onClick={() => setPreview(null)} disabled={!!busy}>← Change amount</button>
              <button className="btn primary" onClick={sendIt} disabled={!!busy}>
                {busy === "approve" ? `Approve ${sym} in your wallet…` : busy === "send" ? "Confirm the payout in your wallet…" : busy === "record" ? "Recording…" : busy ? "Connecting…" : "Send payout"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SafeTxInput({ onTx }: { onTx: (tx: string) => Promise<void> }) {
  const [tx, setTx] = useState("");
  const [err, setErr] = useState("");
  return (
    <div className="row" style={{ marginTop: 6, flexWrap: "wrap" }}>
      <input className="input" style={{ flex: 1, minWidth: 260 }} placeholder="0x…" value={tx} onChange={(e) => setTx(e.target.value.trim())} />
      <button className="btn primary sm" disabled={!/^0x[0-9a-fA-F]{64}$/.test(tx)} onClick={() => onTx(tx).catch((e) => setErr(e.message))}>Record</button>
      {err && <div className="notice err" style={{ width: "100%" }}>{err}</div>}
    </div>
  );
}
