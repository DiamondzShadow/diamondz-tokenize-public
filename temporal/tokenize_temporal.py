"""Diamondz Tokenize background jobs on Temporal Cloud.

Temporal owns WHEN jobs run (schedules, overlap protection, retries, history); the Tokenize API does the work. Each
run is a `TokenizeJobWorkflow` whose single activity calls the API's internal endpoint on this machine:

    POST http://127.0.0.1:<PORT>/api/internal/jobs/<name>     X-Job-Token: <INTERNAL_JOB_TOKEN>

so several API replicas never run a job twice. Same pattern as ~/ShadowVaultV15/temporal/keepers_temporal.py.

Usage (shared venv ~/story-mcp-hub/.venv, temporalio 1.28):
    python tokenize_temporal.py worker              run the worker (pm2: tokenize-temporal)
    python tokenize_temporal.py schedules           create or update every schedule (idempotent)
    python tokenize_temporal.py trigger <job>       run one job now and print its result
    python tokenize_temporal.py status              list schedules with their next/last runs

Env: ~/.temporal-cloud.env (TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, TEMPORAL_API_KEY) and ~/.diamondz-tokenize.env
(INTERNAL_JOB_TOKEN, PORT). Values are read, never printed.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path

from temporalio import activity, workflow
from temporalio.client import (
    Client,
    Schedule,
    ScheduleActionStartWorkflow,
    ScheduleAlreadyRunningError,
    ScheduleIntervalSpec,
    ScheduleOverlapPolicy,
    SchedulePolicy,
    ScheduleSpec,
    ScheduleUpdate,
    ScheduleUpdateInput,
)
from temporalio.common import RetryPolicy
from temporalio.exceptions import ApplicationError
from temporalio.worker import Worker

TASK_QUEUE = "tokenize-jobs"

# job name -> (every, activity timeout). Overlap = SKIP: a run still going means the next tick is skipped.
JOBS: dict[str, tuple[timedelta, timedelta]] = {
    "proof-refresh": (timedelta(minutes=2), timedelta(minutes=10)),
    "accreditation-poll": (timedelta(minutes=2), timedelta(minutes=10)),
    "payout-autodeliver": (timedelta(hours=1), timedelta(minutes=30)),
    "bank-daily": (timedelta(hours=24), timedelta(minutes=30)),
    "ofac-refresh": (timedelta(hours=6), timedelta(minutes=5)),
    # Stellar sales: close any open sale whose offering no longer passes its proof checks (Chainlink + verifiers).
    "stellar-sale-proof": (timedelta(minutes=10), timedelta(minutes=8)),
    # Security evidence for assessors: dependency scan + audit-log export into ~/tokenize-evidence (api/src/evidence.ts).
    "security-evidence": (timedelta(days=30), timedelta(minutes=10)),
    # Adobe Acrobat Sign: catch any signed / expired agreement whose webhook was missed (api/src/esign.ts).
    "esign-poll": (timedelta(minutes=10), timedelta(minutes=8)),
}


def _load_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def _env() -> dict[str, str]:
    home = Path.home()
    env = {**_load_env(home / ".temporal-cloud.env"), **_load_env(home / ".diamondz-tokenize.env")}
    env.update({k: v for k, v in os.environ.items() if k.startswith(("TEMPORAL_", "INTERNAL_JOB_TOKEN", "TOKENIZE_API"))})
    return env


@dataclass
class JobInput:
    name: str


# ------------------------------------------------------------------ activity
def _call_api(name: str) -> dict:
    env = _env()
    token = env.get("INTERNAL_JOB_TOKEN", "")
    if len(token) < 32:
        raise ApplicationError("INTERNAL_JOB_TOKEN missing from ~/.diamondz-tokenize.env", non_retryable=True)
    base = env.get("TOKENIZE_API", f"http://127.0.0.1:{env.get('PORT', '8911')}")
    req = urllib.request.Request(f"{base}/api/internal/jobs/{name}", data=b"{}", method="POST",
                                 headers={"content-type": "application/json", "x-job-token": token})
    try:
        with urllib.request.urlopen(req, timeout=60 * 25) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        body = e.read()[:500].decode("utf-8", "replace")
        if e.code == 409:
            return {"skipped": True, "reason": "already running"}
        if e.code == 404:
            raise ApplicationError(f"job {name} not found on the API: {body}", non_retryable=True)
        raise ApplicationError(f"job {name} failed ({e.code}): {body}")
    except urllib.error.URLError as e:
        raise ApplicationError(f"API unreachable: {e.reason}")


@activity.defn
async def run_job(inp: JobInput) -> dict:
    task = asyncio.create_task(asyncio.to_thread(_call_api, inp.name))
    while not task.done():  # heartbeat while the API works, so a dead worker is noticed quickly
        activity.heartbeat(inp.name)
        await asyncio.wait({task}, timeout=15)
    result = task.result()
    activity.logger.info("job %s -> %s", inp.name, json.dumps(result)[:300])
    return result


# ------------------------------------------------------------------ workflow
@workflow.defn
class TokenizeJobWorkflow:
    @workflow.run
    async def run(self, inp: JobInput) -> dict:
        timeout = JOBS.get(inp.name, (None, timedelta(minutes=15)))[1]
        return await workflow.execute_activity(
            run_job,
            inp,
            start_to_close_timeout=timeout,
            heartbeat_timeout=timedelta(seconds=60),
            retry_policy=RetryPolicy(initial_interval=timedelta(seconds=10), backoff_coefficient=2.0,
                                     maximum_interval=timedelta(minutes=2), maximum_attempts=4),
        )


# ------------------------------------------------------------------ client + CLI
async def _client() -> Client:
    env = _env()
    missing = [k for k in ("TEMPORAL_ADDRESS", "TEMPORAL_NAMESPACE", "TEMPORAL_API_KEY") if not env.get(k)]
    if missing:
        raise SystemExit(f"missing {', '.join(missing)} in ~/.temporal-cloud.env")
    return await Client.connect(env["TEMPORAL_ADDRESS"], namespace=env["TEMPORAL_NAMESPACE"], api_key=env["TEMPORAL_API_KEY"], tls=True)


def _schedule(name: str) -> Schedule:
    every, _ = JOBS[name]
    return Schedule(
        action=ScheduleActionStartWorkflow(TokenizeJobWorkflow.run, JobInput(name), id=f"tokenize-{name}", task_queue=TASK_QUEUE),
        spec=ScheduleSpec(intervals=[ScheduleIntervalSpec(every=every)]),
        policy=SchedulePolicy(overlap=ScheduleOverlapPolicy.SKIP),
    )


async def cmd_schedules() -> None:
    client = await _client()
    for name in JOBS:
        sid = f"tokenize-{name}-periodic"
        try:
            await client.create_schedule(sid, _schedule(name))
            print(f"created  {sid}  every {JOBS[name][0]}")
        except ScheduleAlreadyRunningError:
            handle = client.get_schedule_handle(sid)
            new = _schedule(name)

            async def upd(_: ScheduleUpdateInput, new=new) -> ScheduleUpdate:
                return ScheduleUpdate(schedule=new)

            await handle.update(upd)
            print(f"updated  {sid}  every {JOBS[name][0]}")


async def cmd_trigger(name: str) -> None:
    if name not in JOBS:
        raise SystemExit(f"unknown job {name}; jobs: {', '.join(JOBS)}")
    client = await _client()
    import time
    result = await client.execute_workflow(TokenizeJobWorkflow.run, JobInput(name), id=f"tokenize-{name}-manual-{int(time.time())}", task_queue=TASK_QUEUE)
    print(json.dumps(result, indent=2)[:2000])


async def cmd_status() -> None:
    client = await _client()
    for name in JOBS:
        sid = f"tokenize-{name}-periodic"
        try:
            d = await client.get_schedule_handle(sid).describe()
            recent = d.info.recent_actions[-1].started_at.isoformat() if d.info.recent_actions else "never"
            nxt = d.info.next_action_times[0].isoformat() if d.info.next_action_times else "-"
            print(f"{sid:42} last {recent:32} next {nxt}")
        except Exception as e:  # noqa: BLE001
            print(f"{sid:42} {type(e).__name__}: {e}")


async def cmd_worker() -> None:
    client = await _client()
    worker = Worker(client, task_queue=TASK_QUEUE, workflows=[TokenizeJobWorkflow], activities=[run_job])
    print(f"tokenize worker on {TASK_QUEUE}", flush=True)
    await worker.run()


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    cmd = sys.argv[1]
    if cmd == "worker":
        asyncio.run(cmd_worker())
    elif cmd == "schedules":
        asyncio.run(cmd_schedules())
    elif cmd == "trigger" and len(sys.argv) == 3:
        asyncio.run(cmd_trigger(sys.argv[2]))
    elif cmd == "status":
        asyncio.run(cmd_status())
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
