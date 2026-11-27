// "Bring USDC from another network" (mockup C1–C3, approved 2026-11-27): moves the investor's own USDC to the
// offering's network with Circle CCTP V2 + the Circle Forwarding Service. Two wallet confirmations on the source
// network (approve, send); Circle delivers to the same wallet on the offering's network. Buying stays a separate step.
import { useEffect, useRef, useState } from "react";
import { erc20Abi, formatUnits, parseUnits, type Address, type Hex } from "viem";
import { networkById, txUrl, type Network } from "./chains";
import { TOKEN_MESSENGER_V2_ABI, burnArgs, burnFor, fetchRouteFee, fetchTransferStatus, sourcesFor, type RouteFee } from "./cctp";
import { ensureChain, publicClientFor, send, walletError } from "./wallet";

type Src = { net: Network; usdc: bigint; gas: bigint };
type Phase = "pick" | "approve" | "send" | "tracking" | "done";

const usd = (v: bigint) => Number(formatUnits(v, 6)).toLocaleString(undefined, { maximumFractionDigits: 2 });

/** True when this offering's network can receive USDC from another network (Circle USDC + CCTP). */
export const canBringUsdc = (chainId: number, paySymbol: string) => paySymbol === "USDC" && sourcesFor(chainId).length > 0;

