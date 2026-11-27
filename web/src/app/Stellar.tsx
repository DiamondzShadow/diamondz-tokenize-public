// Stellar edition console (designs X2 deploy, X3 issuer console; approved 2026-11-19).
// The platform relayer does the on-chain work (api/src/stellardeploy.ts); the issuer's Freighter wallet is the
// contracts' admin and signs only what is admin-only (pause / unpause).
import { useCallback, useEffect, useState } from "react";
import { SaleWizard } from "./Wizards";
import { api, type Asset, type StellarDeployment, type StellarSale, type StellarTerms, type StellarToken } from "../lib/api";
import { stellarAccountUrl, stellarTxUrl, networkById, type StellarNetwork } from "../lib/chains";
import { OPEN_COUNTRIES, countryName, lockupLabel, US } from "../lib/rules";
import { CHECK_KINDS, CLASS_CHECKS, kindHash, type CheckKindId } from "../lib/verification";
import { connectWallet, publicClientFor, walletClientFor } from "../lib/wallet";
import { claimSignerMessage } from "../lib/claims";
import { FREIGHTER_URL, connectFreighter, signWithFreighter } from "../lib/freighter";

const UNIT = 10_000_000n; // 7 decimals
const whole = (raw: string | bigint) => {
  const v = BigInt(raw);
  const w = v / UNIT, f = v % UNIT;
  return f === 0n ? w.toLocaleString() : `${w.toLocaleString()}.${f.toString().padStart(7, "0").replace(/0+$/, "")}`;
};

function Check({ state }: { state: "done" | "now" | "wait" | "bad" }) {
  const stroke = state === "done" ? "var(--ok)" : state === "now" ? "var(--brand)" : state === "bad" ? "var(--bad)" : "var(--muted)";
  const label = { done: "Done", now: "In progress", wait: "Waiting", bad: "Stopped" }[state];
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={state === "wait" ? 2 : 2.5} role="img" aria-label={label} style={{ flex: "none" }}>
      <circle cx="12" cy="12" r="10" strokeDasharray={state === "now" ? "4 3" : undefined} />
      {state === "done" && <path d="M7.5 12.5l3 3 6-7" />}
      {state === "bad" && <path d="M9 9l6 6M15 9l-6 6" />}
    </svg>
  );
}

function rulesSummary(asset: Asset): string {
  const r: any = asset.rules ?? {};
  const bits: string[] = [];
  if (r.lockupDays) bits.push(`${lockupLabel(r.lockupDays)} lockup`);
  if (r.maxHolderPct) bits.push(`max ${r.maxHolderPct}% per investor`);
  if (r.countryMode === "allow" && r.countries?.length) bits.push(r.countries.length === 1 && r.countries[0] === US ? "US only" : `${r.countries.length} countries allowed`);
  if (r.countryMode === "block" && r.countries?.length) bits.push(`${r.countries.length} countries blocked`);
  bits.push(`supply cap ${Number(asset.totalSupply).toLocaleString()}`);
  return bits.join(" · ");
}

// ------------------------------------------------------------------ X2 · deploy

const GROUPS = [
  { key: "identity", title: "Investor identity checks", what: "Which checks investors need (KYC, AML) and who may vouch for them" },
  { key: "registry", title: "Investor registry", what: "Links each investor's wallet to their verified identity and country" },
  { key: "rules", title: "Your rules", what: "" },
  { key: "token", title: "", what: "Checks every transfer against the registry and your rules" },
  { key: "chainlink", title: "Connect to Chainlink", what: "We register the offering so Chainlink can record supply and proof checks. No signature needed from you." },
  { key: "handover", title: "Platform steps back", what: "The platform gives up every role it used for setup: your multisig is admin, your wallet runs day to day, and the rules are locked." },
] as const;

// ------------------------------------------------------------------ multisig (mainnet admin actions)
/** Mainnet admin actions need the issuer's multisig: copy the prepared transaction, collect the signatures in the
 *  multisig wallet, paste the signed transaction back. */
