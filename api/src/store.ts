// Storage for the Tokenize API, with two interchangeable backends:
//   - SqliteStore: the original single-file database (default; local dev and the E2E harnesses, which seed it directly)
//   - MongoStore:  MongoDB Atlas (STORE=mongo + MONGO_URI/MONGO_DB), so several API servers share one database
//                  (white-label robustness). Same row shapes; primary key stored as `_id`.
// Every method is async so both backends fit. Rows keep their snake_case shape so call sites only add `await`.
import type { Database } from "bun:sqlite";
import { MongoClient, type Db } from "mongodb";
import { randomBytes } from "node:crypto";

export interface TenantRow { id: string; config: string; admin_key_hash: string }
/** `account` is set for thirdweb sign-ins (the login's address); then tenant_id is the ACTIVE workspace and access is
 *  only granted while the account is a member of it. Google Workspace sign-ins leave it null (host tenant, as before). */
export interface SessionRow { id_hash: string; tenant_id: string; email: string; name: string | null; expires_at: number; account?: string | null }
/** An issuer user who signed in with thirdweb (Google/Apple/email). `address` is the login's account (proven by a
 *  signature); `email` is what thirdweb reported in the browser — display/contact only, not verified by the server. */
export interface AccountRow { address: string; email: string | null; name: string | null; created_at: string; last_login_at: string }
export type Role = "owner" | "admin" | "compliance" | "operations" | "viewer";
export interface MembershipRow { account: string; tenant_id: string; role: Role; created_at: string }
/** A small JSON record in a named collection, scoped to a workspace (invites, entity investors, client accounts…). */
export interface DocRow { coll: string; id: string; tenant_id: string; data: string; created_at: string; updated_at: string }
export interface AssetRow { id: string; tenant_id: string; data: string; created_at: string; updated_at: string }
export interface PayoutRow { id: string; tenant_id: string; asset_id: string; status: string; data: string; created_at: string; updated_at: string }
export interface AccreditationRow {
  id: string; tenant_id: string; asset_id: string; wallet: string; route: "income" | "assets"; status: string;
  mc_customer_id: string; report_id: string | null; report_type: string | null; summary: string | null;
  consent_text: string; consent_at: string; decision: string | null; decided_at: string | null; decided_by: string | null;
  error: string | null; created_at: string; updated_at: string;
}
/** An investor's identity check (Sumsub KYC) with one issuer. `id` is an unguessable handle the investor's browser
 *  keeps; Sumsub knows the investor as externalUserId `${tenant_id}:${wallet}`. No documents or names are stored. */
export interface KycRow {
  id: string; tenant_id: string; wallet: string; applicant_id: string | null;
  status: "init" | "pending" | "approved" | "retry" | "rejected";
  reject_labels: string | null; user_comment: string | null; created_at: string; updated_at: string;
}
/** A message sent through a site's contact form. `data` is the JSON {name, email, company, message, kind}. */
export interface LeadRow { id: string; tenant_id: string; data: string; ip: string | null; created_at: string; read_at: string | null; archived_at: string | null }
export interface BankProofRow {
  asset_id: string; tenant_id: string; mc_customer_id: string; account_id: string | null; account_label: string | null;
  expected_cents: number | null; payers: string; status: string; last_month: string | null; last_tx: string | null;
  last_result: string | null; created_at: string; updated_at: string;
}

