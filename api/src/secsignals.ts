// Security signals (2026-11-21): counts of server errors, failed sign-ins and refused writes, for alerting.
//
// Every API response is classified once, after the handler runs:
//   serverErrors   any 5xx response
//   failedSignins  a sign-in or two-step check that was refused (401/403 on /auth/google, /auth/thirdweb, /mfa/verify)
//   refusedWrites  any other non-GET request refused with 403 (role not allowed, cross-site, two-step gate)
// Counts live in memory in 1-minute buckets for the last hour (no IPs, accounts or paths are kept, so there is
// nothing personal to protect). A restart resets them, which only delays an alert.
//
// GET /api/health/signals returns the totals for the last 5 and 60 minutes. It requires the header
// `x-monitor-token: <MONITOR_TOKEN>` (server env); without MONITOR_TOKEN set the endpoint is off (404).
// The uptime-monitor Cloudflare Worker polls it every 5 minutes and emails when a threshold is crossed.
import type { Hono } from "hono";
import { timingSafeEqual, createHash } from "node:crypto";

export type Signal = "serverErrors" | "failedSignins" | "refusedWrites";
const SIGNALS: Signal[] = ["serverErrors", "failedSignins", "refusedWrites"];
const MINUTES = 60;

const buckets = new Map<number, Record<Signal, number>>(); // key = epoch minute

const SIGNIN_PATHS = new Set(["/auth/google", "/auth/thirdweb", "/mfa/verify"]);

export function classify(method: string, path: string, status: number): Signal | null {
  if (status >= 500) return "serverErrors";
  const p = path.replace(/^\/api/, "") || "/";
  if (SIGNIN_PATHS.has(p) && (status === 401 || status === 403)) return "failedSignins";
  if (method !== "GET" && method !== "HEAD" && status === 403) return "refusedWrites";
  return null;
}

export function record(sig: Signal, now = Date.now()) {
  const m = Math.floor(now / 60_000);
  let b = buckets.get(m);
  if (!b) {
    b = { serverErrors: 0, failedSignins: 0, refusedWrites: 0 };
    buckets.set(m, b);
    for (const k of buckets.keys()) if (k <= m - MINUTES) buckets.delete(k);
  }
  b[sig]++;
}

export function totals(minutes: number, now = Date.now()): Record<Signal, number> {
  const m = Math.floor(now / 60_000);
  const out = { serverErrors: 0, failedSignins: 0, refusedWrites: 0 };
  for (const [k, b] of buckets) if (k > m - minutes) for (const s of SIGNALS) out[s] += b[s];
  return out;
}

export function resetSignals() { buckets.clear(); }

const digest = (s: string) => createHash("sha256").update(s).digest();

export function mountSignals(app: Hono<any>) {
  // Classify every response (runs around all later routes and middleware).
  app.use("*", async (c, next) => {
    await next();
    const sig = classify(c.req.method, c.req.path, c.res.status);
    if (sig) record(sig);
  });

  app.get("/health/signals", (c) => {
    const want = process.env.MONITOR_TOKEN;
    const got = c.req.header("x-monitor-token") ?? "";
    if (!want || want.length < 24 || !timingSafeEqual(digest(want), digest(got))) return c.json({ error: "Not found" }, 404);
    c.header("Cache-Control", "no-store");
    return c.json({ window5m: totals(5), window60m: totals(60), at: new Date().toISOString() });
  });
}
