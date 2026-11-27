// Signed checks through Adobe Acrobat Sign, end to end (designs E1–E7): a stand-in Adobe server, a throwaway anvil
// chain (posing as Robinhood Chain Testnet, 46630) with the real AssetOracle, and a throwaway API + database.
// Touches no real network, no real Adobe account and no real database.
//   bun scripts/e2e-esign.ts
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { createPublicClient, createWalletClient, http, parseUnits, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import artifacts from "../src/contracts/artifacts.json";
import { CLASS_CHECKS, classHash, kindHash } from "../src/lib/verification";

const PORT_RPC = 8551, PORT_API = 8981, FAKE = 8982;
const RPC = `http://127.0.0.1:${PORT_RPC}`, API = `http://127.0.0.1:${PORT_API}`, FAKE_URL = `http://127.0.0.1:${FAKE}`;
const chain = { id: 46630, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
// anvil default dev keys (public, test-only)
const K = {
  platform: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  issuer: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  attester: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
} as const;
const issuerW = privateKeyToAccount(K.issuer), attester = privateKeyToAccount(K.attester);
const A = artifacts as any;
const pc = createPublicClient({ chain, transport: http(RPC) });
const wc = createWalletClient({ account: issuerW, chain, transport: http(RPC) });
let failed = false;
const check = (ok: boolean, l: string) => (console.log(`${ok ? "PASS" : "FAIL"}  ${l}`), ok || (failed = true));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");

// ---------------------------------------------------------------- stand-in Adobe Acrobat Sign (REST v6)
const docs = new Map<string, Uint8Array>();
const agreements = new Map<string, { body: any; status: string }>();
const calls: string[] = [];
const SIGNED_PDF = new TextEncoder().encode("%PDF-1.4\nsigned letter with Adobe signature fields filled\n%%EOF\n");
const AUDIT_PDF = new TextEncoder().encode("%PDF-1.4\nAdobe audit report: created, emailed, viewed, GOV_ID verified, e-signed\n%%EOF\n");
const fake = Bun.serve({
  port: FAKE,
  async fetch(req) {
    const u = new URL(req.url);
    const j = (x: unknown, s = 200) => new Response(JSON.stringify(x), { status: s, headers: { "content-type": "application/json" } });
    if (req.headers.get("authorization") !== "Bearer test-integration-key") return j({ code: "INVALID_ACCESS_TOKEN", message: "bad key" }, 401);
    const p = u.pathname.replace(/^\/api\/rest\/v6/, "");
    calls.push(`${req.method} ${p}`);
    if (p === "/baseUris") return j({ apiAccessPoint: `${FAKE_URL}/`, webAccessPoint: `${FAKE_URL}/` });
    if (p === "/transientDocuments" && req.method === "POST") {
      const f = (await req.formData()).get("File") as File;
      const id = `tdoc_${randomBytes(4).toString("hex")}`;
      docs.set(id, new Uint8Array(await f.arrayBuffer()));
      return j({ transientDocumentId: id }, 201);
    }
    if (p === "/agreements" && req.method === "POST") {
      const body = await req.json();
      const id = `CBJCHBCAABAA${randomBytes(6).toString("hex")}`;
      agreements.set(id, { body, status: "OUT_FOR_SIGNATURE" });
      return j({ id }, 201);
    }
    if (p === "/webhooks" && req.method === "POST") return j({ id: "wh_1" }, 201);
    const m = /^\/agreements\/([^/]+)(\/.*)?$/.exec(p);
    const ag = m ? agreements.get(m[1]!) : undefined;
    if (!m || !ag) return j({ code: "INVALID_AGREEMENT_ID", message: "no such agreement" }, 404);
    const sub = m[2] ?? "";
    if (sub === "" && req.method === "GET") return j({ id: m[1], status: ag.status });
    if (sub === "/signingUrls") return ag.status === "OUT_FOR_SIGNATURE" ? j({ signingUrlSetInfos: [{ signingUrls: [{ email: ag.body.participantSetsInfo[0].memberInfos[0].email, esignUrl: `https://secure.na1.adobesign.com/public/apiesign?pid=${m[1]}` }] }] }) : j({ code: "AGREEMENT_NOT_SIGNABLE", message: "not signable" }, 400);
    if (sub === "/state" && req.method === "PUT") { ag.status = (await req.json() as any).state; return j({}); }
    if (sub === "/members") return j({ participantSets: [{ status: "WAITING_FOR_MY_SIGNATURE", memberInfos: [{ id: "pm_1" }] }] });
    if (sub === "/reminders" && req.method === "POST") return j({ id: "rem_1" }, 201);
    if (sub.startsWith("/combinedDocument")) return new Response(SIGNED_PDF, { headers: { "content-type": "application/pdf" } });
    if (sub === "/auditTrail") return new Response(AUDIT_PDF, { headers: { "content-type": "application/pdf" } });
    return j({ code: "NOT_FOUND", message: "fake: no route" }, 404);
  },
});

function sh(cmd: string, args: string[], env: Record<string, string> = {}) {
  return new Promise<string>((resolve, reject) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: import.meta.dir + "/.." });
    let out = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(out))));
  });
}
async function deploy(name: string, args: unknown[]) {
  const r = await pc.waitForTransactionReceipt({ hash: await wc.deployContract({ abi: A[name].abi, bytecode: A[name].bytecode as Hex, args }) });
  if (r.status !== "success") throw new Error(name);
  return r.contractAddress as Address;
}
async function write(address: Address, name: string, fn: string, args: unknown[]) {
  const r = await pc.waitForTransactionReceipt({ hash: await wc.writeContract({ address, abi: A[name].abi, functionName: fn, args }) });
  if (r.status !== "success") throw new Error(fn);
}

