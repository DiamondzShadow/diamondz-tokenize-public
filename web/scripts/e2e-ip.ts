// IP registry + licensing end to end (designs F1–F7) on a throwaway anvil chain (posing as RH testnet 46630) + a
// throwaway API: issuer saves the record and counsel templates → registers the asset NFT and publishes license types
// (exactly as IPPanel.tsx does) → API checks it on chain → public IP page, terms text whose sha256 is the signed hash
// → licensee request → issuer verifies → licensee buys → certificate status → revenue report → offer for a by-request
// deal → revocation.   bun scripts/e2e-ip.ts
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { createPublicClient, createWalletClient, http, keccak256, parseUnits, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import artifacts from "../src/contracts/artifacts.json";

const PORT_RPC = 8581, PORT_API = 8951, PORT_SS = 8961, PORT_STRIPE = 8971;
const RPC = `http://127.0.0.1:${PORT_RPC}`, API = `http://127.0.0.1:${PORT_API}`;
const chain = { id: 46630, name: "anvil", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const K = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
] as const;
const [platform, issuer, studio, streamer, verifierAcct, brand] = K.map((k) => privateKeyToAccount(k));
// Fake Sumsub (no signature check here; e2e-kyc covers the HMAC): applicants by externalUserId.
const applicants = new Map<string, any>();
let lastLevel = "";
// Fake Stripe: Connect accounts + Checkout sessions (direct charges carry the Stripe-Account header).
const sessions = new Map<string, any>();
let lastStripeAccount = "";
const st = Bun.serve({
  port: PORT_STRIPE,
  async fetch(req) {
    const u = new URL(req.url);
    if (req.headers.get("authorization") !== "Bearer sk_test_e2e") return Response.json({ error: { message: "bad key" } }, { status: 401 });
    const form = req.method === "POST" ? new URLSearchParams(await req.text()) : new URLSearchParams();
    if (req.method === "POST" && u.pathname === "/v1/accounts") return Response.json({ id: "acct_e2eIssuer01" });
    if (req.method === "POST" && u.pathname === "/v1/account_links") return Response.json({ url: `https://connect.stripe.test/onboard/${form.get("account")}` });
    if (req.method === "GET" && u.pathname === "/v1/accounts/acct_e2eIssuer01") return Response.json({ charges_enabled: true, details_submitted: true });
    if (req.method === "POST" && u.pathname === "/v1/checkout/sessions") {
      lastStripeAccount = req.headers.get("stripe-account") ?? "";
      const id = `cs_test_${sessions.size + 1}abcdef`;
      const metadata: Record<string, string> = {};
      for (const [k, v] of form) { const m = /^metadata\[(.+)\]$/.exec(k); if (m) metadata[m[1]!] = v; }
      sessions.set(id, { id, payment_status: "unpaid", amount_total: Number(form.get("line_items[0][price_data][unit_amount]")), currency: "usd", metadata });
      return Response.json({ id, url: `https://checkout.stripe.test/${id}` });
    }
    const m = /^\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/.exec(u.pathname);
    if (m && req.method === "GET") { const x = sessions.get(m[1]!); return x ? Response.json(x) : Response.json({ error: { message: "no such session" } }, { status: 404 }); }
    return Response.json({ error: { message: "not found" } }, { status: 404 });
  },
});
const ss = Bun.serve({
  port: PORT_SS,
  async fetch(req) {
    const u = new URL(req.url);
    if (req.method === "POST" && u.pathname === "/resources/accessTokens") { lastLevel = u.searchParams.get("levelName") ?? ""; return Response.json({ token: "_act-test", userId: u.searchParams.get("userId") }); }
    const byExt = /^\/resources\/applicants\/-;externalUserId=([^/]+)\/one$/.exec(u.pathname);
    if (byExt) { const a = applicants.get(decodeURIComponent(byExt[1]!)); return a ? Response.json(a) : Response.json({ code: 404 }, { status: 404 }); }
    return Response.json({ code: 404 }, { status: 404 });
  },
});
const A = artifacts as any;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const pc = createPublicClient({ chain, transport: http(RPC) });
const wc = (a: typeof issuer) => createWalletClient({ account: a, chain, transport: http(RPC) });
let failed = false;
const check = (ok: boolean, l: string) => (console.log(`${ok ? "PASS" : "FAIL"}  ${l}`), ok || (failed = true));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function deploy(a: typeof issuer, n: string, args: unknown[]) {
  const hash = await wc(a).deployContract({ abi: A[n].abi, bytecode: A[n].bytecode, args });
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`deploy ${n} reverted`);
  return r.contractAddress as Address;
}
async function write(a: typeof issuer, address: Address, n: string, fn: string, args: unknown[]) {
  const hash = await wc(a).writeContract({ address, abi: A[n].abi, functionName: fn, args });
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${fn} reverted`);
  return hash;
}
const read = (address: Address, n: string, fn: string, args: unknown[] = []) => pc.readContract({ address, abi: A[n].abi, functionName: fn, args }) as Promise<any>;
const reverts = (p: Promise<unknown>) => p.then(() => false, () => true);
const TEMPLATE = (n: string) => `${n.toUpperCase()} LICENSE, v1.0\n\nThis is a test template standing in for counsel's text. It grants the Licensee the rights described for ${n}, worldwide, for the stated term, subject to payment of the stated fee and any revenue share.`;

const anvil = spawn("anvil", ["--chain-id", "46630", "--port", String(PORT_RPC), "--silent"]);
let apiProc: ReturnType<typeof spawn> | null = null;
try {
  for (let i = 0; i < 50 && !(await pc.getBlockNumber().then(() => true, () => false)); i++) await sleep(100);

  // ---- platform: Test USD at RH testnet's address, the two registries
  const usd0 = await deploy(issuer, "TestUSD", []);
  const STABLE = "0xf2b2a7D121d2167BedBC6619A4A805786723e8CB" as Address;
  await pc.request({ method: "anvil_setCode" as any, params: [STABLE, await pc.getCode({ address: usd0 })] as any });
  for (const slot of ["0x3", "0x4"]) await pc.request({ method: "anvil_setStorageAt" as any, params: [STABLE, slot, await pc.getStorageAt({ address: usd0, slot: slot as Hex })] as any });
  const usd = STABLE;
  const assets = await deploy(platform, "AssetRegistry", []);
  const licenses = await deploy(platform, "LicenseRegistry", [assets, platform.address, `${API}/api/licenses/46630/`]);

  // ---- issuer: a deployed film offering (token admin = issuer)
  const reg = await deploy(issuer, "InvestorRegistry", [issuer.address, issuer.address, ZERO]);
  const token = await deploy(issuer, "PermissionedToken", [{ name: "Night Shift", symbol: "NITE", decimals: 18, maxSupply: 0n, admin: issuer.address, registry: reg, documentURI: "", rules: ZERO }]);

  // ---- API on a throwaway DB
  const dir = mkdtempSync(`${tmpdir()}/e2e-ip-`);
  const env = { ...process.env, PORT: String(PORT_API), DB_PATH: `${dir}/t.db`, EVIDENCE_DIR: `${dir}/ev`, DEFAULT_HOSTS: "127.0.0.1", ADMIN_DOMAINS: "example.com", RPC_46630: RPC, ASSET_ORACLE_46630: "none", IP_46630: `${assets}:${licenses}:0`, SUMSUB_APP_TOKEN: "sbx:test", SUMSUB_SECRET_KEY: "test", SUMSUB_BASE: `http://127.0.0.1:${PORT_SS}`, SUMSUB_KYB_LEVEL: "kyb-basic", IP_VERIFIER_KEY: K[4], STRIPE_SECRET_KEY: "sk_test_e2e", STRIPE_BASE: `http://127.0.0.1:${PORT_STRIPE}` };
  apiProc = spawn("bun", ["src/server.ts"], { cwd: import.meta.dir + "/../../api", env, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 60 && !(await fetch(`${API}/api/health`).then((r) => r.ok, () => false)); i++) await sleep(150);
  const db = new Database(`${dir}/t.db`);
  const sid = randomBytes(16).toString("hex");
  db.query("INSERT INTO sessions (id_hash, tenant_id, email, name, expires_at) VALUES (?, 'diamondz', 'qa@example.com', 'QA', ?)").run(createHash("sha256").update(sid).digest("hex"), Date.now() + 3_600_000);
  const now = new Date().toISOString();
  const film = { name: "Night Shift", symbol: "NITE", assetClass: "film", standard: "erc7943", chainId: 46630, totalSupply: "100000", pricePerToken: "10", minInvestment: "100", status: "deployed", listed: true, description: "A feature film.", imageUrl: "", location: "", schedule: "Quarterly", lockup: "", details: { holderPct: "30", stage: "production" }, documents: [{ kind: "copyright", name: "copyright.pdf", sha256: "a".repeat(64) }], deployment: { chainId: 46630, registry: reg, token, sale: token, payToken: usd, txs: [], deployedAt: now } };
  db.query("INSERT INTO assets (id, tenant_id, data, created_at, updated_at) VALUES ('ast_film', 'diamondz', ?, ?, ?)").run(JSON.stringify(film), now, now);
  db.query("INSERT INTO assets (id, tenant_id, data, created_at, updated_at) VALUES ('ast_house', 'diamondz', ?, ?, ?)").run(JSON.stringify({ ...film, name: "Harbor", symbol: "HARB", assetClass: "real-estate" }), now, now);
  const call = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`${API}/api${path}`, { ...init, headers: { "content-type": "application/json", origin: API, cookie: `dt_session=${sid}` } });
    const text = await r.text();
    let body: any; try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body, headers: r.headers };
  };

  // ---- 1. F4: save the record and templates
  const types = [
    { key: "clip", name: "Clip & promo", scope: "Up to 60 s", fee: "250", revSharePct: 0, durationDays: 365, territory: "Worldwide", byRequest: false, active: true, termsName: "Clip v1.0", termsText: TEMPLATE("clip") },
    { key: "remix", name: "Commercial remix", scope: "Derivative works", fee: "1000", revSharePct: 10, durationDays: 1095, territory: "Worldwide", byRequest: false, active: true, termsName: "Remix v1.0", termsText: TEMPLATE("remix") },
    { key: "distribution", name: "Distribution", scope: "By agreement", fee: "0", revSharePct: 0, durationDays: 730, territory: "By agreement", byRequest: true, active: true, termsName: "Distribution v1.0", termsText: TEMPLATE("distribution") },
  ];
  const draft = { imageUrl: "", summary: "A feature film.", identifiers: { EIDR: "10.5240/TEST-0001", US_COPYRIGHT: "PAu 1-234-567" }, holdersPct: 30, licenseTypes: types };
  const short = await call("/assets/ast_film/ip", { method: "PUT", body: JSON.stringify({ ...draft, licenseTypes: [{ ...types[0], termsText: "too short" }] }) });
  check(short.status === 400 && /template/.test(short.body.error), "API refuses a license type without the full template text");
  const house = await call("/assets/ast_house/ip", { method: "PUT", body: JSON.stringify(draft) });
  check(house.status === 400 && /film, music and collectibles/.test(house.body.error), "real estate gets a record but no licensing");
  const saved = await call("/assets/ast_film/ip", { method: "PUT", body: JSON.stringify(draft) });
  check(saved.status === 200 && saved.body.licenseTypes.length === 3, "record and 3 counsel templates saved");
  const hashes = Object.fromEntries(saved.body.licenseTypes.map((t: any) => [t.key, t.termsHash as Hex]));
  check(hashes.remix === `0x${createHash("sha256").update(TEMPLATE("remix")).digest("hex")}`, "terms hash = sha256 of the exact template text");

  // ---- 2. on chain, as IPPanel does it
  await write(issuer, assets, "AssetRegistry", "register", [{ offering: token, assetClass: keccak256(toHex("film")), uri: `${API}/api/ip/ast_film/meta`, docsManifest: `0x${"b".repeat(64)}`, payee: issuer.address, holdersBps: 3000, to: issuer.address, idKeys: ["EIDR", "US_COPYRIGHT"], idValues: ["10.5240/TEST-0001", "PAu 1-234-567"] }]);
  const assetId = (await read(assets, "AssetRegistry", "assetOf", [token])) as bigint;
  check(assetId === 1n && (await read(assets, "AssetRegistry", "ownerOf", [1n])) === issuer.address, "asset NFT #1 minted to the issuer");
  const typeIds: Record<string, string> = {};
  for (const t of types) {
    await write(issuer, licenses, "LicenseRegistry", "publishType", [{ assetId, termsHash: hashes[t.key], feeToken: usd, fee: parseUnits(t.fee, 6), revShareBps: t.revSharePct * 100, durationDays: t.durationDays, byRequest: t.byRequest, active: true, name: t.name, territory: t.territory, termsURI: `${API}/api/ip/ast_film/terms/${t.key}` }]);
    typeIds[t.key] = String(await read(licenses, "LicenseRegistry", "typeCount"));
  }
  // a type published with someone else's text is refused by the API check
  await write(issuer, licenses, "LicenseRegistry", "publishType", [{ assetId, termsHash: keccak256(toHex("other text")), feeToken: usd, fee: 0n, revShareBps: 0, durationDays: 365, byRequest: false, active: true, name: "Clip & promo", territory: "Worldwide", termsURI: "" }]);
  const wrongId = String(await read(licenses, "LicenseRegistry", "typeCount"));
  const wrong = await call("/assets/ast_film/ip/registered", { method: "POST", body: JSON.stringify({ assetId: "1", types: { clip: wrongId } }) });
  check(wrong.status === 422 && /fingerprint/.test(wrong.body.error), "API refuses a published type whose terms hash isn't the saved template");
  const ok = await call("/assets/ast_film/ip/registered", { method: "POST", body: JSON.stringify({ assetId: "1", types: typeIds }) });
  check(ok.status === 200, "API verifies the asset and every license type on chain");
  const edit = await call("/assets/ast_film/ip", { method: "PUT", body: JSON.stringify({ ...draft, licenseTypes: types.map((t) => (t.key === "clip" ? { ...t, termsText: TEMPLATE("clip") + " changed" } : t)) }) });
  check(edit.status === 409, "a published template can't be edited (new terms = new license type)");

  // ---- 3. public page, terms, metadata
  const page = (await call("/ip/ast_film")).body;
  check(page.assetId === "1" && page.identifiers.EIDR === "10.5240/TEST-0001" && page.licenseTypes.length === 3 && page.holdersBps === 3000, "public IP page: record, identifiers, 3 license types, holders' 30%");
  const terms = await fetch(`${API}/api/ip/ast_film/terms/remix`);
  const termsText = await terms.text();
  check(`0x${createHash("sha256").update(termsText).digest("hex")}` === hashes.remix && terms.headers.get("x-terms-sha256") === hashes.remix, "published terms text hashes to the on-chain fingerprint");
  const meta = (await call("/ip/ast_film/meta")).body;
  check(meta.name === "Night Shift" && meta.attributes.some((a: any) => a.trait_type === "EIDR"), "asset NFT metadata served");

  // ---- 4. licensee: request → verified → buy
  const rq = await fetch(`${API}/api/ip/ast_film/requests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: studio.address, company: "Test Games LLC", kind: "company", jurisdiction: "Delaware", email: "legal@example.com", typeKey: "remix", work: "Night Shift: The Game" }) });
  check(rq.status === 201, "licensee request accepted");
  const reqs = (await call("/assets/ast_film/ip/requests")).body;
  check(reqs[0]?.company === "Test Games LLC" && reqs[0]?.wallet === studio.address, "issuer sees the request (email stays private to the issuer)");
  check(!JSON.stringify((await call("/ip/ast_film")).body).includes("legal@example.com"), "public page never shows licensee contact details");
  await write(studio, usd, "TestUSD", "mint", [studio.address, parseUnits("50000", 6)]);
  await write(studio, usd, "TestUSD", "approve", [licenses, 2n ** 256n - 1n]);
  check(await reverts(wc(studio).writeContract({ address: licenses, abi: A.LicenseRegistry.abi, functionName: "buy", args: [BigInt(typeIds.remix!), hashes.remix, "Night Shift: The Game"] })), "unverified licensee can't buy");
  await write(issuer, licenses, "LicenseRegistry", "verifyLicensee", [assetId, studio.address, BigInt(Math.floor(Date.now() / 1000) + 365 * 86_400)]);
  await write(studio, licenses, "LicenseRegistry", "buy", [BigInt(typeIds.remix!), hashes.remix, "Night Shift: The Game"]);
  const cert = (await call("/licenses/46630/1")).body;
  check(cert.status === "active" && cert.licensee === studio.address && cert.termsHash === hashes.remix && cert.work === "Night Shift: The Game", "certificate endpoint: license #1 active, signed terms, work");
  check(await reverts(wc(studio).writeContract({ address: licenses, abi: A.LicenseRegistry.abi, functionName: "transferFrom", args: [studio.address, streamer.address, 1n] })), "license NFT can't be transferred");

  // ---- 5. revenue share, by-request offer, revocation, page totals
  await write(studio, licenses, "LicenseRegistry", "reportRevenue", [1n, parseUnits("20000", 6), "2027-Q1"]);
  await write(issuer, licenses, "LicenseRegistry", "verifyLicensee", [assetId, streamer.address, BigInt(Math.floor(Date.now() / 1000) + 365 * 86_400)]);
  await write(issuer, licenses, "LicenseRegistry", "makeOffer", [BigInt(typeIds.distribution!), { typeId: 0n, licensee: streamer.address, fee: parseUnits("5000", 6), revShareBps: 1500, durationDays: 730, termsHash: hashes.distribution, expiresAt: BigInt(Math.floor(Date.now() / 1000) + 14 * 86_400), used: false, territory: "Latin America" }]);
  await write(streamer, usd, "TestUSD", "mint", [streamer.address, parseUnits("10000", 6)]);
  await write(streamer, usd, "TestUSD", "approve", [licenses, 2n ** 256n - 1n]);
  await write(streamer, licenses, "LicenseRegistry", "acceptOffer", [1n, hashes.distribution, "LatAm streaming"]);
  check((await call("/licenses/46630/2")).body.territory === "Latin America", "negotiated distribution deal issued from an offer");
  await write(issuer, licenses, "LicenseRegistry", "revoke", [2n, "test revocation"]);
  check((await call("/licenses/46630/2")).body.status === "revoked", "revoked license shows as revoked on its certificate");
  await sleep(31_000); // page cache
  const p2 = (await call("/ip/ast_film")).body;
  check(p2.licenses.length === 2 && p2.royalties.fees === parseUnits("6000", 6).toString() && p2.royalties.revenueShares === parseUnits("2000", 6).toString(), "page totals: $6,000 fees, $2,000 revenue share");
  check(p2.royalties.holdersOwed === parseUnits("2400", 6).toString(), "holders owed 30% of $8,000 = $2,400");
  check(p2.history.some((h: any) => /revoked/.test(h.text)) && p2.history.some((h: any) => /IP registered/.test(h.text)), "history shows registration through revocation");
  check((await read(usd, "TestUSD", "balanceOf", [issuer.address])) === parseUnits("8000", 6), "all license money went straight to the rights holder");

  // ---- 6. licensee verification through Sumsub (business verification), recorded on chain by the platform verifier
  const cfg = (await call("/ip/config")).body;
  check(cfg.kyb === true && cfg.verifier === verifierAcct.address, "IP config: Sumsub on, platform verifier address published");
  await fetch(`${API}/api/ip/ast_film/requests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: brand.address, company: "Brand Co", kind: "company", jurisdiction: "New York", email: "rights@example.com", typeKey: "clip", work: "Ad campaign" }) });
  const ts = Math.floor(Date.now() / 1000);
  const msg = `Diamondz Tokenize identity check\nIssuer: diamondz\nWallet: ${brand.address}\nTime: ${ts}`;
  const start = await call("/kyc/start", { method: "POST", body: JSON.stringify({ wallet: brand.address, chainId: 46630, ts, signature: await brand.signMessage({ message: msg }), licensee: { assetId: "ast_film", kind: "company" } }) });
  check(start.status === 200 && lastLevel === "kyb-basic", "licensee company starts Sumsub at the business-verification level");
  const early = (await call("/ip/ast_film/verify-me", { method: "POST", body: JSON.stringify({ wallet: brand.address }) })).body;
  check(early.approved === false, "not verified before Sumsub approves");
  applicants.set(`diamondz-lickyb:${brand.address.toLowerCase()}`, { id: "app_b", review: { reviewStatus: "completed", reviewResult: { reviewAnswer: "GREEN" } } });
  await call(`/kyc/${start.body.id}?wallet=${brand.address}`); // investor-side poll refreshes the stored status
  await sleep(21_000); // the status re-read is throttled to every 20 s
  await call(`/kyc/${start.body.id}?wallet=${brand.address}`);
  const notAllowed = (await call("/ip/ast_film/verify-me", { method: "POST", body: JSON.stringify({ wallet: brand.address }) })).body;
  check(notAllowed.approved === true && notAllowed.onChain === false, "approved, but the holder hasn't allowed automatic verification yet");
  const reqs2 = (await call("/assets/ast_film/ip/requests")).body;
  check(reqs2.find((r: any) => r.wallet === brand.address)?.check === "approved", "issuer's request list shows the passed Sumsub check");
  await write(issuer, licenses, "LicenseRegistry", "setVerifier", [assetId, verifierAcct.address, true]);
  const auto = (await call("/ip/ast_film/verify-me", { method: "POST", body: JSON.stringify({ wallet: brand.address }) })).body;
  check(auto.onChain === true && !!auto.tx, "platform verifier records the licensee on chain");
  check(Number(await read(licenses, "LicenseRegistry", "verifiedUntil", [assetId, brand.address])) > Date.now() / 1000, "licensee verified on chain for a year");
  await write(brand, usd, "TestUSD", "mint", [brand.address, parseUnits("1000", 6)]);
  await write(brand, usd, "TestUSD", "approve", [licenses, 2n ** 256n - 1n]);
  await write(brand, licenses, "LicenseRegistry", "buy", [BigInt(typeIds.clip!), hashes.clip, "Ad campaign"]);
  check((await read(licenses, "LicenseRegistry", "balanceOf", [brand.address])) === 1n, "verified licensee buys a clip license");

  // ---- 7. card payment into the issuer's own Stripe account, then the license on chain with the receipt
  const noAcct = await fetch(`${API}/api/ip/ast_film/card-checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ typeKey: "clip", wallet: brand.address, work: "Spring ad" }) });
  check(noAcct.status === 409, "no card checkout before the issuer connects Stripe");
  const con = (await call("/cards/connect", { method: "POST" })).body;
  check(con.url?.includes("acct_e2eIssuer01") && con.account === "acct_e2eIssuer01", "issuer connects its own Stripe account (onboarding link)");
  const stt = (await call("/cards/status")).body;
  check(stt.chargesEnabled === true && stt.testMode === true, "Stripe account can take payments (test mode)");
  const patch = await call("/tenant", { method: "PATCH", body: JSON.stringify({ payments: { stripeAccount: "acct_someoneElse" } }) });
  check(patch.status === 200 && (await call("/cards/status")).body.account === "acct_e2eIssuer01", "the Stripe account can't be swapped through settings");
  const co = (await call("/ip/ast_film/card-checkout", { method: "POST", body: JSON.stringify({ typeKey: "clip", wallet: brand.address, work: "Spring ad" }) })).body;
  const csid = co.url?.split("/").pop();
  check(!!csid && lastStripeAccount === "acct_e2eIssuer01" && sessions.get(csid)?.amount_total === 25000, "checkout is a $250.00 direct charge on the issuer's account");
  const unpaid = await call("/ip/ast_film/card-receipt", { method: "POST", body: JSON.stringify({ session: csid, wallet: brand.address, typeKey: "clip" }) });
  check(unpaid.status === 409, "no receipt before Stripe says paid");
  sessions.get(csid)!.payment_status = "paid";
  const wrongWallet = await call("/ip/ast_film/card-receipt", { method: "POST", body: JSON.stringify({ session: csid, wallet: studio.address, typeKey: "clip" }) });
  check(wrongWallet.status === 409 && /different/.test(wrongWallet.body.error), "a payment can't be claimed by another wallet");
  const rc = (await call("/ip/ast_film/card-receipt", { method: "POST", body: JSON.stringify({ session: csid, wallet: brand.address, typeKey: "clip" }) })).body;
  check(!!rc.receipt?.sig && rc.receipt.amount === parseUnits("250", 6).toString(), "API confirms the payment with Stripe and signs a receipt for $250");
  const issuerBefore = await read(usd, "TestUSD", "balanceOf", [issuer.address]);
  await write(brand, licenses, "LicenseRegistry", "buyWithReceipt", [BigInt(rc.typeId), rc.termsHash, "Spring ad", { paymentRef: rc.receipt.paymentRef, amount: BigInt(rc.receipt.amount), deadline: BigInt(rc.receipt.deadline), sig: rc.receipt.sig }]);
  const n = await read(licenses, "LicenseRegistry", "licenseCount");
  const cardLic = (await call(`/licenses/46630/${n}`)).body;
  check(cardLic.status === "active" && cardLic.work === "Spring ad" && cardLic.feePaid === parseUnits("250", 6).toString(), "license issued on chain, fee recorded as paid by card");
  check((await read(usd, "TestUSD", "balanceOf", [issuer.address])) === issuerBefore, "no USDC moved: the money is in the issuer's Stripe account");
  const again = await call("/ip/ast_film/card-receipt", { method: "POST", body: JSON.stringify({ session: csid, wallet: brand.address, typeKey: "clip" }) });
  check(again.status === 409 && /already issued/.test(again.body.error), "one license per card payment");
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  st.stop(true);
  ss.stop(true);
  apiProc?.kill();
  anvil.kill();
}
console.log(failed ? "\nE2E IP: FAILED" : "\nE2E IP: ALL PASS");
process.exit(failed ? 1 : 0);
