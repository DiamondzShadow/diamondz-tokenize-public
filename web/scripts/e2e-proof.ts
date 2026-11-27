// Proof-of-asset end to end on a throwaway local anvil chain (posing as Robinhood Chain Testnet, 46630).
// Starts anvil and a throwaway API itself; touches no real network and no real database.
//   bun scripts/e2e-proof.ts
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createPublicClient, createWalletClient, http, parseUnits, sha256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import artifacts from "../src/contracts/artifacts.json";
import { CLASS_CHECKS, classHash, kindHash, AttestResult } from "../src/lib/verification";

const PORT_RPC = 8549, PORT_API = 8915;
const RPC = `http://127.0.0.1:${PORT_RPC}`;
const API = `http://127.0.0.1:${PORT_API}`;
const chain = { id: 46630, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
// anvil default dev keys (public, test-only)
const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // platform
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // issuer
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // title company
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // appraiser
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", // insurer
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", // investor
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e", // rogue
] as const;
const [platform, issuer, titleCo, appraiser, insurer, investor, rogue] = KEYS.map((k) => privateKeyToAccount(k));
const A = artifacts as any;
const pc = createPublicClient({ chain, transport: http(RPC) });
const wc = (a: typeof issuer) => createWalletClient({ account: a, chain, transport: http(RPC) });
let failed = false;
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed = true;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function deploy(name: string, args: unknown[]) {
  const hash = await wc(issuer).deployContract({ abi: A[name].abi, bytecode: A[name].bytecode as Hex, args });
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(name + " failed");
  return r.contractAddress as Address;
}
async function write(a: typeof issuer, address: Address, name: string, fn: string, args: unknown[]) {
  const hash = await wc(a).writeContract({ address, abi: A[name].abi, functionName: fn, args });
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(fn + " failed");
  return hash;
}
async function reverts(p: Promise<unknown>, needle: string) {
  try {
    await p;
    return false;
  } catch (e: any) {
    return String(e?.shortMessage ?? "").includes(needle) || String(e?.message ?? "").includes(needle);
  }
}
const read = (address: Address, name: string, fn: string, args: unknown[] = []) => pc.readContract({ address, abi: A[name].abi, functionName: fn, args }) as Promise<any>;
function sh(cmd: string, args: string[], env: Record<string, string> = {}) {
  return new Promise<string>((resolve, reject) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: import.meta.dir + "/.." });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(out))));
  });
}