const anvil = spawn("anvil", ["--chain-id", "46630", "--port", String(PORT_RPC), "--silent"]);
let proc: ReturnType<typeof spawn> | null = null;
try {
  for (let i = 0; i < 50 && !(await pc.getBlockNumber().then(() => true, () => false)); i++) await sleep(100);

  // ---- chain: oracle (real admin script), the e-sign attester approved for title + insurance, one gated offering
  const out = await sh("bun", ["scripts/oracle.ts", "deploy", "--chain", "46630", "--execute"], { RPC_46630: RPC, PRIVATE_KEY: K.platform });
  const m = out.match(/assetOracle: \{ address: "(0x[0-9a-fA-F]{40})", fromBlock: (\d+) \}/);
  const oracle = m![1] as Address;
  const ORACLE_ENV = { RPC_46630: RPC, PRIVATE_KEY: K.platform, ASSET_ORACLE_46630: `${oracle}:${m![2]}` };
  await sh("bun", ["scripts/oracle.ts", "add-verifier", "--chain", "46630", "--oracle", oracle, "--address", attester.address, "--name", "Diamondz e-sign (Adobe Acrobat Sign)", "--kinds", "TITLE,INSURANCE", "--execute"], ORACLE_ENV);
  const usd = await deploy("TestUSD", []);
  const registry = await deploy("InvestorRegistry", [issuerW.address, issuerW.address, "0x0000000000000000000000000000000000000000"]);
  const token = await deploy("PermissionedToken", [{ name: "Harbor Duplex SPV", symbol: "HBRD", decimals: 18, maxSupply: 10n ** 24n, admin: issuerW.address, registry, documentURI: "", rules: "0x0000000000000000000000000000000000000000" }]);
  const sale = await deploy("PrimarySale", [{ token, payToken: usd, treasury: issuerW.address, admin: issuerW.address, price: parseUnits("1", 6), cap: 10n ** 24n, minPurchase: 0n, startsAt: 0n, endsAt: 0n, feeRecipient: "0x0000000000000000000000000000000000000000", feeBps: 0, oracle }]);
  await write(oracle, "AssetOracle", "register", [token, classHash("real-estate"), CLASS_CHECKS["real-estate"].map(kindHash)]);

  // ---- API
  const dir = mkdtempSync(`${tmpdir()}/e2e-esign-`);
  proc = spawn("bun", ["src/server.ts"], {
    cwd: import.meta.dir + "/../../api",
    env: { ...process.env, ...ORACLE_ENV, PRIVATE_KEY: "", STORE: "", MONGO_URI: "", PORT: String(PORT_API), DB_PATH: `${dir}/t.db`, EVIDENCE_DIR: `${dir}/ev`, DEFAULT_HOSTS: "127.0.0.1", ADMIN_DOMAINS: "example.com",
      BANK_PROOF_TICK: "0", TEMPORAL_JOBS: "", MFA_ENC_KEY: "", RESEND_API_KEY: "", ADOBE_SIGN_INTEGRATION_KEY: "test-integration-key", ADOBE_SIGN_API: FAKE_URL,
      ESIGN_ATTESTER_KEY: K.attester, TREX_RELAYER_KEY: K.platform, PUBLIC_ORIGIN: API, LOG_INDEX_NO_PERSIST: "1" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 80 && !(await fetch(`${API}/api/health`).then((r) => r.ok, () => false)); i++) await sleep(150);
  const db = new Database(`${dir}/t.db`);
  const jar = new Map<string, string>();
  const call = async (who: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const cookie = jar.get(who);
    const r = await fetch(`${API}/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json", origin: API, ...(cookie ? { cookie } : {}), ...headers } });
    for (const sc of r.headers.getSetCookie?.() ?? []) { const mm = /^(dt_session)=([^;]+)/.exec(sc); if (mm) jar.set(who, `${mm[1]}=${mm[2]}`); }
    const t = await r.text(); let jj: any = null; try { jj = JSON.parse(t); } catch { /* */ }
    return { status: r.status, body: jj, headers: r.headers };
  };
  const owner = privateKeyToAccount(generatePrivateKey());
  const n = await call("iss", "GET", "/auth/nonce");
  await call("iss", "POST", "/auth/thirdweb", { address: owner.address, chainId: 84532, nonce: n.body.nonce, issuedAt: n.body.issuedAt, signature: await owner.signMessage({ message: n.body.message.replace("{address}", owner.address) }), email: "owner@harborbank.com" });
  await call("iss", "POST", "/workspaces", { name: "Harbor Private Bank" });
  const created = await call("iss", "POST", "/assets", { name: "Harbor Duplex", symbol: "HBRD", assetClass: "real-estate", standard: "erc7943", chainId: 46630, totalSupply: "1000000" });
  const id = created.body?.id ?? created.body?.asset?.id;
  // Mark it deployed + listed (the wizard's on-chain deploy is covered by other tests).
  const row = db.query("SELECT data FROM assets WHERE id = ?").get(id) as { data: string };
  db.query("UPDATE assets SET data = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(row.data), status: "deployed", listed: true, deployment: { chainId: 46630, token, sale, registry, payToken: usd, txs: [] } }), id);
  const psid = randomBytes(16).toString("hex");
  db.query("INSERT INTO sessions (id_hash, tenant_id, email, name, expires_at) VALUES (?, 'diamondz', 'admin@example.com', 'Admin', ?)").run(sha(psid), Date.now() + 3_600_000);
  jar.set("plat", `dt_session=${psid}`);
  const E = `/assets/${id}/esign`;

  // ---- firms (platform) + issuer view
  const g0 = await call("iss", "GET", E);
  check(g0.status === 200 && g0.body.configured === true && g0.body.firms.length === 0 && g0.body.kinds.some((k: any) => k.id === "TITLE"), "issuer sees the checks for real estate; no approved firms yet");
  check((await call("iss", "POST", "/platform/esign/firms", { name: "x", domain: "x.com", kinds: ["TITLE"] })).status === 403, "an issuer can't approve verifier firms");
  const f1 = await call("plat", "POST", "/platform/esign/firms", { name: "Acme Title Insurance Co.", domain: "acmetitle.com", kinds: ["TITLE"] });
  const f2 = await call("plat", "POST", "/platform/esign/firms", { name: "Harbor Mutual Insurance", domain: "harbormutual.com", kinds: ["INSURANCE"] });
  check(f1.status === 200 && f2.status === 200, "platform admin approves two verifier firms");
  const g1 = await call("iss", "GET", E);
  check(g1.body.firms.length === 2, "issuer now sees both firms");

  // ---- send for signature
  const req = (over: Record<string, unknown> = {}) => call("iss", "POST", E, { kind: "TITLE", firmId: f1.body.firm.id, signerName: "Maria Lopez", signerEmail: "mlopez@acmetitle.com", idMethod: "GOV_ID", note: "Policy A-1029", ...over });
  check((await req({ signerEmail: "maria@gmail.com" })).status === 400, "signer email must be at the firm's domain");
  check((await req({ firmId: f2.body.firm.id })).status === 400, "a firm can only sign the checks it's approved for");
  check((await req({ kind: "VALUATION" })).status === 400, "a check with no approved firm is refused");
  check((await req({ idMethod: "PHONE" })).status === 400, "the phone method needs a number");
  const s1 = await req();
  check(s1.status === 200 && s1.body.request.status === "sent", "request sent through Adobe");
  check((await req()).status === 409, "a second request for the same check is refused while one is open");
  const [agrId, ag] = [...agreements.entries()].at(-1)!;
  const mem = ag.body.participantSetsInfo[0].memberInfos[0];
  check(mem.email === "mlopez@acmetitle.com" && mem.securityOption.authenticationMethod === "GOV_ID" && ag.body.signatureType === "ESIGN" && ag.body.state === "IN_PROCESS", "agreement: one signer, government-ID check, sent at once");
  check(ag.body.externalId.id === s1.body.request.id && /EVERY_THIRD_DAY/.test(ag.body.reminderFrequency) && Date.parse(ag.body.expirationTime) > Date.now() + 29 * 86_400_000, "agreement carries our id, reminders every 3 days, 30-day expiry");
  const pdfText = new TextDecoder("latin1").decode(docs.get(ag.body.fileInfos[0].transientDocumentId)!);
  check(pdfText.startsWith("%PDF-1.4") && pdfText.includes("{{Sig_es_:signer1:signature}}") && pdfText.includes("{{*Ref_es_:signer1}}") && pdfText.includes(token), "the letter is a real PDF with Adobe text tags and the token address");
  check(!JSON.stringify(s1.body).includes("/sign/") && !JSON.stringify(g1.body).includes("tokenHash"), "the signer's private link is never shown to the issuer");
  const tok = /\/sign\/([A-Za-z0-9_-]+)/.exec(ag.body.message)![1]!;
  check(!JSON.stringify(db.query("SELECT data FROM docs").all()).includes(tok), "the signer's link token is stored only as a hash");

  // ---- signer's page (E3)
  const sp = await call("anon", "GET", `/esign/sign/${tok}`);
  check(sp.status === 200 && sp.body.offering === "Harbor Duplex" && sp.body.kindName === "Title & ownership" && sp.body.idMethod === "GOV_ID" && !("signerEmail" in sp.body), "signer's page shows the request, not the email");
  check((await call("anon", "GET", `/esign/sign/${"x".repeat(32)}`)).status === 404, "a made-up link shows nothing");
  const su = await call("anon", "POST", `/esign/sign/${tok}/url`);
  check(su.status === 200 && su.body.url.startsWith("https://secure.na1.adobesign.com/"), "signer gets Adobe's signing page");

  // ---- webhook: Adobe's ownership check, then events
  const wv = await fetch(`${API}/api/esign/adobe/webhook`, { headers: { "X-AdobeSign-ClientId": "client-123" } });
  check(wv.headers.get("x-adobesign-clientid") === "client-123", "webhook verification echoes Adobe's client id");
  const hook = (event: string, agreementId = agrId) => fetch(`${API}/api/esign/adobe/webhook`, { method: "POST", headers: { "content-type": "application/json", "X-AdobeSign-ClientId": "client-123" }, body: JSON.stringify({ event, agreement: { id: agreementId, status: "SIGNED" } }) });
  await hook("AGREEMENT_EMAIL_VIEWED");
  await sleep(500);
  check((await call("iss", "GET", E)).body.requests[0].status === "opened", "viewed event: timeline shows opened");
  await hook("AGREEMENT_WORKFLOW_COMPLETED");
  await sleep(800);
  check((await call("iss", "GET", E)).body.requests[0].status === "opened", "a webhook claiming 'signed' is ignored while Adobe's API says out for signature");
  const r0 = await hook("AGREEMENT_WORKFLOW_COMPLETED", "CBJCHBCAABAAunknown00");
  check(r0.status === 200, "an unknown agreement id is accepted and ignored");

  // ---- signed in Adobe → files kept → recorded on chain
  ag.status = "SIGNED";
  await hook("AGREEMENT_WORKFLOW_COMPLETED");
  let done: any = null;
  for (let i = 0; i < 60; i++) { done = (await call("iss", "GET", E)).body.requests[0]; if (done.status === "recorded" || done.recordError) break; await sleep(300); }
  check(done.status === "recorded" && /^0x[0-9a-f]{64}$/.test(done.tx ?? ""), `signed → recorded on chain${done.recordError ? ` (${done.recordError})` : ""}`);
  const latest = (await pc.readContract({ address: oracle, abi: A.AssetOracle.abi, functionName: "latest", args: [token, kindHash("TITLE")] })) as any;
  const ev = await call("anon", "GET", `/esign/${done.id}/evidence`);
  const letter = new Uint8Array(await (await fetch(`${API}${ev.body.letter.url}`)).arrayBuffer());
  const audit = new Uint8Array(await (await fetch(`${API}${ev.body.audit.url}`)).arrayBuffer());
  const recomputed = `0x${sha(JSON.stringify({ letter: sha(letter), audit: sha(audit) }))}`;
  check(latest.verifier.toLowerCase() === attester.address.toLowerCase() && Number(latest.result) === 1, "on chain: the e-sign attester signed TITLE = pass");
  check(latest.evidenceHash === recomputed && ev.body.evidenceHash === recomputed, "anyone can recompute the on-chain fingerprint from the signed letter + audit report");
  check(sha(letter) === sha(SIGNED_PDF) && sha(audit) === sha(AUDIT_PDF) && latest.evidenceURI.endsWith(`/api/esign/${done.id}/evidence`), "the stored files are Adobe's, and the on-chain record points at them");
  const pub = await call("anon", "GET", `/market/${id}/esign`);
  check(pub.status === 200 && pub.body.checks.length === 1 && pub.body.checks[0].signerName === "Maria Lopez" && pub.body.checks[0].firmName === "Acme Title Insurance Co." && !JSON.stringify(pub.body).includes("acmetitle.com"), "listing shows who signed and how, without their email");
  await hook("AGREEMENT_WORKFLOW_COMPLETED");
  await sleep(500);
  const txCount = (await call("iss", "GET", E)).body.requests.filter((x: any) => x.tx).length;
  check(txCount === 1, "a repeated webhook doesn't record twice");

  // ---- remind, cancel, decline (insurance)
  const s2 = await req({ kind: "INSURANCE", firmId: f2.body.firm.id, signerName: "Tom Reyes", signerEmail: "treyes@harbormutual.com", idMethod: "PHONE", phone: { countryCode: "+1", phone: "2125550100" } });
  check(s2.status === 200 && [...agreements.values()].at(-1)!.body.participantSetsInfo[0].memberInfos[0].securityOption.phoneInfo.phone === "2125550100", "phone-code request sent with the signer's number");
  check(!JSON.stringify((await call("iss", "GET", E)).body).includes("2125550100"), "the phone number isn't stored or shown afterwards");
  const rid2 = s2.body.request.id;
  check((await call("iss", "POST", `${E}/${rid2}/remind`)).status === 200, "issuer sends a reminder");
  check((await call("iss", "POST", `${E}/${rid2}/remind`)).status === 429, "only one manual reminder a day");
  check((await call("iss", "POST", `${E}/${rid2}/cancel`)).status === 200 && [...agreements.values()].at(-1)!.status === "CANCELLED", "issuer cancels; Adobe cancels the agreement");
  const s3 = await req({ kind: "INSURANCE", firmId: f2.body.firm.id, signerName: "Tom Reyes", signerEmail: "treyes@harbormutual.com", idMethod: "GOV_ID" });
  check(s3.status === 200, "a new request can go out after a cancel");
  const tok3 = /\/sign\/([A-Za-z0-9_-]+)/.exec([...agreements.values()].at(-1)!.body.message)![1]!;
  check((await call("anon", "POST", `/esign/sign/${tok3}/decline`, { reason: "x" })).status === 400, "declining needs a reason");
  check((await call("anon", "POST", `/esign/sign/${tok3}/decline`, { reason: "Policy lapsed on Nov 1; renewal pending." })).status === 200, "signer declines with a reason");
  const after = (await call("iss", "GET", E)).body.requests.find((x: any) => x.id === s3.body.request.id);
  check(after.status === "declined" && after.declineReason.startsWith("Policy lapsed"), "issuer sees the decline and the reason");

  // ---- platform log
  const pl = await call("plat", "GET", "/platform/esign");
  check(pl.status === 200 && pl.body.requests.length === 3 && pl.body.attester === attester.address && pl.body.requests.every((x: any) => x.offering === "Harbor Duplex"), "platform log lists every request with its offering");
  check((await call("iss", "GET", "/platform/esign")).status === 403, "an issuer can't open the platform log");
  const su2 = await call("plat", "POST", "/platform/esign/setup");
  check(su2.status === 200 && su2.body.webhook.url.endsWith("/api/esign/adobe/webhook") && calls.includes("POST /webhooks"), "platform registers the Adobe webhook");
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  proc?.kill();
  anvil.kill();
  fake.stop(true);
}
console.log(failed ? "\nE2E ESIGN: FAILED" : "\nE2E ESIGN: ALL PASS");
process.exit(failed ? 1 : 0);
