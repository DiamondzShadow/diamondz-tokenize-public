// ERC-3643 (T-REX) in the issuer console: design canvas 86QTBovSWzBHR2dAHSvBAw (E1 upgrade choice, E2 verify investor,
// E3 revoke, E4 token controls), approved 2026-11-18.
// Only the interface signatures of the audited suite are here (ABI fragments); its GPL bytecode never ships to browsers.
import { useCallback, useEffect, useState } from "react";
import { saleWindow } from "../lib/rules";
import { encodeAbiParameters, keccak256, parseAbi, parseAbiItem, parseUnits, type Address, type Hex } from "viem";
import { api, type Asset } from "../lib/api";
import { addrUrl, txUrl, type Network } from "../lib/chains";
import { connectWallet, deploy, ensureChain, publicClientFor, send, walletClientFor, walletError } from "../lib/wallet";
import Connect from "../lib/Connect";

export const TREX_ABI = parseAbi([
  "function changeImplementationAuthority(address token, address newImplementationAuthority)",
  "function getImplementationAuthority() view returns (address)",
  "function addAgent(address agent)",
  "function isAgent(address agent) view returns (bool)",
  "function paused() view returns (bool)",
  "function pause()",
  "function unpause()",
  "function setAddressFrozen(address user, bool freeze)",
  "function isFrozen(address user) view returns (bool)",
  "function forcedTransfer(address from, address to, uint256 amount) returns (bool)",
  "function owner() view returns (address)",
  "function isVerified(address user) view returns (bool)",
  "function identity(address user) view returns (address)",
  "function revokeClaim(bytes32 claimId, address identity) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const identityRegistered = parseAbiItem("event IdentityRegistered(address indexed investorAddress, address indexed identity)");
const KYC_TOPIC = 1n;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

export type UpgradeMode = "own" | "platform";

/** E1 step 3: who may upgrade the token's code. */
export function UpgradeChoice({ value, onChange, disabled }: { value: UpgradeMode; onChange: (v: UpgradeMode) => void; disabled?: boolean }) {
  const opt = (v: UpgradeMode, title: string, body: string, rec?: boolean) => (
    <label className={`choice-card ${value === v ? "sel" : ""}`} style={disabled ? { opacity: 0.6 } : undefined}>
      <input type="radio" name="trex-upgrades" checked={value === v} disabled={disabled} onChange={() => onChange(v)} />
      <span style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <b style={{ fontSize: 14 }}>{title} {rec && <span className="tag g" style={{ marginLeft: 6 }}>Recommended</span>}</b>
        <span className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>{body}</span>
      </span>
    </label>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <b>Who can upgrade the token's code?</b>
      {opt("own", "Only you", "Your wallet gets its own upgrade authority. The platform can never change this token's code. If T-REX publishes a security fix, you apply it.", true)}
      {opt("platform", "Platform-managed", "The platform keeps this token on its shared authority and can apply T-REX updates for you. That also means the platform could change its code.")}
    </div>
  );
}

/** Steps the deploy wizard runs for an ERC-3643 offering (after connect + payment token). */
export function trexSteps(p: {
  asset: Asset; net: Network; upgrade: UpgradeMode; treasury?: Address; payDecimals: number;
  fee: { recipient: string; bps: number };
}) {
  const { asset, net } = p;
  type S = { account?: Address; payToken?: Address; registry?: Address; token?: Address; sale?: Address; txs: string[]; done: string[] };
  return [
    {
      id: "trex-suite",
      label: "Platform deploys your ERC-3643 suite (audited T-REX, owned by your wallet, free for you)",
      run: async (s: S) => {
        const t = await api.trexPrepare(asset.id, s.account!);
        return { ...s, token: t.token, registry: t.identityRegistry };
      },
    },
    {
      id: "trex-upgrades",
      label: p.upgrade === "own" ? "Take control of upgrades (only you can change the token's code)" : "Keep platform-managed upgrades",
      run: async (s: S) => {
        if (p.upgrade === "platform") return s;
        const pc = publicClientFor(net.id);
        const ref = asset.trex?.referenceAuthority ?? net.trex!.implementationAuthority;
        const current = (await pc.readContract({ address: s.token!, abi: TREX_ABI, functionName: "getImplementationAuthority" })) as Address;
        if (current.toLowerCase() !== ref.toLowerCase()) return s; // already has its own
        const h = await send(net.id, s.account!, ref, TREX_ABI, "changeImplementationAuthority", [s.token, ZERO]);
        return { ...s, txs: [...s.txs, h] };
      },
    },
    {
      id: "trex-sale",
      label: "Deploy the sale (investors pay, tokens are issued)",
      run: async (s: S) => {
        const r = await deploy(net.id, s.account!, "PrimarySale3643", [{
          token: s.token, payToken: s.payToken, treasury: p.treasury ?? s.account, admin: s.account,
          price: parseUnits(asset.pricePerToken, p.payDecimals), cap: BigInt(asset.totalSupply) * 10n ** 18n,
          minPurchase: parseUnits(asset.minInvestment || "0", p.payDecimals), ...saleWindow(asset.rules),
          feeRecipient: p.fee.recipient, feeBps: p.fee.bps, oracle: net.assetOracle?.address ?? ZERO,
        }]);
        return { ...s, sale: r.address, txs: [...s.txs, r.hash] };
      },
    },
    {
      id: "trex-agent",
      label: "Allow the sale to issue tokens (nobody else can mint)",
      run: async (s: S) => {
        const pc = publicClientFor(net.id);
        if (await pc.readContract({ address: s.token!, abi: TREX_ABI, functionName: "isAgent", args: [s.sale!] })) return s;
        const h = await send(net.id, s.account!, s.token!, TREX_ABI, "addAgent", [s.sale]);
        return { ...s, txs: [...s.txs, h] };
      },
    },
  ];
}

// ------------------------------------------------------------------ E2 / E3: investors

interface Row { wallet: Address; identity: Address; verified: boolean; frozen: boolean }

const COUNTRIES: [string, number][] = [["United States", 840], ["United Kingdom", 826], ["Canada", 124], ["Germany", 276], ["France", 250], ["Singapore", 702], ["United Arab Emirates", 784], ["Switzerland", 756], ["Australia", 36], ["Japan", 392]];

export function TrexInvestorsPanel({ asset, net, prefill }: { asset: Asset; net: Network; prefill?: { wallet: string; n: number } | null }) {
  const t = asset.trex!;
  const [rows, setRows] = useState<Row[] | null>(null);
  const [wallet, setWallet] = useState("");
  const [country, setCountry] = useState(840);
  const [step, setStep] = useState(0); // 0 idle, 1 screening+identity, 2 signing, 3 filing
  const [claim, setClaim] = useState<{ identity: Address; data: Hex; digest: Hex; statement: string; accredited?: { data: Hex; digest: Hex; statement: string } } | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err" | ""; text: string; tx?: string } | null>(null);
  const [revoking, setRevoking] = useState<Row | null>(null);
  const valid = /^0x[0-9a-fA-F]{40}$/.test(wallet);
  useEffect(() => { if (prefill && step === 0) setWallet(prefill.wallet); }, [prefill]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    const pc = publicClientFor(net.id);
    const head = await pc.getBlockNumber({ cacheTime: 0 });
    const from = BigInt(t.deployBlock ?? Number(head) - 50_000);
    const seen = new Map<string, Address>();
    for (let s = from; s <= head; s += 40_000n) {
      const to = s + 39_999n > head ? head : s + 39_999n;
      const logs = await pc.getLogs({ address: t.identityRegistry, event: identityRegistered, fromBlock: s, toBlock: to });
      for (const l of logs) seen.set(l.args.investorAddress!.toLowerCase(), l.args.investorAddress!);
    }
    const out = await Promise.all([...seen.values()].map(async (w) => {
      const [identity, verified, frozen] = await Promise.all([
        pc.readContract({ address: t.identityRegistry, abi: TREX_ABI, functionName: "identity", args: [w] }) as Promise<Address>,
        pc.readContract({ address: t.identityRegistry, abi: TREX_ABI, functionName: "isVerified", args: [w] }) as Promise<boolean>,
        pc.readContract({ address: t.token, abi: TREX_ABI, functionName: "isFrozen", args: [w] }) as Promise<boolean>,
      ]);
      return { wallet: w, identity, verified, frozen };
    }));
    setRows(out.filter((r) => r.identity !== ZERO));
  }, [net.id, t.identityRegistry, t.token, t.deployBlock]);
  useEffect(() => { load().catch((e) => setMsg({ kind: "err", text: walletError(e) })); }, [load]);

  async function prepare() {
    setMsg(null);
    setStep(1);
    try {
      const scr = await api.screen(wallet, net.id);
      if (scr.sanctioned) throw new Error("This wallet is on a sanctions list and can't be verified.");
      const r = await api.trexIdentity(asset.id, wallet);
      setClaim(r);
      setStep(2);
    } catch (e) {
      setMsg({ kind: "err", text: walletError(e) });
      setStep(0);
    }
  }

  async function sign() {
    if (!claim) return;
    setMsg(null);
    try {
      const me = await connectWallet();
      if (me.toLowerCase() !== t.owner.toLowerCase()) throw new Error(`Only this offering's issuer wallet can sign its KYC claims. Connect ${t.owner}.`);
      const wc = walletClientFor(net.id, me);
      const signature = await wc.signMessage({ account: me, message: { raw: claim.digest } });
      // Accredited-only offerings: a second signature, the accreditation claim the token requires.
      const accredited = claim.accredited
        ? { data: claim.accredited.data, signature: await wc.signMessage({ account: me, message: { raw: claim.accredited.digest } }) }
        : undefined;
      setStep(3);
      const r = await api.trexKyc(asset.id, { wallet, data: claim.data, signature, country, accredited });
      setMsg(r.verified ? { kind: "ok", text: "Verified. This wallet can now buy and hold the token." } : { kind: "err", text: "The claim was filed but the wallet isn't verified yet. Refresh in a moment." });
      setClaim(null);
      setWallet("");
      setStep(0);
      await load();
    } catch (e) {
      setMsg({ kind: "err", text: walletError(e) });
      setStep(2);
    }
  }

  async function revoke(r: Row) {
    setMsg(null);
    try {
      const me = await connectWallet();
      await ensureChain(net.id);
      const claimId = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [t.claimIssuer, KYC_TOPIC]));
      const h = await send(net.id, me, t.claimIssuer, TREX_ABI, "revokeClaim", [claimId, r.identity]);
      setRevoking(null);
      setMsg({ kind: "ok", text: "Claim revoked. The wallet can no longer buy or receive the token.", tx: h });
      await load();
    } catch (e) {
      setMsg({ kind: "err", text: walletError(e) });
    }
  }

  const stepCls = (n: number) => (step > n ? "done" : step === n ? "next" : "");
  return (
    <div className="panel" id="investors">
      <h3>Investors</h3>
      <p className="muted" style={{ fontSize: 14 }}>
        Once your own checks are done, your wallet signs a KYC claim. The platform files it on the investor's on-chain identity. Nothing personal goes on chain.
      </p>
      <div style={{ maxWidth: 320 }}><Connect chainId={net.id} /></div>
      <div className="form3" style={{ gridTemplateColumns: "2fr 1fr" }}>
        <label className="field">Investor wallet<input className="input" value={wallet} placeholder="0x… full address" disabled={step > 0} onChange={(e) => setWallet(e.target.value.trim())} /></label>
        <label className="field">Country of residence
          <select className="input" value={country} disabled={step > 0} onChange={(e) => setCountry(Number(e.target.value))}>
            {COUNTRIES.map(([n, c]) => <option key={c} value={c}>{n}</option>)}
          </select>
        </label>
      </div>
      {step === 0 && <button className="btn primary sm" disabled={!valid} onClick={prepare} style={{ alignSelf: "flex-start" }}>Verify investor</button>}
      {step > 0 && (
        <div>
          <div className={`setup-step ${stepCls(1)}`}><span className="c">{step > 1 ? "✓" : 1}</span><div className="t"><b>Sanctions screening and investor identity</b><small>Platform · free</small></div></div>
          <div className={`setup-step ${stepCls(2)}`}>
            <span className="c">{step > 2 ? "✓" : 2}</span>
            <div className="t" style={{ gap: 8 }}>
              <b>Sign the KYC claim</b>
              <small>A free signature, not a transaction. Only your wallet can sign claims for this offering.</small>
              {claim && <div className="notice" style={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}>{claim.statement}</div>}
              {claim?.accredited && <div className="notice" style={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}>{claim.accredited.statement}<br /><span style={{ fontFamily: "var(--font-body)" }}>Accredited-only offering: your wallet signs this second claim right after the first. Sign it only after you've confirmed accreditation.</span></div>}
              {step === 2 && (
                <div className="row" style={{ flexWrap: "wrap" }}>
                  <button className="btn primary sm" onClick={sign}>{claim?.accredited ? "Sign KYC + accreditation claims" : "Sign KYC claim"}</button>
                  <button className="btn ghost sm" onClick={() => { setStep(0); setClaim(null); }}>Cancel</button>
                  <small className="muted" style={{ wordBreak: "break-all" }}>Signing as {t.owner}</small>
                </div>
              )}
            </div>
          </div>
          <div className={`setup-step ${stepCls(3)}`}><span className="c">3</span><div className="t"><b>File the claim and register the wallet</b><small>Platform · free. The investor can buy as soon as this finishes.</small></div></div>
        </div>
      )}
      {msg?.text && <div className={`notice ${msg.kind}`}>{msg.text} {msg.tx && <a href={txUrl(net, msg.tx)} target="_blank" rel="noreferrer">View transaction ↗</a>}</div>}
      <p className="muted" style={{ fontSize: 12 }}>By signing you confirm the wallet's owner passed your KYC and AML checks. Keep those records yourself; you can revoke a claim at any time.</p>

      <h3 style={{ marginTop: 12 }}>Verified wallets</h3>
      {rows === null ? <span className="muted">Reading from the token's identity registry…</span> : rows.length === 0 ? <span className="muted">No wallets yet.</span> : (
        <div style={{ overflowX: "auto" }}>
          <table className="tbl">
            <thead><tr><th>Wallet</th><th>Status</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.wallet}>
                  <td style={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}><a href={addrUrl(net, r.wallet)} target="_blank" rel="noreferrer">{r.wallet}</a></td>
                  <td>{r.frozen ? <span className="tag y">Frozen</span> : r.verified ? <span className="tag g">Verified</span> : <span className="tag">Revoked</span>}</td>
                  <td>{r.verified ? <button className="btn ghost sm" style={{ color: "var(--bad)" }} onClick={() => setRevoking(r)}>Revoke</button> : <button className="btn ghost sm" onClick={() => { setWallet(r.wallet); setStep(0); }}>Re-verify</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted" style={{ fontSize: 12 }}>Each status is read from the token's identity registry, so it always matches what the sale checks.</p>

      {revoking && (
        <div className="sheet-wrap" role="dialog" aria-modal="true" aria-labelledby="rv-title">
          <button className="scrim" aria-label="Close" onClick={() => setRevoking(null)} />
          <div className="sheet" style={{ gap: 12 }}>
            <h3 id="rv-title">Revoke this investor's KYC claim?</h3>
            <span style={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}>{revoking.wallet}</span>
            {[["Buy from your sale", "Stops immediately"], ["Receive transfers", "Stops immediately"], ["Tokens already held", "Stay in the wallet"], ["Undo", "Verify again with a new signature"]].map(([k, v]) => (
              <div className="li" key={k}><span className="muted">{k}</span><span>{v}</span></div>
            ))}
            <div className="notice">To move tokens the wallet already holds, use Forced transfer under Token controls. Revoking only withdraws your claim.</div>
            <small className="muted">One transaction from your wallet, through your claim issuer. The platform can't revoke on your behalf.</small>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn ghost sm" onClick={() => setRevoking(null)}>Cancel</button>
              <button className="btn primary sm" style={{ background: "var(--bad)" }} onClick={() => revoke(revoking)}>Revoke claim</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ E4: token controls

export function TrexControlsPanel({ asset, net }: { asset: Asset; net: Network }) {
  const t = asset.trex!;
  const [paused, setPaused] = useState<boolean | null>(null);
  const [ia, setIa] = useState<Address | null>(null);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string; tx?: string } | null>(null);
  const [freezeAddr, setFreezeAddr] = useState("");
  const [force, setForce] = useState({ from: "", to: "", amount: "" });

  const load = useCallback(async () => {
    const pc = publicClientFor(net.id);
    const [p, a] = await Promise.all([
      pc.readContract({ address: t.token, abi: TREX_ABI, functionName: "paused" }) as Promise<boolean>,
      pc.readContract({ address: t.token, abi: TREX_ABI, functionName: "getImplementationAuthority" }) as Promise<Address>,
    ]);
    setPaused(p);
    setIa(a);
  }, [net.id, t.token]);
  useEffect(() => { load().catch(() => {}); }, [load]);

  async function run(label: string, fn: string, args: unknown[], to: Address = t.token, ok = "Done.") {
    setBusy(label);
    setMsg(null);
    try {
      const me = await connectWallet();
      await ensureChain(net.id);
      const h = await send(net.id, me, to, TREX_ABI, fn, args);
      setMsg({ kind: "ok", text: ok, tx: h });
      await load();
    } catch (e) {
      setMsg({ kind: "err", text: walletError(e) });
    } finally {
      setBusy("");
    }
  }
  const platformManaged = ia && ia.toLowerCase() === t.referenceAuthority.toLowerCase();
  const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

  return (
    <div className="panel">
      <h3>Token controls</h3>
      <div className="li">
        <span><b>Transfers between investors</b><br /><small className="muted">{paused ? "Investors can buy from your sale but can't send tokens to each other until you open transfers." : "Verified investors can send tokens to other verified wallets."}</small></span>
        {paused === null ? <span className="muted">…</span> : paused ? <span className="tag y">Paused</span> : <span className="tag g">Open</span>}
      </div>
      {paused !== null && (
        <button className={`btn ${paused ? "primary" : "ghost"} sm`} style={{ alignSelf: "flex-start" }} disabled={!!busy}
          onClick={() => run("pause", paused ? "unpause" : "pause", [], t.token, paused ? "Transfers are open." : "Transfers are paused.")}>
          {busy === "pause" ? "Confirm in wallet…" : paused ? "Open transfers" : "Pause transfers"}
        </button>
      )}
      <div className="form3" style={{ gridTemplateColumns: "2fr auto auto", alignItems: "end" }}>
        <label className="field">Freeze or unfreeze a wallet<input className="input" value={freezeAddr} placeholder="0x… full address" onChange={(e) => setFreezeAddr(e.target.value.trim())} /></label>
        <button className="btn ghost sm" disabled={!isAddr(freezeAddr) || !!busy} onClick={() => run("freeze", "setAddressFrozen", [freezeAddr, true], t.token, "Wallet frozen.")}>Freeze</button>
        <button className="btn ghost sm" disabled={!isAddr(freezeAddr) || !!busy} onClick={() => run("freeze", "setAddressFrozen", [freezeAddr, false], t.token, "Wallet unfrozen.")}>Unfreeze</button>
      </div>
      <div className="form3" style={{ gridTemplateColumns: "2fr 2fr 1fr auto", alignItems: "end" }}>
        <label className="field">Forced transfer from<input className="input" value={force.from} placeholder="0x…" onChange={(e) => setForce({ ...force, from: e.target.value.trim() })} /></label>
        <label className="field">To (verified wallet)<input className="input" value={force.to} placeholder="0x…" onChange={(e) => setForce({ ...force, to: e.target.value.trim() })} /></label>
        <label className="field">Tokens<input className="input" value={force.amount} inputMode="decimal" onChange={(e) => setForce({ ...force, amount: e.target.value.replace(/[^\d.]/g, "") })} /></label>
        <button className="btn ghost sm" disabled={!isAddr(force.from) || !isAddr(force.to) || !/^\d+(\.\d{1,18})?$/.test(force.amount) || !!busy}
          onClick={() => run("force", "forcedTransfer", [force.from, force.to, parseUnits(force.amount || "0", 18)], t.token, "Tokens moved.")}>Transfer</button>
      </div>
      <small className="muted">For court orders and lost keys. Every forced transfer is recorded on chain.</small>
      <div className="li"><span className="muted">Who can mint</span><span>Only the sale</span></div>
      <div className="li"><span className="muted">Code upgrades</span><span>{ia === null ? "…" : platformManaged ? "Platform-managed" : "Only you"}</span></div>
      {ia && <div className="li"><span className="muted">Upgrade authority</span><a href={addrUrl(net, ia)} target="_blank" rel="noreferrer" style={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}>{ia}</a></div>}
      {platformManaged && (
        <button className="btn ghost sm" style={{ alignSelf: "flex-start" }} disabled={!!busy}
          onClick={() => run("ia", "changeImplementationAuthority", [t.token, ZERO], t.referenceAuthority, "You now control upgrades.")}>
          {busy === "ia" ? "Confirm in wallet…" : "Take control of upgrades"}
        </button>
      )}
      {msg && <div className={`notice ${msg.kind}`}>{msg.text} {msg.tx && <a href={txUrl(net, msg.tx)} target="_blank" rel="noreferrer">View transaction ↗</a>}</div>}
    </div>
  );
}
