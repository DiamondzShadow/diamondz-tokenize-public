// Finish an ERC-3643 core deploy that stopped after the TREXFactory was deployed and pointed at by the authority
// (e.g. the relayer ran out of gas). Picks up at the IAFactory. Signs with $TREX_RELAYER_KEY.
//
//   bun scripts/trex-resume.ts --chain 42161 --ia 0x.. --factory 0x.. --id-factory 0x.. --ia-owner <Safe> [--execute]
import { getAddress, type Address } from "viem";
import { networkById } from "../src/lib/chains";
import { TREX_ARTIFACTS as T, publicFor, walletFor } from "../../api/src/trex";

const argv = process.argv.slice(2);
const opt = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const net = networkById(Number(opt("chain")));
const ia = getAddress(opt("ia")!) as Address;
const factory = getAddress(opt("factory")!) as Address;
const idFactory = getAddress(opt("id-factory")!) as Address;
const safe = getAddress(opt("ia-owner")!) as Address;
if (!net) throw new Error("--chain");
const pc = publicFor(net);
const code = await pc.getCode({ address: safe });
if (!code || code === "0x") throw new Error(`${safe} has no contract code on ${net.name}: pass the platform Safe`);
const wc = walletFor(net, process.env.TREX_RELAYER_KEY!);
const me = wc.account!.address;
const read = <R,>(a: Address, n: string, fn: string, args: unknown[] = []) => pc.readContract({ address: a, abi: T[n].abi, functionName: fn, args }) as Promise<R>;

const iaOwner = await read<string>(ia, "TREXImplementationAuthority", "owner");
const curIAF = await read<string>(ia, "TREXImplementationAuthority", "getIAFactory").catch(() => "?");
const curFactory = await read<string>(ia, "TREXImplementationAuthority", "getTREXFactory");
console.log(`${net.name}: IA ${ia} owner ${iaOwner}, factory ${curFactory}, IAFactory ${curIAF}; relayer ${me} ${await pc.getBalance({ address: me })} wei`);
if (getAddress(curFactory) !== factory) throw new Error("the authority isn't pointed at this factory");
if (!argv.includes("--execute")) process.exit(0);

async function deploy(name: string, args: unknown[]) {
  const hash = await wc.deployContract({ abi: T[name].abi, bytecode: T[name].bytecode, args, account: wc.account!, chain: wc.chain });
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`deploy ${name} failed: ${hash}`);
  console.log(`✓ ${name} ${r.contractAddress}  ${hash}`);
  return getAddress(r.contractAddress);
}
async function call(a: Address, n: string, fn: string, args: unknown[], why: string) {
  const { request } = await pc.simulateContract({ address: a, abi: T[n].abi, functionName: fn, args, account: wc.account! });
  const hash = await wc.writeContract(request as any);
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${why} failed: ${hash}`);
  console.log(`  ✓ ${why}  ${hash}`);
}

let iaFactory = curIAF && curIAF !== "?" && !/^0x0{40}$/i.test(curIAF) ? getAddress(curIAF) : undefined;
if (!iaFactory) {
  iaFactory = await deploy("IAFactory", [factory]);
  await call(ia, "TREXImplementationAuthority", "setIAFactory", [iaFactory], "enable per-offering authorities");
}
const isTF = await read<boolean>(idFactory, "IdFactory", "isTokenFactory", [factory]).catch(() => false);
if (!isTF) await call(idFactory, "IdFactory", "addTokenFactory", [factory], "let the factory create token identities");
const rules = (process.env[`TREX_RULES_MODULE_${net.id}`] as Address | undefined) ?? (await deploy("OfferingRulesModule", []));
if (getAddress(iaOwner) !== safe) await call(ia, "TREXImplementationAuthority", "transferOwnership", [safe], "hand the reference authority to the Safe");
const fromBlock = Number(opt("from-block") ?? 0);
console.log(`reference IA owner is now ${await read<string>(ia, "TREXImplementationAuthority", "owner")}`);
console.log(`\nAdd to ${net.name} in web/src/lib/chains.ts:\n  trex: { trexFactory: "${factory}", implementationAuthority: "${ia}", iaFactory: "${iaFactory}", idFactory: "${idFactory}", rulesModule: "${getAddress(rules)}", fromBlock: ${fromBlock} },`);
