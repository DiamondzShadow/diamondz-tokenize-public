// Stellar edition end to end (designs X1–X5) on REAL Stellar testnet + Base Sepolia, through a throwaway API:
//   draft (Stellar network forces the Stellar token type) → relayer deploys the full OZ RWA stack with the issuer
//   wallet as admin → Chainlink anchor registered on Base Sepolia → investor request → issuer verifies investors
//   → issue tokens → country allow-list, max balance, unverified recipient and freeze all enforced on chain.
//   bun scripts/e2e-stellar.ts            (needs stellar CLI identities tz-admin/tz-alice/tz-bob/tz-carol/tz-dave)
// Reads STELLAR_RELAYER_SECRET, STELLAR_CLAIM_SECRET, TREX_RELAYER_KEY from ~/.diamondz-tokenize.env into the API only.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { createPublicClient, http, type Address } from "viem";
import { suggestedRules } from "../src/lib/rules";
import { STELLAR_TESTNET_ID, networkById } from "../src/lib/chains";

const PORT_API = 8942;
const API = `http://127.0.0.1:${PORT_API}`;
let failed = false;
const check = (ok: boolean, l: string) => (console.log(`${ok ? "PASS" : "FAIL"}  ${l}`), ok || (failed = true));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (args: string[]) => execFileSync("stellar", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").pop()!;
const key = (who: string) => {
  try { return sh(["keys", "address", who]); } catch { sh(["keys", "generate", who, "--network", "testnet", "--fund"]); return sh(["keys", "address", who]); }
};
const invoke = (src: string, id: string, ...a: string[]) => {
  try { execFileSync("stellar", ["contract", "invoke", "--network", "testnet", "--source", src, "--id", id, "--", ...a], { stdio: "ignore" }); return true; } catch { return false; }
};

const envFile = Object.fromEntries(readFileSync(`${homedir()}/.diamondz-tokenize.env`, "utf8").split("\n")
  .map((l) => l.match(/^(STELLAR_RELAYER_SECRET|STELLAR_CLAIM_SECRET|TREX_RELAYER_KEY|UNIBLOCK_API_KEY)=(.*)$/)).filter(Boolean).map((m) => [m![1], m![2]!.trim()]));

const [issuer, alice, bob, carol, dave, tusdIssuer, treas] = ["tz-admin", "tz-alice", "tz-bob", "tz-carol", "tz-dave", "tz-tusd", "tz-treas"].map(key);
// Test payment asset (Circle's testnet USDC can't be scripted): TUSD issued by tz-tusd, wrapped as a Stellar Asset Contract.
const TUSD = `TUSD:${tusdIssuer}`;
try { sh(["contract", "asset", "deploy", "--asset", TUSD, "--source", "tz-tusd", "--network", "testnet"]); } catch { /* already deployed */ }
const TUSD_SAC = sh(["contract", "id", "asset", "--asset", TUSD, "--network", "testnet"]);
const tx = (...a: string[]) => { try { execFileSync("stellar", ["tx", "new", ...a, "--network", "testnet"], { stdio: "ignore" }); return true; } catch { return false; } };
for (const who of ["tz-admin", "tz-alice", "tz-carol"]) tx("change-trust", "--source-account", who, "--line", TUSD);
for (const w of [alice, carol]) tx("payment", "--source-account", "tz-tusd", "--destination", w, "--asset", TUSD, "--amount", String(10_000n * 10_000_000n));
const dir = mkdtempSync(`${tmpdir()}/e2e-stellar-`);
const env = { ...process.env, ...envFile, STELLAR_PAY_TOKEN_TESTNET: TUSD_SAC, STELLAR_PAY_ASSET_TESTNET: TUSD, STELLAR_SALE_SKIP_PROOF: "1", PORT: String(PORT_API), DB_PATH: `${dir}/t.db`, EVIDENCE_DIR: `${dir}/ev`, DEFAULT_HOSTS: "127.0.0.1", ADMIN_DOMAINS: "example.com" };
const apiProc = spawn("bun", ["src/server.ts"], { cwd: import.meta.dir + "/../../api", env, stdio: ["ignore", "ignore", "inherit"] });
try {
  for (let i = 0; i < 100 && !(await fetch(`${API}/api/health`).then((r) => r.ok, () => false)); i++) await sleep(100);
  const db = new Database(`${dir}/t.db`);
  const sid = randomBytes(16).toString("hex");
  db.query("INSERT INTO sessions (id_hash, tenant_id, email, name, expires_at) VALUES (?, 'diamondz', 'qa@example.com', 'QA', ?)").run(createHash("sha256").update(sid).digest("hex"), Date.now() + 3_600_000);
  const api = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`${API}/api${path}`, { ...init, headers: { "content-type": "application/json", origin: API, cookie: `dt_session=${sid}` } });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  };
  const post = (path: string, body: unknown) => api(path, { method: "POST", body: JSON.stringify(body) });

  // ---- draft
  const rules = { ...suggestedRules("real-estate", "506c", {}), accreditedOnly: false, countryMode: "allow", countries: [840], lockupDays: 0, maxHolderPct: 0.05, maxHolders: 0, resaleApproval: false, maturity: "", saleStartsAt: "", saleEndsAt: "" };
  const base = { name: "E2E Stellar Property", symbol: "E2ES", assetClass: "real-estate", totalSupply: "1000000", pricePerToken: "10", minInvestment: "50", rules };
  check((await post("/assets", { ...base, standard: "erc7943", chainId: STELLAR_TESTNET_ID })).status === 400, "an EVM token type on Stellar is refused");
  check((await post("/assets", { ...base, standard: "stellar-rwa", chainId: 84532 })).status === 400, "the Stellar token type on an EVM network is refused");
  const draft = await post("/assets", { ...base, standard: "stellar-rwa", chainId: STELLAR_TESTNET_ID });
  check(draft.status === 201, `Stellar draft created (${draft.status} ${draft.body?.error ?? ""})`);
  const id = draft.body.id;

  // ---- deploy (relayer; issuer wallet = admin)
  check((await post(`/assets/${id}/stellar/deploy`, { issuer: "not-a-wallet" })).status === 400, "deploy needs a Stellar wallet");
  const started = await post(`/assets/${id}/stellar/deploy`, { issuer });
  check(started.status === 200 && started.body.stellar?.status === "deploying", "deploy started");
  let a: any = null;
  const t0 = Date.now();
  for (let i = 0; i < 400; i++) {
    a = (await api(`/assets/${id}`)).body;
    if (a?.stellar?.status !== "deploying") break;
    await sleep(3_000);
  }
  console.log(`      deploy took ${Math.round((Date.now() - t0) / 1000)}s, ${Object.keys(a?.stellar?.steps ?? {}).length} steps${a?.stellar?.error ? `, error: ${a.stellar.error}` : ""}`);
  check(a?.status === "deployed" && a?.stellar?.status === "deployed", "offering deployed");
  const d = a.deployment;
  const info = (await api(`/stellar/testnet/${d.token}`)).body;
  check(info?.name === base.name && info?.symbol === base.symbol && info?.decimals === 7 && info?.totalSupply === "0", "token reads back from Stellar (name, symbol, 7 decimals, supply 0)");
  check(Object.keys(d.modules).sort().join(",") === "countryAllow,maxBalance,supplyLimit", `rules became modules (${Object.keys(d.modules).join(", ")})`);

  // ---- Chainlink anchor on Base Sepolia
  const evm = networkById(84532)!;
  const pc = createPublicClient({ transport: http(evm.rpc) });
  const anchor = d.anchor.address as Address;
  const sc = await pc.readContract({ address: anchor, abi: [{ type: "function", name: "stellarContract", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }], functionName: "stellarContract" });
  check(sc === d.token, `anchor ${anchor} on Base Sepolia points at the Stellar token`);
  const reg = await pc.readContract({ address: evm.assetOracle!.address, abi: [{ type: "function", name: "registration", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bytes32" }, { type: "bytes32[]" }] }], functionName: "registration", args: [anchor] }).catch(() => null);
  check(!!reg && reg[0] !== "0x" + "0".repeat(64), "anchor registered on AssetOracle");

  // ---- investors
  const req = await fetch(`${API}/api/stellar/assets/${id}/requests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: dave, country: 840 }) });
  check(req.status === 200, "investor can request verification from the listing");
  check((await api(`/stellar/assets/${id}/status/${dave}`)).body?.status === "requested", "request shows as requested");
  for (const [who, cc] of [[alice, 840], [bob, 840], [carol, 124]] as const) {
    const v = await post(`/assets/${id}/stellar/verify`, { account: who, country: cc });
    check(v.status === 200, `verified ${who === alice ? "alice" : who === bob ? "bob" : "carol"} (${cc}) ${v.body?.error ?? ""}`);
  }
  check((await post(`/assets/${id}/stellar/issue`, { account: alice, amount: "100" })).status === 200, "issued 100 to alice");
  check((await post(`/assets/${id}/stellar/issue`, { account: carol, amount: "10" })).status === 422, "issuing to a Canadian investor is blocked (US only)");
  check((await post(`/assets/${id}/stellar/issue`, { account: bob, amount: "600" })).status === 422, "issuing 600 to bob is blocked (max 500 per investor)");
  check((await post(`/assets/${id}/stellar/issue`, { account: dave, amount: "1" })).status === 409, "issuing to an unverified wallet is refused");
  check(!invoke("tz-alice", d.token, "transfer", "--from", alice, "--to", dave, "--amount", "10000000"), "alice can't send to an unverified wallet");
  check(invoke("tz-alice", d.token, "transfer", "--from", alice, "--to", bob, "--amount", "100000000"), "alice → bob 10 (both verified, US)");
  check((await post(`/assets/${id}/stellar/freeze`, { account: alice, freeze: true })).status === 200, "issuer froze alice");
  check(!invoke("tz-alice", d.token, "transfer", "--from", alice, "--to", bob, "--amount", "10000000"), "frozen alice can't send");
  check((await post(`/assets/${id}/stellar/freeze`, { account: alice, freeze: false })).status === 200, "issuer unfroze alice");
  // pause / unpause: admin-only, so the issuer signs (here with the testnet tz-admin key, in the app via Freighter)
  const { Keypair, TransactionBuilder: TB } = await import("../../api/node_modules/@stellar/stellar-sdk");
  const issuerKp = Keypair.fromSecret(sh(["keys", "secret", "tz-admin"]));
  const signPause = async (paused: boolean) => {
    const prep = await post(`/assets/${id}/stellar/pause`, { paused });
    if (!prep.body?.xdr) throw new Error(`pause prepare: ${prep.status} ${JSON.stringify(prep.body)}`);
    const tx = TB.fromXDR(prep.body.xdr, "Test SDF Network ; September 2015");
    tx.sign(issuerKp);
    return post(`/assets/${id}/stellar/pause`, { paused, signedXdr: tx.toXDR() });
  };
  const wrong = await post(`/assets/${id}/stellar/pause`, { paused: true });
  if (!wrong.body?.xdr) throw new Error(`pause prepare: ${wrong.status} ${JSON.stringify(wrong.body)}`);
  const wtx = TB.fromXDR(wrong.body.xdr, "Test SDF Network ; September 2015"); wtx.sign(issuerKp);
  check((await post(`/assets/${id}/stellar/pause`, { paused: false, signedXdr: wtx.toXDR() })).status === 400, "a signed pause can't be submitted as an unpause");
  check((await signPause(true)).status === 200, "issuer paused the token (signed)");
  check(!invoke("tz-bob", d.token, "transfer", "--from", bob, "--to", alice, "--amount", "10000000"), "transfers blocked while paused");
  check((await signPause(false)).status === 200, "issuer unpaused the token (signed)");
  // ---- primary sale via the sale wizard (W12): terms + a separate treasury account that needs a TUSD trustline
  check(!d.sale, "deploy no longer creates the sale (the sale wizard does)");
  // a fresh treasury every run, so the trustline step is exercised
  try { execFileSync("stellar", ["keys", "rm", "tz-treas", "--force"], { stdio: "ignore" }); } catch { /* none */ }
  const treasury = key("tz-treas");
  const facts0 = (await api(`/stellar-account/testnet/${treasury}`)).body;
  check(facts0?.exists === true && facts0?.canReceive === false && facts0?.multisig === false && facts0?.signers === 1, `account check: treasury exists, single signer, no TUSD line yet (${JSON.stringify(facts0)})`);
  const terms = { price: "10", minimum: "50", treasury, capTokens: "800", startsAt: 0, endsAt: 0 };
  const noLine = await post(`/assets/${id}/stellar/sale/setup`, terms);
  check(noLine.status === 422 && /trustline/.test(noLine.body?.error ?? ""), "sale wizard refuses a treasury that can't receive the pay token");
  check((await post(`/assets/${id}/stellar/sale/setup`, { ...terms, capTokens: "9999999" })).status === 400, "can't sell more than the supply");
  const tl = await post(`/stellar-trustline/testnet`, { account: treasury });
  const tlTx = TB.fromXDR(tl.body.xdr, "Test SDF Network ; September 2015"); tlTx.sign(Keypair.fromSecret(sh(["keys", "secret", "tz-treas"])));
  check((await post(`/stellar-trustline/testnet`, { account: treasury, signedXdr: tlTx.toXDR() })).status === 200, "trustline added to the treasury (prepared, signed, submitted)");
  check((await api(`/stellar-account/testnet/${treasury}`)).body?.canReceive === true, "account check: treasury can now receive TUSD");
  const made = await post(`/assets/${id}/stellar/sale/setup`, terms);
  check(made.status === 200 && !!made.body?.deployment?.sale && made.body.deployment.saleTerms?.treasury === treasury, `sale created with the wizard's terms (${made.body?.error ?? made.body?.deployment?.sale})`);
  d.sale = made.body.deployment.sale; d.payToken = made.body.deployment.payToken;
  check(!!d.sale && d.payToken === TUSD_SAC, `sale pays in TUSD (${d.sale})`);
  const saleInfo = async () => (await api(`/stellar/assets/${id}/sale`)).body.sale;
  let si = await saleInfo();
  check(si && si.open === false && si.canMint === false && si.price === "100000000", "sale starts closed, without mint rights, $10 a token");
  check((await post(`/assets/${id}/stellar/sale/open`, { open: true })).status === 409, "can't open before the issuer approves minting");
  const g1 = await post(`/assets/${id}/stellar/sale/grant`, {});
  const gtx = TB.fromXDR(g1.body.xdr, "Test SDF Network ; September 2015"); gtx.sign(issuerKp);
  check((await post(`/assets/${id}/stellar/sale/grant`, { signedXdr: gtx.toXDR() })).status === 200, "issuer approved the sale (signed grant_role)");
  const op = await post(`/assets/${id}/stellar/sale/open`, { open: true });
  check(op.status === 200, `sale opened ${op.body?.error ?? ""}`);
  const tusdBal = (w: string) => { try { return BigInt(execFileSync("stellar", ["contract", "invoke", "--network", "testnet", "--source", "tz-admin", "--id", TUSD_SAC, "--", "balance", "--id", w], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().replace(/"/g, "")); } catch { return -1n; } };
  const treasury0 = tusdBal(treasury);
  const buy = async (who: string, kp: string, amount: string, submitAmount = amount) => {
    const prep = await fetch(`${API}/api/stellar/assets/${id}/buy`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ buyer: who, amount }) });
    const pj: any = await prep.json();
    if (!pj.xdr) return { status: prep.status, body: pj };
    const t = TB.fromXDR(pj.xdr, "Test SDF Network ; September 2015"); t.sign(Keypair.fromSecret(sh(["keys", "secret", kp])));
    const r = await fetch(`${API}/api/stellar/assets/${id}/buy`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ buyer: who, amount: submitAmount, signedXdr: t.toXDR() }) });
    return { status: r.status, body: await r.json() as any };
  };
  const b1 = await buy(alice, "tz-alice", "10");
  check(b1.status === 200, `alice bought 10 tokens online (${b1.body?.error ?? b1.body?.tx})`);
  check(tusdBal(treasury) - treasury0 === 100n * 10_000_000n, "the wizard's treasury account received exactly $100");
  const low = await buy(alice, "tz-alice", "1");
  check(low.status === 422 && /minimum/i.test(low.body?.error ?? ""), `$10 is below the $50 minimum (${low.body?.error})`);
  const carol0 = tusdBal(carol);
  const ca = await buy(carol, "tz-carol", "10");
  check(ca.status === 422, "a Canadian investor can't buy (US-only rule, payment reverted)");
  check(carol0 > 0n && tusdBal(carol) === carol0, "carol kept all her TUSD");
  check((await buy(dave, "tz-dave", "10")).status === 409, "an unverified wallet can't buy");
  check((await buy(alice, "tz-alice", "10", "20")).status === 400, "a signed purchase can't be resubmitted as a bigger one");
  si = await saleInfo();
  check(si.sold === String(10n * 10_000_000n), "sale counted 10 tokens sold");
  check((await post(`/assets/${id}/stellar/sale/open`, { open: false })).status === 200, "sale closed");
  const shut = await buy(alice, "tz-alice", "10");
  check(shut.status === 422 && /closed/i.test(shut.body?.error ?? ""), "buying from a closed sale is refused");

  const bal = async (w: string) => (await api(`/stellar/testnet/${d.token}/balance/${w}`)).body?.balance;
  await sleep(16_000); // API read cache is 15s
  check((await bal(alice)) === "1000000000" && (await bal(bob)) === "100000000", "balances: alice 100 (90 + 10 bought), bob 10");
  console.log(`\n${failed ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED"}  token ${d.token}  anchor ${anchor}`);
} finally {
  apiProc.kill();
}
process.exit(failed ? 1 : 0);
