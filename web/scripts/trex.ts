// ERC-3643 platform core admin (T-REX 4.1.6 / OnchainID 2.2.1). READ-ONLY by default; pass --execute to send.
//
//   bun scripts/trex.ts status       --chain 84532                    what's deployed + who owns it
//   bun scripts/trex.ts deploy-core  --chain 84532 [--execute]        per-chain core, signed by the T-REX relayer
//   bun scripts/trex.ts deploy-core  --chain 42161 --ia-owner <Safe> [--execute]   real network (2026-11-20)
//
// Signs with $TREX_RELAYER_KEY. Testnets: the relayer owns the factory, reference authority and identity factory.
// Real networks: the relayer keeps the factory and identity factory (both are owner-only and the platform uses them
// to create each offering's suite and each investor's identity), and the REFERENCE IMPLEMENTATION AUTHORITY (the
// upgrade power over offerings that don't take their own) goes to the platform Safe given by --ia-owner, which must
// be a contract. The per-chain OfferingRulesModule is deployed too. RPC_<chainId> overrides the RPC (forks).
// TREX_<chainId>=<json> points `status` at a core that isn't in chains.ts yet.
import { getAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { networkById } from "../src/lib/chains";
import { TREX_ARTIFACTS as T, deployCore, ensureRulesModule, publicFor, walletFor } from "../../api/src/trex";
import { trexFor } from "../../api/src/chains";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
};
const net = networkById(Number(opt("chain")));
if (!cmd || !net) {
  console.error("usage: bun scripts/trex.ts <status|deploy-core> --chain <id> [--execute]");
  process.exit(1);
}
const pc = publicFor(net);
const key = () => {
  const k = process.env.TREX_RELAYER_KEY;
  if (!k) throw new Error("TREX_RELAYER_KEY is not set");
  return k;
};

if (cmd === "status") {
  const core = trexFor(net);
  if (!core) {
    console.log(`No ERC-3643 core on ${net.name} yet.`);
  } else {
    const owner = (a: Address, n: string) => pc.readContract({ address: a, abi: T[n].abi, functionName: "owner" }) as Promise<string>;
    console.log(`${net.name} ERC-3643 core`);
    console.log(`  TREXFactory        ${core.trexFactory}  owner ${await owner(core.trexFactory, "TREXFactory")}`);
    console.log(`  reference IA       ${core.implementationAuthority}  owner ${await owner(core.implementationAuthority, "TREXImplementationAuthority")}`);
    console.log(`  IAFactory          ${core.iaFactory}`);
    console.log(`  IdFactory          ${core.idFactory}  owner ${await owner(core.idFactory, "IdFactory")}`);
  }
  if (process.env.TREX_RELAYER_KEY) {
    const a = privateKeyToAccount(key().startsWith("0x") ? (key() as `0x${string}`) : `0x${key()}`).address;
    console.log(`  relayer ${a} balance ${(await pc.getBalance({ address: a })).toString()} wei`);
  }
} else if (cmd === "deploy-core") {
  const iaOwner = opt("ia-owner");
  if (!net.testnet) {
    if (!iaOwner || !/^0x[0-9a-fA-F]{40}$/.test(iaOwner)) throw new Error("Real networks need --ia-owner <platform Safe>: the upgrade authority can't stay with the relayer");
    const code = await pc.getCode({ address: getAddress(iaOwner) });
    if (!code || code === "0x") throw new Error(`${iaOwner} has no contract code on ${net.name}: pass the platform Safe`);
  }
  if (trexFor(net) && !flag("force")) throw new Error(`${net.name} already has an ERC-3643 core in chains.ts (pass --force to deploy another)`);
  const wc = walletFor(net, key());
  const me = wc.account!.address;
  const bal = await pc.getBalance({ address: me });
  if (!flag("execute")) {
    console.log(`DRY RUN: would deploy the ERC-3643 core on ${net.name} from the T-REX relayer ${me} (balance ${bal} wei): 13 contracts + 4 wiring transactions + the rules module${iaOwner ? ` + hand the reference authority to ${iaOwner}` : ""}. Re-run with --execute.`);
    process.exit(0);
  }
  const c = await deployCore(wc, pc);
  const rules = await ensureRulesModule(wc, pc, net);
  if (iaOwner) {
    const h = await wc.writeContract({ address: c.implementationAuthority as Address, abi: T.TREXImplementationAuthority!.abi, functionName: "transferOwnership", args: [getAddress(iaOwner)], chain: wc.chain, account: wc.account! });
    const r = await pc.waitForTransactionReceipt({ hash: h });
    if (r.status !== "success") throw new Error("handing the reference authority to the Safe failed");
    const now = await pc.readContract({ address: c.implementationAuthority as Address, abi: T.TREXImplementationAuthority!.abi, functionName: "owner" });
    console.log(`reference IA owner is now ${now} (Safe)`);
  }
  console.log(`OfferingRulesModule ${rules}`);
  console.log(`\nAdd to ${net.name} in web/src/lib/chains.ts:\n  trex: { trexFactory: "${getAddress(c.trexFactory)}", implementationAuthority: "${getAddress(c.implementationAuthority)}", iaFactory: "${getAddress(c.iaFactory)}", idFactory: "${getAddress(c.idFactory)}", rulesModule: "${getAddress(rules)}", fromBlock: ${c.fromBlock} },`);
} else {
  console.error(`unknown command ${cmd}`);
  process.exit(1);
}
