// Stellar MAINNET rules, proven on testnet before real XLM is spent (STELLAR_MAINNET_RULES_ON_TESTNET=1):
//   gates: legal sign-off, multisig admin (single-sig refused), fee payment checked + never reused
//   deploy: issuer multisig = admin, issuer operator wallet = manager, platform relayer RENOUNCES every role after
//           setup (core contracts: manager; modules: manager + admin) — checked on chain
//   claims: investor claims are signed by the issuer's own EVM wallet (Ethereum personal_sign, the same path a Trezor or
//           Ledger behind MetaMask takes); a claim from any other wallet is refused; the claim issuer has no owner left
//   operations: verify / issue / freeze are prepared txs the OPERATOR signs; the relayer can no longer do them;
//               pause needs the multisig (one signature isn't enough)
//   bun scripts/e2e-stellar-mainnet.ts
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { Keypair, TransactionBuilder } from "../../api/node_modules/@stellar/stellar-sdk";
import { suggestedRules } from "../src/lib/rules";
import { STELLAR_TESTNET_ID } from "../src/lib/chains";
import { termsHash } from "../../api/src/legal";
import { privateKeyToAccount, generatePrivateKey } from "../../api/node_modules/viem/accounts";
import { claimSignerMessage } from "../../api/src/stellardeploy";
import { stellarById } from "../src/lib/chains";

