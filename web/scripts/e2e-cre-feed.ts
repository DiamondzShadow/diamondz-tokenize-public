// Checks that the CRE workflow's report encoding (same viem calls as cre/asset-feeds/main.ts) is accepted by the
// real CreAssetFeed + AssetOracle contracts. Local anvil only; the "forwarder" is an anvil test account.
//   bun scripts/e2e-cre-feed.ts
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, encodeAbiParameters, http, keccak256, parseAbiParameters, stringToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = "http://127.0.0.1:8551";
const chain = { id: 84532, name: "anvil", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const [platform, forwarder, issuer] = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
].map((k) => privateKeyToAccount(k as Hex));
const art = (n: string) => JSON.parse(readFileSync(`${import.meta.dir}/../../contracts/out/${n}.sol/${n}.json`, "utf8"));
const pc = createPublicClient({ chain, transport: http(RPC) });
const wc = (a: typeof platform) => createWalletClient({ account: a, chain, transport: http(RPC) });
let failed = false;
const check = (ok: boolean, l: string) => (console.log(`${ok ? "PASS" : "FAIL"}  ${l}`), ok || (failed = true));
async function deploy(a: typeof platform, n: string, args: unknown[]) {
  const A = art(n);
  const r = await pc.waitForTransactionReceipt({ hash: await wc(a).deployContract({ abi: A.abi, bytecode: A.bytecode.object, args }) });
  return r.contractAddress as Address;
}
async function write(a: typeof platform, address: Address, n: string, fn: string, args: unknown[]) {
  const r = await pc.waitForTransactionReceipt({ hash: await wc(a).writeContract({ address, abi: art(n).abi, functionName: fn, args }) });
  if (r.status !== "success") throw new Error(`${fn} reverted`);
}
const read = (address: Address, n: string, fn: string, args: unknown[] = []) => pc.readContract({ address, abi: art(n).abi, functionName: fn, args }) as Promise<any>;

const anvil = spawn("anvil", ["--chain-id", "84532", "--port", "8551", "--silent"]);
try {
  for (let i = 0; i < 50 && !(await pc.getBlockNumber().then(() => true, () => false)); i++) await new Promise((r) => setTimeout(r, 100));
  const oracle = await deploy(platform, "AssetOracle", [platform.address]);
  const feed = await deploy(platform, "CreAssetFeed", [forwarder.address, oracle]);
  const registry = await deploy(issuer, "InvestorRegistry", [issuer.address, issuer.address, "0x0000000000000000000000000000000000000000"]);
  const token = await deploy(issuer, "PermissionedToken", [{ name: "Mangrove", symbol: "MGRV", decimals: 18, maxSupply: 10n ** 24n, admin: issuer.address, registry, documentURI: "", rules: "0x0000000000000000000000000000000000000000" }]);
  const k = (s: string) => keccak256(stringToHex(s));
  await write(platform, oracle, "AssetOracle", "setMaxValidity", [k("REGISTRY"), 120n * 86400n]);
  await write(platform, oracle, "AssetOracle", "setClassRequirements", [k("carbon"), [k("REGISTRY")]]);
  await write(platform, oracle, "AssetOracle", "setVerifier", [feed, true, "Chainlink CRE: asset feeds"]);
  await write(platform, oracle, "AssetOracle", "setVerifierKind", [feed, k("REGISTRY"), true]);
  await write(issuer, oracle, "AssetOracle", "register", [token, k("carbon"), [k("REGISTRY")]]);

  // ---- exactly the workflow's encoding (cre/asset-feeds/main.ts step 3 + 4)
  const nowSec = BigInt((await pc.getBlock()).timestamp) - 5n;
  const mark = encodeAbiParameters(parseAbiParameters("address, bytes32, int256, uint8, uint64, bytes32"),
    [token, k("CARBON_CREDITS_HELD"), 13793610609715689386570501n, 18, nowSec, k("src")]);
  const attest = encodeAbiParameters(
    parseAbiParameters("(address token, bytes32 kind, uint8 result, uint64 validUntil, int256 value, bytes32 evidenceHash, string evidenceURI)"),
    [{ token, kind: k("REGISTRY"), result: 1, validUntil: nowSec + 30n * 86400n, value: 13793610n, evidenceHash: k("held"), evidenceURI: "evm:polygon-mainnet:0x2F80…:balanceOf:0x7dd4…" }]);
  const report = encodeAbiParameters(parseAbiParameters("(uint8 itemType, bytes body)[]"), [[{ itemType: 1, body: mark }, { itemType: 2, body: attest }]]);
  const metadata = (`0x${"11".repeat(32)}${stringToHex("asset-feed", { size: 10 }).slice(2)}${platform.address.slice(2)}0000`) as Hex;

  check(!(await read(oracle, "AssetOracle", "isVerified", [token])), "carbon token unverified before the report");
  await write(forwarder, feed, "CreAssetFeed", "onReport", [metadata, report]);
  const m = await read(feed, "CreAssetFeed", "latestMark", [token, k("CARBON_CREDITS_HELD")]);
  check(m.value === 13793610609715689386570501n && m.decimals === 18 && m.observedAt === nowSec, "workflow-encoded MARK decoded and stored by CreAssetFeed");
  check(await read(oracle, "AssetOracle", "isVerified", [token]), "workflow-encoded ATTEST signed REGISTRY into AssetOracle -> verified");
  process.env.RPC_84532 = RPC;
  process.env.CRE_FEED_84532 = feed;
  process.env.ASSET_ORACLE_84532 = `${oracle}:0`;
  const { computeProof } = await import("../../api/src/proof");
  const p = await computeProof({ id: "ast_cre", chainId: 84532, assetClass: "carbon", deployment: { token, sale: token, registry, payToken: token } }).catch((e) => ({ error: String(e) }) as any);
  const f = p.feeds?.find((x: any) => x.metric === "CARBON_CREDITS_HELD");
  check(f?.value === "13793610609715689386570501" && f?.source === "chainlink-cre", "proof API shows the Chainlink CRE feed value on the listing");
  const bad = await wc(issuer).writeContract({ address: feed, abi: art("CreAssetFeed").abi, functionName: "onReport", args: [metadata, report] }).then(() => false, () => true);
  check(bad, "reports from anything but the forwarder are rejected");
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  anvil.kill();
}
console.log(failed ? "\nE2E CRE FEED: FAILED" : "\nE2E CRE FEED: ALL PASS");
process.exit(failed ? 1 : 0);
