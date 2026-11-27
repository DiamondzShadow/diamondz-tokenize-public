// Sign a proof-of-asset check as one of the TEST verifiers (test networks only; --chain <id>, default 84532 Base Sepolia). READ-ONLY unless --execute.
// Does exactly what a real verifier does: uploads the evidence file (signed by the verifier wallet) to the API,
// then calls AssetOracle.attest from the verifier's own wallet.
//
//   bun scripts/attest.ts --as title|valuation|insurance --token 0x... --kind TITLE
//       [--result pass|fail] [--days 180] [--value 245000000] [--note "text evidence"] [--file evidence.pdf] [--execute]
//
// Keys: ~/.diamondz-tokenize-test-verifiers.env (testnet-only wallets, never printed).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createPublicClient, createWalletClient, getAddress, http, isAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import artifacts from "../src/contracts/artifacts.json";
import { networkById } from "../src/lib/chains";
import { rpcUrl } from "../../api/src/chains";
import { AttestResult, CHECK_KINDS, kindHash, type CheckKindId } from "../src/lib/verification";

const API = process.env.TOKENIZE_API ?? "https://tokenize.diamondz.one/api";
const argv = process.argv.slice(2);
const opt = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
};
const EXECUTE = argv.includes("--execute");

const role = (opt("as") ?? "").toUpperCase();
const token = opt("token");
const kind = (opt("kind") ?? "").toUpperCase() as CheckKindId;
const result = (opt("result") ?? "pass").toLowerCase();
const days = Number(opt("days") ?? CHECK_KINDS[kind]?.maxDays ?? 30);
const value = BigInt(opt("value") ?? "0");
if (!["TITLE", "VALUATION", "INSURANCE"].includes(role)) throw new Error("--as title|valuation|insurance");
if (!token || !isAddress(token)) throw new Error("--token <token address> required");
if (!CHECK_KINDS[kind]) throw new Error(`--kind one of ${Object.keys(CHECK_KINDS).join(", ")}`);
if (!["pass", "fail"].includes(result)) throw new Error("--result pass|fail");
if (!(days > 0 && days <= CHECK_KINDS[kind].maxDays)) throw new Error(`--days must be 1..${CHECK_KINDS[kind].maxDays} for ${kind}`);

const env = Object.fromEntries(
  readFileSync(`${homedir()}/.diamondz-tokenize-test-verifiers.env`, "utf8").split("\n").filter(Boolean).map((l) => l.split("=") as [string, string]),
);
const acct = privateKeyToAccount(env[`TEST_VERIFIER_${role}_KEY`] as Hex);
const net = networkById(Number(opt("chain") ?? 84532))!;
if (!net?.testnet || !net.assetOracle) throw new Error("--chain must be a test network with an asset oracle");
const oracle = net.assetOracle!.address;
// Same RPC as the API: RPC_<chainId> override → Uniblock (UNIBLOCK_API_KEY) → public.
const rpc = rpcUrl(net);
const chain = { id: net.id, name: net.name, nativeCurrency: net.native, rpcUrls: { default: { http: [rpc] } } } as const;
const pc = createPublicClient({ chain, transport: http(rpc) });
const A = (artifacts as any).AssetOracle;

// Evidence: a file, or a text note turned into a small text document.
const file = opt("file");
const bytes = file ? new Uint8Array(readFileSync(file)) : new TextEncoder().encode(
  `${CHECK_KINDS[kind].name} — ${result.toUpperCase()}\nToken: ${getAddress(token)}\nVerifier: ${acct.address}\nDate: ${new Date().toISOString()}\n\n${opt("note") ?? "TEST attestation on ${net.name} (testnet only)."}\n`,
);
const type = file?.endsWith(".pdf") ? "application/pdf" : file?.endsWith(".png") ? "image/png" : file?.match(/\.jpe?g$/) ? "image/jpeg" : "text/plain";

const [active] = (await pc.readContract({ address: oracle, abi: A.abi, functionName: "verifiers", args: [acct.address] })) as [boolean, string];
const allowed = await pc.readContract({ address: oracle, abi: A.abi, functionName: "canAttest", args: [acct.address, kindHash(kind)] });
console.log(`Verifier ${acct.address} (${role}) active=${active} may sign ${kind}=${allowed}`);
if (!EXECUTE) {
  console.log(`DRY RUN: would upload ${bytes.length} bytes of evidence and sign ${kind}=${result.toUpperCase()} for ${getAddress(token)}, valid ${days} days. Re-run with --execute.`);
  process.exit(0);
}
if (!active || !allowed) throw new Error("This test verifier isn't approved for that check yet (run setup-test-verifiers.sh).");

// 1. upload evidence, signed by the verifier wallet
const sha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const ts = Math.floor(Date.now() / 1000);
const signature = await acct.signMessage({ message: `Diamondz Tokenize evidence upload\nsha256: ${sha}\nnetwork: ${net.id}\ntime: ${ts}` });
const form = new FormData();
form.set("file", new File([bytes], file ?? "evidence.txt", { type }));
for (const [k, v] of Object.entries({ chainId: String(net.id), verifier: acct.address, ts: String(ts), signature })) form.set(k, v);
const up = await fetch(`${API}/proof/evidence`, { method: "POST", body: form });
const ev = (await up.json()) as any;
if (!up.ok) throw new Error(`evidence upload failed: ${ev.error}`);
console.log(`  ✓ evidence ${ev.uri}`);

// 2. sign the check on chain from the verifier's own wallet
const now = BigInt((await pc.getBlock()).timestamp);
const wc = createWalletClient({ account: acct, chain, transport: http(rpc) });
const hash = await wc.writeContract({
  address: oracle, abi: A.abi, functionName: "attest",
  args: [{ token: getAddress(token), kind: kindHash(kind), result: result === "pass" ? AttestResult.Pass : AttestResult.Fail, validUntil: now + BigInt(days * 86_400), value, evidenceHash: ev.sha256, evidenceURI: ev.uri }],
});
const r = await pc.waitForTransactionReceipt({ hash });
if (r.status !== "success") throw new Error(`attest reverted: ${hash}`);
console.log(`  ✓ ${kind} ${result.toUpperCase()} signed  ${net.explorer}/tx/${hash}`);
const verified = await pc.readContract({ address: oracle, abi: A.abi, functionName: "isVerified", args: [getAddress(token)] });
console.log(`  token verified now: ${verified}`);
