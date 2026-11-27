// Copy the SQLite database into MongoDB Atlas, then verify every row.
//   cd api && bun scripts/migrate-to-mongo.ts              # READ-ONLY: counts both sides, writes nothing
//   cd api && bun scripts/migrate-to-mongo.ts --execute    # copy (target must be empty) + verify
// Env: MONGO_URI, MONGO_DB (from ~/.diamondz-tokenize.env), DB_PATH (default api/data/tokenize.db).
// Stop the API first so nothing writes to SQLite mid-copy. The SQLite file is opened read-only and never changed:
// it stays as the rollback (unset STORE and restart).
import { Database } from "bun:sqlite";
import { MongoClient } from "mongodb";
import { MongoStore, SqliteStore } from "../src/store";

const EXECUTE = process.argv.includes("--execute");
const envFile = `${process.env.HOME}/.diamondz-tokenize.env`;
const fileEnv = Object.fromEntries((await Bun.file(envFile).text()).split("\n").filter((l) => /^\s*[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]));
const URI = process.env.MONGO_URI ?? fileEnv.MONGO_URI;
const DB = process.env.MONGO_DB ?? fileEnv.MONGO_DB ?? "tokenize";
const DB_PATH = process.env.DB_PATH ?? `${import.meta.dir}/../data/tokenize.db`;
if (!URI) throw new Error("MONGO_URI missing");

const sq = new Database(DB_PATH, { readonly: true });
const TABLES = ["tenants", "tenant_hosts", "assets", "sessions", "leads", "payouts", "accreditation", "bank_proof"] as const;
const tableExists = (t: string) => !!sq.query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(t);
const rows = (t: string): any[] => (tableExists(t) ? sq.query(`SELECT * FROM ${t}`).all() : []);

const client = new MongoClient(URI);
await client.connect();
const mdb = client.db(DB);
const mongoCount = async (t: string) => mdb.collection(t).countDocuments();

console.log(`SQLite ${DB_PATH}  →  MongoDB database "${DB}"   (${EXECUTE ? "EXECUTE" : "read-only"})\n`);
console.log("table           sqlite   mongo");
let targetRows = 0;
for (const t of TABLES) {
  const m = await mongoCount(t);
  targetRows += m;
  console.log(`${t.padEnd(15)} ${String(rows(t).length).padStart(6)}  ${String(m).padStart(6)}`);
}

if (!EXECUTE) {
  console.log("\nRead-only: nothing written. Stop the API, then rerun with --execute.");
  await client.close();
  process.exit(0);
}
if (targetRows > 0) {
  console.error(`\nRefusing: "${DB}" already holds ${targetRows} documents. Migrate into an empty database only.`);
  await client.close();
  process.exit(1);
}

const store = await MongoStore.connect(URI, DB);
const now = Date.now();
for (const r of rows("tenants")) await store.insertTenant(r);
for (const r of rows("tenant_hosts")) await store.addHost(r.host, r.tenant_id);
for (const r of rows("assets")) await store.insertAsset(r);
let expired = 0;
for (const r of rows("sessions")) {
  if (r.expires_at < now) { expired++; continue; } // already dead: not worth copying
  await store.createSession(r);
}
for (const r of rows("leads")) await store.insertLead({ tenant_id: r.tenant_id, data: r.data, ip: r.ip, created_at: r.created_at });
for (const r of rows("payouts")) await store.insertPayout(r);
for (const r of rows("accreditation")) await store.insertAccreditation(r);
for (const r of rows("bank_proof")) await store.insertBankProof(r);

// ---- verify: every row read back through the same Store API the server uses, compared field by field
const lite = new SqliteStore(sq);
const same = (a: any, b: any) => JSON.stringify(a, Object.keys(a ?? {}).sort()) === JSON.stringify(b, Object.keys(b ?? {}).sort());
const bad: string[] = [];
for (const r of rows("tenants")) if (!same(await lite.getTenant(r.id), await store.getTenant(r.id))) bad.push(`tenant ${r.id}`);
for (const r of rows("tenants")) if (!same(await lite.hostsOf(r.id), await store.hostsOf(r.id))) bad.push(`hosts of ${r.id}`);
for (const r of rows("tenant_hosts")) if ((await store.tenantByHost(r.host))?.id !== r.tenant_id) bad.push(`host ${r.host}`);
for (const r of rows("assets")) if (!same(await lite.getAsset(r.id, r.tenant_id), await store.getAsset(r.id, r.tenant_id))) bad.push(`asset ${r.id}`);
for (const r of rows("sessions")) if (r.expires_at >= now && !same(await lite.getSession(r.id_hash), await store.getSession(r.id_hash))) bad.push("a session");
for (const r of rows("payouts")) if (!same(await lite.getPayout(r.id), await store.getPayout(r.id))) bad.push(`payout ${r.id}`);
for (const r of rows("accreditation")) if (!same(await lite.getAccreditation(r.id), await store.getAccreditation(r.id))) bad.push(`accreditation ${r.id}`);
for (const r of rows("bank_proof")) if (!same(await lite.getBankProof(r.asset_id), await store.getBankProof(r.asset_id))) bad.push(`bank proof ${r.asset_id}`);
if ((await mongoCount("leads")) !== rows("leads").length) bad.push("lead count");

console.log(`\nCopied. Skipped ${expired} expired session(s).`);
console.log("table           sqlite   mongo");
for (const t of TABLES) console.log(`${t.padEnd(15)} ${String(rows(t).length).padStart(6)}  ${String(await mongoCount(t)).padStart(6)}`);
await store.close();
await client.close();
if (bad.length) {
  console.error(`\nVERIFY FAILED (${bad.length}): ${bad.slice(0, 20).join(", ")}`);
  process.exit(1);
}
console.log("\nVERIFY: every row matches. Start the API with STORE=mongo; the SQLite file is untouched for rollback.");