export interface Store {
  kind: "sqlite" | "mongo";
  // tenants
  getTenant(id: string): Promise<TenantRow | null>;
  tenantByHost(host: string): Promise<TenantRow | null>;
  insertTenant(row: TenantRow): Promise<void>;
  setTenantConfig(id: string, config: string): Promise<void>;
  hostsOf(tenantId: string): Promise<string[]>;
  addHost(host: string, tenantId: string): Promise<void>;
  // sessions
  createSession(row: SessionRow): Promise<void>;
  getSession(idHash: string): Promise<SessionRow | null>;
  deleteSession(idHash: string): Promise<void>;
  purgeSessions(now: number): Promise<void>;
  setSessionTenant(idHash: string, tenantId: string): Promise<void>;
  // accounts + workspace memberships (thirdweb sign-in)
  getAccount(address: string): Promise<AccountRow | null>;
  upsertAccount(row: AccountRow): Promise<void>;
  membershipsOf(address: string): Promise<MembershipRow[]>;
  addMembership(row: MembershipRow): Promise<void>;
  /** Everyone in a workspace, oldest first. */
  membersOf(tenantId: string): Promise<MembershipRow[]>;
  setMemberRole(account: string, tenantId: string, role: Role): Promise<void>;
  removeMember(account: string, tenantId: string): Promise<void>;
  // generic JSON records (added 2026-11-20 for team invites, entity investors, client accounts, bank links)
  getDoc(coll: string, id: string): Promise<DocRow | null>;
  putDoc(row: DocRow): Promise<void>;
  /** Newest first. */
  listDocs(coll: string, tenantId: string): Promise<DocRow[]>;
  /** Every tenant's docs in one collection created at or after `since` (ISO), oldest first. Platform jobs only. */
  docsSince(coll: string, since: string): Promise<DocRow[]>;
  deleteDoc(coll: string, id: string): Promise<void>;
  // assets
  getAsset(id: string, tenantId: string): Promise<AssetRow | null>;
  listAssets(tenantId: string): Promise<AssetRow[]>;
  allAssets(): Promise<AssetRow[]>;
  insertAsset(row: AssetRow): Promise<void>;
  updateAsset(id: string, tenantId: string, data: string, updatedAt: string): Promise<void>;
  // leads
  /** Returns the new message's id. */
  insertLead(row: { tenant_id: string; data: string; ip: string | null; created_at: string }): Promise<string>;
  /** Newest first. `archived` picks the inbox (false) or the archive (true). */
  listLeads(tenantId: string, archived: boolean, limit: number): Promise<LeadRow[]>;
  unreadLeads(tenantId: string): Promise<number>;
  /** Sets read/archived timestamps (null clears). Returns false when the message isn't this tenant's. */
  updateLead(id: string, tenantId: string, fields: { read_at?: string | null; archived_at?: string | null }): Promise<boolean>;
  // identity checks (Sumsub KYC)
  getKyc(id: string): Promise<KycRow | null>;
  kycByWallet(tenantId: string, wallet: string): Promise<KycRow | null>;
  insertKyc(row: KycRow): Promise<void>;
  updateKyc(id: string, fields: Partial<KycRow>): Promise<void>;
  /** Newest first. */
  kycForTenant(tenantId: string, limit: number): Promise<KycRow[]>;
  // payouts
  getPayout(id: string): Promise<PayoutRow | null>;
  insertPayout(row: PayoutRow): Promise<void>;
  setPayout(id: string, status: string, data: string, updatedAt: string): Promise<void>;
  payoutsSentByAsset(assetId: string): Promise<PayoutRow[]>;
  payoutsSentByTenant(tenantId: string): Promise<PayoutRow[]>;
  payoutsSent(): Promise<PayoutRow[]>;
  // accreditation
  getAccreditation(id: string): Promise<AccreditationRow | null>;
  insertAccreditation(row: AccreditationRow): Promise<void>;
  updateAccreditation(id: string, fields: Partial<AccreditationRow>): Promise<void>;
  accreditationsForAsset(tenantId: string, assetId: string): Promise<AccreditationRow[]>;
  accreditationsReporting(limit: number): Promise<AccreditationRow[]>;
  // bank proof
  getBankProof(assetId: string): Promise<BankProofRow | null>;
  insertBankProof(row: BankProofRow): Promise<void>;
  updateBankProof(assetId: string, fields: Partial<BankProofRow>): Promise<void>;
  bankProofsConfigured(): Promise<BankProofRow[]>;
  // small key/value cache (third-party lookups such as SEC filings) + atomic counters (paid-API call budgets)
  getKv(key: string): Promise<{ value: string; updated_at: string } | null>;
  setKv(key: string, value: string, updatedAt: string): Promise<void>;
  /** Adds `by` to an integer counter and returns the new total (atomic). */
  bumpCounter(key: string, by?: number): Promise<number>;
}

// ------------------------------------------------------------------ SQLite
const ACC_COLS = ["status", "report_id", "report_type", "summary", "decision", "decided_at", "decided_by", "error", "updated_at"] as const;
const KYC_COLS = ["applicant_id", "status", "reject_labels", "user_comment", "updated_at"] as const;
const BANK_COLS = ["account_id", "account_label", "expected_cents", "payers", "status", "last_month", "last_tx", "last_result", "updated_at", "mc_customer_id"] as const;

function setClause(fields: Record<string, unknown>, allowed: readonly string[]) {
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) throw new Error("nothing to update");
  return { sql: keys.map((k) => `${k} = ?`).join(", "), values: keys.map((k) => (fields as any)[k]) };
}

