// Live CCTP V2 + Forwarding Service check between two TESTNETS, using the same helpers as the app (src/lib/cctp.ts).
// READ-ONLY by default (prints the quote); --execute approves + burns on the source and waits for the USDC to land.
//   bun scripts/cctp-live.ts --from 5042002 --to 43113 --usdc 1 [--execute]
// Signs with $PRIVATE_KEY (testnet only); the recipient is the signer's own address.
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, http, parseUnits, type Hex } from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { networkById } from "../src/lib/chains";
import { TOKEN_MESSENGER_V2_ABI, burnArgs, burnFor, cctpReady, fetchRouteFee, irisBase } from "../src/lib/cctp";

const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const src = networkById(Number(opt("from")));
const dst = networkById(Number(opt("to")));
const usdc = opt("usdc") ?? "1";
if (!cctpReady(src) || !cctpReady(dst)) throw new Error("--from/--to must be CCTP networks with Circle USDC");
if (!src.testnet || !dst.testnet) throw new Error("testnets only");
if (!/^\d{1,3}(\.\d{1,6})?$/.test(usdc) || Number(usdc) > 5) throw new Error("--usdc ≤ 5");

const deliver = parseUnits(usdc, 6);
const fee = await fetchRouteFee(src, dst);
const { amount, maxFee } = burnFor(deliver, fee);
console.log(`${src.name} → ${dst.name}: deliver ${usdc} USDC, burn ${formatUnits(amount, 6)} (maxFee ${formatUnits(maxFee, 6)}; fast ${fee.fastBps} bps + forward ${formatUnits(fee.forwardFee, 6)})`);
if (!argv.includes("--execute")) { console.log("DRY RUN. Re-run with --execute."); process.exit(0); }

const k = process.env.PRIVATE_KEY!;
const acct = privateKeyToAccount((k.startsWith("0x") ? k : `0x${k}`) as Hex, { nonceManager });
const chainOf = (n: typeof src) => ({ id: n.id, name: n.name, nativeCurrency: n.native, rpcUrls: { default: { http: [n.rpc] } } }) as const;
const spc = createPublicClient({ chain: chainOf(src), transport: http(src.rpc) });
const dpc = createPublicClient({ chain: chainOf(dst), transport: http(dst.rpc) });
const wc = createWalletClient({ account: acct, chain: chainOf(src), transport: http(src.rpc) });
const bal = () => dpc.readContract({ address: dst.stable.address, abi: erc20Abi, functionName: "balanceOf", args: [acct.address] });
const before = await bal();

const a = await wc.writeContract({ address: src.stable.address, abi: erc20Abi, functionName: "approve", args: [src.cctp.tokenMessenger, amount] });
await spc.waitForTransactionReceipt({ hash: a });
const burn = await wc.writeContract({ address: src.cctp.tokenMessenger, abi: TOKEN_MESSENGER_V2_ABI, functionName: "depositForBurnWithHook", args: burnArgs(dst, src.stable.address, acct.address, amount, maxFee) });
const r = await spc.waitForTransactionReceipt({ hash: burn });
if (r.status !== "success") throw new Error(`burn reverted ${burn}`);
console.log(`burn ${src.explorer}/tx/${burn}`);

const t0 = Date.now();
let last = "";
while (Date.now() - t0 < 15 * 60_000) {
  const res = await fetch(`${irisBase(true)}/v2/messages/${src.cctp.domain}?transactionHash=${burn}`);
  const raw = res.status === 404 ? "404" : JSON.stringify(((await res.json()) as any).messages?.[0] ?? {}, (key, v) => (key === "message" || key === "attestation" || key === "messageBody" ? "…" : v));
  if (raw !== last) { console.log(`[${Math.round((Date.now() - t0) / 1000)}s] iris: ${raw}`); last = raw; }
  const now = await bal();
  if (now > before) {
    console.log(`✓ ${formatUnits(now - before, 6)} USDC arrived on ${dst.name} after ${Math.round((Date.now() - t0) / 1000)}s`);
    process.exit(0);
  }
  await new Promise((s) => setTimeout(s, 5000));
}
throw new Error("timed out waiting for the USDC to arrive");
