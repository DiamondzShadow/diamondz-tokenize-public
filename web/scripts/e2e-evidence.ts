// Monthly security evidence (2026-11-21): the job writes a dependency scan, the audit log since the last run and a
// summary into a private folder, and remembers where it stopped.
//   bun scripts/e2e-evidence.ts
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { countAdvisories, auditCsv } from "../../api/src/evidence";
const PORT = 8983, API = `http://127.0.0.1:${PORT}`;
const JOB_TOKEN = randomBytes(24).toString("hex");
let failed = false;
const check = (ok: boolean, l: string) => (console.log(`${ok ? "PASS" : "FAIL"}  ${l}`), ok || (failed = true));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const c = countAdvisories({ ws: [{ severity: "high" }, { severity: "moderate" }], zod: [{ severity: "high" }], x: "junk" });
check(c.high === 2 && c.moderate === 1 && c.low === 0, "advisories are counted by severity");
const csv = auditCsv([{ tenant_id: "acme", data: JSON.stringify({ at: "t", who: 'a"b', role: "admin", method: "POST", path: "/x", status: 200, ip: null }) }]);
check(csv.split("\n")[1] === '"t","acme","a""b","admin","POST","/x","200",""', "CSV quotes every cell and escapes quotes");

// Mock metadata server + Cloud Storage upload endpoint for the off-site copy.
const MOCK = 8984;
const uploads: { auth: string | null; url: URL; body: string; type: string | null }[] = [];
let failUploads = false;
const mock = Bun.serve({ port: MOCK, hostname: "127.0.0.1", async fetch(req) {
  const url = new URL(req.url);
  if (url.pathname === "/token") return req.headers.get("metadata-flavor") === "Google" ? Response.json({ access_token: "tok-123", expires_in: 3599 }) : new Response("no", { status: 403 });
  if (url.pathname.startsWith("/upload/b/")) {
    if (failUploads) return new Response("denied", { status: 403 });
    uploads.push({ auth: req.headers.get("authorization"), url, body: await req.text(), type: req.headers.get("content-type") });
    return Response.json({ name: url.searchParams.get("name") });
  }
  return new Response("?", { status: 404 });
} });

let proc: ReturnType<typeof spawn> | null = null;
try {
  const dir = mkdtempSync(`${tmpdir()}/e2e-evidence-`);
  const evDir = join(dir, "evidence");
  proc = spawn("bun", ["src/server.ts"], { cwd: import.meta.dir + "/../../api", env: { ...process.env, STORE: "", MONGO_URI: "", PORT: String(PORT), DB_PATH: `${dir}/t.db`, DEFAULT_HOSTS: "127.0.0.1", BANK_PROOF_TICK: "0", TEMPORAL_JOBS: "1", INTERNAL_JOB_TOKEN: JOB_TOKEN, MFA_ENC_KEY: "", EVIDENCE_DIR: evDir, EVIDENCE_BUCKET: "test-evidence", GCE_METADATA_TOKEN_URL: `http://127.0.0.1:${MOCK}/token`, GCS_UPLOAD_BASE: `http://127.0.0.1:${MOCK}/upload` }, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 80 && !(await fetch(`${API}/api/health`).then((r) => r.ok, () => false)); i++) await sleep(150);
  const db = new Database(`${dir}/t.db`);
  const at = new Date().toISOString();
  for (const [t, who] of [["diamondz", "owner@example.com"], ["acme", "ops@acme.example"]]) {
    db.query("INSERT INTO docs (coll, id, tenant_id, data, created_at, updated_at) VALUES ('audit', ?, ?, ?, ?, ?)").run(`${at}_${t}`, t, JSON.stringify({ at, who, role: "admin", method: "POST", path: "/tenant", status: 200, ip: "203.0.113.9" }), at, at);
  }
  const run = () => fetch(`${API}/api/internal/jobs/security-evidence`, { method: "POST", headers: { "x-job-token": JOB_TOKEN } });
  check((await fetch(`${API}/api/internal/jobs/security-evidence`, { method: "POST", headers: { "x-job-token": JOB_TOKEN, "x-forwarded-for": "1.2.3.4" } })).status === 404, "unreachable through the proxy");
  const r1 = (await (await run()).json()) as any;
  check(r1.ok === true && r1.result.auditLogEntries === 2, `first run exports every workspace's audit entries (got ${r1.result?.auditLogEntries})`);
  check(typeof r1.result.dependencies.web.high === "number" && typeof r1.result.dependencies.api.high === "number", "dependency scan counts for web and api");
  const folders = readdirSync(evDir);
  const f = join(evDir, folders[0]!);
  check(folders.length === 1 && ["audit-log.csv", "dependency-audit.json", "summary.json"].every((n) => readdirSync(f).includes(n)), "one folder with the three evidence files");
  check((statSync(evDir).mode & 0o777) === 0o700 && (statSync(join(f, "audit-log.csv")).mode & 0o777) === 0o600, "folder 700, files 600");
  check(readFileSync(join(f, "audit-log.csv"), "utf8").includes('"acme","ops@acme.example"'), "audit CSV names the workspace");
  check(r1.result.offsite?.bucket === "test-evidence" && r1.result.offsite.uploaded.length === 3 && !r1.result.offsite.error, "all three files copied off-site");
  check(uploads.length === 3 && uploads.every((u) => u.auth === "Bearer tok-123" && u.url.searchParams.get("ifGenerationMatch") === "0" && u.url.searchParams.get("name")!.startsWith(folders[0]! + "/")), "uploads use the VM token, never overwrite (ifGenerationMatch=0), one folder per run");
  check(uploads.find((u) => u.url.searchParams.get("name")!.endsWith("audit-log.csv"))?.body.includes("ops@acme.example") === true && uploads.find((u) => u.url.searchParams.get("name")!.endsWith("audit-log.csv"))?.type === "text/csv", "the off-site CSV is the same file");
  await sleep(1100);
  failUploads = true;
  const r2 = (await (await run()).json()) as any;
  check(r2.ok === true && typeof r2.result.offsite?.error === "string" && r2.result.offsite.error.includes("403"), "a failed upload is recorded, the job still succeeds");
  check(r2.ok === true && r2.result.auditLogEntries === 0, "the next run starts where the last one stopped (no duplicates)");
  check(db.query("SELECT COUNT(*) n FROM docs WHERE coll = 'evidence'").get() ? (db.query("SELECT COUNT(*) n FROM docs WHERE coll = 'evidence'").get() as any).n === 2 : false, "each run is also recorded in the database");
} catch (e) { console.error(e); failed = true; } finally { proc?.kill(); mock.stop(true); }
console.log(failed ? "\nEVIDENCE: FAILURES" : "\nEVIDENCE: ALL PASS");
process.exit(failed ? 1 : 0);
