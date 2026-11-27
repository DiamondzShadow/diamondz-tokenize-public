// Mastercard Open Finance US relay (Cloud Run, us-central1).
//
// Why it exists: Open Finance US only accepts calls from US/UK/CA/AU IP addresses, and the platform VM is in
// europe-west4. The Tokenize API calls this relay; the relay calls Mastercard (api.finicity.com) from the US.
//
// Rules:
//   - Not a proxy: only the operations below exist, with strict id formats. Nothing else is forwarded.
//   - Two locks: Cloud Run itself only admits the platform VM's Google identity (roles/run.invoker; the org policy
//     forbids public services), and every request also needs `X-Relay-Token: <RELAY_TOKEN>`.
//   - Never logs request or response bodies: they carry consumer PII (names, SSN/DOB, balances).
//   - Mastercard credentials come from Secret Manager via env: MC_OF_PARTNER_ID, MC_OF_SECRET, MC_OF_APP_KEY.
//
// Operations (all JSON):
//   POST /customers                         { username, testing }          → { id }
//   POST /customers/:cid/consumer           { firstName, lastName, state, ... } → { id }   (required before reports)
//   POST /customers/:cid/connect            { webhook?, redirectUri?, experience? } → { link }
//   POST /customers/:cid/accounts/refresh                                  → accounts
//   GET  /customers/:cid/accounts                                          → accounts
//   POST /customers/:cid/reports/:type      { fromDate? }  type = voa | voi | voaHistory → { id, status }
//   GET  /customers/:cid/reports/:rid?purpose=1W                           → report
//   GET  /customers/:cid/transactions?fromDate=&toDate=                    → transactions (proof-of-asset income)
//   GET  /health
import { timingSafeEqual } from "node:crypto";

const BASE = "https://api.finicity.com";
const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};
const PARTNER_ID = env("MC_OF_PARTNER_ID");
const SECRET = env("MC_OF_SECRET");
const APP_KEY = env("MC_OF_APP_KEY");
const RELAY_TOKEN = env("RELAY_TOKEN");
if (RELAY_TOKEN.length < 32) throw new Error("RELAY_TOKEN must be at least 32 characters");

// ---------------------------------------------------------------- Mastercard access token (2h; renew at 90 min)
let tok: { value: string; at: number } | null = null;
let tokPending: Promise<string> | null = null;
async function appToken(): Promise<string> {
  if (tok && Date.now() - tok.at < 90 * 60_000) return tok.value;
  // One login at a time: five failed logins lock the Mastercard account.
  tokPending ??= (async () => {
    const r = await fetch(`${BASE}/aggregation/v2/partners/authentication`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "Finicity-App-Key": APP_KEY },
      body: JSON.stringify({ partnerId: PARTNER_ID, partnerSecret: SECRET }),
    });
    if (!r.ok) throw new Error(`Mastercard authentication failed (${r.status})`);
    const { token } = (await r.json()) as { token: string };
    tok = { value: token, at: Date.now() };
    return token;
  })().finally(() => (tokPending = null));
  return tokPending;
}

async function mc(method: string, path: string, body?: unknown, retry = true): Promise<Response> {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "Finicity-App-Key": APP_KEY,
      "Finicity-App-Token": await appToken(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 401 && retry) {
    tok = null; // token revoked or expired early: one fresh login, then give up
    return mc(method, path, body, false);
  }
  return r;
}

// ---------------------------------------------------------------- request helpers
const ID = /^\d{1,20}$/;
const REPORT_ID = /^[A-Za-z0-9-]{1,64}$/;
const REPORT_TYPES: Record<string, string> = { voa: "voa", voi: "voi", voaHistory: "voaHistory" };
const PURPOSES = new Set(["1W", "3F"]); // written instructions of the consumer (general / prequalification)

const json = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function authorized(req: Request) {
  // Authorization carries Cloud Run's Google identity token; the relay secret has its own header.
  const got = Buffer.from(req.headers.get("x-relay-token") ?? "");
  const want = Buffer.from(RELAY_TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
}

async function readJson(req: Request, max = 16_384): Promise<any> {
  const text = await req.text();
  if (text.length > max) throw Object.assign(new Error("body too large"), { status: 413 });
  return text ? JSON.parse(text) : {};
}

const pick = (o: any, keys: string[]) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));