const PASS = "Test SDF Network ; September 2015";
const PORT_API = 8944;
const API = `http://127.0.0.1:${PORT_API}`;
let failed = false;
const check = (ok: boolean, l: string) => (console.log(`${ok ? "PASS" : "FAIL"}  ${l}`), ok || (failed = true));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (args: string[]) => execFileSync("stellar", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").pop()!;
const key = (who: string) => {
  try { return sh(["keys", "address", who]); } catch { sh(["keys", "generate", who, "--network", "testnet", "--fund"]); return sh(["keys", "address", who]); }
};
const kp = (who: string) => Keypair.fromSecret(sh(["keys", "secret", who]));
const tx = (...a: string[]) => { try { execFileSync("stellar", ["tx", "new", ...a, "--network", "testnet"], { stdio: "ignore" }); return true; } catch { return false; } };
const read = (src: string, id: string, ...a: string[]) => { try { return execFileSync("stellar", ["contract", "invoke", "--network", "testnet", "--source", src, "--id", id, "--", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return "ERR"; } };
const invoke = (src: string, id: string, ...a: string[]) => read(src, id, ...a) !== "ERR";

const envFile = Object.fromEntries(readFileSync(`${homedir()}/.diamondz-tokenize.env`, "utf8").split("\n")
  .map((l) => l.match(/^(STELLAR_RELAYER_SECRET|STELLAR_CLAIM_SECRET|TREX_RELAYER_KEY|UNIBLOCK_API_KEY)=(.*)$/)).filter(Boolean).map((m) => [m![1], m![2]!.trim()]));

// ---- accounts: multisig admin (2 of 2), a single-sig admin (must be refused), the issuer's operator wallet, fee account
const [ms, ms2, single, op, fee, alice, tusdIssuer] = ["tz-ms", "tz-ms2", "tz-single", "tz-op", "tz-fee", "tz-alice", "tz-tusd"].map(key);
const relayerPub = Keypair.fromSecret(envFile.STELLAR_RELAYER_SECRET!).publicKey();
// Make tz-ms a real multisig once: master weight 1 + tz-ms2 weight 1, medium/high threshold 2.
const msInfo = JSON.parse(execFileSync("curl", ["-s", `https://horizon-testnet.stellar.org/accounts/${ms}`], { encoding: "utf8" }));
if ((msInfo.signers ?? []).length < 2)
  tx("set-options", "--source-account", "tz-ms", "--signer", ms2, "--signer-weight", "1", "--master-weight", "1", "--low-threshold", "1", "--med-threshold", "2", "--high-threshold", "2");
// Fee: TUSD stands in for USDC on testnet. The operator pays $1,000 (Launch plan) to the fee account.
const TUSD = `TUSD:${tusdIssuer}`;
try { sh(["contract", "asset", "deploy", "--asset", TUSD, "--source", "tz-tusd", "--network", "testnet"]); } catch { /* exists */ }
for (const who of ["tz-op", "tz-fee"]) tx("change-trust", "--source-account", who, "--line", TUSD);
tx("payment", "--source-account", "tz-tusd", "--destination", op, "--asset", TUSD, "--amount", String(5_000n * 10_000_000n));

// Legal clearance (2026-11-20) needs a Stripe-verified company: a fake Stripe answers for the test's company account.
const fakeStripe = Bun.serve({ port: 8945, fetch: () => new Response(JSON.stringify({ id: "acct_T", details_submitted: true, requirements: { currently_due: [], past_due: [], disabled_reason: null }, capabilities: { transfers: "active" }, company: { name: "Test Co" } }), { headers: { "content-type": "application/json" } }) });
const dir = mkdtempSync(`${tmpdir()}/e2e-stellar-main-`);
const env = {
  STRIPE_BASE: "http://127.0.0.1:8945", STRIPE_AI_AGENT_KEY: "rk_test_fake", MFA_ENC_KEY: "",
  ...process.env, ...envFile, STELLAR_MAINNET_RULES_ON_TESTNET: "1", STELLAR_FEE_ACCOUNT_TESTNET: fee, STELLAR_FEE_ASSET_TESTNET: TUSD,
  PORT: String(PORT_API), DB_PATH: `${dir}/t.db`, EVIDENCE_DIR: `${dir}/ev`, DEFAULT_HOSTS: "127.0.0.1", ADMIN_DOMAINS: "example.com",
};
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
  /** Legal clearance = company verified (fake Stripe) + lawyer signed the CURRENT terms + Diamondz approved. */
  const setCounsel = (ready: boolean, assetId: string) => {
    const t = new Date().toISOString();
    if (!ready) { db.query("DELETE FROM docs WHERE coll IN ('legal','kyb')").run(); return; }
    const a = JSON.parse((db.query("SELECT data FROM assets WHERE id = ?").get(assetId) as { data: string }).data);
    const terms = termsHash({ ...a, id: assetId });
    db.query("INSERT OR REPLACE INTO docs (coll, id, tenant_id, data, created_at, updated_at) VALUES ('kyb', 'diamondz', 'diamondz', ?, ?, ?)").run(JSON.stringify({ accountId: "acct_T" }), t, t);
    const legalDoc = { counsel: { name: "Dana Whitfield", firm: "W&P LLP", email: "d@wp.example", barState: "NY", barNumber: "4821907" }, tokenHash: "x", invitedAt: t, invitedBy: "qa", expiresAt: t,
      letter: { sha256: "0".repeat(64), bytes: 500, at: t }, signed: { at: t, name: "Dana Whitfield", barState: "NY", barNumber: "4821907", terms, ip: null },
      review: { decision: "approved", by: "qa", at: t, licenseFound: true, note: "", terms } };
    db.query("INSERT OR REPLACE INTO docs (coll, id, tenant_id, data, created_at, updated_at) VALUES ('legal', ?, 'diamondz', ?, ?, ?)").run(assetId, JSON.stringify(legalDoc), t, t);
  };
  /** prepare → sign (by these keys) → submit, for operator- or multisig-signed actions */
  const signed = async (path: string, body: any, signers: Keypair[]) => {
    const prep = await post(path, body);
    if (!prep.body?.xdr) return prep;
    const t = TransactionBuilder.fromXDR(prep.body.xdr, PASS);
    for (const k of signers) t.sign(k);
    return post(path, { ...body, signedXdr: t.toXDR() });
  };

  // fee payment (operator → fee account)
  // the CLI prints "Signing transaction: <hash>" on stderr
  const pay = spawnSync("stellar", ["tx", "new", "payment", "--source-account", "tz-op", "--destination", fee, "--asset", TUSD, "--amount", String(1_000n * 10_000_000n), "--network", "testnet"], { encoding: "utf8" });
  const feeTx = /Signing transaction: ([0-9a-f]{64})/.exec(`${pay.stdout}${pay.stderr}`)?.[1] ?? "";
  check(/^[0-9a-f]{64}$/.test(feeTx), `operator paid the $1,000 offering fee (${feeTx})`);

  const rules = { ...suggestedRules("real-estate", "506c", {}), accreditedOnly: false, countryMode: "allow", countries: [840], lockupDays: 0, maxHolderPct: 1, maxHolders: 0, resaleApproval: false, maturity: "", saleStartsAt: "", saleEndsAt: "" };
  const draft = await post("/assets", { name: "Mainnet Rules Property", symbol: "MRP", assetClass: "real-estate", standard: "stellar-rwa", chainId: STELLAR_TESTNET_ID, totalSupply: "1000000", rules });
  const id = draft.body.id;
  // The issuer's claim-signing wallet (stands in for a hardware wallet behind MetaMask).
  const claimWallet = privateKeyToAccount(generatePrivateKey());
  const strangerWallet = privateKeyToAccount(generatePrivateKey());
  const net = stellarById(STELLAR_TESTNET_ID)!;
  const claimSigner = { address: claimWallet.address, signature: await claimWallet.signMessage({ message: claimSignerMessage(id, net, claimWallet.address) }) };
  const dep = (b: any) => post(`/assets/${id}/stellar/deploy`, b.admin ? { claimSigner, ...b } : b);

  setCounsel(false, id);
  const g1 = await dep({ admin: ms, operator: op, feeTx });
  check(g1.status === 422 && /lawyer|company/.test(g1.body?.error ?? ""), "deploy refused without the company check and the lawyer's sign-off");
  setCounsel(true, id);
  const g2 = await dep({ admin: single, operator: op, feeTx });
  check(g2.status === 422 && /multisig/.test(g2.body?.error ?? ""), `a single-signer admin is refused (${(g2.body?.error ?? "").slice(0, 90)})`);
  const g3 = await dep({ admin: op, operator: op, feeTx });
  check(g3.status === 422 && /not the wallet you use day to day/.test(g3.body?.error ?? ""), "admin can't be the operator wallet");
  const g4 = await dep({ admin: ms, operator: op, feeTx: "ab".repeat(32) });
  check(g4.status === 422 && /fee payment not found/.test(g4.body?.error ?? ""), "an unknown fee payment is refused");
  check((await dep({ issuer: op })).status === 400, "the testnet one-wallet form is refused under mainnet rules");
  const badSigner = { address: claimWallet.address, signature: await strangerWallet.signMessage({ message: claimSignerMessage(id, net, claimWallet.address) }) };
  const g5 = await dep({ admin: ms, operator: op, feeTx, claimSigner: badSigner });
  check(g5.status === 400 && /claim-signing wallet/.test(g5.body?.error ?? ""), "a claim-signing wallet named with someone else's signature is refused");

  const started = await dep({ admin: ms, operator: op, feeTx });
  check(started.status === 200 && started.body?.stellar?.status === "deploying", `deploy started (${started.body?.error ?? ""})`);
  let a: any = null;
  const t0 = Date.now();
  for (let i = 0; i < 400; i++) { a = (await api(`/assets/${id}`)).body; if (a?.stellar?.status !== "deploying") break; await sleep(3_000); }
  console.log(`      deploy took ${Math.round((Date.now() - t0) / 1000)}s, ${Object.keys(a?.stellar?.steps ?? {}).length} steps${a?.stellar?.error ? `, error: ${a.stellar.error}` : ""}`);
  check(a?.status === "deployed", "offering deployed");
  const d = a.deployment;
  check(Object.keys(a.stellar.steps).filter((k) => k.startsWith("handover.")).length === 5 + 2 * Object.keys(d.modules).length, "handover steps recorded for every contract");
  check(a.stellar.claimSigner?.address === claimWallet.address, "the issuer's claim-signing wallet is recorded");

  // ---- on chain: who holds what
  const has = (c: string, who: string) => read("tz-admin", c, "has_role", "--account", who, "--role", "manager");
  for (const [k, c] of [["token", d.token], ["registry", d.registry], ["compliance", d.compliance], ["claim topics", d.claimTopicsAndIssuers]] as const) {
    check(has(c, relayerPub) === "null" || has(c, relayerPub) === "", `${k}: platform relayer holds NO manager role`);
    check(!["null", "", "ERR"].includes(has(c, op)), `${k}: issuer's operator wallet is manager`);
    check(read("tz-admin", c, "get_admin").replace(/"/g, "") === ms, `${k}: admin is the issuer's multisig`);
  }
  for (const [k, m] of Object.entries(d.modules) as [string, string][]) {
    check(["null", ""].includes(read("tz-admin", m, "get_admin")), `${k} module: no admin left (rules locked)`);
    check(["null", ""].includes(has(m, relayerPub)), `${k} module: relayer gave up manager`);
  }

  // fee can't be reused
  const other = await post("/assets", { name: "Second", symbol: "SEC", assetClass: "real-estate", standard: "stellar-rwa", chainId: STELLAR_TESTNET_ID, totalSupply: "1000", rules });
  const otherSigner = { address: claimWallet.address, signature: await claimWallet.signMessage({ message: claimSignerMessage(other.body.id, net, claimWallet.address) }) };
  const reuse = await post(`/assets/${other.body.id}/stellar/deploy`, { admin: ms, operator: op, feeTx, claimSigner: otherSigner });
  check(reuse.status === 422 && /already used/.test(reuse.body?.error ?? ""), "the same fee payment can't deploy a second offering");

  // ---- claim issuer: the issuer's EVM key is the only claim key; nobody owns the contract any more
  const pkHex = a.stellar.claimSigner.publicKey.slice(2);
  check(read("tz-admin", d.claimIssuer, "is_eth_key_allowed", "--public_key", pkHex, "--registry", d.claimTopicsAndIssuers, "--claim_topic", "1") === "true", "claim issuer: the issuer's wallet key is allowed for KYC");
  check(["null", ""].includes(read("tz-admin", d.claimIssuer, "get_owner")), "claim issuer: no owner left (the platform can't add a key)");
  check(!invoke("tz-relayer", d.claimIssuer, "allow_eth_key", "--public_key", "04" + "11".repeat(64), "--registry", d.claimTopicsAndIssuers, "--claim_topic", "1"), "the platform relayer can't add a claim key");

  // ---- verify: platform prepares the identity → the issuer's claim wallet signs each claim → the operator signs
  const vp = await post(`/assets/${id}/stellar/verify`, { account: alice, country: 840 });
  check(vp.status === 200 && Array.isArray(vp.body?.claims) && vp.body.claims.length >= 2 && vp.body.claimSigner === claimWallet.address, `verify asks the issuer's claim wallet to sign ${vp.body?.claims?.length ?? 0} claims (${vp.body?.error ?? ""})`);
  const sigBy = (w: typeof claimWallet) => Promise.all(vp.body.claims.map(async (c: any) => ({ topic: c.topic, signature: await w.signMessage({ message: { raw: c.digest } }) })));
  const forged = await post(`/assets/${id}/stellar/verify`, { account: alice, country: 840, claimSignatures: await sigBy(strangerWallet) });
  check(forged.status === 400 && /not this offering's claim signer/.test(forged.body?.error ?? ""), "claims signed by another wallet are refused");
  const claimSignatures = await sigBy(claimWallet);
  const v = await signed(`/assets/${id}/stellar/verify`, { account: alice, country: 840, claimSignatures }, [kp("tz-op")]);
  check(v.status === 200 && v.body?.stellar?.investors?.some((i: any) => i.account === alice), `operator verified alice (${v.body?.error ?? ""})`);
  const iss = await signed(`/assets/${id}/stellar/issue`, { account: alice, amount: "100" }, [kp("tz-op")]);
  check(iss.status === 200, `operator issued 100 to alice (${iss.body?.error ?? ""})`);
  check(!invoke("tz-relayer", d.token, "mint", "--to", alice, "--amount", "10000000", "--operator", relayerPub), "the platform relayer can no longer mint");
  const wrongSigner = await signed(`/assets/${id}/stellar/issue`, { account: alice, amount: "1" }, [kp("tz-alice")]);
  check(wrongSigner.status !== 200, "a mint signed by anyone but the operator fails");
  const fz = await signed(`/assets/${id}/stellar/freeze`, { account: alice, freeze: true }, [kp("tz-op")]);
  check(fz.status === 200, "operator froze alice");
  await signed(`/assets/${id}/stellar/freeze`, { account: alice, freeze: false }, [kp("tz-op")]);

  // ---- admin actions need the multisig
  const oneSig = await signed(`/assets/${id}/stellar/pause`, { paused: true }, [kp("tz-ms")]);
  check(oneSig.status !== 200, "pause with ONE multisig signature is rejected");
  const twoSig = await signed(`/assets/${id}/stellar/pause`, { paused: true }, [kp("tz-ms"), kp("tz-ms2")]);
  check(twoSig.status === 200, `pause with BOTH multisig signatures works (${twoSig.body?.error ?? ""})`);
  await signed(`/assets/${id}/stellar/pause`, { paused: false }, [kp("tz-ms"), kp("tz-ms2")]);

  console.log(`\n${failed ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED"}  token ${d.token}`);
} finally {
  apiProc.kill();
  fakeStripe.stop(true);
}
process.exit(failed ? 1 : 0);