export type MultisigAsk = { label: string; xdr: string; submit: (signedXdr: string) => Promise<unknown> };
export function MultisigBox({ ask, onDone, onCancel }: { ask: MultisigAsk; onDone: (msg: string) => void; onCancel: () => void }) {
  const [signed, setSigned] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  return (
    <div className="panel" style={{ borderColor: "var(--brand-line)" }}>
      <h3>{ask.label}: sign with your multisig</h3>
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>This needs your multisig's signatures. Copy the transaction, sign it in your multisig wallet with enough signers, then paste the signed transaction here.</p>
      <textarea className="input mono" readOnly rows={4} value={ask.xdr} aria-label="Transaction to sign" />
      <div className="row"><button type="button" className="btn ghost sm" onClick={() => { navigator.clipboard?.writeText(ask.xdr).then(() => setCopied(true), () => {}); }}>{copied ? "Copied" : "Copy transaction"}</button></div>
      <label htmlFor="ms-signed" className="muted" style={{ fontSize: 13 }}>Signed transaction</label>
      <textarea id="ms-signed" className="input mono" rows={4} value={signed} onChange={(e) => setSigned(e.target.value.trim())} placeholder="Paste the signed transaction (XDR)" />
      {err && <div className="notice err">{err}</div>}
      <div className="row" style={{ gap: 10 }}>
        <button type="button" className="btn primary" disabled={!signed || busy} onClick={async () => {
          setBusy(true); setErr("");
          try { await ask.submit(signed); onDone(`${ask.label}: done.`); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
        }}>{busy ? "Submitting…" : "Submit"}</button>
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

export function StellarDeployPanel({ asset, net, onChange }: { asset: Asset; net: StellarNetwork; onChange: (a: Asset) => void }) {
  const [wallet, setWallet] = useState((net.testnet ? asset.stellar?.issuer : asset.stellar?.operator) ?? "");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const st = asset.stellar;
  const running = st?.status === "deploying";
  // Mainnet: admin = the issuer's multisig, operator = this wallet, fee paid first.
  const main = !net.testnet;
  const [admin, setAdmin] = useState(asset.stellar?.issuer ?? "");
  const [feeTx, setFeeTx] = useState(asset.stellar?.feeTx ?? "");
  // Mainnet: the issuer's claim-signing wallet (EVM; a Trezor or Ledger behind MetaMask), named by one signature.
  const [claimSigner, setClaimSigner] = useState<{ address: string; signature: string } | null>(null);
  const [terms, setTerms] = useState<StellarTerms | null>(null);
  useEffect(() => { if (main) api.stellarTerms(net.key).then(setTerms, () => {}); }, [main, net.key]);
  const groups = GROUPS.filter((g) => main || g.key !== "handover");

  // Poll while the relayer works.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => api.asset(asset.id).then(onChange, () => {}), 3_000);
    return () => clearInterval(t);
  }, [running, asset.id, onChange]);

  const connect = async () => {
    setErr("");
    try { setWallet(await connectFreighter(net)); } catch (e) { setErr((e as Error).message); }
  };
  const nameClaimSigner = async () => {
    setErr("");
    try {
      const me = await connectWallet();
      // personal_sign needs no particular chain; any configured one gives a wallet client.
      const signature = await walletClientFor(42161, me).signMessage({ account: me, message: claimSignerMessage(asset.id, net, me) });
      setClaimSigner({ address: me, signature });
    } catch (e) { setErr((e as Error).message); }
  };
  const start = async () => {
    setErr(""); setBusy(true);
    try {
      onChange(main ? await api.stellarDeployMainnet(asset.id, admin.trim(), wallet, feeTx.trim(), claimSigner!) : await api.stellarDeploy(asset.id, wallet));
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const steps = st?.steps ?? {};
  const started = (g: string) => Object.keys(steps).some((k) => k.startsWith(`${g}.`));
  const lastStarted = [...groups].reverse().find((g) => started(g.key))?.key ?? (running ? "identity" : undefined);
  const stateOf = (i: number): "done" | "now" | "wait" | "bad" => {
    const g = groups[i]!.key;
    if (st?.status === "deployed") return "done";
    const later = groups.slice(i + 1).some((x) => started(x.key));
    if (later) return "done";
    if (g === lastStarted) return st?.status === "failed" ? "bad" : running ? "now" : "wait";
    return "wait";
  };
  const label = (i: number) => {
    const s = stateOf(i);
    return s === "done" ? <span className="st-state ok">Done</span> : s === "now" ? <span className="st-state now">Creating…</span> : s === "bad" ? <span className="st-state bad">Stopped</span> : <span className="st-state">Waiting</span>;
  };

  return (
    <div className="panel">
      <h3>Deploy {asset.symbol} on {net.name}</h3>
      <p className="muted" style={{ margin: 0 }}>This creates your token and its compliance contracts on Stellar.{net.testnet ? " It's a test network, so the fees are play money, and the platform pays them." : ""}</p>

      {main && terms && !terms.open && <div className="notice err">{net.name} isn't open for offerings yet{!terms.codeReady ? ": the platform is still uploading its contracts" : ""}.</div>}
      {main && terms?.testnetOnlyPlan && <div className="notice err">The Free plan runs on test networks only. Choose a plan to go live.</div>}
      {main && terms && !terms.counselReady && <div className="notice err">Tick legal sign-off on your setup checklist before going live.</div>}
      <div className="li" style={{ alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <span><b>1. Connect your Stellar wallet</b><br /><span className="muted" style={{ fontSize: 14 }}>Freighter, set to {net.testnet ? "Testnet" : "Mainnet"}. {main ? "This wallet runs the offering day to day: verifying investors, issuing and freezing." : "This wallet becomes the token's admin."}</span></span>
        {wallet
          ? <span className="tag g">Connected</span>
          : <button type="button" className="btn primary" onClick={connect}>Connect Freighter</button>}
      </div>
      {wallet && <div className="mono" style={{ padding: "10px 12px", background: "var(--surface2)", borderRadius: 8 }}>{wallet}</div>}
      {!wallet && <span className="muted" style={{ fontSize: 13 }}>No Freighter yet? <a href={FREIGHTER_URL} target="_blank" rel="noreferrer">Install it</a>, create an account and switch it to {net.testnet ? "Testnet" : "Mainnet"}.</span>}
      {main && (
        <>
          <div className="q">
            <label htmlFor="st-admin"><b>2. Your multisig (admin)</b></label>
            <span className="muted" style={{ fontSize: 14 }}>A Stellar account that needs more than one signature. It becomes the token's admin: pausing, approving the sale and replacing your day-to-day wallet need it. It can't be the wallet above.</span>
            <input id="st-admin" className="input mono" placeholder="G…" value={admin} onChange={(e) => setAdmin(e.target.value.trim())} />
          </div>
          <div className="li" style={{ alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            <span><b>3. Your claim-signing wallet</b><br /><span className="muted" style={{ fontSize: 14 }}>You vouch for each investor you verify by signing their identity claims. Use an Ethereum wallet, ideally a Trezor or Ledger connected through MetaMask. It becomes the only key that can sign claims for this offering. The platform never holds one. Keep it safe: if it's lost, your multisig has to set up a new claim issuer.</span></span>
            {claimSigner
              ? <span className="tag g">Named</span>
              : <button type="button" className="btn" onClick={nameClaimSigner}>{st?.claimSigner ? "Sign again to resume" : "Connect and sign"}</button>}
          </div>
          {(claimSigner || st?.claimSigner) && <div className="mono" style={{ padding: "10px 12px", background: "var(--surface2)", borderRadius: 8 }}>{claimSigner?.address ?? st?.claimSigner?.address}</div>}
          <div className="q">
            <label htmlFor="st-fee"><b>4. Pay the offering fee</b></label>
            <span className="muted" style={{ fontSize: 14 }}>
              {terms?.feeAccount
                ? <>Send <b>{terms.feeUsd.toLocaleString()} {terms.payToken.code}</b> on Stellar to <span className="mono">{terms.feeAccount}</span>, then paste the payment's transaction hash. Each payment can be used once.</>
                : "The platform's fee account isn't set yet."}
            </span>
            <input id="st-fee" className="input mono" placeholder="Transaction hash (64 characters)" value={feeTx} onChange={(e) => setFeeTx(e.target.value.trim())} />
          </div>
        </>
      )}

      <div>
        <b>{main ? "5" : "2"}. Create the contracts</b>
        <p className="muted" style={{ margin: "4px 0 10px", fontSize: 14 }}>{main ? "The platform creates them and pays the network fees, then steps back." : "The platform creates them with your wallet as admin."} You can leave this page; it keeps going.</p>
        <ol className="st-steps">
          {groups.map((g, i) => (
            <li key={g.key} className={stateOf(i) === "now" ? "now" : ""}>
              <Check state={stateOf(i)} />
              <span className="st-label">
                <b style={{ fontWeight: 500 }}>{g.key === "token" ? `The ${asset.symbol} token` : g.title}</b>
                <small>{g.key === "rules" ? rulesSummary(asset) : g.what}</small>
              </span>
              {label(i)}
            </li>
          ))}
        </ol>
      </div>
      {st?.status === "failed" && <div className="notice err">It stopped: {st.error}. Press Resume; finished steps are kept and nothing is created twice.</div>}
      {err && <div className="notice err">{err}</div>}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        {!running && (
          <button type="button" className="btn primary" disabled={!wallet || busy || (main && (!/^G[A-Z2-7]{55}$/.test(admin) || !/^[0-9a-f]{64}$/i.test(feeTx) || !terms?.open || !claimSigner))} onClick={start}>
            {st?.status === "failed" ? "Resume" : `Deploy on ${net.name}`}
          </button>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ X3 · online sale (contracts/sale)

export const payAmount = (raw: string, decimals: number) => {
  const v = Number(BigInt(raw)) / 10 ** decimals;
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
};

function StellarSalePanel({ asset, net, onChange }: { asset: Asset; net: StellarNetwork; onChange: (a: Asset) => void }) {
  const d = asset.deployment as unknown as StellarDeployment & { sale?: string };
  const issuer = asset.stellar!.issuer;
  const [sale, setSale] = useState<StellarSale | null | undefined>(undefined);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const load = useCallback(() => api.stellarSale(asset.id).then((r) => setSale(r.sale), () => setSale(null)), [asset.id]);
  useEffect(() => { load(); }, [load, d.sale]);

  const act = async (label: string, f: () => Promise<unknown>, ok: string) => {
    setBusy(label); setMsg({});
    try { await f(); setMsg({ ok }); await load(); } catch (e) { setMsg({ err: (e as Error).message }); } finally { setBusy(""); }
  };
  const [ask, setAsk] = useState<MultisigAsk | null>(null);
  const grant = () => act("grant", async () => {
    if (!net.testnet) {
      const r = await api.stellarSaleGrant(asset.id);
      if (r.already || !r.xdr) return;
      setAsk({ label: "Approve the sale", xdr: r.xdr, submit: async (signed) => { await api.stellarSaleGrant(asset.id, signed); await load(); } });
      return;
    }
    const w = await connectFreighter(net);
    if (w !== issuer) throw new Error(`Switch Freighter to the admin wallet ${issuer}`);
    const r = await api.stellarSaleGrant(asset.id);
    if (r.already || !r.xdr) return;
    await api.stellarSaleGrant(asset.id, await signWithFreighter(net, r.xdr, w));
  }, "Approved: the sale can now issue tokens to buyers.");
  const open = (o: boolean) => act("open", () => api.stellarSaleOpen(asset.id, o), o ? "The sale is open." : "The sale is closed.");

  const pd = sale?.payToken.decimals ?? net.payToken.decimals;
  const code = sale?.payToken.code ?? net.payToken.code;
  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
        <h3>Online sale</h3>
        {sale && <span className={`tag ${sale.open ? "g" : "y"}`}>{sale.open ? "Open" : "Closed"}</span>}
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>
        Verified investors buy on your listing with {code} from their Stellar wallet. Payments go straight to your treasury account; the sale mints their tokens through every rule on the token.
      </p>
      {sale === undefined && <span className="muted">Reading the sale…</span>}
      {sale === null && !d.sale && <SaleWizard asset={asset} net={net} onCreated={(a) => { onChange(a); setMsg({ ok: `Sale created. Next, approve it ${net.testnet ? "in Freighter" : "with your multisig"}.` }); }} />}
      {sale && (
        <>
          <div className="st-stats">
            <div><span className="muted">Price</span><b>{payAmount(sale.price, pd)} {code}</b><small className="muted">per token</small></div>
            <div><span className="muted">Minimum</span><b>{Number(sale.minPurchase) ? `${payAmount(sale.minPurchase, pd)} ${code}` : "None"}</b><small className="muted">per purchase</small></div>
            <div><span className="muted">Sold online</span><b>{whole(sale.sold)}</b><small className="muted">tokens</small></div>
            <div><span className="muted">Left</span><b>{whole(BigInt(sale.cap) - BigInt(sale.sold))}</b><small className="muted">of {whole(sale.cap)}</small></div>
          </div>
          {sale.closedByProof && !sale.open && <div className="notice err">The sale was closed automatically on {new Date(sale.closedByProof).toLocaleString()} because a proof-of-asset check stopped passing. Reopen it once every check passes again.</div>}
          {!sale.canMint ? (
            <div className="row" style={{ flexWrap: "wrap" }}>
              <button type="button" className="btn primary" disabled={!!busy} onClick={grant}>{busy === "grant" ? "Waiting for Freighter…" : "Approve the sale in Freighter"}</button>
              <span className="muted" style={{ fontSize: 13 }}>One signature lets the sale issue tokens to buyers. Only your admin wallet can give that permission.</span>
            </div>
          ) : (
            <div className="row" style={{ flexWrap: "wrap" }}>
              <button type="button" className={`btn ${sale.open ? "ghost" : "primary"}`} disabled={!!busy} onClick={() => open(!sale.open)}>{busy === "open" ? "…" : sale.open ? "Close the sale" : "Open the sale"}</button>
              <span className="muted" style={{ fontSize: 13 }}>{sale.open ? "Closes automatically if a proof-of-asset check stops passing." : `Opens once every proof-of-asset check passes. Your admin wallet needs a ${code} trustline to receive payments.`}</span>
            </div>
          )}
          <div className="li"><span className="muted">Sale contract</span><a className="mono" href={stellarAccountUrl(net, sale.address)} target="_blank" rel="noreferrer">{sale.address}</a></div>
        </>
      )}
      {msg.ok && <div className="notice ok">{msg.ok}</div>}
      {msg.err && <div className="notice err">{msg.err}</div>}
      {ask && <MultisigBox ask={ask} onDone={(m) => { setAsk(null); setMsg({ ok: m }); load(); }} onCancel={() => setAsk(null)} />}
    </div>
  );
}

// ------------------------------------------------------------------ X3 · console

const latestAbi = [{
  type: "function", name: "latest", stateMutability: "view", inputs: [{ type: "address" }, { type: "bytes32" }],
  outputs: [{ type: "tuple", components: [
    { name: "verifier", type: "address" }, { name: "result", type: "uint8" }, { name: "attestedAt", type: "uint64" },
    { name: "validUntil", type: "uint64" }, { name: "value", type: "int256" }, { name: "evidenceHash", type: "bytes32" }, { name: "evidenceURI", type: "string" },
  ] }],
}] as const;

export type StellarProof = { kind: CheckKindId | "REGISTRY"; result: number; validUntil: number };

/** The offering's checks on AssetOracle, read at its StellarAssetAnchor (Chainlink CRE fills REGISTRY from Stellar). */
export function useStellarProof(assetClass: Asset["assetClass"], anchor: { chainId: number; address: `0x${string}` } | undefined) {
  const [proof, setProof] = useState<StellarProof[] | null>(null);
  useEffect(() => {
    const evm = anchor ? networkById(anchor.chainId) : undefined;
    if (!anchor || !evm?.assetOracle) return;
    const kinds = [...new Set([...(CLASS_CHECKS[assetClass] ?? []), "REGISTRY" as CheckKindId])];
    const pc = publicClientFor(evm.id);
    Promise.all(kinds.map(async (k) => {
      const a = await pc.readContract({ address: evm.assetOracle!.address, abi: latestAbi, functionName: "latest", args: [anchor.address, kindHash(k)] }).catch(() => null);
      return { kind: k, result: a ? Number(a.result) : 0, validUntil: a ? Number(a.validUntil) : 0 };
    })).then(setProof);
  }, [assetClass, anchor?.chainId, anchor?.address]);
  return proof;
}
export const stellarCheckName = (k: string) => (k === "REGISTRY" ? "Stellar supply within cap" : CHECK_KINDS[k as CheckKindId]?.name ?? k);

export function StellarConsole({ asset, net, onChange }: { asset: Asset; net: StellarNetwork; onChange: (a: Asset) => void }) {
  const d = asset.deployment as unknown as StellarDeployment;
  const st = asset.stellar!;
  const [tok, setTok] = useState<StellarToken | null>(null);
  const [bal, setBal] = useState<Record<string, string>>({});
  const proof = useStellarProof(asset.assetClass, d.anchor);
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const [busy, setBusy] = useState("");
  const [acct, setAcct] = useState("");
  const [country, setCountry] = useState(US);
  const [issueTo, setIssueTo] = useState("");
  const [amount, setAmount] = useState("");

  const refresh = useCallback(async () => {
    api.stellarToken(net.key, d.token).then(setTok, () => {});
    const entries = await Promise.all(st.investors.map(async (i) => [i.account, (await api.stellarBalance(net.key, d.token, i.account).catch(() => ({ balance: "0" }))).balance] as const));
    setBal(Object.fromEntries(entries));
  }, [net.key, d.token, st.investors]);
  useEffect(() => { refresh(); }, [refresh]);

  const run = async (label: string, f: () => Promise<unknown>, ok: string) => {
    setBusy(label); setMsg({});
    try { await f(); setMsg({ ok }); onChange(await api.asset(asset.id)); refresh(); } catch (e) { setMsg({ err: (e as Error).message }); } finally { setBusy(""); }
  };
  // Mainnet: day-to-day actions come back as { xdr } for the operator wallet to sign in Freighter.
  const operatorSign = async (first: { xdr?: string }, resend: (signed: string) => Promise<unknown>) => {
    if (!first.xdr) return;
    const op = st.operator ?? st.issuer;
    const w = await connectFreighter(net);
    if (w !== op) throw new Error(`Switch Freighter to your day-to-day wallet ${op}`);
    await resend(await signWithFreighter(net, first.xdr, w));
  };
  const [ask, setAsk] = useState<MultisigAsk | null>(null);
  const verify = (account: string, cc: number) => run(`verify:${account}`, async () => {
    let first = await api.stellarVerify(asset.id, account, cc);
    // Mainnet: your claim-signing wallet signs each identity claim first (MetaMask; a hardware wallet asks to confirm).
    if (first.claims?.length) {
      const signer = first.claimSigner!;
      const me = await connectWallet();
      if (me.toLowerCase() !== signer.toLowerCase()) throw new Error(`Connect your claim-signing wallet ${signer} in MetaMask`);
      const wc = walletClientFor(42161, me);
      const claimSignatures: { topic: number; signature: string }[] = [];
      for (const c of first.claims) claimSignatures.push({ topic: c.topic, signature: await wc.signMessage({ account: me, message: { raw: c.digest } }) });
      first = await api.stellarVerify(asset.id, account, cc, undefined, claimSignatures);
    }
    await operatorSign(first, (s) => api.stellarVerify(asset.id, account, cc, s));
  }, "Investor verified on Stellar.");
  const issue = () => run("issue", async () => {
    await operatorSign(await api.stellarIssue(asset.id, issueTo, amount), (s) => api.stellarIssue(asset.id, issueTo, amount, s));
  }, `Issued ${amount} ${asset.symbol}.`);
  const freeze = (account: string, f: boolean) => run(`freeze:${account}`, async () => {
    await operatorSign(await api.stellarFreeze(asset.id, account, f), (s) => api.stellarFreeze(asset.id, account, f, s));
  }, f ? "Wallet frozen." : "Wallet unfrozen.");
  const pause = (p: boolean) => net.testnet ? pauseTestnet(p) : run("pause", async () => {
    const { xdr } = await api.stellarPausePrepare(asset.id, p);
    setAsk({ label: p ? "Pause all transfers" : "Reopen transfers", xdr, submit: (signed) => api.stellarPauseSubmit(asset.id, p, signed) });
  }, "Sign it with your multisig below.");
  const pauseTestnet = (p: boolean) => run("pause", async () => {
    const issuer = await connectFreighter(net);
    if (issuer !== st.issuer) throw new Error(`Switch Freighter to the admin wallet ${st.issuer}`);
    const { xdr } = await api.stellarPausePrepare(asset.id, p);
    await api.stellarPauseSubmit(asset.id, p, await signWithFreighter(net, xdr, issuer));
  }, p ? "All transfers paused." : "Transfers are open again.");

  const now = Date.now() / 1000;
  const r: any = asset.rules ?? {};
  const kindName = stellarCheckName;
  const evm = networkById(d.anchor.chainId);

  return (
    <>
      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
          <h3>On {net.name}</h3>
          <span className="tag g">Deployed</span>
        </div>
        <div className="st-stats">
          <div><span className="muted">Tokens issued</span><b>{tok ? whole(tok.totalSupply) : "…"}</b><small className="muted">of {Number(asset.totalSupply).toLocaleString()} cap</small></div>
          <div><span className="muted">Investors verified</span><b>{st.investors.length}</b><small className="muted">{st.requests.length ? `${st.requests.length} waiting` : "none waiting"}</small></div>
          <div><span className="muted">Transfers</span><b>{tok ? (tok.paused ? "Paused" : "Open") : "…"}</b><small className="muted">{tok?.paused ? "nobody can move tokens" : "not paused"}</small></div>
          <div><span className="muted">Read from Stellar</span><b>{tok ? `Ledger ${tok.ledger.toLocaleString()}` : "…"}</b><small className="muted">updates every 15 seconds</small></div>
        </div>
        {msg.ok && <div className="notice ok">{msg.ok}</div>}
        {msg.err && <div className="notice err">{msg.err}</div>}
        {ask && <MultisigBox ask={ask} onDone={(m) => { setAsk(null); setMsg({ ok: m }); refresh(); }} onCancel={() => setAsk(null)} />}
      </div>

      <StellarSalePanel asset={asset} net={net} onChange={onChange} />

      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
          <h3>Proof of asset</h3>
          <span className="st-chainlink">Checked by Chainlink</span>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>Chainlink reads this token directly from the Stellar ledger and records the result on Base. New sales open once every required check passes.</p>
        <table className="st-table">
          <thead><tr><th>Check</th><th>Status</th></tr></thead>
          <tbody>
            {(proof ?? []).map((p) => {
              const current = p.result === 1 && p.validUntil > now;
              return (
                <tr key={p.kind}>
                  <td>{kindName(p.kind)}{p.kind === "REGISTRY" && <><br /><small className="muted">{tok ? `${whole(tok.totalSupply)} of ${Number(asset.totalSupply).toLocaleString()} tokens` : ""}</small></>}</td>
                  <td>{current ? <span className="st-pass">Pass</span> : p.result === 2 && p.validUntil > now ? <span className="st-wait" style={{ color: "var(--bad)" }}>Fail</span> : <span className="st-wait">Waiting</span>}
                    <br /><small className="muted">{p.kind === "REGISTRY" ? "Chainlink CRE, rechecked every 30 min" : current ? `valid until ${new Date(p.validUntil * 1000).toLocaleDateString()}` : "needs an approved verifier"}</small></td>
                </tr>
              );
            })}
            {!proof && <tr><td colSpan={2} className="muted">Reading the oracle…</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="panel" id="investors">
        <h3>Holders</h3>
        <div className="st-scroll">
          <table className="st-table">
            <thead><tr><th>Stellar wallet</th><th>Tokens</th><th>Country</th><th>State</th><th /></tr></thead>
            <tbody>
              {st.investors.map((i) => (
                <tr key={i.account}>
                  <td className="mono"><a href={stellarAccountUrl(net, i.account)} target="_blank" rel="noreferrer">{i.account}</a></td>
                  <td>{bal[i.account] !== undefined ? whole(bal[i.account]!) : "…"}</td>
                  <td>{countryName(i.country)}</td>
                  <td>{i.frozen ? "Frozen" : "Active"}</td>
                  <td style={{ textAlign: "right" }}>
                    <button type="button" className="btn ghost sm" disabled={!!busy} onClick={() => freeze(i.account, !i.frozen)}>{busy === `freeze:${i.account}` ? "…" : i.frozen ? "Unfreeze" : "Freeze"}</button>
                  </td>
                </tr>
              ))}
              {!st.investors.length && <tr><td colSpan={5} className="muted">No verified investors yet.</td></tr>}
            </tbody>
          </table>
        </div>
        {st.requests.length > 0 && (
          <>
            <h4 style={{ margin: "8px 0 0" }}>Waiting for verification</h4>
            <div className="st-scroll">
              <table className="st-table">
                <tbody>
                  {st.requests.map((q) => (
                    <tr key={q.account}>
                      <td className="mono">{q.account}</td>
                      <td>{countryName(q.country)}</td>
                      <td>{new Date(q.at).toLocaleDateString()}</td>
                      <td style={{ textAlign: "right" }}><button type="button" className="btn primary sm" disabled={!!busy} onClick={() => verify(q.account, q.country)}>{busy === `verify:${q.account}` ? "Verifying…" : "Verify"}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <span className="muted" style={{ fontSize: 13 }}>Check their identity documents first. Verifying records a KYC and AML check for that wallet on Stellar.</span>
          </>
        )}
      </div>

      <div className="panel">
        <h3>Actions</h3>
        <div className="wz-two">
          <form className="q" onSubmit={(e) => { e.preventDefault(); verify(acct.trim(), country); }}>
            <label htmlFor="st-acct"><b>Verify an investor</b></label>
            <input id="st-acct" className="input mono" placeholder="Stellar wallet, G…" value={acct} onChange={(e) => setAcct(e.target.value)} />
            <label htmlFor="st-cc" className="muted" style={{ fontSize: 13 }}>Country of residence</label>
            <select id="st-cc" className="input" value={country} onChange={(e) => setCountry(Number(e.target.value))}>
              {OPEN_COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
            </select>
            <button type="submit" className="btn ghost" disabled={!!busy || !/^G[A-Z2-7]{55}$/.test(acct.trim())}>{busy.startsWith("verify:") ? "Verifying…" : "Verify investor"}</button>
          </form>
          <form className="q" onSubmit={(e) => { e.preventDefault(); issue(); }}>
            <label htmlFor="st-to"><b>Issue tokens to an investor</b></label>
            <select id="st-to" className="input" value={issueTo} onChange={(e) => setIssueTo(e.target.value)}>
              <option value="">Choose a verified investor</option>
              {st.investors.filter((i) => !i.frozen).map((i) => <option key={i.account} value={i.account}>{i.account}</option>)}
            </select>
            <label htmlFor="st-amt" className="muted" style={{ fontSize: 13 }}>Tokens</label>
            <input id="st-amt" className="input" inputMode="numeric" placeholder="e.g. 100" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))} />
            <button type="submit" className="btn primary" disabled={!!busy || !issueTo || !amount}>{busy === "issue" ? "Issuing…" : "Issue tokens"}</button>
          </form>
        </div>
        <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
          <button type="button" className="btn ghost" disabled={!!busy || !tok} onClick={() => pause(!tok?.paused)}>{busy === "pause" ? "Waiting for Freighter…" : tok?.paused ? "Reopen transfers" : "Pause all transfers"}</button>
          <span className="muted" style={{ fontSize: 13 }}>{net.testnet ? "Pausing is approved in Freighter with your admin wallet." : "Pausing needs your multisig's signatures."}</span>
        </div>
      </div>

      <div className="panel">
        <h3>Rules on the token</h3>
        <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4, fontSize: 14 }}>
          <li>Supply cap {Number(asset.totalSupply).toLocaleString()}</li>
          {r.maxHolderPct > 0 && <li>At most {r.maxHolderPct}% of all tokens per investor</li>}
          {r.countryMode === "allow" && r.countries?.length > 0 && <li>Only investors in {r.countries.map(countryName).join(", ")}</li>}
          {r.countryMode === "block" && r.countries?.length > 0 && <li>Blocked: {r.countries.map(countryName).join(", ")}</li>}
          {r.lockupDays > 0 && <li>{lockupLabel(r.lockupDays)} lockup after each purchase</li>}
          <li>Every holder must be verified (KYC and AML{r.accreditedOnly ? ", accredited" : ""})</li>
        </ul>
        {st.offChainRules.length > 0 && <p className="muted" style={{ margin: 0, fontSize: 13 }}>Not enforced by the Stellar token yet, so check these yourself: {st.offChainRules.join("; ")}.</p>}
      </div>

      <div className="panel">
        <h3>Contract addresses</h3>
        <div className="li"><span className="muted">Token on Stellar</span><a className="mono" href={stellarAccountUrl(net, d.token)} target="_blank" rel="noreferrer">{d.token}</a></div>
        <div className="li"><span className="muted">Admin (your wallet)</span><a className="mono" href={stellarAccountUrl(net, st.issuer)} target="_blank" rel="noreferrer">{st.issuer}</a></div>
        <div className="li"><span className="muted">Investor registry</span><a className="mono" href={stellarAccountUrl(net, d.registry)} target="_blank" rel="noreferrer">{d.registry}</a></div>
        <div className="li"><span className="muted">Compliance</span><a className="mono" href={stellarAccountUrl(net, d.compliance)} target="_blank" rel="noreferrer">{d.compliance}</a></div>
        {evm && <div className="li"><span className="muted">Chainlink record on {evm.name}</span><a className="mono" href={`${evm.explorer}/address/${d.anchor.address}`} target="_blank" rel="noreferrer">{d.anchor.address}</a></div>}
      </div>
    </>
  );
}

export { stellarTxUrl, whole as stellarAmount };
