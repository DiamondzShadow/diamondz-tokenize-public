// Security signals (2026-11-21): failed sign-ins, refused writes and server errors are counted for alerting, and the
// counts are readable only with the monitor token. Nothing personal is kept.
//   bun scripts/e2e-signals.ts
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { classify, record, totals, resetSignals } from "../../api/src/secsignals";
const PORT = 8982, API = `http://127.0.0.1:${PORT}`;
const TOKEN = randomBytes(24).toString("hex");
let failed = false;
const check = (ok: boolean, l: string) => (console.log(`${ok ? "PASS" : "FAIL"}  ${l}`), ok || (failed = true));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Unit: classification and the rolling window.
check(classify("GET", "/api/x", 500) === "serverErrors" && classify("POST", "/api/x", 503) === "serverErrors", "any 5xx is a server error");
check(classify("POST", "/api/auth/google", 401) === "failedSignins" && classify("POST", "/api/mfa/verify", 403) === "failedSignins", "refused sign-ins and two-step checks are failed sign-ins");
check(classify("POST", "/api/tenant", 403) === "refusedWrites" && classify("DELETE", "/api/team/x", 403) === "refusedWrites", "403 on a write is a refused write");
check(classify("GET", "/api/tenant", 403) === null && classify("POST", "/api/tenant", 401) === null && classify("POST", "/api/x", 200) === null, "reads, plain 401s and successes are not counted");
resetSignals();
const t0 = Date.UTC(2026, 10, 21, 12, 0, 0);
record("serverErrors", t0 - 30 * 60_000);
record("serverErrors", t0 - 2 * 60_000);
record("refusedWrites", t0 - 61 * 60_000);
const w5 = totals(5, t0), w60 = totals(60, t0);
check(w5.serverErrors === 1 && w60.serverErrors === 2 && w60.refusedWrites === 0, "5- and 60-minute windows count only their own minutes");
resetSignals();

let proc: ReturnType<typeof spawn> | null = null;
try {
  const dir = mkdtempSync(`${tmpdir()}/e2e-signals-`);
  proc = spawn("bun", ["src/server.ts"], { cwd: import.meta.dir + "/../../api", env: { ...process.env, STORE: "", MONGO_URI: "", PORT: String(PORT), DB_PATH: `${dir}/t.db`, DEFAULT_HOSTS: "127.0.0.1", BANK_PROOF_TICK: "0", TEMPORAL_JOBS: "", MFA_ENC_KEY: "", MONITOR_TOKEN: TOKEN, GOOGLE_CLIENT_ID: "e2e.apps.googleusercontent.com" }, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 80 && !(await fetch(`${API}/api/health`).then((r) => r.ok, () => false)); i++) await sleep(150);
  const read = (t?: string) => fetch(`${API}/api/health/signals`, { headers: t ? { "x-monitor-token": t } : {} });
  check((await read()).status === 404, "no token: the endpoint looks absent (404)");
  check((await read("wrong-" + TOKEN)).status === 404, "wrong token: 404");
  const base = (await (await read(TOKEN)).json()) as any;
  check(base.window5m && base.window60m && base.window5m.failedSignins === 0, "with the token: counts for 5 and 60 minutes");

  // Failed sign-ins: a Google credential that doesn't verify.
  for (let i = 0; i < 3; i++) await fetch(`${API}/api/auth/google`, { method: "POST", headers: { "content-type": "application/json", origin: API }, body: JSON.stringify({ credential: "x.y.z" }) });
  // Refused writes: a signed-in session writing from another site.
  const db = new Database(`${dir}/t.db`);
  const sid = randomBytes(16).toString("hex");
  db.query("INSERT INTO sessions (id_hash, tenant_id, email, name, expires_at) VALUES (?, 'diamondz', 'a@example.com', 'A', ?)").run(createHash("sha256").update(sid).digest("hex"), Date.now() + 3_600_000);
  const x = await fetch(`${API}/api/tenant`, { method: "PATCH", headers: { cookie: `dt_session=${sid}`, origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
  check(x.status === 403, "a cross-site write is refused (403)");
  const after = (await (await read(TOKEN)).json()) as any;
  check(after.window5m.failedSignins === 3, `three failed sign-ins counted (got ${after.window5m.failedSignins})`);
  check(after.window5m.refusedWrites >= 1, `the refused write is counted (got ${after.window5m.refusedWrites})`);
  check(!/example\.com|evil|x\.y\.z|127\.0\.0\.1/.test(JSON.stringify(after)), "no accounts, origins, credentials or IPs in the output");
} catch (e) { console.error(e); failed = true; } finally { proc?.kill(); }
console.log(failed ? "\nSIGNALS: FAILURES" : "\nSIGNALS: ALL PASS");
process.exit(failed ? 1 : 0);
