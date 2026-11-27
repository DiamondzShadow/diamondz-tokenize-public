// End-to-end rehearsal against a local anvil chain posing as Robinhood Chain Testnet (46630):
// API draft -> browser-identical deploys -> API on-chain verification -> listing -> investor verify -> buy.
// Usage: anvil --chain-id 46630 --port 8546 &  API on :8913 with RPC_46630=http://127.0.0.1:8546, then
//   API=http://127.0.0.1:8913 SESSION=<sid> bun scripts/e2e-anvil.ts
import { createPublicClient, createWalletClient, http, keccak256, parseUnits, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import artifacts from "../src/contracts/artifacts.json";

const API = process.env.API ?? "http://127.0.0.1:8913";
const SESSION = process.env.SESSION!;
const RPC = "http://127.0.0.1:8546";
const chain = { id: 46630, name: "anvil-rh-test", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
// anvil default dev keys (public, test-only)
const issuer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const investor = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const pc = createPublicClient({ chain, transport: http(RPC) });
const wc = (a: typeof issuer) => createWalletClient({ account: a, chain, transport: http(RPC) });
const A = artifacts as any;

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(API + "/api" + path, {
    ...init,
    headers: { "content-type": "application/json", origin: API, cookie: `dt_session=${SESSION}`, host: "127.0.0.1" },
  });
  const body = await res.json();
  return { status: res.status, body };
}
async function deploy(name: string, args: unknown[]) {
  const hash = await wc(issuer).deployContract({ abi: A[name].abi, bytecode: A[name].bytecode as Hex, args });
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(name + " failed");
  return { address: r.contractAddress as Address, hash };
}
async function write(a: typeof issuer, address: Address, name: string, fn: string, args: unknown[]) {
  const hash = await wc(a).writeContract({ address, abi: A[name].abi, functionName: fn, args });
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(fn + " failed");
  return hash;
}
const read = (address: Address, name: string, fn: string, args: unknown[] = []) => pc.readContract({ address, abi: A[name].abi, functionName: fn, args }) as Promise<any>;
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) process.exitCode = 1;
};

const draft = await api("/assets", { method: "POST", body: JSON.stringify({ name: "Oak Ridge Duplex SPV", symbol: "OAKR", assetClass: "real-estate", standard: "erc7943", chainId: 46630, totalSupply: "1000000", pricePerToken: "1.5", minInvestment: "500" }) });
check(draft.status === 201, "create draft");
const id = draft.body.id;

const tenant = (await api("/tenant")).body;
const usd = await deploy("TestUSD", []);
const reg = await deploy("InvestorRegistry", [issuer.address, issuer.address, "0x0000000000000000000000000000000000000000"]); // RH testnet: no on-chain oracle
const tok = await deploy("PermissionedToken", [{ name: "Oak Ridge Duplex SPV", symbol: "OAKR", decimals: 18, maxSupply: 1_000_000n * 10n ** 18n, admin: issuer.address, registry: reg.address, documentURI: "", rules: "0x0000000000000000000000000000000000000000" }]);
const sale = await deploy("PrimarySale", [{ token: tok.address, payToken: usd.address, treasury: tenant.payments.treasury ?? issuer.address, admin: issuer.address, price: parseUnits("1.5", 6), cap: 1_000_000n * 10n ** 18n, minPurchase: parseUnits("500", 6), startsAt: 0n, endsAt: 0n, feeRecipient: "0x0000000000000000000000000000000000000000", feeBps: 0 /* testnet: no fee */, oracle: "0x0000000000000000000000000000000000000000" }]);

// Negative: before MINTER_ROLE is granted, verification must refuse.
const early = await api(`/assets/${id}/deployment`, { method: "POST", body: JSON.stringify({ registry: reg.address, token: tok.address, sale: sale.address, payToken: usd.address, txs: [] }) });
check(early.status === 422 && /MINTER_ROLE/.test(early.body.error), "verification refuses a sale that can't mint");

const g = await write(issuer, tok.address, "PermissionedToken", "grantRole", [keccak256(toHex("MINTER_ROLE")), sale.address]);

// Negative: listing before deploy must be refused.
const earlyList = await api(`/assets/${id}`, { method: "PATCH", body: JSON.stringify({ listed: true }) });
check(earlyList.status === 409, "can't list an undeployed asset");

const rec = await api(`/assets/${id}/deployment`, { method: "POST", body: JSON.stringify({ registry: reg.address, token: tok.address, sale: sale.address, payToken: usd.address, txs: [usd.hash, reg.hash, tok.hash, sale.hash, g] }) });
check(rec.status === 200 && rec.body.status === "deployed", `deployment verified on chain ${rec.status === 200 ? "" : JSON.stringify(rec.body)}`);

const termsEdit = await api(`/assets/${id}`, { method: "PATCH", body: JSON.stringify({ pricePerToken: "2" }) });
check(termsEdit.status === 409, "deployed terms are locked");

const list = await api(`/assets/${id}`, { method: "PATCH", body: JSON.stringify({ listed: true, description: "Two-unit rental in Austin.", location: "Austin, TX" }) });
check(list.status === 200 && list.body.listed === true, "listing switched on");
const market = (await fetch(API + "/api/market", { headers: { host: "127.0.0.1" } }).then((r) => r.json())) as any[];
check(market.length === 1 && market[0].id === id && !("tenantId" in market[0]), "public marketplace shows it (public fields only)");

// Sanctions screening endpoint (OFAC list): a known OFAC-listed address vs a clean one.
const bad = await api("/screen/0x7F367cC41522cE07553e823bf3be79A889DEbe1B?chainId=46630");
const good = await api(`/screen/${investor.address}?chainId=46630`);
check(bad.body.sanctioned === true && good.body.sanctioned === false, "OFAC screening flags a sanctioned wallet and clears a clean one");

// Investor flow, exactly as the Buy panel does it.
await write(issuer, reg.address, "InvestorRegistry", "setInvestor", [investor.address, true, 840, 0n]);
check(await read(tok.address, "PermissionedToken", "canReceive", [investor.address]), "investor verified");
await write(investor, usd.address, "TestUSD", "mint", [investor.address, parseUnits("10000", 6)]);
const qty = 1000n * 10n ** 18n;
const cost = (qty * parseUnits("1.5", 6) + 10n ** 18n - 1n) / 10n ** 18n;
await write(investor, usd.address, "TestUSD", "approve", [sale.address, cost]);
await write(investor, sale.address, "PrimarySale", "buy", [qty]);
check((await read(tok.address, "PermissionedToken", "balanceOf", [investor.address])) === qty, "investor received 1,000 OAKR");
const treasury = (await read(sale.address, "PrimarySale", "treasury")) as Address;
check((await read(usd.address, "TestUSD", "balanceOf", [treasury])) === cost, "treasury received 1,500 tUSD");
check((await read(sale.address, "PrimarySale", "sold")) === qty, "sale progress updated");
