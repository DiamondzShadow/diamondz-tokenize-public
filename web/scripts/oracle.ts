// Platform admin for the proof-of-asset AssetOracle. READ-ONLY by default; pass --execute to send transactions.
//
//   bun scripts/oracle.ts status          --chain 84532
//   bun scripts/oracle.ts deploy          --chain 84532 [--admin 0xSafe] [--execute]
//   bun scripts/oracle.ts configure       --chain 84532 [--execute]          (re-apply kinds + class checklists)
//   bun scripts/oracle.ts add-verifier    --chain 84532 --address 0x.. --name "Acme Title Co." --kinds TITLE,INSURANCE [--execute]
//   bun scripts/oracle.ts remove-verifier --chain 84532 --address 0x.. [--execute]
//   bun scripts/oracle.ts deploy-distributor --chain 84532 --fee 25 [--fee-recipient 0xSafe] [--admin 0xSafe] [--execute]
//       Deploys the platform payout contract and enables the network's stablecoin with a FLAT fee per payout (USD).
//       Testnets without a stablecoin: add --stable 0x.. (the platform Test USD from deploy-testusd).
//   bun scripts/oracle.ts deploy-testusd  --chain 46630 [--execute]     (testnet only, network must have no stablecoin)
//   bun scripts/oracle.ts deploy-feed     --chain 84532 [--simulation] [--kinds NAV,REGISTRY] [--execute]
//   bun scripts/oracle.ts stellar-anchor  --chain 84532 --network testnet --contract C… --class real-estate [--execute]
//       Deploys CreAssetFeed (Chainlink CRE receiver) and approves it on the AssetOracle as a verifier for --kinds.
//       --simulation trusts Chainlink's MockKeystoneForwarder (for `cre workflow simulate --broadcast`) instead of
//       the production KeystoneForwarder. Forwarders verified against docs.chain.link forwarder directory 2026-11-17.
//
// Signs with $PRIVATE_KEY (only read with --execute). When the signer isn't the oracle admin (e.g. mainnet, where the
// platform Safe is admin) it prints the calls as Safe transaction data instead of sending them.
// RPC_<chainId> overrides the network's public RPC.
import {
  createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, isAddress, type Abi, type Address, type Hex,
} from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import artifacts from "../src/contracts/artifacts.json";
import { networkById } from "../src/lib/chains";
import { rpcUrl } from "../../api/src/chains";
import { CHECK_KINDS, CLASS_CHECKS, classHash, kindHash, maxValiditySeconds, type CheckKindId } from "../src/lib/verification";
import type { AssetClassId } from "../src/lib/catalog";

const ART = (artifacts as any).AssetOracle as { abi: Abi; bytecode: Hex };
// KeystoneForwarder (production) and MockKeystoneForwarder (simulation broadcast), per chain id.
const FORWARDERS: Record<number, { prod: Address; sim: Address }> = {
  8453: { prod: "0xF8344CFd5c43616a4366C34E3EEE75af79a74482", sim: "0x5e342a8438b4f5d39e72875fcee6f76b39cce548" },
  42161: { prod: "0xF8344CFd5c43616a4366C34E3EEE75af79a74482", sim: "0xd770499057619c9a76205fd4168161cf94abc532" },
  84532: { prod: "0xF8344CFd5c43616a4366C34E3EEE75af79a74482", sim: "0x82300bd7c3958625581cc2f77bc6464dcecdf3e5" },
  421614: { prod: "0x76c9cf548b4179F8901cda1f8623568b58215E62", sim: "0xd41263567ddfead91504199b8c6c87371e83ca5d" },
};
const ADMIN_ROLE = `0x${"0".repeat(64)}` as Hex;

// ---- args (explicit parsing; never positional-shift tricks)
const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
};
const EXECUTE = flag("execute");
const chainId = Number(opt("chain"));
const net = networkById(chainId);
if (!cmd || !net) {
  console.error("usage: bun scripts/oracle.ts <status|deploy|configure|add-verifier|remove-verifier> --chain <id> [...] [--execute]");
  process.exit(1);
}
// Same RPC as the API: RPC_<chainId> override → Uniblock (UNIBLOCK_API_KEY) → public.
const rpc = rpcUrl(net);
const chain = { id: net.id, name: net.name, nativeCurrency: net.native, rpcUrls: { default: { http: [rpc] } } } as const;
const pc = createPublicClient({ chain, transport: http(rpc) });

