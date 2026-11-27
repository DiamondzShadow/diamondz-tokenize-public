// Mainnet-path rehearsal on a local FORK of Robinhood Chain (4663): real USDG, platform fee to the RH Safe,
// admin handover to the treasury, and the API's mainnet checks. Nothing is broadcast to the real chain.
// Usage: anvil --chain-id 4663 --port 8547 &  then place a stand-in ERC-20 at the USDG address (anvil_setCode);
//   (a live fork fails: the public RH RPC prunes old state within seconds).
//   API on :8914 with RPC_4663=http://127.0.0.1:8547 PLATFORM_FEE_RECIPIENTS=4663:<RH Safe> PLATFORM_SALE_FEE_BPS=150
//   API=http://127.0.0.1:8914 SESSION=<sid> bun scripts/e2e-fork-rh.ts
import { createPublicClient, createWalletClient, http, keccak256, parseUnits, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import artifacts from "../src/contracts/artifacts.json";

const API = process.env.API ?? "http://127.0.0.1:8914";
const SESSION = process.env.SESSION!;
const RPC = "http://127.0.0.1:8547";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const chain = { id: 4663, name: "rh-fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const issuer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"); // anvil dev key
const treasury = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address; // anvil dev account #1 stands in for the Safe
const pc = createPublicClient({ chain, transport: http(RPC) });
const wc = createWalletClient({ account: issuer, chain, transport: http(RPC) });
const A = artifacts as any;
const ADMIN = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;
const ROLE = (n: string) => keccak256(toHex(n));

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(API + "/api" + path, { ...init, headers: { "content-type": "application/json", origin: API, cookie: `dt_session=${SESSION}`, host: "127.0.0.1" } });
  return { status: res.status, body: (await res.json()) as any };
}
async function deploy(name: string, args: unknown[]) {
  const hash = await wc.deployContract({ abi: A[name].abi, bytecode: A[name].bytecode as Hex, args });
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(name + " failed");
  return r.contractAddress as Address;
}
async function write(address: Address, name: string, fn: string, args: unknown[]) {
  const r = await pc.waitForTransactionReceipt({ hash: await wc.writeContract({ address, abi: A[name].abi, functionName: fn, args }) });
  if (r.status !== "success") throw new Error(fn + " failed");
}
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) process.exitCode = 1;
};

const tenant = (await api("/tenant")).body;
const safe = tenant.platform.feeRecipients["4663"] as Address;
const feeUsd = tenant.plan.offeringFeeUsd as number;
check(tenant.platform.saleFeeBps === 0 && !!safe, `no % sale fee; platform Safe on RH = ${safe}`);
check(feeUsd === 1000 && tenant.plan.id === "launch", "Launch plan: $1,000 flat per mainnet offering");

const mkDraft = async (sym: string) => (await api("/assets", { method: "POST", body: JSON.stringify({ name: "RH Test " + sym, symbol: sym, assetClass: "real-estate", standard: "erc7943", chainId: 4663, totalSupply: "1000000", pricePerToken: "1", minInvestment: "100" }) })).body.id as string;

