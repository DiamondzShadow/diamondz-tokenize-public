import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { keccak256, parseUnits, toHex, type Address } from "viem";
import { api, type Asset } from "../lib/api";
import { ITEM_ID, assetClassById, standardById } from "../lib/catalog";
import { addrUrl, networkById, stellarById, txUrl, type Network } from "../lib/chains";
import { StellarConsole, StellarDeployPanel } from "./Stellar";
import { GoLiveCard } from "./Wizards";
import { useTenant } from "../lib/tenant";
import { CLASS_CHECKS, classHash, kindHash } from "../lib/verification";
import { OPEN_COUNTRIES, documentURI, hasRules, isSanctioned, rulesConfig, saleWindow } from "../lib/rules";
import { IpLicensingPanel, IpRegisterPanel, ipAvailable } from "./IPPanel";
import { isLicensable } from "../lib/ip";
import { ProofPanel, useProof } from "../lib/Proof";
import PayoutsPanel from "./Payouts";
import AccreditationPanel from "./Accreditation";
import BankProofPanel from "./BankProof";
import FormDPanel from "./FormD";
import ApprovalsPanel from "./Approvals";
import { TrexControlsPanel, TrexInvestorsPanel, UpgradeChoice, trexSteps, type UpgradeMode } from "./Trex";

function AdminProof({ asset }: { asset: Asset }) {
  const proof = useProof(asset.id);
  return <ProofPanel proof={proof} assetClass={asset.assetClass} />;
}
import { ART, ROLES, connectWallet, deploy, ensureChain, publicClientFor, send, walletError } from "../lib/wallet";
import { PageHelp } from "./onboarding";
import Connect from "../lib/Connect";

const ROLE = (n: string) => keccak256(toHex(n));

