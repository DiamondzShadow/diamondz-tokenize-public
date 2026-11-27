// Background jobs, run once per schedule no matter how many API servers there are.
//
// Production (TEMPORAL_JOBS=1): Temporal Cloud owns the schedules (temporal/tokenize_temporal.py). Its worker calls
//   POST http://127.0.0.1:<PORT>/api/internal/jobs/<name>   header X-Job-Token: <INTERNAL_JOB_TOKEN>
// and gets retries with backoff, overlap protection (a run still going means the next one is skipped) and a history
// of every run. Several API replicas behind a load balancer therefore never deliver a payout or sign a check twice.
//
// Without TEMPORAL_JOBS=1 (local dev, tests) each job falls back to an in-process timer, as before.
//
// The internal endpoint is unreachable from the internet: requests that came through nginx (which always sets
// X-Real-IP / X-Forwarded-For) are refused, and the token must match.
import type { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";

type JobFn = () => Promise<unknown>;
const JOBS = new Map<string, { fn: JobFn; running: boolean }>();
const TEMPORAL = process.env.TEMPORAL_JOBS === "1";

/** Register a job. `fallbackEveryMs` / `firstRunMs` drive the local timer when Temporal isn't scheduling it. */
export function registerJob(name: string, fn: JobFn, fallbackEveryMs: number, firstRunMs = 30_000, localFallback = true) {
  const job = { fn, running: false };
  JOBS.set(name, job);
  if (TEMPORAL || !localFallback) return;
  const run = () => {
    if (job.running) return;
    job.running = true;
    fn().catch((e) => console.error(`[jobs] ${name}`, e?.shortMessage ?? e?.message ?? e)).finally(() => (job.running = false));
  };
  setTimeout(run, firstRunMs);
  setInterval(run, fallbackEveryMs);
}

export const jobNames = () => [...JOBS.keys()];

export function mountJobs(app: Hono<any>) {
  app.post("/internal/jobs/:name", async (c) => {
    // Only the local Temporal worker: anything proxied by nginx carries these headers.
    if (c.req.header("x-real-ip") || c.req.header("x-forwarded-for") || c.req.header("cf-connecting-ip")) return c.json({ error: "Not found" }, 404);
    const want = process.env.INTERNAL_JOB_TOKEN ?? "";
    const got = c.req.header("x-job-token") ?? "";
    if (want.length < 32 || got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) return c.json({ error: "Not found" }, 404);
    const job = JOBS.get(c.req.param("name"));
    if (!job) return c.json({ error: "unknown job", jobs: jobNames() }, 404);
    if (job.running) return c.json({ skipped: true, reason: "already running" }, 409);
    job.running = true;
    const t0 = Date.now();
    try {
      const result = await job.fn();
      return c.json({ ok: true, ms: Date.now() - t0, result: result ?? null });
    } catch (e: any) {
      // 500 ⇒ the Temporal activity fails and retries with backoff.
      console.error(`[jobs] ${c.req.param("name")}`, e?.shortMessage ?? e?.message ?? e);
      return c.json({ ok: false, ms: Date.now() - t0, error: String(e?.shortMessage ?? e?.message ?? e).slice(0, 300) }, 500);
    } finally {
      job.running = false;
    }
  });
}