const build = async (name: string, sym: string, saleFeeBps = 0) => {
  const reg = await deploy("InvestorRegistry", [issuer.address, issuer.address, "0x0000000000000000000000000000000000000000"]); // RH: no Chainalysis oracle
  const tok = await deploy("PermissionedToken", [{ name, symbol: sym, decimals: 18, maxSupply: 1_000_000n * 10n ** 18n, admin: issuer.address, registry: reg, documentURI: "", rules: "0x0000000000000000000000000000000000000000" }]);
  const sale = await deploy("PrimarySale", [{ token: tok, payToken: USDG, treasury, admin: issuer.address, price: parseUnits("1", 6), cap: 1_000_000n * 10n ** 18n, minPurchase: parseUnits("100", 6), startsAt: 0n, endsAt: 0n, feeRecipient: saleFeeBps ? safe : "0x0000000000000000000000000000000000000000", feeBps: saleFeeBps, oracle: "0x0000000000000000000000000000000000000000" }]);
  await write(tok, "PermissionedToken", "grantRole", [ROLE("MINTER_ROLE"), sale]);
  return { reg, tok, sale };
};
const handover = async ({ reg, tok, sale }: { reg: Address; tok: Address; sale: Address }) => {
  await write(tok, "PermissionedToken", "grantRole", [ADMIN, treasury]);
  await write(sale, "PrimarySale", "grantRole", [ADMIN, treasury]);
  await write(reg, "InvestorRegistry", "grantRole", [ADMIN, treasury]);
  for (const r of ["MINTER_ROLE", "ENFORCER_ROLE", "PAUSER_ROLE"]) await write(tok, "PermissionedToken", "renounceRole", [ROLE(r), issuer.address]);
  await write(tok, "PermissionedToken", "renounceRole", [ADMIN, issuer.address]);
  await write(sale, "PrimarySale", "renounceRole", [ADMIN, issuer.address]);
  await write(reg, "InvestorRegistry", "renounceRole", [ADMIN, issuer.address]);
};
const pay = async (usd: string) => {
  const hash = await wc.writeContract({ address: USDG, abi: A.TestUSD.abi, functionName: "transfer", args: [safe, parseUnits(usd, 6)] });
  await pc.waitForTransactionReceipt({ hash });
  return hash;
};
const record = (id: string, c: { reg: Address; tok: Address; sale: Address }, feeTx?: string) =>
  api(`/assets/${id}/deployment`, { method: "POST", body: JSON.stringify({ registry: c.reg, token: c.tok, sale: c.sale, payToken: USDG, txs: [], feeTx }) });

await wc.writeContract({ address: USDG, abi: A.TestUSD.abi, functionName: "mint", args: [issuer.address, parseUnits("5000", 6)] });

const id1 = await mkDraft("AAA");
const c1 = await build("RH Test AAA", "AAA");
const r1 = await record(id1, c1);
check(r1.status === 422 && /legal sign-off/.test(r1.body.error) && /treasury/.test(r1.body.error), "mainnet refused without sign-off + treasury");
await api("/tenant", { method: "PATCH", body: JSON.stringify({ payments: { treasury }, onboarding: { counselReady: true } }) });

const r2 = await record(id1, c1);
check(r2.status === 422 && /handed to your treasury/.test(r2.body.error) && /offering fee/.test(r2.body.error), "refused before admin handover and before the fee is paid");
await handover(c1);

const short = await pay("999");
const r3 = await record(id1, c1, short);
check(r3.status === 422 && /offering fee not found/.test(r3.body.error), "refused when the fee payment is $1 short");

const feeTx = await pay("1000");
const r4 = await record(id1, c1, feeTx);
check(r4.status === 200 && r4.body.status === "deployed" && r4.body.deployment.feeTx === feeTx, `accepted with the $1,000 fee paid ${r4.status === 200 ? "" : JSON.stringify(r4.body)}`);

const id2 = await mkDraft("BBB");
const c2 = await build("RH Test BBB", "BBB");
await handover(c2);
const r5 = await record(id2, c2, feeTx);
check(r5.status === 422 && /already used/.test(r5.body.error), "the same fee payment can't be reused for a second offering");

const id3 = await mkDraft("CCC");
const c3 = await build("RH Test CCC", "CCC", 150);
await handover(c3);
const r6 = await record(id3, c3, await pay("1000"));
check(r6.status === 422 && /platform fee/.test(r6.body.error), "a sale that takes a % of the raise is refused");

const keeps = await Promise.all([
  pc.readContract({ address: c1.tok, abi: A.PermissionedToken.abi, functionName: "hasRole", args: [ADMIN, issuer.address] }),
  pc.readContract({ address: c1.sale, abi: A.PrimarySale.abi, functionName: "hasRole", args: [ADMIN, issuer.address] }),
]);
check(keeps.every((k) => k === false), "deployer wallet keeps no admin rights");
