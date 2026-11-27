// CSP violation reports (2026-11-20): browsers' reports are grouped and counted (directive, blocked origin, page path),
// query strings never stored, both report formats accepted, platform admin only can read them.
//   bun scripts/e2e-csp.ts
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
const PORT = 8981, API = `http://127.0.0.1:${PORT}`;
let failed = false;
const check = (ok: boolean, l: string) => (console.log(`${ok ? "PASS" : "FAIL"}  ${l}`), ok || (failed = true));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let proc: ReturnType<typeof spawn> | null = null;
try {
  const dir = mkdtempSync(`${tmpdir()}/e2e-csp-`);
  proc = spawn("bun", ["src/server.ts"], { cwd: import.meta.dir + "/../../api", env: { ...process.env, STORE: "", MONGO_URI: "", PORT: String(PORT), DB_PATH: `${dir}/t.db`, DEFAULT_HOSTS: "127.0.0.1", BANK_PROOF_TICK: "0", TEMPORAL_JOBS: "", MFA_ENC_KEY: "" }, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 80 && !(await fetch(`${API}/api/health`).then((r) => r.ok, () => false)); i++) await sleep(150);
  const db = new Database(`${dir}/t.db`);
  const sid = randomBytes(16).toString("hex");
  db.query("INSERT INTO sessions (id_hash, tenant_id, email, name, expires_at) VALUES (?, 'diamondz', 'yakini@example.com', 'Y', ?)").run(createHash("sha256").update(sid).digest("hex"), Date.now() + 3_600_000);
  const old = { "csp-report": { "document-uri": "https://tokenize.diamondz.one/counsel/AbCdEfGhIjKlMnOpQrStUvWx?secret=1", "effective-directive": "script-src-elem", "blocked-uri": "https://evil.example/x.js?token=abc", disposition: "report" } };
  for (let i = 0; i < 3; i++) await fetch(`${API}/api/csp-report`, { method: "POST", headers: { "content-type": "application/csp-report" }, body: JSON.stringify(old) });
  const r = await fetch(`${API}/api/csp-report`, { method: "POST", headers: { "content-type": "application/reports+json" }, body: JSON.stringify([{ type: "csp-violation", body: { documentURL: "https://tokenize.diamondz.one/market", effectiveDirective: "frame-src", blockedURL: "https://widget.example/frame", disposition: "report" } }]) });
  check(r.status === 204, "reports are accepted with 204 (no body)");
  check((await fetch(`${API}/api/platform/csp`)).status === 401, "reading reports needs a sign-in");
  const g = (await fetch(`${API}/api/platform/csp`, { headers: { cookie: `dt_session=${sid}` } }).then((x) => x.json())) as any;
  const a = g.groups.find((x: any) => x.directive === "script-src-elem");
  check(!!a && a.count === 3 && a.blocked === "https://evil.example" && a.page === "/counsel/:id", "repeated reports are grouped and counted; origin only; page path with ids masked");
  check(!JSON.stringify(g).includes("token=abc") && !JSON.stringify(g).includes("secret=1") && !JSON.stringify(g).includes("AbCdEf"), "query strings and link tokens are never stored");
  check(g.groups.some((x: any) => x.directive === "frame-src" && x.blocked === "https://widget.example"), "the newer Reporting API format is accepted too");
  check((await fetch(`${API}/api/csp-report`, { method: "POST", body: "not json" })).status === 204, "garbage is ignored quietly");
} catch (e) { console.error(e); failed = true; } finally { proc?.kill(); }
console.log(failed ? "\nCSP: FAILURES" : "\nCSP: ALL PASS");
process.exit(failed ? 1 : 0);
