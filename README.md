# Glitch Hunt

[Open the live demo](https://glitch-hunt.vercel.app) · [Source on GitHub](https://github.com/yosuke37/glitch-hunt)

Glitch Hunt uses an AI playtest agent to choose waypoints in a puzzle game, replays the resulting moves on two builds, and checks the resulting game state. The dashboard opens with a real saved live run, including the model's tool arguments, moves, observations, latency, and token usage.

The agent chooses destinations. A deterministic pathfinder translates those choices into moves on the baseline and applies the same inputs to the candidate. An independent exhaustive search verifies whether a failed candidate replay represents an impossible completion state. These roles appear separately in the activity trace.

## Current capabilities

- Three levels and four candidate updates, including a healthy build, a gate that forgets its state, a gate that stays locked, and an exit that never completes.
- Three outcomes, **Regression found**, **No regression found**, and **Agent couldn't finish**. A healthy result covers the observed trace.
- PostgreSQL stores batches, jobs, replays, and per-attempt trace checkpoints. A worker continues after the browser closes, and a batch ID saved in the browser restores the results.
- Leases, stale-worker fencing, two bounded attempts, cancellation, shared concurrency up to 20, a daily live-attempt cap, and a shared cooldown after Gateway HTTP 429 responses.
- Operator authentication for all batch operations and a separate secret for the hosted worker endpoint. Public visitors can watch the saved replay and run the bounded offline solver.
- A reproducible scaling workload and published aggregate measurements at 1, 5, and 20 slots. The first live report includes provider throttling failures.

## Run locally

Use Node 22 and PostgreSQL 18. From this project folder:

```powershell
npm.cmd ci
Copy-Item .env.example .env.local
```

Fill in the local environment variables.

| Variable | Purpose |
| --- | --- |
| `HUNT_MODEL` | Tool-capable Gateway model ID, tested with `openai/gpt-4.1-mini` |
| `AI_GATEWAY_API_KEY` | Vercel Gateway credential for local workers |
| `HUNT_RUN_TOKEN` | Private operator password entered in the dashboard |
| `DATABASE_URL` | PostgreSQL connection string |
| `CRON_SECRET` | Separate worker secret when using the hosted worker endpoint |

For a new Docker database, set `POSTGRES_PASSWORD` in the shell, then run `docker compose up -d --wait`. Set `DATABASE_URL` to `postgresql://glitchhunt:YOUR_URL_ENCODED_PASSWORD@127.0.0.1:55439/glitchhunt`.

Start the dashboard and background worker together:

```powershell
npm.cmd start
```

Open [Glitch Hunt](http://127.0.0.1:4317). The saved live replay is available immediately. Select **Live AI agent**, enter your operator token, and launch a batch. Leave the terminal running. The worker continues if you close the browser. Reopen the dashboard, enter the token, and select **Resume saved batch**.

`npm.cmd run dev` starts only the web server. `npm.cmd run worker` starts only the worker. Both use the ignored `.env.local` file. Restart processes after changing that file. `PORT` selects an alternative local web port.

The development environment used for the November 20 verification has a separate PostgreSQL cluster under the parent workspace's `.local/glitch-hunt-postgres`, listening on localhost port 55439 with SCRAM password authentication. Its connection string was added to `.env.local`. After a machine restart, its server can be started from this folder with:

```powershell
& ../.tools/postgresql-18.6-5/pgsql/bin/pg_ctl.exe -D ../.local/glitch-hunt-postgres -l ../.local/glitch-hunt-pg.log -o "-h 127.0.0.1 -p 55439" -w start
```

## Verification and measurements

```powershell
npm.cmd test
npm.cmd run test:db
npm.cmd run scale
npm.cmd run scale -- --live
```

The database test creates and removes its own temporary schema. CI runs it against a disposable PostgreSQL service. The scale command needs an independent worker running. Each cohort submits the same 20 trials at 1, 5, and 20 slots. Live measurements make paid API requests. The direct single-trial development command is `npm.cmd run live`.

Full benchmark evidence is saved in PostgreSQL and ignored `output/benchmark-live.json` (or `output/benchmark-live-cloud.json` for the hosted run). Public aggregate results are in [public/benchmark.json](public/benchmark.json) and the dashboard. They include completion, findings, missed detections, false alarms, p95 time from batch submission to successful completion, and estimated cost per finding. Cohorts share provider limits, and each is cancelled after three minutes. The estimate uses uncached GPT-4.1 mini list rates of $0.40/M input tokens and $1.60/M output tokens. Actual charges belong to the Gateway billing dashboard.

The first local live scaling run on November 20 completed four trials before HTTP 429 throttling and exhausted its daily attempt cap through retries. A subsequent hosted benchmark uses the shared cooldown fix and private Vercel consumers. A benchmark against higher provider limits is still needed to measure unconstrained scaling.

The hosted run completed 12/20 trials at one slot, 7/20 at five slots, and 1/20 at twenty slots. It verified nine, six, and one planted regressions respectively. The report retains HTTP 429 errors, incomplete trials, and deadline cancellations. Higher concurrency encountered the shared provider limit sooner.

To measure the deployed service with the same workload, use `npm.cmd run scale -- --live --cloud`. This uses the operator token from the local configuration and submits through the production batch API. It needs no local database or worker.

## Deploy

The production app at [glitch-hunt.vercel.app](https://glitch-hunt.vercel.app) has a Neon Free-plan database and Vercel Queues delivery. A hosted five-job verification batch completed all four offline cases and a live two-call regression reproduction after its submitter exited. The batch and repair endpoints enforce authentication. Deployments currently use the Vercel CLI. Connecting the GitHub repository for automatic deployment still requires account-side access.

Create a Vercel project from this repository, use the **Other** framework preset, and keep this project's root as the deployment root. The configuration serves `public/` and deploys the `api/` Node handlers.

For a new installation, the saved replay and offline demo work immediately. Durable live batches need PostgreSQL, the environment variables above, the schema migration, and a worker:

1. Set the hosted database URL in the deployment environment and run `npm.cmd run db:migrate` using that connection.
2. Production batch submission publishes one durable Vercel Queue message per job. The private consumer runs that job and acknowledges the message only when PostgreSQL records a terminal state. Deferred jobs retry with a delay determined by the shared controls.
3. A daily repair schedule at 08:00 UTC calls `GET /api/worker` using `Authorization: Bearer YOUR_CRON_SECRET` to republish unfinished jobs. This repairs a crash between the PostgreSQL commit and queue publication. **Resume saved batch** also retries publication. Message IDs are deduplicated and PostgreSQL leases fence duplicate deliveries.
4. For local development or an external host, `npm.cmd run worker` polls PostgreSQL directly.

The queue consumer has no public URL. Messages retain delivery eligibility for seven days. PostgreSQL retains jobs and replays beyond that window, and repair can publish a fresh message after expiry. Queue and function use count toward Vercel plan allowances.

## Operational boundaries

Control values live in the singleton `gh_control` row. Defaults are 20 active attempts and 100 live attempts per UTC day. Every claimed live attempt consumes allowance, including retries. Cancellation aborts an active model request when the worker next checks the database. A provider may still charge a request already in flight.

Results are committed only by the worker that still owns the job's valid lease. A crashed attempt can be repeated after lease expiry. Model calls are therefore at least once, and their costs can recur on retries. Successful jobs have one saved result. Tool arguments and game state are checkpointed after every completed model call.

The model sees the synthetic game's map and tool results. Its API key and operator token stay out of traces and saved samples. A sample result is a recording and is labelled as such.

## Architecture

```mermaid
flowchart LR
  UI[Dashboard on Vercel] --> API[Authenticated batch API]
  API --> PG[(Neon PostgreSQL jobs and replays)]
  API --> Q[Vercel Queues]
  Q --> W[Private cloud consumer]
  W --> PG
  W --> G[Vercel AI Gateway]
  G --> T[Waypoint tool and game engine]
  T --> V[Deterministic verifier]
  V --> PG
  PG --> UI
```
