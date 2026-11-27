// Storage contract test: the SAME scenario runs on SqliteStore and on MongoStore (real Atlas, isolated `tokenize_test`
// database and user) and every result must be identical.   cd api && bun scripts/store-contract.ts
// Needs ~/.tokenize-mongo-test.env (MONGO_TEST_URI, MONGO_TEST_DB). Drops tokenize_test before and after.
import { Database } from "bun:sqlite";
import { MongoClient } from "mongodb";
import { MongoStore, SqliteStore, type Store } from "../src/store";

const env = Object.fromEntries((await Bun.file(`${process.env.HOME}/.tokenize-mongo-test.env`).text()).split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]));
if (env.MONGO_TEST_DB !== "tokenize_test") throw new Error("refusing: test database must be tokenize_test");

const sortKeys = (v: any): any => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
const norm = (v: any) => JSON.stringify(sortKeys(v ?? null));

async function scenario(s: Store) {
  const out: Record<string, unknown> = {};
  const t = { id: "diamondz", config: JSON.stringify({ name: "Diamondz Tokenize" }), admin_key_hash: "disabled" };
  await s.insertTenant(t);
  await s.insertTenant({ id: "other", config: "{}", admin_key_hash: "disabled" });
  await s.addHost("tokenize.diamondz.one", "diamondz");
  await s.addHost("localhost", "diamondz");
  await s.addHost("localhost", "other"); // ignored: host already taken
  await s.addHost("invest.other.example", "other");
  out.tenantByHost = await s.tenantByHost("localhost");
  out.tenantByHostMissing = await s.tenantByHost("nope.example");
  out.hosts = await s.hostsOf("diamondz");
  await s.setTenantConfig("diamondz", JSON.stringify({ name: "Renamed" }));
  out.tenant = await s.getTenant("diamondz");

  await s.createSession({ id_hash: "h1", tenant_id: "diamondz", email: "a@x.com", name: "A", expires_at: 2_000 });
  await s.createSession({ id_hash: "h2", tenant_id: "diamondz", email: "b@x.com", name: null, expires_at: 9_000 });
  out.session = await s.getSession("h2");
  await s.purgeSessions(5_000);
  out.purged = [await s.getSession("h1"), await s.getSession("h2")];
  await s.deleteSession("h2");
  out.deleted = await s.getSession("h2");

  for (const [i, d] of [["a1", "2026-01-01"], ["a2", "2026-03-01"], ["a3", "2026-02-01"]] as const) {
    await s.insertAsset({ id: i, tenant_id: "diamondz", data: JSON.stringify({ n: i }), created_at: d, updated_at: d });
  }
  await s.insertAsset({ id: "b1", tenant_id: "other", data: "{}", created_at: "2026-01-05", updated_at: "2026-01-05" });
  out.assetsOrdered = (await s.listAssets("diamondz")).map((a) => a.id);
  out.assetOtherTenant = await s.getAsset("b1", "diamondz");
  await s.updateAsset("a1", "diamondz", JSON.stringify({ n: "a1", v: 2 }), "2026-04-01");
  await s.updateAsset("b1", "diamondz", "{\"hijack\":true}", "2026-04-01"); // wrong tenant: no-op
  out.asset = await s.getAsset("a1", "diamondz");
  out.assetB = await s.getAsset("b1", "other");
  out.allAssets = (await s.allAssets()).map((a) => a.id).sort();

  await s.insertLead({ tenant_id: "diamondz", data: "{}", ip: null, created_at: "2026-01-01" });
  // inbox: ids differ by backend (SQLite row number vs msg_…), so compare everything except the id
  const l2 = await s.insertLead({ tenant_id: "diamondz", data: '{"name":"B"}', ip: "1.2.3.4", created_at: "2026-01-03" });
  const l3 = await s.insertLead({ tenant_id: "diamondz", data: '{"name":"C"}', ip: null, created_at: "2026-01-02" });
  const lo = await s.insertLead({ tenant_id: "other", data: '{"name":"O"}', ip: null, created_at: "2026-01-04" });
  const noId = (rows: any[]) => rows.map(({ id: _id, ...r }) => r);
  out.leadsInbox = noId(await s.listLeads("diamondz", false, 10));
  out.leadsUnread = await s.unreadLeads("diamondz");
  out.leadsMarkRead = await s.updateLead(l2, "diamondz", { read_at: "2026-01-05" });
  out.leadsCrossTenant = [await s.updateLead(lo, "diamondz", { archived_at: "2026-01-05" }), await s.updateLead("msg_nope", "diamondz", { read_at: "x" }), await s.updateLead("999999", "diamondz", { read_at: "x" })];
  out.leadsArchive = await s.updateLead(l3, "diamondz", { archived_at: "2026-01-06", read_at: "2026-01-06" });
  out.leadsAfter = [noId(await s.listLeads("diamondz", false, 10)), noId(await s.listLeads("diamondz", true, 10)), await s.unreadLeads("diamondz"), await s.unreadLeads("other")];
  out.leadsLimit = noId(await s.listLeads("diamondz", false, 1));
  out.leadsUnarchive = [await s.updateLead(l3, "diamondz", { archived_at: null }), noId(await s.listLeads("diamondz", true, 10)).length];
  out.leadsIdsDistinct = new Set([l2, l3, lo]).size;
  // identity checks
  const k = (id: string, tenant: string, wallet: string, created: string) => ({ id, tenant_id: tenant, wallet, applicant_id: null, status: "init" as const, reject_labels: null, user_comment: null, created_at: created, updated_at: created });
  await s.insertKyc(k("kyc_a", "diamondz", "0xAbC0000000000000000000000000000000000001", "2026-02-01"));
  await s.insertKyc(k("kyc_b", "diamondz", "0x0000000000000000000000000000000000000002", "2026-02-03"));
  await s.insertKyc(k("kyc_o", "other", "0xabc0000000000000000000000000000000000001", "2026-02-02"));
  out.kycById = await s.getKyc("kyc_a");
  out.kycByWalletAnyCase = [(await s.kycByWallet("diamondz", "0xABC0000000000000000000000000000000000001"))?.id, (await s.kycByWallet("other", "0xabc0000000000000000000000000000000000001"))?.id, await s.kycByWallet("diamondz", "0x9")];
  let dup = "none"; try { await s.insertKyc(k("kyc_dup", "diamondz", "0xabc0000000000000000000000000000000000001", "2026-02-04")); } catch { dup = "refused"; }
  out.kycDuplicateWallet = dup;
  await s.updateKyc("kyc_a", { applicant_id: "app1", status: "retry", reject_labels: '["BAD_PHOTO"]', user_comment: "Blurry", updated_at: "2026-02-05" });
  out.kycUpdated = await s.getKyc("kyc_a");
  out.kycTenantList = (await s.kycForTenant("diamondz", 10)).map((r) => r.id);
  out.kycTenantLimit = (await s.kycForTenant("diamondz", 1)).map((r) => r.id);
  out.kycMissing = await s.getKyc("kyc_nope");
  // accounts, memberships, workspace switching
  await s.upsertAccount({ address: "0xAAA0000000000000000000000000000000000001", email: "a@x.com", name: "Ann", created_at: "2026-03-01", last_login_at: "2026-03-01" });
  await s.upsertAccount({ address: "0xaaa0000000000000000000000000000000000001", email: null, name: null, created_at: "2026-03-09", last_login_at: "2026-03-05" });
  out.accountKeepsDetails = await s.getAccount("0xAaA0000000000000000000000000000000000001");
  out.accountMissing = await s.getAccount("0x0000000000000000000000000000000000000009");
  await s.addMembership({ account: "0xAAA0000000000000000000000000000000000001", tenant_id: "diamondz", role: "owner", created_at: "2026-03-02" });
  await s.addMembership({ account: "0xaaa0000000000000000000000000000000000001", tenant_id: "other", role: "admin", created_at: "2026-03-03" });
  await s.addMembership({ account: "0xaaa0000000000000000000000000000000000001", tenant_id: "other", role: "owner", created_at: "2026-03-04" }); // ignored
  out.memberships = await s.membershipsOf("0xAAA0000000000000000000000000000000000001");
  out.membershipsNone = await s.membershipsOf("0x0000000000000000000000000000000000000009");
  await s.createSession({ id_hash: "hacc", tenant_id: "diamondz", email: "a@x.com", name: "Ann", expires_at: 9_999_999_999_999, account: "0xAAA0000000000000000000000000000000000001" });
  await s.setSessionTenant("hacc", "other");
  out.accountSession = await s.getSession("hacc");
  // team members + generic records (2026-11-20)
  await s.addMembership({ account: "0xBBB0000000000000000000000000000000000002", tenant_id: "diamondz", role: "viewer", created_at: "2026-03-06" });
  await s.setMemberRole("0xbbb0000000000000000000000000000000000002", "diamondz", "compliance");
  out.membersOf = (await s.membersOf("diamondz")).map((m) => [m.account, m.role]);
  await s.removeMember("0xBBB0000000000000000000000000000000000002", "diamondz");
  out.membersAfterRemove = (await s.membersOf("diamondz")).map((m) => m.account);
  await s.putDoc({ coll: "invites", id: "i1", tenant_id: "diamondz", data: '{"a":1}', created_at: "2026-03-01", updated_at: "2026-03-01" });
  await s.putDoc({ coll: "invites", id: "i2", tenant_id: "diamondz", data: '{"a":2}', created_at: "2026-03-02", updated_at: "2026-03-02" });
  await s.putDoc({ coll: "invites", id: "i3", tenant_id: "other", data: '{"a":3}', created_at: "2026-03-03", updated_at: "2026-03-03" });
  await s.putDoc({ coll: "clients", id: "i1", tenant_id: "diamondz", data: '{"c":1}', created_at: "2026-03-04", updated_at: "2026-03-04" });
  await s.putDoc({ coll: "invites", id: "i1", tenant_id: "diamondz", data: '{"a":11}', created_at: "2026-09-09", updated_at: "2026-03-05" });
  out.docGet = await s.getDoc("invites", "i1");
  out.docList = (await s.listDocs("invites", "diamondz")).map((d) => d.id);
  out.docOtherColl = (await s.listDocs("clients", "diamondz")).map((d) => d.data);
  await s.deleteDoc("invites", "i2");
  out.docAfterDelete = (await s.listDocs("invites", "diamondz")).map((d) => d.id);
  out.docMissing = await s.getDoc("invites", "nope");

  const pay = (id: string, asset: string, tenant: string, status: string, at: string) => ({ id, tenant_id: tenant, asset_id: asset, status, data: JSON.stringify({ id }), created_at: at, updated_at: at });
  await s.insertPayout(pay("p1", "a1", "diamondz", "draft", "2026-01-01"));
  await s.insertPayout(pay("p2", "a1", "diamondz", "sent", "2026-02-01"));
  await s.insertPayout(pay("p3", "a2", "diamondz", "sent", "2026-03-01"));
  await s.insertPayout(pay("p4", "b1", "other", "sent", "2026-03-02"));
  await s.setPayout("p1", "sent", JSON.stringify({ id: "p1", tx: "0x1" }), "2026-04-01");
  out.payout = await s.getPayout("p1");
  out.sentByAsset = (await s.payoutsSentByAsset("a1")).map((p) => p.id);
  out.sentByTenant = (await s.payoutsSentByTenant("diamondz")).map((p) => p.id);
  out.sentAll = (await s.payoutsSent()).map((p) => p.id).sort();

  const acc = (id: string, status: string, at: string) => ({
    id, tenant_id: "diamondz", asset_id: "a1", wallet: "0xabc", route: "income" as const, status, mc_customer_id: "700", report_id: null,
    report_type: null, summary: null, consent_text: "consent", consent_at: at, decision: null, decided_at: null, decided_by: null, error: null, created_at: at, updated_at: at,
  });
  await s.insertAccreditation(acc("c1", "linking", "2026-01-01"));
  await s.insertAccreditation(acc("c2", "reporting", "2026-01-02"));
  await s.insertAccreditation(acc("c3", "reporting", "2026-01-03"));
  await s.updateAccreditation("c3", { status: "ready", summary: "{\"x\":1}", updated_at: "2026-01-04" });
  await s.updateAccreditation("c2", { report_id: "r2", updated_at: "2026-01-05" });
  out.accreditation = await s.getAccreditation("c3");
  out.accForAsset = (await s.accreditationsForAsset("diamondz", "a1")).map((r) => r.id);
  out.accReporting = (await s.accreditationsReporting(10)).map((r) => r.id);
  let refused = false;
  try { await s.updateAccreditation("c2", { wallet: "0xevil" } as any); } catch { refused = true; }
  out.accUpdateWhitelist = refused;

  const bank = (asset: string) => ({ asset_id: asset, tenant_id: "diamondz", mc_customer_id: "800", account_id: null, account_label: null, expected_cents: null, payers: "[]", status: "linking", last_month: null, last_tx: null, last_result: null, created_at: "2026-01-01", updated_at: "2026-01-01" });
  await s.insertBankProof(bank("a1"));
  await s.insertBankProof(bank("a2"));
  await s.updateBankProof("a1", { account_id: "6001", expected_cents: 4_000_000, status: "linked", updated_at: "2026-01-02" });
  out.bank = await s.getBankProof("a1");
  out.bankConfigured = (await s.bankProofsConfigured()).map((r) => r.asset_id);
  out.kvMissing = await s.getKv("nope");
  await s.setKv("formd:q:acme", '{"a":1}', "2026-01-01");
  await s.setKv("formd:q:acme", '{"a":2}', "2026-01-02");
  out.kv = await s.getKv("formd:q:acme");
  out.counter = [await s.bumpCounter("calls"), await s.bumpCounter("calls"), await s.bumpCounter("calls", 5), await s.bumpCounter("other")];
  out.counterConcurrent = (await Promise.all(Array.from({ length: 10 }, () => s.bumpCounter("race")))).sort((x, y) => x - y);
  return out;
}

let failed = false;
const mongo = new MongoClient(env.MONGO_TEST_URI!);
try {
  await mongo.connect();
  await mongo.db("tokenize_test").dropDatabase();
  const a = await scenario(new SqliteStore(new Database(":memory:")));
  const m = await MongoStore.connect(env.MONGO_TEST_URI!, "tokenize_test");
  const b = await scenario(m);
  await m.close();
  for (const k of Object.keys(a)) {
    const same = norm(a[k]) === norm(b[k]);
    console.log(`${same ? "PASS" : "FAIL"}  ${k}`);
    if (!same) { failed = true; console.log("  sqlite:", norm(a[k]).slice(0, 300), "\n  mongo: ", norm(b[k]).slice(0, 300)); }
  }
  console.log(`(${Object.keys(a).length} checks; e.g. assets newest first = ${norm(a.assetsOrdered)}, sessions purged = ${norm(a.purged)})`);
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  await mongo.db("tokenize_test").dropDatabase().catch(() => {});
  await mongo.close();
}
console.log(failed ? "\nSTORE CONTRACT: FAILED" : "\nSTORE CONTRACT: ALL PASS (SQLite ≡ MongoDB)");
process.exit(failed ? 1 : 0);
