// Two-step sign-in (TOTP) against a throwaway API: owners/admins must set it up before changing anything, codes are
// checked with ±30 s drift and can't be replayed, each new session must enter a code, recovery codes work once,
// secrets are encrypted at rest, and turning it off needs a current code.
//   bun scripts/e2e-mfa.ts
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHmac, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const PORT = 8974;
const API = `http://127.0.0.1:${PORT}`;
let failed = false;
const check = (ok: boolean, l: string) => (console.log(`${ok ? "PASS" : "FAIL"}  ${l}`), ok || (failed = true));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const dec = (s: string) => { let bits = 0, v = 0; const o: number[] = []; for (const ch of s) { v = (v << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { o.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(o); };
const code = (secret: string, offset = 0) => {
  const step = Math.floor(Date.now() / 30000) + offset;
  const m = Buffer.alloc(8); m.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", dec(secret)).update(m).digest(); const o = h[h.length - 1]! & 15;
  return String((((h[o]! & 127) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!) % 1_000_000).padStart(6, "0");
};
let proc: ReturnType<typeof spawn> | null = null;

try {
  const dir = mkdtempSync(`${tmpdir()}/e2e-mfa-`);
  proc = spawn("bun", ["src/server.ts"], {
    cwd: import.meta.dir + "/../../api",
    env: { ...process.env, STORE: "", MONGO_URI: "", PORT: String(PORT), DB_PATH: `${dir}/t.db`, DEFAULT_HOSTS: "127.0.0.1", ADMIN_DOMAINS: "example.com", BANK_PROOF_TICK: "0", TEMPORAL_JOBS: "", MFA_ENC_KEY: randomBytes(32).toString("hex") },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 80 && !(await fetch(`${API}/api/health`).then((r) => r.ok, () => false)); i++) await sleep(150);
  const db = new Database(`${dir}/t.db`);
  const jar = new Map<string, string>();
  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(`${API}/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json", origin: API, ...(jar.get(who) ? { cookie: `dt_session=${jar.get(who)}` } : {}) } });
    const sc = r.headers.get("set-cookie"); const m = sc && /dt_session=([^;]+)/.exec(sc); if (m) jar.set(who, m[1]!);
    const t = await r.text(); let j: any = null; try { j = JSON.parse(t); } catch { /* */ }
    return { status: r.status, body: j };
  };
  const login = async (who: string, acct: ReturnType<typeof privateKeyToAccount>) => {
    const n = await call(who, "GET", "/auth/nonce");
    const message = n.body.message.replace("{address}", acct.address);
    return call(who, "POST", "/auth/thirdweb", { address: acct.address, chainId: 84532, nonce: n.body.nonce, issuedAt: n.body.issuedAt, signature: await acct.signMessage({ message }), email: "owner@bank.example" });
  };
  const own = privateKeyToAccount(generatePrivateKey());
  await login("a", own);
  check((await call("a", "POST", "/workspaces", { name: "Harbor Private Bank" })).status === 200, "a new account can still create its workspace");
  check((await call("a", "GET", "/assets")).status === 200, "owner without two-step sign-in can read");
  const w = await call("a", "PATCH", "/tenant", { name: "Harbor Bank" });
  check(w.status === 403 && w.body?.mfaSetupRequired === true, "…but can't change anything until it's on");
  check((await call("a", "GET", "/mfa")).body?.required === true, "the console is told it's required for owners");

  const setup = await call("a", "POST", "/mfa/setup");
  const secret = setup.body?.secret as string;
  check(setup.status === 200 && /^[A-Z2-7]{32}$/.test(secret) && setup.body.uri.startsWith("otpauth://totp/"), "setup returns a secret and an authenticator link");
  const stored = (db.query("SELECT data FROM docs WHERE coll='mfa'").get() as any).data;
  check(!stored.includes(secret), "the secret is stored encrypted, never in plain text");
  check((await call("a", "POST", "/mfa/enable", { code: "000000" === code(secret) ? "111111" : "000000" })).status === 400, "a wrong code doesn't turn it on");
  const en = await call("a", "POST", "/mfa/enable", { code: code(secret) });
  const rec = en.body?.recoveryCodes as string[];
  check(en.status === 200 && rec?.length === 10, "the right code turns it on and returns 10 recovery codes");
  check(!JSON.stringify(db.query("SELECT data FROM docs WHERE coll='mfa'").all()).includes(rec[0]!), "recovery codes are stored only as hashes");
  check((await call("a", "PATCH", "/tenant", { name: "Harbor Private Bank" })).status === 200, "this session can now make changes");

  // a new session must enter a code
  jar.delete("a"); await login("a", own);
  const blocked = await call("a", "GET", "/assets");
  check(blocked.status === 401 && blocked.body?.needsMfa === true, "a new session is asked for a code before anything");
  check((await call("a", "POST", "/mfa/verify", { code: "123456" === code(secret) ? "654321" : "123456" })).status === 400, "a wrong code is refused");
  const nextStep = async () => { const s0 = Math.floor(Date.now() / 30000); while (Math.floor(Date.now() / 30000) === s0) await sleep(500); };
  await nextStep(); // the enable code's 30-second window is spent (no replays)
  const used = code(secret);
  check((await call("a", "POST", "/mfa/verify", { code: used })).status === 200 && (await call("a", "GET", "/assets")).status === 200, "the current code opens the console");
  jar.delete("a"); await login("a", own);
  check((await call("a", "POST", "/mfa/verify", { code: used })).status === 400, "the same code can't be replayed in another session");
  check((await call("a", "POST", "/mfa/verify", { code: rec[0] })).status === 200, "a recovery code works");
  jar.delete("a"); await login("a", own);
  check((await call("a", "POST", "/mfa/verify", { code: rec[0] })).status === 400, "…only once");
  check((await call("a", "POST", "/mfa/verify", { code: rec[1]!.toUpperCase() })).status === 200, "recovery codes ignore letter case");

  check((await call("a", "POST", "/mfa/disable", { code: "999999" === code(secret) ? "888888" : "999999" })).status === 400, "turning it off needs a valid code");
  await nextStep();
  check((await call("a", "POST", "/mfa/disable", { code: code(secret) })).status === 200, "a fresh code turns it off");
  check((await call("a", "PATCH", "/tenant", { name: "Harbor Private Bank" })).status === 403, "with it off, the owner is blocked from changes again");
} catch (e) { console.error(e); failed = true; } finally { proc?.kill(); }
console.log(failed ? "\nMFA: FAILURES" : "\nMFA: ALL PASS");
process.exit(failed ? 1 : 0);
