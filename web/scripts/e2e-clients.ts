// Client accounts for advisors (design 4, 2026-11-20) against a throwaway API: the firm invites a client by private
// link, the client links THEIR OWN wallet with a signed consent, only clients who passed the offering's checks can be
// allocated, proposals reach only that client, the client approves or declines, other firms can't see the clients,
// and the link token is stored only as a hash.
//   bun scripts/e2e-clients.ts
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const PORT = 8977;
const API = `http://127.0.0.1:${PORT}`;
let failed = false;
const check = (ok: boolean, l: string) => (console.log(`${ok ? "PASS" : "FAIL"}  ${l}`), ok || (failed = true));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let proc: ReturnType<typeof spawn> | null = null;
try {
  const dir = mkdtempSync(`${tmpdir()}/e2e-clients-`);
  proc = spawn("bun", ["src/server.ts"], {
    cwd: import.meta.dir + "/../../api",
    env: { ...process.env, STORE: "", MONGO_URI: "", PORT: String(PORT), DB_PATH: `${dir}/t.db`, DEFAULT_HOSTS: "127.0.0.1", ADMIN_DOMAINS: "example.com", BANK_PROOF_TICK: "0", TEMPORAL_JOBS: "", MFA_ENC_KEY: "", RESEND_API_KEY: "" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 80 && !(await fetch(`${API}/api/health`).then((r) => r.ok, () => false)); i++) await sleep(150);
  const db = new Database(`${dir}/t.db`);
  const jar = new Map<string, string>();
  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(`${API}/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json", origin: API, ...(jar.get(who) ? { cookie: `dt_session=${jar.get(who)}` } : {}) } });
    const sc = r.headers.get("set-cookie"); const m = sc && /dt_session=([^;]+)/.exec(sc); if (m) jar.set(who, m[1]!);
    const t = await r.text(); let j: any = null; try { j = JSON.parse(t); } catch { /* */ }
    return { status: r.status, body: j };
  };
  const login = async (who: string, acct: ReturnType<typeof privateKeyToAccount>) => {
    const n = await call(who, "GET", "/auth/nonce");
    const message = n.body.message.replace("{address}", acct.address);
    return call(who, "POST", "/auth/thirdweb", { address: acct.address, chainId: 84532, nonce: n.body.nonce, issuedAt: n.body.issuedAt, signature: await acct.signMessage({ message }), email: `${who}@firm.example` });
  };
  const firm = privateKeyToAccount(generatePrivateKey()), other = privateKeyToAccount(generatePrivateKey());
  const alice = privateKeyToAccount(generatePrivateKey()), bob = privateKeyToAccount(generatePrivateKey());
  await login("firm", firm); await call("firm", "POST", "/workspaces", { name: "Crestline Wealth" });
  await login("other", other); await call("other", "POST", "/workspaces", { name: "Other Advisors" });

  // a listed, deployed 506(c) offering from the platform's own issuer
  const t = new Date().toISOString();
  const asset = { name: "Harbor Credit Note I", symbol: "HCN", assetClass: "private-credit", standard: "erc7943", chainId: 84532, totalSupply: "1000000", pricePerToken: "1", minInvestment: "10000", status: "deployed", listed: true, exemption: "506c", description: "", imageUrl: "", location: "", schedule: "", lockup: "", deployment: { chainId: 84532, token: "0x0000000000000000000000000000000000000001", sale: "0x0000000000000000000000000000000000000002", txs: [], deployedAt: t } };
  db.query("INSERT INTO assets (id, tenant_id, data, created_at, updated_at) VALUES ('ast_00000000000000c1', 'diamondz', ?, ?, ?)").run(JSON.stringify(asset), t, t);

  const inv = await call("firm", "POST", "/clients", { name: "Alice Rivera", email: "alice@example.com", kind: "individual" });
  check(inv.status === 200 && /\/client\/[A-Za-z0-9_-]+$/.test(inv.body.link ?? ""), "firm invites a client; the private link comes back to send");
  const tokA = inv.body.link.split("/client/")[1];
  const invB = await call("firm", "POST", "/clients", { name: "Bob Trust", email: "bob@example.com", kind: "trust" });
  const tokB = invB.body.link.split("/client/")[1];
  check((await call("firm", "POST", "/clients", { name: "Alice Again", email: "alice@example.com", kind: "individual" })).status === 409, "the same client can't be added twice");
  check(!JSON.stringify(db.query("SELECT * FROM docs").all()).includes(tokA), "the link token is stored only as a hash");

  const portal = await call("anon", "GET", `/client-portal/${tokA}`);
  check(portal.status === 200 && portal.body.firm === "Crestline Wealth" && portal.body.wallet === null && portal.body.message.includes("{wallet}"), "the client sees who invited them and the consent to sign");
  check((await call("anon", "GET", `/client-portal/${"x".repeat(32)}`)).status === 404, "a made-up link is refused");
  const msgA = portal.body.message.replace("{wallet}", alice.address);
  check((await call("anon", "POST", `/client-portal/${tokA}/link`, { wallet: alice.address, chainId: 84532, signature: await bob.signMessage({ message: msgA }) })).status === 401, "someone else's signature can't link Alice's wallet");
  check((await call("anon", "POST", `/client-portal/${tokA}/link`, { wallet: alice.address, chainId: 84532, signature: await alice.signMessage({ message: msgA }) })).status === 200, "Alice links her own wallet with a signed consent");
  const pB = await call("anon", "GET", `/client-portal/${tokB}`);
  await call("anon", "POST", `/client-portal/${tokB}/link`, { wallet: bob.address, chainId: 84532, signature: await bob.signMessage({ message: pB.body.message.replace("{wallet}", bob.address) }) });

  const list = await call("firm", "GET", "/clients");
  check(list.status === 200 && list.body.clients.length === 2 && list.body.clients.every((c: any) => c.wallet), "the firm sees both clients with their wallets");
  check(list.body.offerings.some((o: any) => o.id === "ast_00000000000000c1"), "…and the open offerings");
  check((await call("other", "GET", "/clients")).body.clients.length === 0, "another firm can't see these clients");

  const cs = list.body.clients;
  const idA = cs.find((c: any) => c.name === "Alice Rivera").id, idB = cs.find((c: any) => c.name === "Bob Trust").id;
  let el = await call("firm", "GET", "/clients/eligibility/ast_00000000000000c1");
  check(el.body.clients[idA].eligible === false && el.body.clients[idA].identity === "not started", "before any checks, nobody can be allocated");
  check((await call("firm", "POST", "/clients/proposals", { assetId: "ast_00000000000000c1", items: [{ clientId: idA, amountUsd: 25000 }] })).status === 400, "allocating to an unverified client is refused");

  // Alice passes identity + accreditation with the issuer; Bob only identity
  const k = (id: string, w: string) => db.query("INSERT INTO kyc (id, tenant_id, wallet, applicant_id, status, reject_labels, user_comment, created_at, updated_at) VALUES (?, 'diamondz', ?, 'x', 'approved', NULL, NULL, ?, ?)").run(id, w.toLowerCase(), t, t);
  k("kyc_a", alice.address); k("kyc_b", bob.address);
  db.query("INSERT INTO accreditation (id, tenant_id, asset_id, wallet, route, status, mc_customer_id, consent_text, consent_at, decision, created_at, updated_at) VALUES ('acc_a', 'diamondz', 'ast_00000000000000c1', ?, 'income', 'ready', 'm', 'c', ?, 'approved', ?, ?)").run(alice.address.toLowerCase(), t, t, t);
  el = await call("firm", "GET", "/clients/eligibility/ast_00000000000000c1");
  check(el.body.clients[idA].eligible === true, "Alice (identity + accreditation) can be allocated");
  check(el.body.clients[idB].eligible === false && el.body.clients[idB].accredited === "not started", "Bob (identity only) can't, on an accredited-only offering");
  check((await call("firm", "POST", "/clients/proposals", { assetId: "ast_00000000000000c1", items: [{ clientId: idA, amountUsd: 5000 }] })).status === 400, "an amount under the offering minimum is refused");
  check((await call("firm", "POST", "/clients/proposals", { assetId: "ast_00000000000000c1", items: [{ clientId: idA, amountUsd: 25000 }, { clientId: idB, amountUsd: 25000 }] })).status === 400, "a batch with one ineligible client is refused whole");
  const pr = await call("firm", "POST", "/clients/proposals", { assetId: "ast_00000000000000c1", items: [{ clientId: idA, amountUsd: 25000 }] });
  check(pr.status === 200 && pr.body.proposals.length === 1, "proposal sent to Alice");
  const prId = pr.body.proposals[0].id;
  check((await call("anon", "GET", `/client-portal/${tokB}`)).body.proposals.length === 0, "Bob doesn't see Alice's proposal");
  check((await call("anon", "POST", `/client-portal/${tokB}/proposals/${prId}`, { decision: "approve" })).status === 404, "Bob can't approve Alice's proposal");
  const ap = await call("anon", "POST", `/client-portal/${tokA}/proposals/${prId}`, { decision: "approve" });
  check(ap.status === 200 && ap.body.investUrl === "/invest/ast_00000000000000c1?amount=25000", "Alice approves and is sent to the investor flow to buy from her own wallet");
  check((await call("anon", "POST", `/client-portal/${tokA}/proposals/${prId}`, { decision: "decline" })).status === 409, "a decided proposal can't change");
  check((await call("firm", "GET", "/clients/proposals")).body.proposals[0].status === "approved", "the firm sees it approved");

  check((await call("firm", "DELETE", `/clients/${idB}`)).status === 200 && (await call("anon", "GET", `/client-portal/${tokB}`)).status === 404, "removing a client also kills their link");
  check((await call("other", "DELETE", `/clients/${idA}`)).status === 404, "another firm can't remove the client");
} catch (e) { console.error(e); failed = true; } finally { proc?.kill(); }
console.log(failed ? "\nCLIENTS: FAILURES" : "\nCLIENTS: ALL PASS");
process.exit(failed ? 1 : 0);
