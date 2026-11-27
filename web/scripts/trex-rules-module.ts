// Deploy (or redeploy) the shared OfferingRulesModule on one chain. Signs with $TREX_RELAYER_KEY.
// The module holds no admin role: every setting arrives through an offering's own compliance contract.
//
//   bun scripts/trex-rules-module.ts --chain 42161 [--execute]
import { getAddress } from "viem";
import { networkById } from "../src/lib/chains";
import { TREX_ARTIFACTS as T, publicFor, walletFor } from "../../api/src/trex";

const argv = process.argv.slice(2);
const net = networkById(Number(argv[argv.indexOf("--chain") + 1]));
if (!net) throw new Error("--chain");
const pc = publicFor(net);
const wc = walletFor(net, process.env.TREX_RELAYER_KEY!);
const me = wc.account!.address;
console.log(`${net.name}: relayer ${me} ${await pc.getBalance({ address: me })} wei; pinned ${(net.trex as any)?.rulesModule ?? "none"}`);
if (!argv.includes("--execute")) process.exit(0);
const { abi, bytecode } = T.OfferingRulesModule;
const hash = await wc.deployContract({ abi, bytecode, args: [], account: wc.account!, chain: wc.chain });
const r = await pc.waitForTransactionReceipt({ hash });
if (r.status !== "success" || !r.contractAddress) throw new Error(`deploy failed: ${hash}`);
const at = getAddress(r.contractAddress);
const name = await pc.readContract({ address: at, abi, functionName: "name" });
console.log(`✓ OfferingRulesModule ${at} (${name}) block ${r.blockNumber}  ${hash}  gas ${r.gasUsed}`);