export default function BringUsdc({ destChainId, account, shortfall, onArrived, onClose }: {
  destChainId: number;
  account: Address;
  /** What the wallet is short for the purchase being entered (USDC base units); pre-fills the amount. */
  shortfall: bigint;
  /** Called once the USDC is in the wallet on the offering's network (amount in base units, Circle's mint tx). */
  onArrived: (amount: bigint, mintTx?: Hex) => void;
  onClose: () => void;
}) {
  const dest = networkById(destChainId)!;
  const [sources, setSources] = useState<Src[] | null>(null);
  const [srcId, setSrcId] = useState<number | null>(null);
  const [amount, setAmount] = useState(shortfall > 0n ? formatUnits(shortfall, 6) : "");
  const [fee, setFee] = useState<RouteFee | null>(null);
  const [feeErr, setFeeErr] = useState("");
  const [phase, setPhase] = useState<Phase>("pick");
  const [err, setErr] = useState("");
  const [burnTx, setBurnTx] = useState<Hex | null>(null);
  const [attested, setAttested] = useState(false);
  const [mintTx, setMintTx] = useState<Hex | undefined>();
  const [arrived, setArrived] = useState<bigint>(0n);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // Balances on every source network (USDC + a little gas for the two confirmations).
  useEffect(() => {
    let off = false;
    Promise.all(sourcesFor(destChainId).map(async (net): Promise<Src> => {
      const pc = publicClientFor(net.id);
      const [usdc, gas] = await Promise.all([
        pc.readContract({ address: net.stable!.address, abi: erc20Abi, functionName: "balanceOf", args: [account] }).catch(() => 0n),
        pc.getBalance({ address: account }).catch(() => 0n),
      ]);
      return { net, usdc, gas };
    })).then((list) => {
      if (off) return;
      list.sort((a, b) => (b.usdc > a.usdc ? 1 : b.usdc < a.usdc ? -1 : 0));
      setSources(list);
      setSrcId((cur) => cur ?? (list.find((s) => s.usdc > 0n)?.net.id ?? null));
    });
    return () => { off = true; };
  }, [destChainId, account]);

  const src = sources?.find((s) => s.net.id === srcId) ?? null;
  useEffect(() => {
    if (!src) return;
    setFee(null);
    setFeeErr("");
    fetchRouteFee(src.net, dest).then(setFee, (e) => setFeeErr(String(e?.message ?? e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcId]);

  const deliver = /^\d{1,9}(\.\d{1,6})?$/.test(amount) ? parseUnits(amount, 6) : 0n;
  const burn = fee && deliver > 0n ? burnFor(deliver, fee) : null;
  const tooMuch = !!(src && burn && burn.amount > src.usdc);
  const noGas = !!src && src.gas === 0n;

  async function go() {
    if (!src || !burn) return;
    setErr("");
    try {
      const pc = publicClientFor(src.net.id);
      const usdc = src.net.stable!.address;
      const tm = src.net.cctp!.tokenMessenger;
      await ensureChain(src.net.id);
      const allowance = await pc.readContract({ address: usdc, abi: erc20Abi, functionName: "allowance", args: [account, tm] });
      if (allowance < burn.amount) {
        setPhase("approve");
        await send(src.net.id, account, usdc, erc20Abi, "approve", [tm, burn.amount]);
      }
      setPhase("send");
      const destBefore = await publicClientFor(dest.id).readContract({ address: dest.stable!.address, abi: erc20Abi, functionName: "balanceOf", args: [account] });
      const hash = await send(src.net.id, account, tm, TOKEN_MESSENGER_V2_ABI, "depositForBurnWithHook", [...burnArgs(dest as Parameters<typeof burnArgs>[0], usdc, account, burn.amount, burn.maxFee)]);
      setBurnTx(hash);
      setPhase("tracking");
      track(hash, destBefore);
      ensureChain(dest.id).catch(() => {}); // back to the offering's network for Buy
    } catch (e) {
      setErr(walletError(e));
      setPhase("pick");
    }
  }

  async function track(hash: Hex, destBefore: bigint) {
    const t0 = Date.now();
    while (alive.current && Date.now() - t0 < 30 * 60_000) {
      const st = await fetchTransferStatus(src!.net, hash).catch(() => null);
      if (st && st.state !== "pending") setAttested(true);
      if (st?.state === "delivered") setMintTx(st.mintTx);
      const now = await publicClientFor(dest.id).readContract({ address: dest.stable!.address, abi: erc20Abi, functionName: "balanceOf", args: [account] }).catch(() => destBefore);
      if (now > destBefore) {
        setArrived(now - destBefore);
        setPhase("done");
        onArrived(now - destBefore, st?.state === "delivered" ? st.mintTx : undefined);
        return;
      }
      await new Promise((r) => setTimeout(r, 4000));
    }
  }

  if (phase === "done") {
    return (
      <div className="notice ok">
        {usd(arrived)} USDC arrived on {dest.name}. {mintTx && <a href={txUrl(dest, mintTx)} target="_blank" rel="noreferrer">View ↗</a>}
      </div>
    );
  }

  if (phase === "tracking" && src && burnTx) {
    const step = (done: boolean, active: boolean, text: React.ReactNode) => (
      <li style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <span aria-hidden="true" style={{ width: 20, height: 20, borderRadius: 10, flex: "none", boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, background: done ? "var(--ok)" : "transparent", color: "var(--on-brand)", border: done ? "none" : `2px solid ${active ? "var(--brand)" : "var(--line)"}` }}>{done ? "✓" : ""}</span>
        {text}
      </li>
    );
    return (
      <div className="bring" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <b>{usd(deliver)} USDC on its way</b>
        <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 10, fontSize: 14 }}>
          {step(true, false, <>Sent from {src.net.name} <a href={txUrl(src.net, burnTx)} target="_blank" rel="noreferrer" style={{ marginLeft: "auto", fontSize: 12 }}>View ↗</a></>)}
          {step(attested, !attested, "Confirmed by Circle")}
          {step(false, attested, `Arriving on ${dest.name}…`)}
        </ol>
        <small className="muted">You can leave this page; the USDC still arrives in your wallet.</small>
      </div>
    );
  }

  const busy = phase === "approve" || phase === "send";
  return (
    <div className="bring" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <b>Bring USDC</b>
        <button type="button" className="lnk" onClick={onClose} disabled={busy} style={{ background: "none", border: 0, cursor: "pointer", fontSize: 13 }}>Back to Invest</button>
      </div>
      <small className="muted" style={{ lineHeight: 1.5 }}>Moves your own USDC to {dest.name} with Circle. It arrives in this same wallet; nothing is bought yet.</small>
      <div role="radiogroup" aria-label="Network your USDC is on" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {!sources && <small className="muted">Checking your USDC on other networks…</small>}
        {sources?.map((s) => (
          <button key={s.net.id} type="button" role="radio" aria-checked={s.net.id === srcId} disabled={s.usdc === 0n || busy}
            className={`choice ${s.net.id === srcId ? "sel" : ""}`}
            onClick={() => setSrcId(s.net.id)}
            style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", minHeight: 48, padding: "0 14px", cursor: s.usdc === 0n ? "default" : "pointer", opacity: s.usdc === 0n ? 0.6 : 1, font: "inherit", fontSize: 14, color: "var(--text)" }}>
            <span>{s.net.name}</span><span>{usd(s.usdc)} USDC</span>
          </button>
        ))}
        {sources && !sources.some((s) => s.usdc > 0n) && <small className="muted">No USDC found for this wallet on {sources.map((s) => s.net.name).join(", ")}.</small>}
      </div>
      <label className="field">Amount to arrive on {dest.name}
        <input className="input" inputMode="decimal" value={amount} disabled={busy} placeholder="e.g. 250" onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, "").slice(0, 16))} />
      </label>
      {shortfall > 0n && <small className="muted" style={{ marginTop: -6 }}>Pre-filled with what you're short for this purchase.</small>}
      {src && (
        <div>
          <div className="li"><span className="muted">Leaves {src.net.name}</span><span>{burn ? `${Number(formatUnits(burn.amount, 6)).toLocaleString(undefined, { maximumFractionDigits: 6 })} USDC` : "—"}</span></div>
          <div className="li"><span className="muted">Circle fee (fast transfer + delivery)</span><span>{burn ? `up to ${Number(formatUnits(burn.maxFee, 6)).toLocaleString(undefined, { maximumFractionDigits: 4 })} USDC` : feeErr ? "unavailable" : "…"}</span></div>
          <div className="li"><span className="muted">Arrives on {dest.name}</span><b>{deliver ? `${usd(deliver)} USDC` : "—"}</b></div>
          <div className="li"><span className="muted">Usually takes</span><span>under a minute</span></div>
        </div>
      )}
      {feeErr && <div className="notice err">Circle can't quote this route right now: {feeErr}</div>}
      {tooMuch && <div className="notice err">Not enough USDC on {src!.net.name} (fee included).</div>}
      {noGas && <div className="notice err">This wallet has no {src!.net.native.symbol} on {src!.net.name} for the two confirmations.</div>}
      {err && <div className="notice err">{err}</div>}
      <button className="btn primary" style={{ justifyContent: "center" }} disabled={!src || !burn || tooMuch || noGas || busy} onClick={go}>
        {phase === "approve" ? `Allow Circle to move USDC in wallet…` : phase === "send" ? "Confirm send in wallet…" : `Send ${deliver ? usd(deliver) : ""} USDC to ${dest.name}`}
      </button>
      <small className="muted" style={{ lineHeight: 1.5 }}>Two wallet confirmations on {src?.net.name ?? "the network your USDC is on"}: allow Circle to move the USDC, then send. Your wallet switches network for you. You need a little {src?.net.native.symbol ?? "gas"} there; nothing on {dest.name}.</small>
    </div>
  );
}