const anvil = spawn("anvil", ["--chain-id", "46630", "--port", String(PORT_RPC), "--silent"]);
let apiProc: ReturnType<typeof spawn> | null = null;
try {
  for (let i = 0; i < 50; i++) {
    if (await pc.getBlockNumber().then(() => true, () => false)) break;
    await sleep(100);
  }

  // ---- 1. platform deploys + configures the oracle with the real admin script
  const out = await sh("bun", ["scripts/oracle.ts", "deploy", "--chain", "46630", "--execute"], { RPC_46630: RPC, PRIVATE_KEY: KEYS[0] });
  const m = out.match(/assetOracle: \{ address: "(0x[0-9a-fA-F]{40})", fromBlock: (\d+) \}/);
  check(!!m, "admin script deployed + configured the oracle");
  const oracle = m![1] as Address;
  const ORACLE_ENV = { RPC_46630: RPC, PRIVATE_KEY: KEYS[0], ASSET_ORACLE_46630: `${oracle}:${m![2]}` };
  const add = (who: Address, name: string, kinds: string) =>
    sh("bun", ["scripts/oracle.ts", "add-verifier", "--chain", "46630", "--oracle", oracle, "--address", who, "--name", name, "--kinds", kinds, "--execute"], ORACLE_ENV);
  await add(titleCo.address, "Acme Title Insurance Co.", "TITLE");
  await add(appraiser.address, "Jane Doe, MAI", "VALUATION");
  await add(insurer.address, "Harbor Mutual Insurance", "INSURANCE");
  const st = await sh("bun", ["scripts/oracle.ts", "status", "--chain", "46630", "--oracle", oracle], ORACLE_ENV);
  check(!st.includes("✗") && st.includes("✓ real-estate"), "all 8 asset-class checklists configured on chain");
  const dry = await sh("bun", ["scripts/oracle.ts", "add-verifier", "--chain", "46630", "--oracle", oracle, "--address", rogue.address, "--name", "x", "--kinds", "TITLE"], ORACLE_ENV);
  check(dry.includes("DRY RUN") && !(await read(oracle, "AssetOracle", "verifiers", [rogue.address]))[0], "admin script is read-only without --execute");

  // ---- 2. issuer deploys an offering gated by the oracle (same calls as the browser wizard)
  const usd = await deploy("TestUSD", []);
  const registry = await deploy("InvestorRegistry", [issuer.address, issuer.address, "0x0000000000000000000000000000000000000000"]);
  const token = await deploy("PermissionedToken", [{ name: "Oak Ridge Duplex SPV", symbol: "OAKR", decimals: 18, maxSupply: 1_000_000n * 10n ** 18n, admin: issuer.address, registry, documentURI: "", rules: "0x0000000000000000000000000000000000000000" }]);
  const sale = await deploy("PrimarySale", [{ token, payToken: usd, treasury: issuer.address, admin: issuer.address, price: parseUnits("1.5", 6), cap: 1_000_000n * 10n ** 18n, minPurchase: 0n, startsAt: 0n, endsAt: 0n, feeRecipient: "0x0000000000000000000000000000000000000000", feeBps: 0, oracle }]);
  await write(issuer, token, "PermissionedToken", "grantRole", [await read(token, "PermissionedToken", "MINTER_ROLE"), sale]);
  const kinds = CLASS_CHECKS["real-estate"];
  check(await reverts(wc(issuer).writeContract({ address: oracle, abi: A.AssetOracle.abi, functionName: "register", args: [token, classHash("real-estate"), kinds.slice(0, 2).map(kindHash)] }), "MissingRequiredKind"), "issuer can't skip a required check");
  await write(issuer, oracle, "AssetOracle", "register", [token, classHash("real-estate"), kinds.map(kindHash)]);
  await write(issuer, registry, "InvestorRegistry", "setInvestor", [investor.address, true, 840, 0n]);
  await write(investor, usd, "TestUSD", "mint", [investor.address, parseUnits("1000", 6)]);
  await write(investor, usd, "TestUSD", "approve", [sale, 2n ** 256n - 1n]);
  check(await reverts(wc(investor).writeContract({ address: sale, abi: A.PrimarySale.abi, functionName: "buy", args: [10n ** 18n] }), "AssetNotVerified"), "sale refuses purchases before verification");
  check(await reverts(wc(issuer).writeContract({ address: oracle, abi: A.AssetOracle.abi, functionName: "setVerifier", args: [issuer.address, true, "Me Title"] }), "AccessControlUnauthorizedAccount"), "issuer can't approve itself as a verifier");

  // ---- 3. API: evidence upload signed by an approved verifier; rogue wallets refused
  const dir = mkdtempSync(`${tmpdir()}/proof-e2e-`);
  apiProc = spawn("bun", ["src/server.ts"], {
    cwd: import.meta.dir + "/../../api",
    env: { ...process.env, PORT: String(PORT_API), DB_PATH: `${dir}/t.db`, EVIDENCE_DIR: `${dir}/evidence`, DEFAULT_HOSTS: "127.0.0.1", ADMIN_DOMAINS: "example.com", ...ORACLE_ENV, PRIVATE_KEY: "" },
  });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${API}/api/health`).then((r) => r.ok, () => false)) break;
    await sleep(100);
  }
  const { evidenceMessage } = await import("../../api/src/proof");
  async function upload(who: typeof titleCo, body: string) {
    const bytes = new TextEncoder().encode(body);
    const sha = sha256(bytes).slice(2);
    const ts = Math.floor(Date.now() / 1000);
    const signature = await who.signMessage({ message: evidenceMessage(sha, 46630, ts) });
    const f = new FormData();
    f.set("file", new File([bytes], "doc.txt", { type: "text/plain" }));
    for (const [k, v] of Object.entries({ chainId: "46630", verifier: who.address, ts: String(ts), signature })) f.set(k, v);
    const res = await fetch(`${API}/api/proof/evidence`, { method: "POST", body: f });
    return { status: res.status, body: (await res.json()) as any };
  }
  const titleDoc = await upload(titleCo, "Owner's title policy #A-1029, Oak Ridge Duplex, vested in Oak Ridge SPV LLC");
  if (titleDoc.status !== 200) console.log("upload:", titleDoc.status, JSON.stringify(titleDoc.body));
  check(titleDoc.status === 200 && titleDoc.body.sha256?.length === 66, "approved verifier uploads evidence");
  check((await upload(rogue, "fake deed")).status === 403, "unapproved wallet can't upload evidence");
  const got = await fetch(titleDoc.body.uri.replace(/^https:\/\/[^/]+/, API));
  check(got.ok && (await got.text()).includes("Oak Ridge SPV LLC") && got.headers.get("content-security-policy") === "sandbox", "evidence is served back, sandboxed");
  const dirList = (await (await fetch(`${API}/api/proof/verifiers/46630`)).json()) as any[];
  check(dirList.length === 3 && dirList.some((v) => v.name === "Harbor Mutual Insurance" && v.kinds.includes("INSURANCE")), "verifier directory lists the 3 approved verifiers with their kinds");

  // ---- 4. proof status: missing -> partly -> verified -> purchases open
  const { computeProof } = await import("../../api/src/proof");
  const asset = { id: "ast_e2e", chainId: 46630, assetClass: "real-estate", deployment: { token, sale, registry, payToken: usd } };
  process.env.ASSET_ORACLE_46630 = ORACLE_ENV.ASSET_ORACLE_46630;
  process.env.RPC_46630 = RPC;
  let p = await computeProof(asset);
  check(p.gated && p.registered && !p.verified && p.checks.length === 3 && p.checks.every((c) => c.status === "missing"), "proof: gated, registered, 3 checks missing");
  const now = BigInt((await pc.getBlock()).timestamp);
  const attest = (who: typeof titleCo, kind: string, result: number, ttlDays: number, value: bigint, doc: { sha256: string; uri: string }) =>
    write(who, oracle, "AssetOracle", "attest", [{ token, kind: kindHash(kind as any), result, validUntil: now + BigInt(ttlDays * 86400), value, evidenceHash: doc.sha256, evidenceURI: doc.uri }]);
  await attest(titleCo, "TITLE", AttestResult.Pass, 300, 0n, titleDoc.body);
  check(await reverts(attest(titleCo, "VALUATION", AttestResult.Pass, 30, 0n, titleDoc.body), "NotAllowedVerifier"), "title company can't sign a valuation");
  const appr = (await upload(appraiser, "Appraisal report: market value $2,450,000")).body;
  await attest(appraiser, "VALUATION", AttestResult.Pass, 10, 245_000_000n, appr);
  p = await computeProof(asset);
  check(!p.verified && p.checks.find((c) => c.kind === "VALUATION")?.status === "expiring" && p.checks.find((c) => c.kind === "INSURANCE")?.status === "missing", "proof: 2 of 3 signed, valuation flagged as expiring soon");
  const pol = (await upload(insurer, "Policy HM-77 in force")).body;
  await attest(insurer, "INSURANCE", AttestResult.Pass, 300, 300_000_000n, pol);
  p = await computeProof(asset);
  const t = p.checks.find((c) => c.kind === "TITLE")!;
  check(p.verified && t.verifier?.name === "Acme Title Insurance Co." && !!t.tx && t.evidenceURI === titleDoc.body.uri, "proof: verified, shows verifier name, evidence and tx");
  await write(investor, sale, "PrimarySale", "buy", [100n * 10n ** 18n]);
  check((await read(token, "PermissionedToken", "balanceOf", [investor.address])) === 100n * 10n ** 18n, "verified asset: investor buys");
  p = await computeProof(asset);
  check(p.live.find((l) => l.id === "supply-matches-sales")?.ok === true, "live check: circulation matches sales");

  // ---- 5. issuer mints outside the sale -> live check flags dilution
  await write(issuer, token, "PermissionedToken", "grantRole", [await read(token, "PermissionedToken", "MINTER_ROLE"), issuer.address]);
  await write(issuer, token, "PermissionedToken", "mint", [investor.address, 5n * 10n ** 18n]);
  p = await computeProof(asset);
  const dil = p.live.find((l) => l.id === "supply-matches-sales")!;
  check(dil.ok === false && dil.detail.includes("minted outside the sale"), "live check catches tokens minted outside the sale");

  // ---- 6. appraisal lapses -> sales stop; a fail can't be shopped away
  await pc.request({ method: "evm_increaseTime" as any, params: [11 * 86400] as any });
  await pc.request({ method: "evm_mine" as any, params: [] as any });
  check(await reverts(wc(investor).writeContract({ address: sale, abi: A.PrimarySale.abi, functionName: "buy", args: [10n ** 18n] }), "AssetNotVerified"), "lapsed appraisal: sale stops");
  p = await computeProof(asset);
  check(!p.verified && p.checks.find((c) => c.kind === "VALUATION")?.status === "expired", "proof: valuation shown as expired");
  await attest(titleCo, "TITLE", AttestResult.Fail, 60, 0n, (await upload(titleCo, "Undisclosed lien recorded 2026-11-01")).body);
  p = await computeProof(asset);
  check(p.checks.find((c) => c.kind === "TITLE")?.status === "failed", "proof: failed title shown as failed");
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  apiProc?.kill();
  anvil.kill();
}
console.log(failed ? "\nE2E PROOF: FAILED" : "\nE2E PROOF: ALL PASS");
process.exit(failed ? 1 : 0);