/** Pass Mastercard's answer through, keeping its status; never logs the body. */
async function relay(r: Response) {
  const text = await r.text();
  return new Response(text || "{}", { status: r.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

// ---------------------------------------------------------------- routes
async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname.split("/").filter(Boolean);
  const m = req.method;
  if (m === "GET" && url.pathname === "/health") return json(200, { ok: true });
  if (!authorized(req)) return json(401, { error: "unauthorized" });

  // POST /customers
  if (m === "POST" && p.length === 1 && p[0] === "customers") {
    const b = await readJson(req);
    if (typeof b.username !== "string" || !/^[A-Za-z0-9._-]{6,255}$/.test(b.username)) return json(400, { error: "bad username" });
    return relay(await mc("POST", `/aggregation/v2/customers/${b.testing ? "testing" : "active"}`, { username: b.username }));
  }
  if (p[0] !== "customers" || !ID.test(p[1] ?? "")) return json(404, { error: "not found" });
  const cid = p[1];

  // POST /customers/:cid/consumer
  if (m === "POST" && p.length === 3 && p[2] === "consumer") {
    const b = await readJson(req);
    const body = pick(b, ["firstName", "lastName", "address", "city", "state", "zip", "phone", "ssn", "birthday", "email", "suffix"]);
    if (!body.firstName || !body.lastName || !body.state) return json(400, { error: "firstName, lastName and state are required" });
    if (!body.ssn && !body.birthday) return json(400, { error: "ssn or birthday is required" });
    if (!body.phone && !body.email) return json(400, { error: "phone or email is required" });
    return relay(await mc("POST", `/decisioning/v1/customers/${cid}/consumer`, body));
  }
  // POST /customers/:cid/connect
  if (m === "POST" && p.length === 3 && p[2] === "connect") {
    const b = await readJson(req);
    const extra = pick(b, ["webhook", "redirectUri", "experience", "language"]);
    if (extra.webhook && !/^https:\/\//.test(extra.webhook)) return json(400, { error: "webhook must be https" });
    if (extra.redirectUri && !/^https:\/\//.test(extra.redirectUri)) return json(400, { error: "redirectUri must be https" });
    return relay(await mc("POST", "/connect/v2/generate", { partnerId: PARTNER_ID, customerId: cid, ...extra }));
  }
  // POST /customers/:cid/accounts/refresh · GET /customers/:cid/accounts
  if (p.length === 4 && p[2] === "accounts" && p[3] === "refresh" && m === "POST") return relay(await mc("POST", `/aggregation/v1/customers/${cid}/accounts`, {}));
  if (p.length === 3 && p[2] === "accounts" && m === "GET") return relay(await mc("GET", `/aggregation/v1/customers/${cid}/accounts`));

  // POST /customers/:cid/reports/:type
  if (m === "POST" && p.length === 4 && p[2] === "reports" && REPORT_TYPES[p[3]!]) {
    const b = await readJson(req);
    const qs = typeof b.fromDate === "number" ? `?fromDate=${Math.floor(b.fromDate)}` : "";
    return relay(await mc("POST", `/decisioning/v2/customers/${cid}/${REPORT_TYPES[p[3]!]}${qs}`, {}));
  }
  // GET /customers/:cid/reports/:rid?purpose=1W
  if (m === "GET" && p.length === 4 && p[2] === "reports" && REPORT_ID.test(p[3]!)) {
    const purpose = url.searchParams.get("purpose") ?? "";
    if (!PURPOSES.has(purpose)) return json(400, { error: "purpose must be 1W or 3F (consumer's written instructions)" });
    return relay(await mc("GET", `/decisioning/v3/customers/${cid}/reports/${p[3]}?purpose=${purpose}`));
  }
  // GET /customers/:cid/transactions?fromDate&toDate
  if (m === "GET" && p.length === 3 && p[2] === "transactions") {
    const from = Number(url.searchParams.get("fromDate")), to = Number(url.searchParams.get("toDate"));
    if (!Number.isInteger(from) || !Number.isInteger(to) || from <= 0 || to <= from) return json(400, { error: "fromDate/toDate (epoch seconds) required" });
    const start = url.searchParams.get("start") ?? "1";
    if (!/^\d{1,6}$/.test(start)) return json(400, { error: "bad start" });
    return relay(await mc("GET", `/aggregation/v3/customers/${cid}/transactions?fromDate=${from}&toDate=${to}&start=${start}&limit=1000&sort=desc`));
  }
  return json(404, { error: "not found" });
}

Bun.serve({
  port: Number(process.env.PORT ?? 8080),
  async fetch(req) {
    const t0 = Date.now();
    let res: Response;
    try {
      res = await route(req);
    } catch (e: any) {
      res = json(e?.status ?? 502, { error: e?.status ? e.message : "relay error" });
      console.error(JSON.stringify({ severity: "ERROR", msg: "relay failure", path: new URL(req.url).pathname.replace(/\d{4,}/g, ":id"), err: String(e?.message ?? e).slice(0, 200) }));
    }
    // Paths only, with ids masked; never bodies.
    console.log(JSON.stringify({ severity: "INFO", method: req.method, path: new URL(req.url).pathname.replace(/\d{4,}/g, ":id"), status: res.status, ms: Date.now() - t0 }));
    return res;
  },
});
console.log(JSON.stringify({ severity: "INFO", msg: "mc-relay listening" }));