export class SqliteStore implements Store {
  kind = "sqlite" as const;
  constructor(private db: Database) {
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, config TEXT NOT NULL, admin_key_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tenant_hosts (host TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id));
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), data TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS assets_tenant ON assets(tenant_id);
      CREATE TABLE IF NOT EXISTS sessions (
        id_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), email TEXT NOT NULL,
        name TEXT, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, data TEXT NOT NULL, ip TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS payouts (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, asset_id TEXT NOT NULL, status TEXT NOT NULL,
        data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS payouts_asset ON payouts(asset_id);
      CREATE TABLE IF NOT EXISTS accreditation (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, asset_id TEXT NOT NULL, wallet TEXT NOT NULL,
        route TEXT NOT NULL, status TEXT NOT NULL, mc_customer_id TEXT NOT NULL, report_id TEXT, report_type TEXT,
        summary TEXT, consent_text TEXT NOT NULL, consent_at TEXT NOT NULL, decision TEXT, decided_at TEXT, decided_by TEXT,
        error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS accreditation_asset ON accreditation (tenant_id, asset_id);
      CREATE TABLE IF NOT EXISTS bank_proof (
        asset_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, mc_customer_id TEXT NOT NULL, account_id TEXT, account_label TEXT,
        expected_cents INTEGER, payers TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, last_month TEXT, last_tx TEXT,
        last_result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, n INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts (address TEXT PRIMARY KEY, email TEXT, name TEXT, created_at TEXT NOT NULL, last_login_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memberships (account TEXT NOT NULL, tenant_id TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (account, tenant_id));
      CREATE TABLE IF NOT EXISTS docs (coll TEXT NOT NULL, id TEXT NOT NULL, tenant_id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (coll, id));
      CREATE INDEX IF NOT EXISTS docs_tenant ON docs (coll, tenant_id, created_at);
      CREATE TABLE IF NOT EXISTS kyc (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, wallet TEXT NOT NULL, applicant_id TEXT, status TEXT NOT NULL,
        reject_labels TEXT, user_comment TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (tenant_id, wallet));
    `);
    // Inbox state for contact-form messages (added 2026-11-18; older databases get the columns here).
    const leadCols = new Set(this.all<{ name: string }>("PRAGMA table_info(leads)").map((c) => c.name));
    for (const col of ["read_at", "archived_at"]) if (!leadCols.has(col)) db.exec(`ALTER TABLE leads ADD COLUMN ${col} TEXT`);
    db.exec("CREATE INDEX IF NOT EXISTS leads_tenant ON leads (tenant_id, created_at)");
    if (!this.all<{ name: string }>("PRAGMA table_info(sessions)").some((c) => c.name === "account")) db.exec("ALTER TABLE sessions ADD COLUMN account TEXT");
  }
  private one<T>(sql: string, ...args: any[]) { return (this.db.query(sql).get(...args) as T | null) ?? null; }
  private all<T>(sql: string, ...args: any[]) { return this.db.query(sql).all(...args) as T[]; }
  private run(sql: string, ...args: any[]) { this.db.query(sql).run(...args); }

  async getTenant(id: string) { return this.one<TenantRow>("SELECT * FROM tenants WHERE id = ?", id); }
  async tenantByHost(host: string) { return this.one<TenantRow>("SELECT t.* FROM tenant_hosts h JOIN tenants t ON t.id = h.tenant_id WHERE h.host = ?", host); }
  async insertTenant(r: TenantRow) { this.run("INSERT INTO tenants (id, config, admin_key_hash) VALUES (?, ?, ?)", r.id, r.config, r.admin_key_hash); }
  async setTenantConfig(id: string, config: string) { this.run("UPDATE tenants SET config = ? WHERE id = ?", config, id); }
  async hostsOf(tenantId: string) { return this.all<{ host: string }>("SELECT host FROM tenant_hosts WHERE tenant_id = ? ORDER BY host", tenantId).map((r) => r.host); }
  async addHost(host: string, tenantId: string) { this.run("INSERT OR IGNORE INTO tenant_hosts (host, tenant_id) VALUES (?, ?)", host, tenantId); }

  async createSession(r: SessionRow) { this.run("INSERT INTO sessions (id_hash, tenant_id, email, name, expires_at, account) VALUES (?, ?, ?, ?, ?, ?)", r.id_hash, r.tenant_id, r.email, r.name, r.expires_at, r.account?.toLowerCase() ?? null); }
  async setSessionTenant(idHash: string, tenantId: string) { this.run("UPDATE sessions SET tenant_id = ? WHERE id_hash = ?", tenantId, idHash); }
  async getAccount(address: string) { return this.one<AccountRow>("SELECT * FROM accounts WHERE address = ?", address.toLowerCase()); }
  async upsertAccount(r: AccountRow) {
    this.run("INSERT INTO accounts (address, email, name, created_at, last_login_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(address) DO UPDATE SET email = COALESCE(excluded.email, accounts.email), name = COALESCE(excluded.name, accounts.name), last_login_at = excluded.last_login_at",
      r.address.toLowerCase(), r.email, r.name, r.created_at, r.last_login_at);
  }
  async membershipsOf(address: string) { return this.all<MembershipRow>("SELECT * FROM memberships WHERE account = ? ORDER BY created_at DESC", address.toLowerCase()); }
  async addMembership(r: MembershipRow) { this.run("INSERT OR IGNORE INTO memberships (account, tenant_id, role, created_at) VALUES (?, ?, ?, ?)", r.account.toLowerCase(), r.tenant_id, r.role, r.created_at); }
  async membersOf(tenantId: string) { return this.all<MembershipRow>("SELECT * FROM memberships WHERE tenant_id = ? ORDER BY created_at ASC", tenantId); }
  async setMemberRole(account: string, tenantId: string, role: Role) { this.run("UPDATE memberships SET role = ? WHERE account = ? AND tenant_id = ?", role, account.toLowerCase(), tenantId); }
  async removeMember(account: string, tenantId: string) { this.run("DELETE FROM memberships WHERE account = ? AND tenant_id = ?", account.toLowerCase(), tenantId); }
  async getDoc(coll: string, id: string) { return this.one<DocRow>("SELECT * FROM docs WHERE coll = ? AND id = ?", coll, id); }
  async putDoc(r: DocRow) {
    this.run("INSERT INTO docs (coll, id, tenant_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(coll, id) DO UPDATE SET tenant_id = excluded.tenant_id, data = excluded.data, updated_at = excluded.updated_at",
      r.coll, r.id, r.tenant_id, r.data, r.created_at, r.updated_at);
  }
  async listDocs(coll: string, tenantId: string) { return this.all<DocRow>("SELECT * FROM docs WHERE coll = ? AND tenant_id = ? ORDER BY created_at DESC", coll, tenantId); }
  async docsSince(coll: string, since: string) { return this.all<DocRow>("SELECT * FROM docs WHERE coll = ? AND created_at >= ? ORDER BY created_at", coll, since); }
  async deleteDoc(coll: string, id: string) { this.run("DELETE FROM docs WHERE coll = ? AND id = ?", coll, id); }
  async getSession(idHash: string) { return this.one<SessionRow>("SELECT * FROM sessions WHERE id_hash = ?", idHash); }
  async deleteSession(idHash: string) { this.run("DELETE FROM sessions WHERE id_hash = ?", idHash); }
  async purgeSessions(now: number) { this.run("DELETE FROM sessions WHERE expires_at < ?", now); }

  async getAsset(id: string, tenantId: string) { return this.one<AssetRow>("SELECT * FROM assets WHERE id = ? AND tenant_id = ?", id, tenantId); }
  async listAssets(tenantId: string) { return this.all<AssetRow>("SELECT * FROM assets WHERE tenant_id = ? ORDER BY created_at DESC", tenantId); }
  async allAssets() { return this.all<AssetRow>("SELECT * FROM assets"); }
  async insertAsset(r: AssetRow) { this.run("INSERT INTO assets (id, tenant_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", r.id, r.tenant_id, r.data, r.created_at, r.updated_at); }
  async updateAsset(id: string, tenantId: string, data: string, updatedAt: string) { this.run("UPDATE assets SET data = ?, updated_at = ? WHERE id = ? AND tenant_id = ?", data, updatedAt, id, tenantId); }

  async insertLead(r: { tenant_id: string; data: string; ip: string | null; created_at: string }) {
    const row = this.one<{ id: number }>("INSERT INTO leads (tenant_id, data, ip, created_at) VALUES (?, ?, ?, ?) RETURNING id", r.tenant_id, r.data, r.ip, r.created_at);
    return String(row!.id);
  }
  async listLeads(tenantId: string, archived: boolean, limit: number) {
    return this.all<LeadRow & { id: number }>(
      `SELECT * FROM leads WHERE tenant_id = ? AND archived_at IS ${archived ? "NOT " : ""}NULL ORDER BY created_at DESC, id DESC LIMIT ?`, tenantId, limit,
    ).map((r) => ({ ...r, id: String(r.id) }));
  }
  async unreadLeads(tenantId: string) { return this.one<{ n: number }>("SELECT COUNT(*) AS n FROM leads WHERE tenant_id = ? AND read_at IS NULL AND archived_at IS NULL", tenantId)!.n; }
  async updateLead(id: string, tenantId: string, fields: { read_at?: string | null; archived_at?: string | null }) {
    if (!/^\d+$/.test(id)) return false;
    const sets = (["read_at", "archived_at"] as const).filter((k) => k in fields);
    if (!sets.length) return !!this.one("SELECT id FROM leads WHERE id = ? AND tenant_id = ?", Number(id), tenantId);
    const res = this.db.query(`UPDATE leads SET ${sets.map((k) => `${k} = ?`).join(", ")} WHERE id = ? AND tenant_id = ?`)
      .run(...sets.map((k) => fields[k] ?? null), Number(id), tenantId);
    return res.changes > 0;
  }

  async getKyc(id: string) { return this.one<KycRow>("SELECT * FROM kyc WHERE id = ?", id); }
  async kycByWallet(tenantId: string, wallet: string) { return this.one<KycRow>("SELECT * FROM kyc WHERE tenant_id = ? AND wallet = ?", tenantId, wallet.toLowerCase()); }
  async insertKyc(r: KycRow) {
    this.run("INSERT INTO kyc (id, tenant_id, wallet, applicant_id, status, reject_labels, user_comment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      r.id, r.tenant_id, r.wallet.toLowerCase(), r.applicant_id, r.status, r.reject_labels, r.user_comment, r.created_at, r.updated_at);
  }
  async updateKyc(id: string, fields: Partial<KycRow>) { const s = setClause(fields, KYC_COLS); this.run(`UPDATE kyc SET ${s.sql} WHERE id = ?`, ...s.values, id); }
  async kycForTenant(tenantId: string, limit: number) { return this.all<KycRow>("SELECT * FROM kyc WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?", tenantId, limit); }

  async getPayout(id: string) { return this.one<PayoutRow>("SELECT * FROM payouts WHERE id = ?", id); }
  async insertPayout(r: PayoutRow) { this.run("INSERT INTO payouts (id, tenant_id, asset_id, status, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", r.id, r.tenant_id, r.asset_id, r.status, r.data, r.created_at, r.updated_at); }
  async setPayout(id: string, status: string, data: string, updatedAt: string) { this.run("UPDATE payouts SET status = ?, data = ?, updated_at = ? WHERE id = ?", status, data, updatedAt, id); }
  async payoutsSentByAsset(assetId: string) { return this.all<PayoutRow>("SELECT * FROM payouts WHERE asset_id = ? AND status = 'sent' ORDER BY created_at DESC", assetId); }
  async payoutsSentByTenant(tenantId: string) { return this.all<PayoutRow>("SELECT * FROM payouts WHERE status = 'sent' AND tenant_id = ? ORDER BY created_at DESC", tenantId); }
  async payoutsSent() { return this.all<PayoutRow>("SELECT * FROM payouts WHERE status = 'sent'"); }

  async getAccreditation(id: string) { return this.one<AccreditationRow>("SELECT * FROM accreditation WHERE id = ?", id); }
  async insertAccreditation(r: AccreditationRow) {
    this.run(`INSERT INTO accreditation (id, tenant_id, asset_id, wallet, route, status, mc_customer_id, report_id, report_type, summary, consent_text, consent_at, decision, decided_at, decided_by, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, r.id, r.tenant_id, r.asset_id, r.wallet, r.route, r.status, r.mc_customer_id, r.report_id, r.report_type, r.summary, r.consent_text, r.consent_at, r.decision, r.decided_at, r.decided_by, r.error, r.created_at, r.updated_at);
  }
  async updateAccreditation(id: string, fields: Partial<AccreditationRow>) {
    const s = setClause(fields, ACC_COLS);
    this.run(`UPDATE accreditation SET ${s.sql} WHERE id = ?`, ...s.values, id);
  }
  async accreditationsForAsset(tenantId: string, assetId: string) { return this.all<AccreditationRow>("SELECT * FROM accreditation WHERE tenant_id = ? AND asset_id = ? AND status != 'linking' ORDER BY created_at DESC LIMIT 200", tenantId, assetId); }
  async accreditationsReporting(limit: number) { return this.all<AccreditationRow>("SELECT * FROM accreditation WHERE status = 'reporting' ORDER BY updated_at LIMIT ?", limit); }

  async getBankProof(assetId: string) { return this.one<BankProofRow>("SELECT * FROM bank_proof WHERE asset_id = ?", assetId); }
  async insertBankProof(r: BankProofRow) {
    this.run(`INSERT INTO bank_proof (asset_id, tenant_id, mc_customer_id, account_id, account_label, expected_cents, payers, status, last_month, last_tx, last_result, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, r.asset_id, r.tenant_id, r.mc_customer_id, r.account_id, r.account_label, r.expected_cents, r.payers, r.status, r.last_month, r.last_tx, r.last_result, r.created_at, r.updated_at);
  }
  async updateBankProof(assetId: string, fields: Partial<BankProofRow>) {
    const s = setClause(fields, BANK_COLS);
    this.run(`UPDATE bank_proof SET ${s.sql} WHERE asset_id = ?`, ...s.values, assetId);
  }
  async bankProofsConfigured() { return this.all<BankProofRow>("SELECT * FROM bank_proof WHERE account_id IS NOT NULL AND expected_cents IS NOT NULL"); }

  async getKv(key: string) { return this.one<{ value: string; updated_at: string }>("SELECT value, updated_at FROM kv WHERE key = ?", key); }
  async setKv(key: string, value: string, updatedAt: string) { this.run("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", key, value, updatedAt); }
  async bumpCounter(key: string, by = 1) { return this.one<{ n: number }>("INSERT INTO counters (key, n) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET n = n + excluded.n RETURNING n", key, by)!.n; }
}

// ------------------------------------------------------------------ MongoDB
type WithId<T, K extends keyof T> = Omit<T, K> & { _id: string };
const strip = <T,>(doc: any, key: string): T | null => {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { [key]: _id, ...rest } as T;
};
const only = (fields: Record<string, unknown>, allowed: readonly string[]) => {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(fields)) if (allowed.includes(k)) out[k] = (fields as any)[k];
  if (!Object.keys(out).length) throw new Error("nothing to update");
  return out;
};

export class MongoStore implements Store {
  kind = "mongo" as const;
  private constructor(private client: MongoClient, private db: Db) {}

  static async connect(uri: string, dbName: string) {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15_000, appName: "tokenize-api" });
    await client.connect();
    const s = new MongoStore(client, client.db(dbName));
    await s.ensureIndexes();
    return s;
  }
  async close() { await this.client.close(); }

  private c(name: string) { return this.db.collection<any>(name); }
  async ensureIndexes() {
    await this.c("tenant_hosts").createIndex({ tenant_id: 1 });
    await this.c("assets").createIndex({ tenant_id: 1, created_at: -1 });
    await this.c("sessions").createIndex({ expires_at: 1 });
    await this.c("payouts").createIndex({ asset_id: 1, status: 1, created_at: -1 });
    await this.c("payouts").createIndex({ tenant_id: 1, status: 1, created_at: -1 });
    await this.c("accreditation").createIndex({ tenant_id: 1, asset_id: 1, created_at: -1 });
    await this.c("accreditation").createIndex({ status: 1, updated_at: 1 });
    await this.c("bank_proof").createIndex({ account_id: 1 });
    await this.c("leads").createIndex({ tenant_id: 1, archived_at: 1, created_at: -1 });
    await this.c("kyc").createIndex({ tenant_id: 1, wallet: 1 }, { unique: true });
    await this.c("memberships").createIndex({ account: 1, created_at: -1 });
    await this.c("memberships").createIndex({ tenant_id: 1, created_at: 1 });
    await this.c("docs").createIndex({ coll: 1, tenant_id: 1, created_at: -1 });
    await this.c("kyc").createIndex({ tenant_id: 1, created_at: -1 });
  }

  async getTenant(id: string) { return strip<TenantRow>(await this.c("tenants").findOne({ _id: id }), "id"); }
  async tenantByHost(host: string) {
    const h = await this.c("tenant_hosts").findOne({ _id: host });
    return h ? this.getTenant(h.tenant_id) : null;
  }
  async insertTenant(r: TenantRow) { const { id, ...rest } = r; await this.c("tenants").insertOne({ _id: id, ...rest }); }
  async setTenantConfig(id: string, config: string) { await this.c("tenants").updateOne({ _id: id }, { $set: { config } }); }
  async hostsOf(tenantId: string) { return (await this.c("tenant_hosts").find({ tenant_id: tenantId }).sort({ _id: 1 }).toArray()).map((d) => d._id as string); }
  async addHost(host: string, tenantId: string) { await this.c("tenant_hosts").updateOne({ _id: host }, { $setOnInsert: { tenant_id: tenantId } }, { upsert: true }); }

  async createSession(r: SessionRow) { const { id_hash, ...rest } = r; await this.c("sessions").insertOne({ _id: id_hash, ...rest, account: r.account?.toLowerCase() ?? null }); }
  async setSessionTenant(idHash: string, tenantId: string) { await this.c("sessions").updateOne({ _id: idHash }, { $set: { tenant_id: tenantId } }); }
  async getAccount(address: string) { return strip<AccountRow>(await this.c("accounts").findOne({ _id: address.toLowerCase() }), "address"); }
  async upsertAccount(r: AccountRow) {
    const set: Record<string, unknown> = { last_login_at: r.last_login_at };
    if (r.email != null) set.email = r.email;
    if (r.name != null) set.name = r.name;
    await this.c("accounts").updateOne({ _id: r.address.toLowerCase() }, { $set: set, $setOnInsert: { created_at: r.created_at, ...(r.email == null ? { email: null } : {}), ...(r.name == null ? { name: null } : {}) } }, { upsert: true });
  }
  async membershipsOf(address: string) {
    return (await this.c("memberships").find({ account: address.toLowerCase() }).sort({ created_at: -1 }).toArray()).map(({ _id, ...d }) => d as MembershipRow);
  }
  async addMembership(r: MembershipRow) {
    await this.c("memberships").updateOne({ _id: `${r.account.toLowerCase()}|${r.tenant_id}` }, { $setOnInsert: { account: r.account.toLowerCase(), tenant_id: r.tenant_id, role: r.role, created_at: r.created_at } }, { upsert: true });
  }
  async membersOf(tenantId: string) {
    return (await this.c("memberships").find({ tenant_id: tenantId }).sort({ created_at: 1 }).toArray()).map(({ _id, ...d }) => d as MembershipRow);
  }
  async setMemberRole(account: string, tenantId: string, role: Role) { await this.c("memberships").updateOne({ _id: `${account.toLowerCase()}|${tenantId}` }, { $set: { role } }); }
  async removeMember(account: string, tenantId: string) { await this.c("memberships").deleteOne({ _id: `${account.toLowerCase()}|${tenantId}` }); }
  async getDoc(coll: string, id: string) {
    const d = await this.c("docs").findOne({ _id: `${coll}|${id}` });
    if (!d) return null;
    const { _id, ...rest } = d;
    return rest as DocRow;
  }
  async putDoc(r: DocRow) {
    await this.c("docs").updateOne({ _id: `${r.coll}|${r.id}` }, { $set: { coll: r.coll, id: r.id, tenant_id: r.tenant_id, data: r.data, updated_at: r.updated_at }, $setOnInsert: { created_at: r.created_at } }, { upsert: true });
  }
  async listDocs(coll: string, tenantId: string) {
    return (await this.c("docs").find({ coll, tenant_id: tenantId }).sort({ created_at: -1 }).toArray()).map(({ _id, ...d }) => d as DocRow);
  }
  async docsSince(coll: string, since: string) {
    return (await this.c("docs").find({ coll, created_at: { $gte: since } }).sort({ created_at: 1 }).toArray()).map(({ _id, ...d }) => d as DocRow);
  }
  async deleteDoc(coll: string, id: string) { await this.c("docs").deleteOne({ _id: `${coll}|${id}` }); }
  async getSession(idHash: string) { return strip<SessionRow>(await this.c("sessions").findOne({ _id: idHash }), "id_hash"); }
  async deleteSession(idHash: string) { await this.c("sessions").deleteOne({ _id: idHash }); }
  async purgeSessions(now: number) { await this.c("sessions").deleteMany({ expires_at: { $lt: now } }); }

  async getAsset(id: string, tenantId: string) { return strip<AssetRow>(await this.c("assets").findOne({ _id: id, tenant_id: tenantId }), "id"); }
  async listAssets(tenantId: string) { return (await this.c("assets").find({ tenant_id: tenantId }).sort({ created_at: -1 }).toArray()).map((d) => strip<AssetRow>(d, "id")!); }
  async allAssets() { return (await this.c("assets").find({}).toArray()).map((d) => strip<AssetRow>(d, "id")!); }
  async insertAsset(r: AssetRow) { const { id, ...rest } = r; await this.c("assets").insertOne({ _id: id, ...rest }); }
  async updateAsset(id: string, tenantId: string, data: string, updatedAt: string) { await this.c("assets").updateOne({ _id: id, tenant_id: tenantId }, { $set: { data, updated_at: updatedAt } }); }

  async insertLead(r: { tenant_id: string; data: string; ip: string | null; created_at: string }) {
    const id = `msg_${randomBytes(8).toString("hex")}`;
    await this.c("leads").insertOne({ _id: id, ...r, read_at: null, archived_at: null });
    return id;
  }
  async listLeads(tenantId: string, archived: boolean, limit: number) {
    const docs = await this.c("leads").find({ tenant_id: tenantId, archived_at: archived ? { $ne: null } : null })
      .sort({ created_at: -1 }).limit(limit).toArray();
    return docs.map((d) => ({ ...strip<LeadRow>({ ...d, _id: String(d._id) }, "id")!, read_at: d.read_at ?? null, archived_at: d.archived_at ?? null }));
  }
  async unreadLeads(tenantId: string) { return this.c("leads").countDocuments({ tenant_id: tenantId, read_at: null, archived_at: null }); }
  async updateLead(id: string, tenantId: string, fields: { read_at?: string | null; archived_at?: string | null }) {
    const set: Record<string, string | null> = {};
    for (const k of ["read_at", "archived_at"] as const) if (k in fields) set[k] = fields[k] ?? null;
    const res = Object.keys(set).length
      ? await this.c("leads").updateOne({ _id: id, tenant_id: tenantId }, { $set: set })
      : { matchedCount: await this.c("leads").countDocuments({ _id: id, tenant_id: tenantId }) };
    return res.matchedCount > 0;
  }

  async getKyc(id: string) { return strip<KycRow>(await this.c("kyc").findOne({ _id: id }), "id"); }
  async kycByWallet(tenantId: string, wallet: string) { return strip<KycRow>(await this.c("kyc").findOne({ tenant_id: tenantId, wallet: wallet.toLowerCase() }), "id"); }
  async insertKyc(r: KycRow) { const { id, ...rest } = r; await this.c("kyc").insertOne({ _id: id, ...rest, wallet: r.wallet.toLowerCase() }); }
  async updateKyc(id: string, fields: Partial<KycRow>) { await this.c("kyc").updateOne({ _id: id }, { $set: only(fields, KYC_COLS) }); }
  async kycForTenant(tenantId: string, limit: number) { return (await this.c("kyc").find({ tenant_id: tenantId }).sort({ created_at: -1, _id: -1 }).limit(limit).toArray()).map((d) => strip<KycRow>(d, "id")!); }

  async getPayout(id: string) { return strip<PayoutRow>(await this.c("payouts").findOne({ _id: id }), "id"); }
  async insertPayout(r: PayoutRow) { const { id, ...rest } = r; await this.c("payouts").insertOne({ _id: id, ...rest }); }
  async setPayout(id: string, status: string, data: string, updatedAt: string) { await this.c("payouts").updateOne({ _id: id }, { $set: { status, data, updated_at: updatedAt } }); }
  async payoutsSentByAsset(assetId: string) { return (await this.c("payouts").find({ asset_id: assetId, status: "sent" }).sort({ created_at: -1 }).toArray()).map((d) => strip<PayoutRow>(d, "id")!); }
  async payoutsSentByTenant(tenantId: string) { return (await this.c("payouts").find({ tenant_id: tenantId, status: "sent" }).sort({ created_at: -1 }).toArray()).map((d) => strip<PayoutRow>(d, "id")!); }
  async payoutsSent() { return (await this.c("payouts").find({ status: "sent" }).toArray()).map((d) => strip<PayoutRow>(d, "id")!); }

  async getAccreditation(id: string) { return strip<AccreditationRow>(await this.c("accreditation").findOne({ _id: id }), "id"); }
  async insertAccreditation(r: AccreditationRow) { const { id, ...rest } = r; await this.c("accreditation").insertOne({ _id: id, ...rest }); }
  async updateAccreditation(id: string, fields: Partial<AccreditationRow>) { await this.c("accreditation").updateOne({ _id: id }, { $set: only(fields, ACC_COLS) }); }
  async accreditationsForAsset(tenantId: string, assetId: string) { return (await this.c("accreditation").find({ tenant_id: tenantId, asset_id: assetId, status: { $ne: "linking" } }).sort({ created_at: -1 }).limit(200).toArray()).map((d) => strip<AccreditationRow>(d, "id")!); }
  async accreditationsReporting(limit: number) { return (await this.c("accreditation").find({ status: "reporting" }).sort({ updated_at: 1 }).limit(limit).toArray()).map((d) => strip<AccreditationRow>(d, "id")!); }

  async getBankProof(assetId: string) { return strip<BankProofRow>(await this.c("bank_proof").findOne({ _id: assetId }), "asset_id"); }
  async insertBankProof(r: BankProofRow) { const { asset_id, ...rest } = r; await this.c("bank_proof").insertOne({ _id: asset_id, ...rest }); }
  async updateBankProof(assetId: string, fields: Partial<BankProofRow>) { await this.c("bank_proof").updateOne({ _id: assetId }, { $set: only(fields, BANK_COLS) }); }
  async bankProofsConfigured() { return (await this.c("bank_proof").find({ account_id: { $ne: null }, expected_cents: { $ne: null } }).toArray()).map((d) => strip<BankProofRow>(d, "asset_id")!); }

  async getKv(key: string) { const d = await this.c("kv").findOne({ _id: key }); return d ? { value: d.value as string, updated_at: d.updated_at as string } : null; }
  async setKv(key: string, value: string, updatedAt: string) { await this.c("kv").updateOne({ _id: key }, { $set: { value, updated_at: updatedAt } }, { upsert: true }); }
  async bumpCounter(key: string, by = 1) {
    const d = await this.c("counters").findOneAndUpdate({ _id: key }, { $inc: { n: by } }, { upsert: true, returnDocument: "after" });
    return d!.n as number;
  }
}

export type { WithId };