function signer() {
  const k = process.env.PRIVATE_KEY;
  if (!k) throw new Error("PRIVATE_KEY is not set (needed only with --execute)");
  // Local nonce tracking (same as api/src/trex.ts): load-balanced public RPCs can return a just-used nonce from a lagging
  // node ("nonce too low"), which broke the first Avalanche Fuji run on 2026-11-27.
  return privateKeyToAccount((k.startsWith("0x") ? k : `0x${k}`) as Hex, { nonceManager });
}

type Call = { to: Address; fn: string; args: unknown[]; why: string };

async function run(calls: Call[], oracle: Address) {
  const data = calls.map((c) => ({ ...c, data: encodeFunctionData({ abi: ART.abi, functionName: c.fn, args: c.args }) }));
  if (!EXECUTE) {
    console.log(`\nDRY RUN on ${net!.name}: ${calls.length} call(s) to ${oracle}. Nothing was sent. Re-run with --execute to send.`);
    for (const c of data) console.log(`  - ${c.why}\n    ${c.fn}  data=${c.data.slice(0, 74)}…`);
    return;
  }
  const acct = signer();
  const isAdmin = await pc.readContract({ address: oracle, abi: ART.abi, functionName: "hasRole", args: [ADMIN_ROLE, acct.address] });
  if (!isAdmin) {
    console.log(`\n${acct.address} is not the oracle admin on ${net!.name}. Propose these in the admin Safe (Transaction Builder):`);
    for (const c of data) console.log(JSON.stringify({ to: c.to, value: "0", data: c.data, note: c.why }));
    return;
  }
  const wc = createWalletClient({ account: acct, chain, transport: http(rpc) });
  for (const c of data) {
    const hash = await wc.sendTransaction({ to: c.to, data: c.data });
    const r = await pc.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${c.fn} failed: ${hash}`);
    console.log(`  ✓ ${c.why}  ${net!.explorer}/tx/${hash}`);
  }
}

function configureCalls(oracle: Address): Call[] {
  const calls: Call[] = [];
  for (const k of Object.keys(CHECK_KINDS) as CheckKindId[]) {
    calls.push({ to: oracle, fn: "setMaxValidity", args: [kindHash(k), BigInt(maxValiditySeconds(k))], why: `enable ${k} (valid up to ${CHECK_KINDS[k].maxDays} days)` });
  }
  for (const [cls, kinds] of Object.entries(CLASS_CHECKS) as [AssetClassId, CheckKindId[]][]) {
    calls.push({ to: oracle, fn: "setClassRequirements", args: [classHash(cls), kinds.map(kindHash)], why: `${cls} requires ${kinds.join(", ")}` });
  }
  return calls;
}

function needOracle(): Address {
  const a = opt("oracle") ?? net!.assetOracle?.address;
  if (!a || !isAddress(a)) throw new Error(`No AssetOracle configured for ${net!.name}. Deploy first, or pass --oracle 0x…`);
  return getAddress(a);
}

if (cmd === "whoami") {
  // Prints only the signer's public address and balance (never the key).
  const a = signer().address;
  console.log(`${a} balance ${(await pc.getBalance({ address: a })).toString()} wei on ${net.name}`);
} else if (cmd === "deploy-distributor") {
  const fee = opt("fee") ?? "25";
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(fee)) throw new Error("--fee <USD per payout>, e.g. 25");
  // --stable 0x.. (testnets only): use a platform Test USD that isn't in chains.ts yet (e.g. RH testnet).
  const stableOpt = opt("stable");
  if (stableOpt && !net.testnet) throw new Error("--stable is for testnets only; mainnets use the stablecoin in chains.ts");
  let stable = net.stable;
  if (stableOpt) {
    if (!isAddress(stableOpt)) throw new Error("--stable must be an address");
    const T = (artifacts as any).TestUSD as { abi: Abi };
    const address = getAddress(stableOpt);
    const [symbol, decimals] = await Promise.all([
      pc.readContract({ address, abi: T.abi, functionName: "symbol" }) as Promise<string>,
      pc.readContract({ address, abi: T.abi, functionName: "decimals" }) as Promise<number>,
    ]);
    stable = { address, symbol, decimals: Number(decimals) };
  }
  if (!stable) throw new Error(`${net.name} has no default stablecoin configured (testnets: pass --stable 0x..)`);
  const admin = opt("admin");
  const feeRecipient = opt("fee-recipient");
  if (!net.testnet && (!admin || !feeRecipient)) throw new Error("Mainnet: pass --admin and --fee-recipient (the platform Safe on this network)");
  if (!EXECUTE) {
    console.log(`DRY RUN: would deploy Distributor on ${net.name}, enable ${stable.symbol} ${stable.address} with a flat fee of $${fee} per payout${admin ? `, then hand admin to ${admin}` : " (deployer stays admin: testnet)"}. Re-run with --execute.`);
    process.exit(0);
  }
  const D = (artifacts as any).Distributor as { abi: Abi; bytecode: Hex };
  const acct = signer();
  const wc = createWalletClient({ account: acct, chain, transport: http(rpc) });
  const hash = await wc.deployContract({ abi: D.abi, bytecode: D.bytecode, args: [acct.address, feeRecipient ? getAddress(feeRecipient) : acct.address] });
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`deploy failed: ${hash}`);
  const dist = getAddress(r.contractAddress);
  console.log(`✓ Distributor ${dist} (block ${r.blockNumber})  ${net.explorer}/tx/${hash}`);
  const feeUnits = BigInt(Math.round(Number(fee) * 100)) * 10n ** BigInt(stable.decimals) / 100n;
  const send = async (fn: string, args: unknown[], why: string) => {
    const h = await wc.writeContract({ address: dist, abi: D.abi, functionName: fn, args });
    const rr = await pc.waitForTransactionReceipt({ hash: h });
    if (rr.status !== "success") throw new Error(`${fn} failed: ${h}`);
    console.log(`  ✓ ${why}  ${net.explorer}/tx/${h}`);
  };
  await send("setPayoutToken", [stable.address, true, feeUnits], `enable ${stable.symbol} payouts, flat fee $${fee}`);
  if (admin) {
    await send("grantRole", [ADMIN_ROLE, getAddress(admin)], `make ${admin} admin`);
    await send("renounceRole", [ADMIN_ROLE, acct.address], "deployer gives up admin");
  }
  console.log(`\nAdd to ${net.name} in web/src/lib/chains.ts:\n  distributor: { address: "${dist}", fromBlock: ${r.blockNumber} },`);
} else if (cmd === "deploy-testusd") {
  // TESTNET ONLY: one shared platform Test USD (6 decimals, anyone may mint up to 100k per call) for networks
  // without a real stablecoin, used for practice purchases AND payouts.
  if (!net.testnet) throw new Error("Test USD is never deployed on a mainnet");
  if (net.stable) throw new Error(`${net.name} already has ${net.stable.symbol} ${net.stable.address} in chains.ts`);
  if (!EXECUTE) {
    console.log(`DRY RUN: would deploy the platform Test USD on ${net.name}. Re-run with --execute.`);
    process.exit(0);
  }
  const T = (artifacts as any).TestUSD as { abi: Abi; bytecode: Hex };
  const wc = createWalletClient({ account: signer(), chain, transport: http(rpc) });
  const hash = await wc.deployContract({ abi: T.abi, bytecode: T.bytecode, args: [] });
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`deploy failed: ${hash}`);
  const a = getAddress(r.contractAddress);
  console.log(`✓ TestUSD ${a} (block ${r.blockNumber})  ${net.explorer}/tx/${hash}`);
  console.log(`\nAdd to ${net.name} in web/src/lib/chains.ts:\n  stable: { address: "${a}", symbol: "tUSD", decimals: 6 },`);
} else if (cmd === "payout-fee") {
  // Change the flat per-payout fee for the network's stablecoin on the platform payout contract.
  const fee = opt("fee");
  if (!fee || !/^\d{1,5}(\.\d{1,2})?$/.test(fee)) throw new Error("--fee <USD per payout>, e.g. 0 or 25");
  const dist = (opt("distributor") ?? net.distributor?.address) as Address | undefined;
  if (!dist || !isAddress(dist)) throw new Error(`No payout contract configured for ${net.name}`);
  const stable = net.stable;
  if (!stable) throw new Error(`${net.name} has no default stablecoin configured`);
  const D = (artifacts as any).Distributor as { abi: Abi };
  const units = (BigInt(Math.round(Number(fee) * 100)) * 10n ** BigInt(stable.decimals)) / 100n;
  const data = encodeFunctionData({ abi: D.abi, functionName: "setPayoutToken", args: [stable.address, true, units] });
  if (!EXECUTE) {
    console.log(`DRY RUN: would set the flat payout fee on ${dist} (${net.name}) to $${fee} in ${stable.symbol}. Re-run with --execute.`);
    process.exit(0);
  }
  const acct = signer();
  const wc = createWalletClient({ account: acct, chain, transport: http(rpc) });
  const h = await wc.sendTransaction({ to: getAddress(dist), data });
  const r = await pc.waitForTransactionReceipt({ hash: h });
  if (r.status !== "success") throw new Error(`setPayoutToken failed: ${h}`);
  console.log(`  ✓ payout fee is now $${fee} per payout on ${net.name}  ${net.explorer}/tx/${h}`);
} else if (cmd === "fund") {
  // Testnet only: send gas money to a test wallet (e.g. a practice verifier).
  if (!net.testnet) throw new Error("fund is testnet-only");
  const to = opt("address");
  const eth = opt("eth") ?? "0.003";
  if (!to || !isAddress(to)) throw new Error("--address required");
  // Cap in the network's own gas token: 0.02 ETH-class; USDC (Arc) and XRP gas tokens are worth ~$1, so allow up to 5.
  const cap = net.native.symbol === "USDC" || net.native.symbol === "XRP" ? 5 : 0.02;
  if (!/^\d+(\.\d{1,6})?$/.test(eth) || Number(eth) <= 0 || Number(eth) > cap) throw new Error(`--eth must be a small amount ≤ ${cap} ${net.native.symbol}`);
  if (!EXECUTE) {
    console.log(`DRY RUN: would send ${eth} ${net.native.symbol} to ${to} on ${net.name}. Re-run with --execute.`);
    process.exit(0);
  }
  const acct = signer();
  const wc = createWalletClient({ account: acct, chain, transport: http(rpc) });
  const hash = await wc.sendTransaction({ to: getAddress(to), value: BigInt(Math.round(Number(eth) * 1e6)) * 10n ** 12n });
  await pc.waitForTransactionReceipt({ hash });
  console.log(`  ✓ sent ${eth} ${net.native.symbol} to ${to}  ${net.explorer}/tx/${hash}`);
} else if (cmd === "status") {
  const oracle = needOracle();
  console.log(`AssetOracle ${oracle} on ${net.name}`);
  for (const [cls, kinds] of Object.entries(CLASS_CHECKS) as [AssetClassId, CheckKindId[]][]) {
    const onchain = (await pc.readContract({ address: oracle, abi: ART.abi, functionName: "classRequirements", args: [classHash(cls)] })) as Hex[];
    const ok = onchain.length === kinds.length && kinds.every((k) => onchain.includes(kindHash(k)));
    console.log(`  ${ok ? "✓" : "✗"} ${cls}: ${kinds.join(", ")}${ok ? "" : `  (on chain: ${onchain.length} kinds; run configure)`}`);
  }
} else if (cmd === "deploy") {
  const admin = opt("admin");
  if (admin && !isAddress(admin)) throw new Error("--admin must be an address");
  if (!net.testnet && !admin) throw new Error("Mainnet: pass --admin <platform Safe on this network>; the deployer must not stay admin");
  if (!EXECUTE) {
    console.log(`DRY RUN: would deploy AssetOracle on ${net.name}, configure ${Object.keys(CHECK_KINDS).length} check kinds and ${Object.keys(CLASS_CHECKS).length} asset classes${admin ? `, then hand admin to ${admin} and renounce the deployer` : " (deployer stays admin: testnet)"}. Re-run with --execute.`);
    process.exit(0);
  }
  const acct = signer();
  const wc = createWalletClient({ account: acct, chain, transport: http(rpc) });
  const hash = await wc.deployContract({ abi: ART.abi, bytecode: ART.bytecode, args: [acct.address] });
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`deploy failed: ${hash}`);
  const oracle = getAddress(r.contractAddress);
  console.log(`✓ AssetOracle ${oracle} (block ${r.blockNumber})  ${net.explorer}/tx/${hash}`);
  await run(configureCalls(oracle), oracle);
  if (admin) {
    await run([
      { to: oracle, fn: "grantRole", args: [ADMIN_ROLE, getAddress(admin)], why: `make ${admin} admin` },
      { to: oracle, fn: "renounceRole", args: [ADMIN_ROLE, acct.address], why: "deployer gives up admin" },
    ], oracle);
  }
  console.log(`\nAdd to ${net.name} in web/src/lib/chains.ts:\n  assetOracle: { address: "${oracle}", fromBlock: ${r.blockNumber} },`);
} else if (cmd === "configure") {
  // --only <class>: just that class's requirements (e.g. a newly added asset class)
  const oracle = needOracle();
  const only = opt("only");
  const calls = configureCalls(oracle).filter((c) => !only || (c.fn === "setClassRequirements" && c.args[0] === classHash(only as AssetClassId)));
  if (only && !calls.length) throw new Error(`--only must be one of ${Object.keys(CLASS_CHECKS).join(", ")}`);
  await run(calls, oracle);
} else if (cmd === "add-verifier" || cmd === "remove-verifier") {
  const oracle = needOracle();
  const who = opt("address");
  if (!who || !isAddress(who)) throw new Error("--address required");
  const v = getAddress(who);
  if (cmd === "remove-verifier") {
    const [, name] = (await pc.readContract({ address: oracle, abi: ART.abi, functionName: "verifiers", args: [v] })) as [boolean, string];
    await run([{ to: oracle, fn: "setVerifier", args: [v, false, name], why: `remove ${name || v} (voids all of its attestations)` }], oracle);
  } else {
    const name = opt("name");
    const kinds = (opt("kinds") ?? "").split(",").map((k) => k.trim().toUpperCase()).filter(Boolean) as CheckKindId[];
    if (!name) throw new Error('--name "Legal name" required');
    const bad = kinds.filter((k) => !CHECK_KINDS[k]);
    if (!kinds.length || bad.length) throw new Error(`--kinds must be a comma list of: ${Object.keys(CHECK_KINDS).join(", ")}`);
    await run([
      { to: oracle, fn: "setVerifier", args: [v, true, name], why: `approve ${name} (${v})` },
      ...kinds.map((k) => ({ to: oracle, fn: "setVerifierKind", args: [v, kindHash(k), true], why: `allow ${name} to sign ${k}` })),
    ], oracle);
  }
} else if (cmd === "deploy-feed") {
  const oracle = needOracle();
  const fw = FORWARDERS[chainId];
  if (!fw) throw new Error(`No Chainlink CRE forwarder known for ${net.name}`);
  const forwarder = flag("simulation") ? fw.sim : fw.prod;
  const kinds = (opt("kinds") ?? "NAV,REGISTRY").split(",").map((k) => k.trim().toUpperCase()) as CheckKindId[];
  const bad = kinds.filter((k) => !CHECK_KINDS[k]);
  if (bad.length) throw new Error(`unknown kinds: ${bad.join(", ")}`);
  if (!EXECUTE) {
    console.log(`DRY RUN: would deploy CreAssetFeed on ${net.name} trusting ${flag("simulation") ? "MockKeystoneForwarder" : "KeystoneForwarder"} ${forwarder}, then approve it on ${oracle} to sign ${kinds.join(", ")}. Re-run with --execute.`);
    process.exit(0);
  }
  const FEED = (await import("../../contracts/out/CreAssetFeed.sol/CreAssetFeed.json")).default as any;
  const acct = signer();
  const wc = createWalletClient({ account: acct, chain, transport: http(rpc) });
  const hash = await wc.deployContract({ abi: FEED.abi, bytecode: FEED.bytecode.object, args: [forwarder, oracle] });
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`deploy failed: ${hash}`);
  const feed = getAddress(r.contractAddress);
  console.log(`✓ CreAssetFeed ${feed} (owner ${acct.address})  ${net.explorer}/tx/${hash}`);
  await run([
    { to: oracle, fn: "setVerifier", args: [feed, true, "Chainlink CRE: Diamondz asset feeds"], why: "approve the CRE feed as a verifier" },
    ...kinds.map((k) => ({ to: oracle, fn: "setVerifierKind", args: [feed, kindHash(k), true], why: `allow the CRE feed to sign ${k}` })),
  ], oracle);
  console.log(`\nNext: set "receiver": "${feed}" in cre/asset-feeds/config.${net.testnet ? "staging" : "production"}.json, and after the workflow is deployed lock the feed to it:\n  setExpectedAuthor(<workflow owner>) + setExpectedWorkflowId(<workflow id>) on ${feed}.`);
} else if (cmd === "handover") {
  // Finish a deploy that stopped before its last step: make the platform Safe admin, then the signer renounces.
  //   bun scripts/oracle.ts handover --chain 42161 --oracle 0x… --admin 0xSafe [--execute]
  const oracle = needOracle();
  const admin = opt("admin");
  if (!admin || !isAddress(admin)) throw new Error("--admin <platform Safe> is required");
  if (!EXECUTE) {
    console.log(`DRY RUN: would grant admin on ${oracle} to ${admin}, then the signer renounces admin. Re-run with --execute.`);
    process.exit(0);
  }
  await run([
    { to: oracle, fn: "grantRole", args: [ADMIN_ROLE, getAddress(admin)], why: `make ${admin} admin` },
    { to: oracle, fn: "renounceRole", args: [ADMIN_ROLE, signer().address], why: "deployer gives up admin" },
  ], oracle);
} else if (cmd === "stellar-anchor") {
  // EVM identity for a Stellar (Soroban) offering: deploy StellarAssetAnchor (owner = signer = issuer), then register
  // it on the oracle with the class checklist + REGISTRY, which the CRE feed fills from Stellar RPC.
  //   bun scripts/oracle.ts stellar-anchor --chain 84532 --network testnet --contract C… --class real-estate [--execute]
  const oracle = needOracle();
  const stellarNet = opt("network");
  const contract = opt("contract");
  const cls = (opt("class") ?? "") as AssetClassId;
  if (stellarNet !== "testnet" && stellarNet !== "mainnet") throw new Error("--network testnet|mainnet");
  if (!contract || !/^C[A-Z2-7]{55}$/.test(contract)) throw new Error("--contract must be a Soroban contract id (C…, 56 chars)");
  if (!CLASS_CHECKS[cls]) throw new Error(`--class must be one of ${Object.keys(CLASS_CHECKS).join(", ")}`);
  const kinds = [...new Set([...CLASS_CHECKS[cls], "REGISTRY" as CheckKindId])];
  if (!EXECUTE) {
    console.log(`DRY RUN: would deploy StellarAssetAnchor(${stellarNet}, ${contract}) on ${net.name}, owned by the signer, then register it on ${oracle} as ${cls} requiring ${kinds.join(", ")}. Re-run with --execute.`);
    process.exit(0);
  }
  const ANCHOR = (await import("../../contracts/out/StellarAssetAnchor.sol/StellarAssetAnchor.json")).default as any;
  const acct = signer();
  const wc = createWalletClient({ account: acct, chain, transport: http(rpc) });
  const hash = await wc.deployContract({ abi: ANCHOR.abi, bytecode: ANCHOR.bytecode.object, args: [stellarNet, contract, acct.address] });
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`deploy failed: ${hash}`);
  const anchor = getAddress(r.contractAddress);
  console.log(`✓ StellarAssetAnchor ${anchor} for ${stellarNet}:${contract} (owner ${acct.address})  ${net.explorer}/tx/${hash}`);
  const reg = await wc.writeContract({ address: oracle, abi: ART.abi, functionName: "register", args: [anchor, classHash(cls), kinds.map(kindHash)] });
  const rr = await pc.waitForTransactionReceipt({ hash: reg });
  if (rr.status !== "success") throw new Error(`register failed: ${reg}`);
  console.log(`✓ registered as ${cls} requiring ${kinds.join(", ")}  ${net.explorer}/tx/${reg}`);
  console.log(`\nNext: set "anchor": "${anchor}" on this token in cre/asset-feeds/config.${net.testnet ? "staging" : "production"}.json.`);
} else {
  console.error(`unknown command ${cmd}`);
  process.exit(1);
}
