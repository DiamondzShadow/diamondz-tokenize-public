// Monthly security evidence (2026-11-21), kept for a SOC 2 / ISO 27001 assessor.
//
// Job "security-evidence" (Temporal, every 30 days; local timer otherwise) writes to EVIDENCE_DIR
// (default ~/tokenize-evidence), one folder per run, files mode 600:
//   dependency-audit.json   `bun audit --json` for web/ and api/ plus counts by severity
//   audit-log.csv           every console write logged since the previous run, all workspaces
//   summary.json            what was collected, when, and the counts
// A short record of each run is also stored (docs coll "evidence", platform tenant) so the history survives a disk loss.
// The audit-log CSV holds emails and IPs, so the folder is private to the service user.
//
// Off-site copy (2026-11-21, LOG-RETENTION.md): with EVIDENCE_BUCKET set, the three files are also uploaded to that
// Google Cloud Storage bucket (private, versioned, 7-year retention policy) as <stamp>/<file>, using the VM's
// Application Default Credentials (metadata server). The VM's service account only has objectCreator on the bucket:
// it can add files, not read, overwrite or delete them. A failed upload is recorded in the summary and logged; the
// local copy and the period bookkeeping stand, so a retry never double-counts.
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { Store } from "./store";

const REPO = resolve(import.meta.dir, "../..");
const DIR = process.env.EVIDENCE_DIR || join(homedir(), "tokenize-evidence");
const SEVERITIES = ["critical", "high", "moderate", "low"] as const;
// Overridable only so tests can point at a mock.
const TOKEN_URL = process.env.GCE_METADATA_TOKEN_URL || "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const GCS_UPLOAD = process.env.GCS_UPLOAD_BASE || "https://storage.googleapis.com/upload/storage/v1";

type Offsite = { bucket: string; uploaded: string[]; error?: string } | null;

/** Uploads local files to gs://<bucket>/<prefix>/<name>; never throws. */
export async function uploadOffsite(bucket: string | undefined, prefix: string, files: { name: string; body: string; type: string }[]): Promise<Offsite> {
  if (!bucket) return null;
  const uploaded: string[] = [];
  try {
    const t = await fetch(TOKEN_URL, { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(5000) });
    if (!t.ok) throw new Error(`metadata token HTTP ${t.status}`);
    const token = ((await t.json()) as { access_token?: string }).access_token;
    if (!token) throw new Error("metadata token missing");
    for (const f of files) {
      const name = `${prefix}/${f.name}`;
      const url = `${GCS_UPLOAD}/b/${encodeURIComponent(bucket)}/o?uploadType=media&ifGenerationMatch=0&name=${encodeURIComponent(name)}`;
      const r = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": f.type }, body: f.body, signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`upload ${f.name}: HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
      uploaded.push(name);
    }
    return { bucket, uploaded };
  } catch (e) {
    const error = String((e as Error).message).slice(0, 300);
    console.error(`[evidence] off-site copy failed: ${error}`);
    return { bucket, uploaded, error };
  }
}

type Counts = Record<(typeof SEVERITIES)[number], number>;

export function countAdvisories(auditJson: unknown): Counts {
  const out: Counts = { critical: 0, high: 0, moderate: 0, low: 0 };
  if (!auditJson || typeof auditJson !== "object") return out;
  for (const list of Object.values(auditJson as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    for (const a of list) {
      const s = String((a as any)?.severity ?? "").toLowerCase();
      if (s in out) out[s as keyof Counts]++;
    }
  }
  return out;
}

async function bunAudit(cwd: string): Promise<{ ok: boolean; counts: Counts; raw: unknown; error?: string }> {
  try {
    const p = Bun.spawn(["bun", "audit", "--json"], { cwd, stdout: "pipe", stderr: "pipe" });
    const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    const raw = JSON.parse(out || "{}");
    return { ok: true, counts: countAdvisories(raw), raw };
  } catch (e) {
    return { ok: false, counts: { critical: 0, high: 0, moderate: 0, low: 0 }, raw: null, error: String((e as Error).message).slice(0, 200) };
  }
}

const csvCell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

export function auditCsv(rows: { tenant_id: string; data: string }[]): string {
  const cols = ["at", "workspace", "who", "role", "method", "path", "status", "ip"] as const;
  const lines = rows.map((r) => {
    const d = JSON.parse(r.data);
    return [d.at, r.tenant_id, d.who, d.role, d.method, d.path, d.status, d.ip].map(csvCell).join(",");
  });
  return [cols.join(","), ...lines].join("\n") + "\n";
}

export async function collectEvidence(store: Store, platformTenant: string, now = new Date()) {
  const last = await store.getKv("evidence:last");
  const since = last?.value ?? new Date(now.getTime() - 31 * 86_400_000).toISOString();
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const dir = join(DIR, stamp);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(DIR, 0o700);

  const [web, api] = await Promise.all([bunAudit(join(REPO, "web")), bunAudit(join(REPO, "api"))]);
  const auditRows = await store.docsSince("audit", since);

  const files: { name: string; body: string; type: string }[] = [];
  const put = (name: string, body: string, type: string) => { writeFileSync(join(dir, name), body, { mode: 0o600 }); files.push({ name, body, type }); };
  put("dependency-audit.json", JSON.stringify({ web, api }, null, 2), "application/json");
  put("audit-log.csv", auditCsv(auditRows), "text/csv");
  const base = {
    at: now.toISOString(),
    period: { from: since, to: now.toISOString() },
    dependencies: { web: web.ok ? web.counts : { error: web.error }, api: api.ok ? api.counts : { error: api.error } },
    auditLogEntries: auditRows.length,
    folder: dir,
  };
  put("summary.json", JSON.stringify(base, null, 2), "application/json");
  const offsite = await uploadOffsite(process.env.EVIDENCE_BUCKET, stamp, files);
  const summary = { ...base, offsite };

  await store.putDoc({ coll: "evidence", id: `${now.toISOString()}_${randomBytes(3).toString("hex")}`, tenant_id: platformTenant, data: JSON.stringify(summary), created_at: now.toISOString(), updated_at: now.toISOString() });
  await store.setKv("evidence:last", now.toISOString(), now.toISOString());
  return summary;
}