export default function AssetDetail() {
  const { id = "" } = useParams();
  const [asset, setAsset] = useState<Asset | null>(null);
  const [err, setErr] = useState("");
  const reload = useCallback(() => api.asset(id).then(setAsset, (e) => setErr(e.message)), [id]);
  // An approved accreditation request fills the wallet into the Investors panel.
  const [prefill, setPrefill] = useState<{ wallet: string; n: number } | null>(null);
  useEffect(() => {
    reload();
  }, [reload]);

  if (err) return <div className="content"><div className="notice err">{err}</div></div>;
  if (!asset) return null;
  const net = networkById(asset.chainId);
  const stellar = stellarById(asset.chainId);
  const deployed = asset.status === "deployed";

  return (
    <>
      <div className="topbar">
        <h1>{asset.name} <span className="muted" style={{ fontSize: 15 }}>{asset.symbol}</span></h1>
        <div className="row">
          <span className={`tag ${deployed ? "g" : "y"}`}>{deployed ? "Deployed" : "Draft"}</span>
          {!deployed && <Link className="btn ghost sm" to={`/app/new?id=${asset.id}`}>Edit terms</Link>}
          {deployed && asset.listed && <Link className="btn ghost sm" to={`/market/${asset.id}`}>View on marketplace ↗</Link>}
        </div>
      </div>
      <div className="content">
        <PageHelp
          id="asset"
          what="Everything about one asset: deploying it to a network, how it appears on the marketplace, and which investor wallets may buy."
          next={deployed ? "Fill in the listing and switch it on, then verify investor wallets so they can buy." : "Deploy it on a testnet first to practice. Mainnet unlocks after legal sign-off."}
        />
        <div className="panel">
          <h3>Terms</h3>
          {[
            ["Asset class", assetClassById(asset.assetClass)?.name],
            ["Standard", standardById(asset.standard)?.name],
            ["Network", net ? `${net.name}${net.testnet ? " (testnet)" : ""}` : stellar ? stellar.name : `chain ${asset.chainId}`],
            ["Total supply", Number(asset.totalSupply).toLocaleString()],
            ["Price per token", asset.pricePerToken ? `$${asset.pricePerToken}` : "—"],
            ["Minimum investment", asset.minInvestment ? `$${asset.minInvestment}` : "—"],
          ].map(([k, v]) => <div className="li" key={k}><span className="muted">{k}</span><span>{v}</span></div>)}
          {asset.deployment && net && (
            <>
              {(["token", "sale", "registry", "payToken"] as const).map((k) => (
                <div className="li" key={k}>
                  <span className="muted">{{ token: "Token contract", sale: "Sale contract", registry: asset.standard === "erc3643" ? "Identity registry" : "Investor registry", payToken: "Payment token" }[k]}</span>
                  <a href={addrUrl(net, asset.deployment![k])} target="_blank" rel="noreferrer" style={{ fontFamily: "monospace", fontSize: 13, wordBreak: "break-all" }}>{asset.deployment![k]}</a>
                </div>
              ))}
            </>
          )}
        </div>

        {!deployed && <GoLiveCard asset={asset} />}
        {!deployed && net && <DeployPanel asset={asset} net={net} onDone={setAsset} />}
        {!deployed && stellar && <StellarDeployPanel asset={asset} net={stellar} onChange={setAsset} />}
        {deployed && stellar && asset.stellar && <StellarConsole asset={asset} net={stellar} onChange={setAsset} />}
        <ListingPanel asset={asset} onSaved={setAsset} />
        <FormDPanel asset={asset} onChange={setAsset} />
        {deployed && !stellar && <AccreditationPanel asset={asset} onApprove={(w) => { setPrefill({ wallet: w, n: Date.now() }); setTimeout(() => document.getElementById("investors")?.scrollIntoView({ behavior: "smooth" }), 50); }} />}
        {deployed && net && asset.standard === "erc3643" && asset.trex && <TrexInvestorsPanel asset={asset} net={net} prefill={prefill} />}
        {deployed && net && asset.standard === "erc3643" && asset.trex && <TrexControlsPanel asset={asset} net={net} />}
        {deployed && net && asset.standard !== "erc3643" && <InvestorsPanel asset={asset} net={net} prefill={prefill} />}
        {deployed && net && asset.standard !== "erc3643" && <ApprovalsPanel asset={asset} />}
        {deployed && net && <PayoutsPanel asset={asset} net={net} />}
        {deployed && net && ["real-estate", "energy", "music-ip", "film"].includes(asset.assetClass) && <BankProofPanel asset={asset} net={net} />}
        {deployed && net && ipAvailable(asset, net) && <IpRegisterPanel asset={asset} net={net} onChange={setAsset} />}
        {deployed && net && ipAvailable(asset, net) && isLicensable(asset.assetClass) && (asset as any).ip?.registered && <IpLicensingPanel asset={asset} net={net} />}
        {deployed && !stellar && <AdminProof asset={asset} />}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ deploy

interface Progress {
  account?: Address;
  feeTx?: string;
  payToken?: Address;
  registry?: Address;
  token?: Address;
  sale?: Address;
  /** OfferingRules contract (offerings with rules). */
  rules?: Address;
  txs: string[];
  done: string[];
}

function DeployPanel({ asset, net, onDone }: { asset: Asset; net: Network; onDone: (a: Asset) => void }) {
  const { tenant } = useTenant();
  const key = `dt_deploy_${asset.id}_${asset.chainId}`;
  const [p, setP] = useState<Progress>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "") as Progress;
    } catch {
      return { txs: [], done: [] };
    }
  });
  const [running, setRunning] = useState<string | null>(null);
  const [upgrade, setUpgrade] = useState<UpgradeMode>("own");
  const [err, setErr] = useState("");
  const save = (next: Progress) => {
    setP(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* resume won't survive a reload; deploy still works */
    }
  };

  if (!tenant) return null;
  const existingRegistry = tenant.registries?.[String(net.id)] as Address | undefined;
  const treasury = tenant.payments.treasury as Address | undefined;
  const payDecimals = net.stable?.decimals ?? 6;
  // Platform Safe on this chain: receives the flat offering fee on mainnet (and the % sale fee if ever enabled).
  const platformSafe = tenant.platform.feeRecipients?.[String(net.id)] as Address | undefined;
  const fee = platformSafe && tenant.platform.saleFeeBps > 0 ? { recipient: platformSafe, bps: tenant.platform.saleFeeBps } : { recipient: "0x0000000000000000000000000000000000000000", bps: 0 };
  const offeringFee = tenant.plan.offeringFeeUsd;

  const blockers: string[] = [];
  const isVault = asset.standard === "erc4626";
  // ERC-1155: one item (token id ITEM_ID) per offering; units are whole fractions of it.
  const isMulti = asset.standard === "erc1155";
  // ERC-721: one NFT per unique unit; totalSupply = number of NFTs, price = per NFT.
  const isNft = asset.standard === "erc721";
  // ERC-3643: the platform deploys the audited T-REX suite; the issuer's wallet does the rest (app/Trex.tsx).
  const isTrex = asset.standard === "erc3643";
  // Offering rules (wizard step 5): a per-offering OfferingRules contract the token checks; ERC-3643 gets them from the
  // platform's compliance module when the suite is deployed instead.
  const offeringRules = asset.rules;
  const withRules = !isTrex && hasRules(offeringRules);
  const win = saleWindow(offeringRules);
  const RULES = ART.OfferingRules.abi;
  const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as Address;
  const TOK = isMulti ? ART.PermissionedMultiToken.abi : isNft ? ART.PermissionedNFT.abi : ART.PermissionedToken.abi;
  const SALE = isMulti ? ART.PrimarySale1155.abi : isNft ? ART.PrimarySale721.abi : ART.PrimarySale.abi;
  if (isTrex && !net.trex) blockers.push(`ERC-3643 isn't available on ${net.name} yet. Pick another network in Edit terms.`);
  if (isTrex && !net.testnet) blockers.push("ERC-3643 is on test networks for now. Pick a testnet in Edit terms.");
  if (asset.standard !== "erc7943" && !isVault && !isMulti && !isNft && !isTrex) blockers.push("This token type can't be deployed yet. Change the standard in Edit terms.");
  if (!asset.pricePerToken || Number(asset.pricePerToken) <= 0) blockers.push("Set a price per token in Edit terms.");
  if (!net.testnet && !tenant.onboarding?.counselReady) blockers.push("Mainnet needs legal sign-off ticked on your dashboard checklist.");
  if (!net.testnet && !treasury) blockers.push("Mainnet needs a treasury multisig set in Payments.");
  if (!net.testnet && (!platformSafe || !net.stable)) blockers.push(`${net.name} isn't open for mainnet offerings yet. Pick another network in Edit terms.`);

  const proofKinds = CLASS_CHECKS[asset.assetClass] ?? [];
  const steps: { id: string; label: string; run: (s: Progress) => Promise<Progress> }[] = [
    {
      id: "connect",
      label: `Use your connected wallet on ${net.name}`,
      run: async (s) => {
        const account = await connectWallet();
        await ensureChain(net.id);
        return { ...s, account };
      },
    },
    {
      id: "pay",
      label: net.stable ? `Use ${net.stable.symbol} for payments` : "Deploy Test USD (play money for practice purchases)",
      run: async (s) => {
        if (net.stable) return { ...s, payToken: net.stable.address };
        const r = await deploy(net.id, s.account!, "TestUSD", []);
        return { ...s, payToken: r.address, txs: [...s.txs, r.hash] };
      },
    },
    ...(isTrex ? trexSteps({ asset, net, upgrade, treasury, payDecimals, fee }) : []),
    ...(isTrex ? [] : [{
      id: "registry",
      label: existingRegistry ? "Use your existing investor registry on this network" : "Deploy your investor registry (who is verified)",
      run: async (s: Progress) => {
        if (existingRegistry) return { ...s, registry: existingRegistry };
        const r = await deploy(net.id, s.account!, "InvestorRegistry", [s.account, s.account, net.sanctionsOracle ?? "0x0000000000000000000000000000000000000000"]);
        return { ...s, registry: r.address, txs: [...s.txs, r.hash] };
      },
    }]),
    ...(withRules ? [{
      id: "rules",
      label: "Deploy your offering's rules (holding period, limits, who may hold)",
      run: async (s: Progress) => {
        const r = await deploy(net.id, s.account!, "OfferingRules", [rulesConfig(offeringRules!, asset, s.account!)]);
        return { ...s, rules: r.address, txs: [...s.txs, r.hash] };
      },
    }] : []),
    ...(isVault
      ? [{
          id: "vault",
          label: `Deploy the ${asset.symbol} fund vault (investors deposit ${net.stable?.symbol ?? "Test USD"} and receive shares)`,
          run: async (s: Progress) => {
            // Offering size in the payment token: total supply × price per token.
            const cap = parseUnits(asset.pricePerToken, payDecimals) * BigInt(asset.totalSupply);
            const r = await deploy(net.id, s.account!, "PermissionedVault", [{
              asset: s.payToken, name: asset.name, symbol: asset.symbol, admin: s.account, registry: s.registry,
              maxNavChangeBps: Math.round(Number(asset.details?.maxNavMovePct ?? 20) * 100), oracle: net.assetOracle?.address ?? "0x0000000000000000000000000000000000000000", depositCap: cap,
              rules: s.rules ?? ZERO_ADDR,
            }]);
            return { ...s, token: r.address, sale: r.address, txs: [...s.txs, r.hash] };
          },
        }]
      : []),
    ...(isMulti ? [{
      id: "token",
      label: `Deploy the ${asset.symbol} token (ERC-1155)`,
      run: async (s: Progress) => {
        const r = await deploy(net.id, s.account!, "PermissionedMultiToken", [{
          name: asset.name, symbol: asset.symbol, uri: `${location.origin}/api/meta/${asset.id}/{id}`,
          admin: s.account, registry: s.registry, documentURI: await documentURI(asset.id, asset.documents ?? []), rules: s.rules ?? ZERO_ADDR,
        }]);
        return { ...s, token: r.address, txs: [...s.txs, r.hash] };
      },
    },
    {
      id: "item",
      label: `Create the item: ${Number(asset.totalSupply).toLocaleString()} fractions, fixed for good`,
      run: async (s: Progress) => {
        const h = await send(net.id, s.account!, s.token!, TOK, "createItem", [ITEM_ID, BigInt(asset.totalSupply), ""]);
        return { ...s, txs: [...s.txs, h] };
      },
    },
    {
      id: "sale",
      label: "Deploy the sale (investors pay, fractions are issued)",
      run: async (s: Progress) => {
        const r = await deploy(net.id, s.account!, "PrimarySale1155", [{
          token: s.token, tokenId: ITEM_ID, payToken: s.payToken, treasury: treasury ?? s.account, admin: s.account,
          price: parseUnits(asset.pricePerToken, payDecimals), cap: BigInt(asset.totalSupply),
          minPurchase: parseUnits(asset.minInvestment || "0", payDecimals),
          startsAt: win.startsAt, endsAt: win.endsAt,
          feeRecipient: fee.recipient,
          feeBps: fee.bps,
          oracle: net.assetOracle?.address ?? "0x0000000000000000000000000000000000000000",
        }]);
        return { ...s, sale: r.address, txs: [...s.txs, r.hash] };
      },
    }] : []),
    ...(isNft ? [{
      id: "token",
      label: `Deploy the ${asset.symbol} token (ERC-721, ${Number(asset.totalSupply).toLocaleString()} NFTs at most)`,
      run: async (s: Progress) => {
        const r = await deploy(net.id, s.account!, "PermissionedNFT", [{
          name: asset.name, symbol: asset.symbol, baseURI: `${location.origin}/api/meta/${asset.id}/`,
          maxSupply: BigInt(asset.totalSupply), admin: s.account, registry: s.registry, documentURI: await documentURI(asset.id, asset.documents ?? []), rules: s.rules ?? ZERO_ADDR,
        }]);
        return { ...s, token: r.address, txs: [...s.txs, r.hash] };
      },
    },
    {
      id: "sale",
      label: "Deploy the sale (investors pay, NFTs are issued in order)",
      run: async (s: Progress) => {
        const r = await deploy(net.id, s.account!, "PrimarySale721", [{
          token: s.token, payToken: s.payToken, treasury: treasury ?? s.account, admin: s.account,
          price: parseUnits(asset.pricePerToken, payDecimals), cap: BigInt(asset.totalSupply),
          minPurchase: parseUnits(asset.minInvestment || "0", payDecimals),
          startsAt: win.startsAt, endsAt: win.endsAt,
          feeRecipient: fee.recipient,
          feeBps: fee.bps,
          oracle: net.assetOracle?.address ?? "0x0000000000000000000000000000000000000000",
        }]);
        return { ...s, sale: r.address, txs: [...s.txs, r.hash] };
      },
    }] : []),
    ...(isVault || isMulti || isNft || isTrex ? [] : [{
      id: "token",
      label: `Deploy the ${asset.symbol} token`,
      run: async (s: Progress) => {
        const r = await deploy(net.id, s.account!, "PermissionedToken", [{
          name: asset.name, symbol: asset.symbol, decimals: 18, maxSupply: BigInt(asset.totalSupply) * 10n ** 18n,
          admin: s.account, registry: s.registry, documentURI: await documentURI(asset.id, asset.documents ?? []), rules: s.rules ?? ZERO_ADDR,
        }]);
        return { ...s, token: r.address, txs: [...s.txs, r.hash] };
      },
    },
    {
      id: "sale",
      label: "Deploy the sale (investors pay, tokens are issued)",
      run: async (s: Progress) => {
        const r = await deploy(net.id, s.account!, "PrimarySale", [{
          token: s.token, payToken: s.payToken, treasury: treasury ?? s.account, admin: s.account,
          price: parseUnits(asset.pricePerToken, payDecimals), cap: BigInt(asset.totalSupply) * 10n ** 18n,
          minPurchase: parseUnits(asset.minInvestment || "0", payDecimals),
          startsAt: win.startsAt, endsAt: win.endsAt,
          feeRecipient: fee.recipient,
          feeBps: fee.bps,
          oracle: net.assetOracle?.address ?? "0x0000000000000000000000000000000000000000",
        }]);
        return { ...s, sale: r.address, txs: [...s.txs, r.hash] };
      },
    }]),
    ...(withRules ? [{
      id: "bind",
      label: "Connect the rules to your token (before anything is issued)",
      run: async (s: Progress) => {
        const h = await send(net.id, s.account!, s.rules!, RULES, "bindToken", [s.token]);
        return { ...s, txs: [...s.txs, h] };
      },
    }] : []),
    ...(isVault || isTrex ? [] : [{
      id: "minter",
      label: "Allow the sale to issue tokens",
      run: async (s: Progress) => {
        const h = await send(net.id, s.account!, s.token!, TOK, "grantRole", [ROLE("MINTER_ROLE"), s.sale]);
        return { ...s, txs: [...s.txs, h] };
      },
    }]),
    ...(net.assetOracle
      ? [{
          id: "proof",
          label: `Register for proof of asset (${proofKinds.length} independent checks; sales open once they're signed)`,
          run: async (s: Progress) => {
            const h = await send(net.id, s.account!, net.assetOracle!.address, ART.AssetOracle.abi, "register", [s.token, classHash(asset.assetClass), proofKinds.map(kindHash)]);
            return { ...s, txs: [...s.txs, h] };
          },
        }]
      : []),
    ...(net.testnet
      ? []
      : [{
          id: "handover",
          label: "Hand admin control to your treasury multisig (several wallet confirmations)",
          run: async (s: Progress) => {
            const me = s.account!;
            const txs = [...s.txs];
            const tx = async (addr: Address, abi: any, fn: string, args: unknown[]) => txs.push(await send(net.id, me, addr, abi, fn, args));
            if (s.rules) {
              await tx(s.rules, RULES, "grantRole", [ROLES.ADMIN, treasury]);
              await tx(s.rules, RULES, "grantRole", [ROLE("APPROVER_ROLE"), treasury]);
              await tx(s.rules, RULES, "renounceRole", [ROLE("APPROVER_ROLE"), me]);
              await tx(s.rules, RULES, "renounceRole", [ROLES.ADMIN, me]);
            }
            if (isVault) {
              const V = ART.PermissionedVault.abi;
              await tx(s.token!, V, "grantRole", [ROLES.ADMIN, treasury]);
              for (const r of ["MANAGER_ROLE", "PAUSER_ROLE"]) await tx(s.token!, V, "grantRole", [ROLE(r), treasury]);
              if (!existingRegistry) await tx(s.registry!, ART.InvestorRegistry.abi, "grantRole", [ROLES.ADMIN, treasury]);
              for (const r of ["MANAGER_ROLE", "PAUSER_ROLE"]) await tx(s.token!, V, "renounceRole", [ROLE(r), me]);
              await tx(s.token!, V, "renounceRole", [ROLES.ADMIN, me]);
              if (!existingRegistry) await tx(s.registry!, ART.InvestorRegistry.abi, "renounceRole", [ROLES.ADMIN, me]);
              return { ...s, txs };
            }
            await tx(s.token!, TOK, "grantRole", [ROLES.ADMIN, treasury]);
            await tx(s.sale!, SALE, "grantRole", [ROLES.ADMIN, treasury]);
            if (!existingRegistry) await tx(s.registry!, ART.InvestorRegistry.abi, "grantRole", [ROLES.ADMIN, treasury]);
            for (const r of ["MINTER_ROLE", "ENFORCER_ROLE", "PAUSER_ROLE"]) await tx(s.token!, TOK, "renounceRole", [ROLE(r), me]);
            await tx(s.token!, TOK, "renounceRole", [ROLES.ADMIN, me]);
            await tx(s.sale!, SALE, "renounceRole", [ROLES.ADMIN, me]);
            if (!existingRegistry) await tx(s.registry!, ART.InvestorRegistry.abi, "renounceRole", [ROLES.ADMIN, me]);
            return { ...s, txs };
          },
        }]),
    ...(net.testnet
      ? []
      : [{
          id: "fee",
          label: `Pay the $${offeringFee.toLocaleString()} offering fee in ${net.stable?.symbol ?? "stablecoin"} (${tenant.plan.name} plan)`,
          run: async (s: Progress) => {
            const h = await send(net.id, s.account!, net.stable!.address, ART.TestUSD.abi, "transfer", [platformSafe, parseUnits(String(offeringFee), net.stable!.decimals)]);
            return { ...s, feeTx: h, txs: [...s.txs, h] };
          },
        }]),
    {
      id: "record",
      label: "Verify everything on chain and mark the asset as deployed",
      run: async (s) => {
        const a = await api.recordDeployment(asset.id, { registry: s.registry!, token: s.token!, sale: s.sale!, payToken: s.payToken!, rules: s.rules, txs: s.txs, feeTx: s.feeTx });
        onDone(a);
        return s;
      },
    },
  ];

  async function runAll() {
    setErr("");
    let s = p;
    for (const step of steps) {
      if (s.done.includes(step.id) && step.id !== "connect") continue;
      setRunning(step.id);
      try {
        s = await step.run(s);
        s = { ...s, done: [...new Set([...s.done, step.id])] };
        save(s);
      } catch (e) {
        setErr(walletError(e));
        setRunning(null);
        return;
      }
    }
    setRunning(null);
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="panel">
      <h3>Deploy to {net.name}{net.testnet ? " (testnet)" : ""}</h3>
      <p className="muted" style={{ fontSize: 14 }}>
        Your wallet signs each step and pays the network fee in {net.native.symbol}. If a step fails, fix the cause and press the button again: finished steps are skipped.
        {net.note && <> {net.note}</>}
      </p>
      <div className="notice">
        {net.testnet
          ? "Testnets are free."
          : `Platform fee: a flat $${offeringFee.toLocaleString()} for this offering on your ${tenant.plan.name} plan, paid in ${net.stable?.symbol ?? "stablecoin"} during deployment. No percentage is taken from your raise.`}
        {isTrex
          ? ` Every wallet is screened against the OFAC list${net.sanctionsOracle ? " and Chainalysis' sanctions oracle" : ""} before its KYC claim is filed.`
          : net.sanctionsOracle ? " Sanctioned wallets are blocked on chain by Chainalysis' sanctions oracle." : " Sanctioned wallets are screened against the OFAC list before verification."}
      </div>
      {!net.testnet && <div className="notice">Mainnet: admin control moves to your treasury multisig at the end, so your wallet keeps no special rights over the token.</div>}
      {!treasury && net.testnet && <div className="notice">No treasury set yet, so practice proceeds will go to your connected wallet.</div>}
      {blockers.map((b) => <div className="notice err" key={b}>{b}</div>)}
      {isTrex && (
        <>
          <UpgradeChoice value={upgrade} onChange={setUpgrade} disabled={p.done.includes("trex-upgrades") || !!running} />
          <div className="notice">ERC-3643 uses the audited T-REX standard. The platform deploys the suite at no cost to you; your wallet owns every part of it. Transfers between investors start paused; buying from your sale works straight away.</div>
        </>
      )}
      <div style={{ maxWidth: 320 }}><Connect chainId={net.id} /></div>
      <div>
        {steps.map((s, i) => {
          const done = p.done.includes(s.id);
          return (
            <div key={s.id} className={`setup-step ${done ? "done" : ""} ${running === s.id ? "next" : ""}`}>
              <span className="c">{done ? "✓" : i + 1}</span>
              <div className="t"><b style={done ? { textDecoration: "none" } : undefined}>{s.label}</b>{running === s.id && <small>Confirm in your wallet, then wait for the network…</small>}</div>
            </div>
          );
        })}
      </div>
      {p.txs.length > 0 && (
        <details>
          <summary className="muted" style={{ fontSize: 13, cursor: "pointer" }}>{p.txs.length} transaction(s)</summary>
          {p.txs.map((h) => <div key={h}><a href={txUrl(net, h)} target="_blank" rel="noreferrer" style={{ fontFamily: "monospace", fontSize: 12 }}>{h}</a></div>)}
        </details>
      )}
      {err && <div className="notice err">{err}</div>}
      <button className="btn primary" disabled={!!running || blockers.length > 0} onClick={runAll} style={{ alignSelf: "flex-start" }}>
        {running ? "Deploying…" : p.done.length ? "Continue deployment" : `Deploy to ${net.name}`}
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ listing

function ListingPanel({ asset, onSaved }: { asset: Asset; onSaved: (a: Asset) => void }) {
  const [f, setF] = useState({ description: asset.description ?? "", imageUrl: asset.imageUrl ?? "", location: asset.location ?? "", listed: !!asset.listed });
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const deployed = asset.status === "deployed";

  async function saveListing() {
    setMsg(null);
    try {
      const a = await api.updateAsset(asset.id, f);
      onSaved(a);
      setMsg({ kind: "ok", text: f.listed ? "Saved. It's live on your marketplace." : "Saved." });
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    }
  }

  return (
    <div className="panel">
      <h3>Marketplace listing</h3>
      <p className="muted" style={{ fontSize: 14 }}>What investors see on your marketplace. Describe the asset, where it is, how it earns, and the key risks.</p>
      <label className="field">Description<textarea className="input" rows={5} maxLength={4000} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
      <div className="form3" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <label className="field">Image URL (https)<input className="input" value={f.imageUrl} placeholder="https://…" onChange={(e) => setF({ ...f, imageUrl: e.target.value })} /></label>
        <label className="field">Location<input className="input" value={f.location} maxLength={120} placeholder="Austin, TX" onChange={(e) => setF({ ...f, location: e.target.value })} /></label>
      </div>
      <div className="toggle">
        <span>Show on the marketplace {!deployed && <span className="muted">(deploy first)</span>}</span>
        <div className={`tg ${f.listed ? "" : "off"}`} style={!deployed ? { opacity: 0.4, cursor: "not-allowed" } : undefined} onClick={() => deployed && setF({ ...f, listed: !f.listed })} />
      </div>
      {msg && <div className={`notice ${msg.kind}`}>{msg.text}</div>}
      <button className="btn primary sm" onClick={saveListing} style={{ alignSelf: "flex-start" }}>Save listing</button>
    </div>
  );
}

// ------------------------------------------------------------------ investors

export function InvestorsPanel({ asset, net, prefill }: { asset: Asset; net: Network; prefill?: { wallet: string; n: number } | null }) {
  const dep = asset.deployment!;
  const [wallet, setWallet] = useState("");
  useEffect(() => { if (prefill) setWallet(prefill.wallet); }, [prefill]);
  const [country, setCountry] = useState("840");
  const [accredited, setAccredited] = useState(true);
  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const valid = /^0x[0-9a-fA-F]{40}$/.test(wallet);

  async function check() {
    setStatus("");
    const pc = publicClientFor(net.id);
    const ok = await pc.readContract({ address: dep.registry, abi: ART.InvestorRegistry.abi, functionName: "isVerified", args: [wallet] });
    if (!ok) return setStatus("Not verified yet (or the approval has expired).");
    const holds = dep.rules ? await pc.readContract({ address: dep.rules, abi: ART.OfferingRules.abi, functionName: "canHold", args: [wallet] }) : true;
    setStatus(holds ? "✓ Verified: this wallet can buy and hold the token." : "Verified on your registry, but this offering's rules don't allow it (accreditation or country).");
  }

  async function verify() {
    setBusy(true);
    setStatus("");
    try {
      if (isSanctioned(Number(country))) throw new Error("Investors from sanctioned countries can't be approved.");
      const id = await api.identity(wallet, net.id);
      if (id.required && !id.passed) throw new Error("This wallet hasn't passed an identity check with you. Send the investor to the offering page to verify first.");
      const scr = await api.screen(wallet, net.id);
      if (scr.sanctioned) throw new Error("This wallet is on a sanctions list (OFAC). It can't be verified.");
      const me = await connectWallet();
      await ensureChain(net.id);
      // Approvals lapse after the offering's approval period (wizard step 5); 0 = never.
      const days = asset.rules?.approvalDays ?? 0;
      const expiresAt = days ? BigInt(Math.floor(Date.now() / 1000) + days * 86_400) : 0n;
      const h = await send(net.id, me, dep.registry, ART.InvestorRegistry.abi, "setInvestor", [wallet, accredited, Number(country), expiresAt]);
      setStatus(`✓ Verified${days ? ` until ${new Date(Number(expiresAt) * 1000).toLocaleDateString()}` : ""}. Transaction ${h.slice(0, 10)}…`);
    } catch (e) {
      setStatus(walletError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel" id="investors">
      <h3>Investors</h3>
      <p className="muted" style={{ fontSize: 14 }}>
        {net.testnet
          ? "Test network: approve any wallet for practice."
          : "Approve wallets that passed an identity check on the offering page."} Only approved wallets can buy, receive or send the token.
      </p>
      <div style={{ maxWidth: 320 }}><Connect chainId={net.id} /></div>
      <div className="form3">
        <label className="field">Investor wallet<input className="input" value={wallet} placeholder="0x… full address" onChange={(e) => setWallet(e.target.value.trim())} /></label>
        <label className="field">Country of residence
          <select className="input" value={country} onChange={(e) => setCountry(e.target.value)}>
            {OPEN_COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
          </select>
        </label>
        <label className="field">Accredited
          <select className="input" value={accredited ? "y" : "n"} onChange={(e) => setAccredited(e.target.value === "y")}><option value="y">Yes</option><option value="n">No</option></select>
        </label>
      </div>
      {asset.rules?.accreditedOnly && <div className="notice">This offering is for accredited investors only: the token refuses wallets marked "No". Check the accreditation panel above first.</div>}
      {status && <div className="notice">{status}</div>}
      <div className="row">
        <button className="btn primary sm" disabled={!valid || busy} onClick={verify}>{busy ? "Confirm in wallet…" : "Verify investor"}</button>
        <button className="btn ghost sm" disabled={!valid} onClick={() => check().catch((e) => setStatus(walletError(e)))}>Check status</button>
      </div>
    </div>
  );
}
