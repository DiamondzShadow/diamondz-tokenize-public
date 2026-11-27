// Team members and roles (design 2, 2026-11-20) against a throwaway API: the owner invites by link, the invitee accepts
// with a signed-in account, each role can make only its own console writes, invites are single-use / expiring /
// owner-only, the owner can't be demoted or removed, and removing a member cuts their access at once.
//   bun scripts/e2e-team.ts
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const PORT = 8973;
const API = `http://127.0.0.1:${PORT}`;
let failed = false;
const check = (ok: boolean, l: string) => (console.log(`${ok ? "PASS" : "FAIL"}  ${l}`), ok || (failed = true));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let proc: ReturnType<typeof spawn> | null = null;

try {
  const dir = mkdtempSync(`${tmpdir()}/e2e-team-`);
  proc = spawn("bun", ["src/server.ts"], {
    cwd: import.meta.dir + "/../../api",
    env: { ...process.env, STORE: "", MONGO_URI: "", PORT: String(PORT), DB_PATH: `${dir}/t.db`, DEFAULT_HOSTS: "127.0.0.1", ADMIN_DOMAINS: "example.com", BANK_PROOF_TICK: "0", TEMPORAL_JOBS: "", RESEND_API_KEY: "" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 80 && !(await fetch(`${API}/api/health`).then((r) => r.ok, () => false)); i++) await sleep(150);
  const db = new Database(`${dir}/t.db`);

  const jar = new Map<string, string>();
  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(`${API}/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json", origin: API, ...(jar.get(who) ? { cookie: `dt_session=${jar.get(who)}` } : {}) } });
    const sc = r.headers.get("set-cookie"); const m = sc && /dt_session=([^;]+)/.exec(sc); if (m) jar.set(who, m[1]!);
    const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: r.status, body: json };
  };
  const login = async (who: string, acct: ReturnType<typeof privateKeyToAccount>, email: string) => {
    const n = await call(who, "GET", "/auth/nonce");
    const message = n.body.message.replace("{address}", acct.address);
    return call(who, "POST", "/auth/thirdweb", { address: acct.address, chainId: 84532, nonce: n.body.nonce, issuedAt: n.body.issuedAt, signature: await acct.signMessage({ message }), email });
  };
  const A = () => privateKeyToAccount(generatePrivateKey());
  const own = A(), comp = A(), ops = A(), view = A(), adm = A(), eve = A();

  await login("own", own, "owner@bank.example");
  const ws = await call("own", "POST", "/workspaces", { name: "Harbor Private Bank" });
  const wsId = ws.body.workspace.id;
  const draft = await call("own", "POST", "/assets", { name: "Harbor Note", symbol: "HNOTE", assetClass: "private-credit", standard: "erc7943", chainId: 84532, totalSupply: "1000", exemption: "506c" });
  check(draft.status === 200 || draft.status === 201, "owner creates a draft offering");
  if (!(draft.status === 200 || draft.status === 201)) console.log(draft.status, JSON.stringify(draft.body).slice(0, 300));
  const assetId = draft.body?.id ?? draft.body?.asset?.id;
  if (!assetId) console.log(JSON.stringify(draft.body).slice(0, 300));

  // invites
  const invite = async (email: string, role: string) => call("own", "POST", "/team/invites", { email, role });
  const ic = await invite("compliance@bank.example", "compliance");
  check(ic.status === 200 && ic.body.emailed === false && /\/start\/join\?t=/.test(ic.body.link ?? ""), "owner invites compliance; with no email provider the link comes back to copy");
  check((await invite("x@bank.example", "owner")).status === 400, "nobody can be invited as a second owner");
  check((await invite("owner@bank.example", "admin")).status === 409, "inviting someone already on the team is refused");
  const tok = (link: string) => new URL(link).searchParams.get("t")!;
  const tc = tok(ic.body.link);
  const look = await call("anon", "GET", `/invites/${tc}`);
  check(look.status === 200 && look.body.workspace === "Harbor Private Bank" && look.body.role === "compliance" && look.body.state === "open", "join page sees the workspace, role and an open invite");
  check((await call("anon", "POST", "/invites/accept", { token: tc })).status === 401, "accepting needs a signed-in account");
  await login("comp", comp, "compliance@bank.example");
  check((await call("comp", "POST", "/invites/accept", { token: "A".repeat(32) })).status === 404, "a made-up token is refused");
  const acc = await call("comp", "POST", "/invites/accept", { token: tc });
  check(acc.status === 200 && acc.body.workspace === wsId, "invitee accepts and lands in the workspace");
  await login("eve", eve, "eve@evil.example");
  check((await call("eve", "POST", "/invites/accept", { token: tc })).status === 410, "the same link can't be used twice");
  check((await call("anon", "GET", `/invites/${tc}`)).body.state === "used", "used invites show as used");

  for (const [who, acct, email, role] of [["ops", ops, "ops@bank.example", "operations"], ["view", view, "audit@firm.example", "viewer"], ["adm", adm, "digital@bank.example", "admin"]] as const) {
    const r = await invite(email, role);
    await login(who, acct, email);
    await call(who, "POST", "/invites/accept", { token: tok(r.body.link) });
  }
  const team = await call("own", "GET", "/team");
  check(team.status === 200 && team.body.members.length === 5 && team.body.invites.length === 0, "team lists the owner and 4 members, no open invites");
  check(team.body.members.find((m: any) => m.you)?.role === "owner", "the owner sees themselves marked as owner");
  check((await call("view", "GET", "/team")).status === 200 && (await call("view", "GET", "/assets")).status === 200, "a viewer can read the team and offerings");

  // role permissions (403 = refused by role; anything else = got past the role check)
  const allowed = (r: { status: number }) => r.status !== 403;
  check(!allowed(await call("view", "PATCH", `/assets/${assetId}`, { name: "Renamed" })), "viewer can't edit an offering");
  check(!allowed(await call("view", "POST", "/assets", { name: "X" })), "viewer can't create an offering");
  check(allowed(await call("ops", "PATCH", `/assets/${assetId}`, { name: "Harbor Note I" })), "operations can edit an offering");
  check(!allowed(await call("ops", "POST", `/assets/${assetId}/formd`, {})), "operations can't attach a Form D");
  check(!allowed(await call("ops", "POST", `/assets/${assetId}/deployment`, {})), "operations can't deploy");
  check(!allowed(await call("ops", "PATCH", "/tenant", { onboarding: { counselReady: true } })), "operations can't record the legal sign-off");
  check(allowed(await call("comp", "POST", `/assets/${assetId}/formd/search`, { query: "x" })), "compliance can work on the Form D");
  check(allowed(await call("comp", "PATCH", "/tenant", { onboarding: { counselReady: true, counselName: "Counsel LLP", counselDate: "2026-11-20" } })), "compliance can record the legal sign-off");
  check(!allowed(await call("comp", "PATCH", "/tenant", { name: "Renamed Bank" })), "compliance can't change other workspace settings");
  check(!allowed(await call("comp", "PATCH", `/assets/${assetId}`, { name: "Y" })), "compliance can't edit offering terms");
  check(allowed(await call("adm", "PATCH", "/tenant", { name: "Harbor Private Bank" })), "admin can change workspace settings");
  check(!allowed(await call("adm", "POST", "/team/invites", { email: "z@bank.example", role: "viewer" })), "admin can't invite (owner only)");
  check(!allowed(await call("adm", "POST", "/billing/plan-request", { plan: "growth" })), "admin can't touch billing (owner only)");
  check(JSON.parse((db.query("SELECT config FROM tenants WHERE id = ?").get(wsId) as any).config).name === "Harbor Private Bank", "the refused rename never landed");

  // owner protections + removal
  const ownAcct = own.address.toLowerCase();
  check((await call("own", "PATCH", `/team/members/${ownAcct}`, { role: "viewer" })).status === 400, "the owner can't be demoted");
  check((await call("own", "DELETE", `/team/members/${ownAcct}`)).status === 400, "the owner can't be removed");
  check((await call("own", "PATCH", `/team/members/${view.address.toLowerCase()}`, { role: "operations" })).status === 200, "owner changes the viewer to operations");
  check(allowed(await call("view", "PATCH", `/assets/${assetId}`, { name: "Harbor Note I" })), "…and the new role applies on the next request");
  check((await call("own", "DELETE", `/team/members/${view.address.toLowerCase()}`)).status === 200, "owner removes a member");
  check((await call("view", "GET", "/assets")).status === 403, "a removed member loses access immediately");

  // invite lifecycle
  const late = await invite("late@bank.example", "viewer");
  const lateId = late.body.invite.id;
  const row = db.query("SELECT data FROM docs WHERE coll='invites' AND id=?").get(lateId) as any;
  db.query("UPDATE docs SET data=? WHERE coll='invites' AND id=?").run(JSON.stringify({ ...JSON.parse(row.data), expiresAt: "2020-01-01T00:00:00Z" }), lateId);
  check((await call("eve", "POST", "/invites/accept", { token: tok(late.body.link) })).status === 410, "an expired invite is refused");
  check((await call("own", "GET", "/team")).body.invites.some((i: any) => i.id === lateId && i.expired), "the owner sees it as expired");
  check((await call("own", "DELETE", `/team/invites/${lateId}`)).status === 200 && (await call("own", "GET", "/team")).body.invites.length === 0, "owner cancels an invite");
  check(!db.query("SELECT 1 FROM docs WHERE coll='invites' AND data LIKE '%' || ? || '%'").get(tok(late.body.link)), "invite tokens are never stored, only their hash");
  // audit trail of console writes
  const log = await call("own", "GET", "/audit");
  const ents = log.body?.entries ?? [];
  check(log.status === 200 && ents.length > 10, "the workspace has an audit log of console writes");
  check(ents.some((e: any) => e.role === "viewer" && e.status === 403 && e.method === "PATCH"), "refused writes are logged with who, role and the 403");
  check(ents.some((e: any) => e.role === "operations" && e.status === 200 && e.path === `/assets/${assetId}`), "allowed writes are logged with their result");
  check(!JSON.stringify(ents).includes("Renamed Bank") && !JSON.stringify(ents).includes("Counsel LLP"), "request bodies are never stored in the log");
  const csv = await fetch(`${API}/api/audit?format=csv`, { headers: { cookie: `dt_session=${jar.get("own")}` } });
  check(csv.ok && (await csv.text()).startsWith("at,who,role,method,path,status,ip"), "the log exports as CSV");
  check((await call("eve", "GET", "/audit")).status === 403, "outsiders can't read a workspace's log");
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  proc?.kill();
}
console.log(failed ? "\nTEAM: FAILURES" : "\nTEAM: ALL PASS");
process.exit(failed ? 1 : 0);
