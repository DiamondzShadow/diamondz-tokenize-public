// Platform deploy of the IP registry (AssetRegistry + LicenseRegistry) on one network. READ-ONLY by default.
//   bun scripts/deploy-ip.ts --chain 84532 [--admin 0xSafe] [--assets 0xExistingAssetRegistry] [--execute]
// --assets reuses a deployed AssetRegistry and deploys only a new LicenseRegistry (contract upgrades).
// Signs with $PRIVATE_KEY (or $DEPLOYER_PK), only read with --execute. --admin = LicenseRegistry platform admin (sets
// the platform fee and metadata URL only; it can't touch anyone's licenses); defaults to the signer on testnets.
// Prints the chains.ts entry to add.
import { createPublicClient, createWalletClient, getAddress, http, isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import artifacts from "../src/contracts/artifacts.json";
import { networkById } from "../src/lib/chains";
import { rpcUrl } from "../../api/src/chains";

const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const net = networkById(Number(opt("chain")));
if (!net) throw new Error("usage: bun scripts/deploy-ip.ts --chain <id> [--admin 0x..] [--execute]");
const execute = argv.includes("--execute");
// Same RPC as the API: RPC_<chainId> override → Uniblock (UNIBLOCK_API_KEY) → public.
const rpc = rpcUrl(net);
const chain = { id: net.id, name: net.name, nativeCurrency: net.native, rpcUrls: { default: { http: [rpc] } } } as const;
const pc = createPublicClient({ chain, transport: http(rpc) });
const A = artifacts as any;
const base = `https://tokenize.diamondz.one/api/licenses/${net.id}/`;
const adminArg = opt("admin");
if (adminArg && !isAddress(adminArg)) throw new Error("--admin must be a full 0x address");
if (!net.testnet && !adminArg) throw new Error("mainnet needs --admin <platform Safe>");

if (!execute) {
  console.log(`DRY RUN on ${net.name}: would deploy ${opt("assets") ? `(reusing AssetRegistry ${opt("assets")})` : "AssetRegistry"}, then LicenseRegistry(assets, admin=${adminArg ?? "<signer>"}, "${base}"). Re-run with --execute.`);
  process.exit(0);
}
const k = process.env.PRIVATE_KEY || process.env.DEPLOYER_PK;
if (!k) throw new Error("PRIVATE_KEY (or DEPLOYER_PK) is not set");
const account = privateKeyToAccount((k.startsWith("0x") ? k : `0x${k}`) as Hex);
const wc = createWalletClient({ account, chain, transport: http(rpc) });
const admin = getAddress(adminArg ?? account.address);
async function deploy(name: string, args: unknown[]) {
  const hash = await wc.deployContract({ abi: A[name].abi, bytecode: A[name].bytecode, args });
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`${name} failed: ${hash}`);
  console.log(`✓ ${name} ${r.contractAddress}  ${hash}`);
  return { address: getAddress(r.contractAddress) as Address, block: Number(r.blockNumber) };
}
const existing = opt("assets");
if (existing && !isAddress(existing)) throw new Error("--assets must be a full 0x address");
const assets = existing
  ? { address: getAddress(existing) as Address, block: Number((await pc.getBlockNumber())) }
  : await deploy("AssetRegistry", []);
const licenses = await deploy("LicenseRegistry", [assets.address, admin, base]);
console.log(`\nchains.ts (${net.id}): ip: { assets: "${assets.address}", licenses: "${licenses.address}", fromBlock: ${existing ? "<keep the original>" : assets.block} },`);
