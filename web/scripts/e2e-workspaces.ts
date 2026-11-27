// Issuer accounts + workspaces (thirdweb sign-in, stage 1) against a throwaway API: one-time signed login on the
// platform site only, no access to anything until a workspace exists (and never to the platform's own workspace),
// workspace isolation between accounts, switching only between your own workspaces, Free plan + 14-day trial,
// existing Google Workspace sessions unchanged.
//   bun scripts/e2e-workspaces.ts
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const PORT = 8971;
const API = `http://127.0.0.1:${PORT}`, OTHER = `http://localhost:${PORT}`;
let failed = false;
const check = (ok: boolean, l: string) => (console.log(`${ok ? "PASS" : "FAIL"}  ${l}`), ok || (failed = true));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let proc: ReturnType<typeof spawn> | null = null;

try {
  const dir = mkdtempSync(`${tmpdir()}/e2e-ws-`);
  proc = spawn("bun", ["src/server.ts"], {
    cwd: import.meta.dir + "/../../api",
    env: { ...process.env, STORE: "", MONGO_URI: "", PORT: String(PORT), DB_PATH: `${dir}/t.db`, DEFAULT_HOSTS: "127.0.0.1", ADMIN_DOMAINS: "example.com", BANK_PROOF_TICK: "0", TEMPORAL_JOBS: "" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 80 && !(await fetch(`${API}/api/health`).then((r) => r.ok, () => false)); i++) await sleep(150);
  const db = new Database(`${dir}/t.db`);
  const cfg = JSON.parse((db.query("SELECT config FROM tenants WHERE id = 'diamondz'").get() as any).config);
  db.query("INSERT INTO tenants (id, config, admin_key_hash) VALUES ('acme', ?, 'disabled')").run(JSON.stringify({ ...cfg, name: "Acme Invest" }));
  db.query("INSERT INTO tenant_hosts (host, tenant_id) VALUES ('localhost', 'acme')").run();
  const t0 = new Date().toISOString();
  db.query("INSERT INTO assets (id, tenant_id, data, created_at, updated_at) VALUES ('ast_00000000000000p1', 'diamondz', ?, ?, ?)").run(JSON.stringify({ name: "Platform Secret Draft", symbol: "PSD", assetClass: "real-estate", standard: "erc7943", chainId: 84532, totalSupply: "1000", status: "draft", listed: false }), t0, t0);
  // an existing Google Workspace session for the platform tenant
  const gsid = randomBytes(16).toString("hex");
  db.query("INSERT INTO sessions (id_hash, tenant_id, email, name, expires_at) VALUES (?, 'diamondz', 'owner@example.com', 'Owner', ?)").run(createHash("sha256").update(gsid).digest("hex"), Date.now() + 3_600_000);

  const jar = new Map<string, string>(); // cookie per actor
  const call = async (who: string, base: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json", origin: base, ...(jar.get(who) ? { cookie: `dt_session=${jar.get(who)}` } : {}) } });
    const sc = r.headers.get("set-cookie"); const m = sc && /dt_session=([^;]+)/.exec(sc); if (m) jar.set(who, m[1]!);
    const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: r.status, body: json };
  };
  const login = async (who: string, acct: ReturnType<typeof privateKeyToAccount>, extra: Record<string, unknown> = {}, base = API, tamper?: (m: string) => string) => {
    const n = await call(who, base, "GET", "/auth/nonce");
    if (n.status !== 200) return n;
    let message = n.body.message.replace("{address}", acct.address);
    if (tamper) message = tamper(message);
    const signature = await acct.signMessage({ message });
    return call(who, base, "POST", "/auth/thirdweb", { address: acct.address, chainId: 84532, nonce: n.body.nonce, issuedAt: n.body.issuedAt, signature, ...extra });
  };
  const ann = privateKeyToAccount(generatePrivateKey()), bob = privateKeyToAccount(generatePrivateKey()), eve = privateKeyToAccount(generatePrivateKey());

  // 1. sign-in rules
  check((await call("x", OTHER, "GET", "/auth/nonce")).status === 404, "account sign-in only exists on the platform site (not on a white-label domain)");
  const bad = await login("eve", eve, {}, API, (m) => m.replace("Site: 127.0.0.1", "Site: evil.example"));
  check(bad.status === 401, "a signature over a different site's message is refused");
  const n = await call("eve", API, "GET", "/auth/nonce");
  const msg = n.body.message.replace("{address}", eve.address);
  const sig = await eve.signMessage({ message: msg });
  const first = await call("eve", API, "POST", "/auth/thirdweb", { address: eve.address, chainId: 84532, nonce: n.body.nonce, issuedAt: n.body.issuedAt, signature: sig });
  check(first.status === 200, "valid sign-in accepted");
  check((await call("eve2", API, "POST", "/auth/thirdweb", { address: eve.address, chainId: 84532, nonce: n.body.nonce, issuedAt: n.body.issuedAt, signature: sig })).status === 400, "replaying the same signed sign-in is refused");
  const forged = await call("eve3", API, "POST", "/auth/thirdweb", { address: ann.address, chainId: 84532, nonce: (await call("eve3", API, "GET", "/auth/nonce")).body.nonce, issuedAt: "x", signature: sig });
  check(forged.status === 400 || forged.status === 401, "signing in as someone else's address is refused");

  // 2. a fresh account can't touch anything — especially the platform's own workspace
  const a1 = await login("ann", ann, { email: "ann@harbor.example", name: "Ann" });
  check(a1.status === 200 && a1.body.workspaces.length === 0 && a1.body.active === null, "new account: signed in, no workspaces");
  const blocked = await call("ann", API, "GET", "/assets");
  check(blocked.status === 403 && blocked.body?.needsWorkspace === true, "no workspace yet: console data refused with 'create your workspace first'");
  check((await call("ann", API, "GET", "/messages")).status === 403 && (await call("ann", API, "PATCH", "/tenant", { name: "Hijacked" })).status === 403, "…including the platform's inbox and settings");
  check(JSON.parse((db.query("SELECT config FROM tenants WHERE id='diamondz'").get() as any).config).name !== "Hijacked", "platform workspace unchanged");

  // 3. create a workspace: Free plan + 14-day trial, isolated data
  check((await call("ann", API, "POST", "/workspaces", { name: "H" })).status === 400, "workspace name too short is refused");
  const ws = await call("ann", API, "POST", "/workspaces", { name: "Harbor Partners", role: "MD", offerings: ["real-estate", "energy"] });
  const wsId = ws.body?.workspace?.id;
  const trialDays = ws.body ? (Date.parse(ws.body.workspace.trialEndsAt) - Date.now()) / 86_400_000 : 0;
  check(ws.status === 200 && /^ws_[0-9a-f]{12}$/.test(wsId ?? "") && ws.body.workspace.plan === "free" && trialDays > 13.9 && trialDays <= 14, "workspace created on the Free plan with a 14-day trial");
  const me = await call("ann", API, "GET", "/workspace");
  check(me.status === 200 && me.body.name === "Harbor Partners" && me.body.plan.id === "free" && me.body.plan.testnetOnly === true && JSON.stringify(me.body.offerings) === '["real-estate","energy"]', "console now acts on Harbor Partners (Free, test networks only)");
  const assets = await call("ann", API, "GET", "/assets");
  check(assets.status === 200 && assets.body.length === 0, "Harbor sees none of the platform's offerings");
  check((await call("ann", API, "PATCH", "/tenant", { name: "Harbor Partners LLC" })).body?.name === "Harbor Partners LLC" && JSON.parse((db.query("SELECT config FROM tenants WHERE id='diamondz'").get() as any).config).name === "Diamondz Tokenize", "settings change Harbor's workspace, not the platform's");
  check((await call("ann", API, "PATCH", "/tenant", { plan: "whitelabel", trialEndsAt: "2099-01-01" })).body?.plan?.id === "free" && (await call("ann", API, "GET", "/account")).body.workspaces[0].trialEndsAt === ws.body.workspace.trialEndsAt, "a workspace can't upgrade itself or extend its trial through settings");
  check((await call("ann", API, "GET", "/tenant")).body?.name === "Diamondz Tokenize", "public site info still describes the platform site");
  check((await call("ann", API, "PATCH", "/tenant", { brand: { primary: "#AA3300" } })).body?.brand?.primary === "#AA3300", "during the Growth trial, colors can change");
  const c0 = JSON.parse((db.query("SELECT config FROM tenants WHERE id = ?").get(wsId) as any).config);
  db.query("UPDATE tenants SET config = ? WHERE id = ?").run(JSON.stringify({ ...c0, trialEndsAt: new Date(Date.now() - 1000).toISOString() }), wsId);
  const after = await call("ann", API, "PATCH", "/tenant", { brand: { primary: "#00AA33" } });
  check(after.status === 403 && /trial has ended/.test(after.body?.error ?? ""), "after the trial, a Free workspace can't change its colors");
  check((await call("ann", API, "PATCH", "/tenant", { brand: { primary: "#AA3300" }, onboarding: { brandingDone: true } })).status === 200, "…but other settings still save (unchanged brand passes)");
  db.query("UPDATE tenants SET config = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse((db.query("SELECT config FROM tenants WHERE id = ?").get(wsId) as any).config), trialEndsAt: c0.trialEndsAt }), wsId);

  // 3b. wizard: offerings store the expected exemption
  const draft = await call("ann", API, "POST", "/assets", { name: "Harbor Lofts", symbol: "HARB", assetClass: "real-estate", standard: "erc7943", chainId: 84532, totalSupply: "100000", exemption: "506c" });
  check(draft.status === 201 && draft.body.exemption === "506c", "a draft saves the wizard's exemption choice");
  check((await call("ann", API, "PATCH", `/assets/${draft.body.id}`, { exemption: "regs" })).body?.exemption === "regs", "…and it can change while a draft");
  check((await call("ann", API, "POST", "/assets", { name: "X", symbol: "X", assetClass: "real-estate", standard: "erc7943", chainId: 84532, totalSupply: "1", exemption: "made-up" })).status === 400, "an unknown exemption is refused");
  check((await call("ann", API, "POST", "/assets", { name: "Y", symbol: "Y", assetClass: "real-estate", standard: "erc7943", chainId: 84532, totalSupply: "1" })).body?.exemption === "unsure", "no choice means 'not sure yet'");
  db.query("DELETE FROM assets WHERE tenant_id = ?").run(wsId);

  // 4. another account is isolated; switching only to your own workspaces
  await login("bob", bob, { email: "bob@other.example" });
  const bws = await call("bob", API, "POST", "/workspaces", { name: "Bob Capital" });
  check((await call("bob", API, "POST", `/workspaces/${wsId}/switch`)).status === 404, "can't switch into someone else's workspace");
  check((await call("bob", API, "POST", "/workspaces/diamondz/switch")).status === 404, "can't switch into the platform workspace");
  check((await call("bob", API, "GET", "/workspace")).body?.name === "Bob Capital", "Bob still acts on his own workspace");
  const ws2 = await call("ann", API, "POST", "/workspaces", { name: "Harbor Fund II" });
  check((await call("ann", API, "GET", "/workspace")).body?.name === "Harbor Fund II", "a second workspace becomes active");
  check((await call("ann", API, "POST", `/workspaces/${wsId}/switch`)).status === 200 && (await call("ann", API, "GET", "/workspace")).body?.name === "Harbor Partners LLC", "switch back to your first workspace");
  const acct = await call("ann", API, "GET", "/account");
  check(acct.body?.workspaces?.length === 2 && acct.body.account.email === "ann@harbor.example" && acct.body.active === wsId, "account lists both workspaces and the active one");

  // 5. signing in again lands in a workspace you belong to
  jar.delete("ann");
  const again = await login("ann", ann);
  check(again.body?.workspaces?.length === 2 && [wsId, ws2.body.workspace.id].includes(again.body.active) && (await call("ann", API, "GET", "/workspace")).status === 200, "signing in again opens one of your workspaces");

  // 6. Google Workspace sessions unchanged
  jar.set("owner", gsid);
  check((await call("owner", API, "GET", "/workspace")).body?.name === "Diamondz Tokenize" && (await call("owner", API, "GET", "/assets")).body?.length === 1, "existing Google sign-in still administers the platform workspace");
  check((await call("owner", API, "GET", "/account")).status === 401, "a Google session isn't treated as a thirdweb account");
  check(bws.status === 200, "Bob's workspace was created");

  // 7. stage 2: one marketplace on the platform site, each offering under its own issuer
  const dep = { chainId: 84532, token: "0x0000000000000000000000000000000000000001", sale: "0x0000000000000000000000000000000000000002", registry: "0x0000000000000000000000000000000000000003", payToken: "0x0000000000000000000000000000000000000004", txs: [], deployedAt: t0 };
  const base = { symbol: "HRB", assetClass: "real-estate", standard: "erc7943", chainId: 84532, totalSupply: "1000", pricePerToken: "10", minInvestment: "50", description: "", imageUrl: "", location: "", schedule: "", lockup: "", status: "deployed", deployment: dep };
  db.query("INSERT INTO assets (id, tenant_id, data, created_at, updated_at) VALUES ('ast_000000000000ws01', ?, ?, ?, ?)").run(wsId, JSON.stringify({ ...base, name: "Harbor Lofts", listed: true }), t0, t0);
  db.query("INSERT INTO assets (id, tenant_id, data, created_at, updated_at) VALUES ('ast_000000000000ws02', ?, ?, ?, ?)").run(wsId, JSON.stringify({ ...base, name: "Harbor Unlisted", listed: false }), t0, t0);
  db.query("INSERT INTO assets (id, tenant_id, data, created_at, updated_at) VALUES ('ast_000000000000pl01', 'diamondz', ?, ?, ?)").run(JSON.stringify({ ...base, name: "Platform Listed", listed: true }), t0, t0);
  db.query("INSERT INTO assets (id, tenant_id, data, created_at, updated_at) VALUES ('ast_000000000000ac01', 'acme', ?, ?, ?)").run(JSON.stringify({ ...base, name: "Acme Listed", listed: true }), t0, t0);
  const mk = (await call("anon", API, "GET", "/market")).body as any[];
  const names = mk.map((a) => a.name).sort();
  check(JSON.stringify(names) === '["Harbor Lofts","Platform Listed"]', "platform marketplace: the platform's and Harbor's listed offerings (no unlisted, no white-label tenant's)");
  check(mk.find((a) => a.name === "Harbor Lofts")?.issuer?.name === "Harbor Partners LLC" && mk.find((a) => a.name === "Platform Listed")?.issuer?.id === "diamondz", "each offering carries its issuer");
  check((await call("anon", API, "GET", "/market/ast_000000000000ws01")).status === 200 && (await call("anon", API, "GET", "/market/ast_000000000000ws02")).status === 404, "Harbor's listed offering opens on the platform site; its unlisted one doesn't");
  const ac = (await call("anon", OTHER, "GET", "/market")).body as any[];
  check(ac.length === 1 && ac[0].name === "Acme Listed" && (await call("anon", OTHER, "GET", "/market/ast_000000000000ws01")).status === 404, "a white-label domain still shows only its own offerings");
  const consent = await call("anon", API, "GET", "/accreditation/consent/ast_000000000000ws01");
  check(consent.status === 200 && /Harbor Partners LLC/.test(consent.body.text) && !/Diamondz Tokenize\)/.test(consent.body.text), "accreditation consent names the offering's issuer, not the website");
  check((await call("anon", OTHER, "GET", "/accreditation/consent/ast_000000000000ws01")).status === 404, "…and isn't available through a white-label domain");
  check((await call("anon", API, "GET", "/portfolio/0x0000000000000000000000000000000000000abc")).status === 200, "investor income view works across the platform's issuers");
  await call("ann", API, "POST", `/workspaces/${wsId}/switch`);
  check((await call("ann", API, "GET", "/assets")).body?.map((a: any) => a.name).sort().join() === "Harbor Lofts,Harbor Unlisted", "Harbor's console shows only Harbor's offerings");
  check((await call("owner", API, "GET", "/assets")).body?.map((a: any) => a.name).sort().join() === "Platform Listed,Platform Secret Draft", "the platform's console shows only the platform's offerings");
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  proc?.kill();
}
console.log(failed ? "\nE2E WORKSPACES: FAILED" : "\nE2E WORKSPACES: ALL PASS");
process.exit(failed ? 1 : 0);
