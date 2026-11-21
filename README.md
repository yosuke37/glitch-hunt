# Glitch Hunt

[Open the live demo](https://glitch-hunt.vercel.app) · [Source on GitHub](https://github.com/yosuke37/glitch-hunt)

[Watch the 44-second walkthrough](https://glitch-hunt.vercel.app/demo.mp4). This captioned edit uses captured frames from the deployed dashboard. It shows a recorded live agent replay and two explicitly labelled offline reference checks; playback speed is not a model performance measurement.

Glitch Hunt uses an AI playtest agent to choose waypoints in a puzzle game, replays the resulting moves on two builds, and checks the resulting game state. The dashboard opens with a real saved live run, including the model's tool arguments, moves, observations, latency, and token usage.

The agent chooses destinations. A deterministic pathfinder translates those choices into moves on the baseline and applies the same inputs to the candidate. An independent exhaustive search verifies whether a failed candidate replay represents an impossible completion state. These roles appear separately in the activity trace.

## Current capabilities

- Five levels and five candidate updates with 25 labelled combinations. Two levels include solvable route changes. A level permits four extra moves, so a 14-move candidate route passes against a 10-move baseline while an 18-move candidate route violates the same budget.
- Three outcomes, **Regression found**, **No regression found**, and **Agent couldn't finish**. A healthy result covers the observed trace.
- PostgreSQL stores batches, jobs, replays, and per-attempt trace checkpoints. A worker continues after the browser closes, and a batch ID saved in the browser restores the results.
- Leases, stale-worker fencing, two real-failure attempts, cancellation, shared concurrency up to 20, a daily live-job cap, request pacing, and a shared cooldown after Gateway HTTP 429 responses. Scheduling deferrals retain checkpoints and the real-failure budget.
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

The database test creates and removes its own temporary schema. CI runs it against a disposable PostgreSQL service. The scale command needs an independent worker running. Each cohort submits the original 20 trials at 1, 5, and 20 slots. Use `--expanded` to exercise all 25 labelled combinations. Live measurements make paid API requests. The direct single-trial development command is `npm.cmd run live`. Run `npm.cmd run validate:live` to repeat the three hosted live outcome checks.

Full benchmark evidence is saved in PostgreSQL and ignored `output/benchmark-live.json` (or `output/benchmark-live-cloud.json` for the hosted run). Public aggregate results are in [public/benchmark.json](public/benchmark.json) and the dashboard. They include completion, findings, missed detections, false alarms, p95 time from batch submission to successful completion, and estimated cost per finding. Cohorts share provider limits and request pacing. The runner defaults to a twenty-minute deadline. Use `--timeout-seconds=180` to repeat the earlier three-minute deadline. The estimate uses uncached GPT-4.1 mini list rates of $0.40/M input tokens and $1.60/M output tokens. Actual charges belong to the Gateway billing dashboard.

The first local live scaling run on November 20 completed four trials before HTTP 429 throttling and exhausted its daily attempt cap through retries. A subsequent hosted benchmark uses the shared cooldown fix and private Vercel consumers. A benchmark against higher provider limits is still needed to measure unconstrained scaling.

The original hosted run completed 12/20 trials at one slot, 7/20 at five slots, and 1/20 at twenty slots. It verified nine, six, and one planted regressions respectively. The [earlier report](public/benchmark-before-pacing.json) retains HTTP 429 errors, incomplete trials, and deadline cancellations.

The November 21 semantic-landmark benchmark completed all 60 live trials. Every cohort made 40 model calls, found all 15 labelled regressions, and correctly classified five healthy trials. There were zero misses, false alarms, incomplete trials, or provider HTTP 429 responses.

| Slots / peak leased attempts | Completed | Verified findings | Batch time | Estimated model cost |
| --- | --- | --- | --- | --- |
| 1 / 1 | 20/20 | 15 | 622.10 s | $0.01264 |
| 5 / 5 | 20/20 | 15 | 607.30 s | $0.01054 |
| 20 / 20 | 20/20 | 15 | 608.41 s | $0.01054 |

Peak active jobs in the dashboard counts overlapping worker leases. Model requests follow the shared schedule. These results demonstrate completion under concurrency and recovery, while the current quota constrains throughput. Estimated model cost across the 60 trials was $0.03371, excluding hosting and queue charges. This run used a 1,200-second deadline and 15-second request spacing. The [intermediate checkpoint report](public/benchmark-after-checkpoints.json) retains the earlier 10/20, 13/20, and 9/20 results with a 600-second deadline and 7.5-second spacing. Both the tool interface and deadline changed between reports; this is an engineering progression rather than an isolated causal experiment.

To measure the deployed service with the same workload, use `npm.cmd run scale -- --live --cloud`. This uses the operator token from the local configuration and submits through the production batch API. It needs no local database or worker.

## Deploy

The production app at [glitch-hunt.vercel.app](https://glitch-hunt.vercel.app) has a Neon Free-plan database and Vercel Queues delivery. A hosted five-job verification batch completed all four offline cases and a live two-call regression reproduction after its submitter exited. The batch and repair endpoints enforce authentication. GitHub is connected to the production branch, `codex/glitch-hunt`. Pushes trigger Vercel deployments and PostgreSQL CI checks.

Create a Vercel project from this repository, use the **Other** framework preset, and keep this project's root as the deployment root. The configuration serves `public/` and deploys the `api/` Node handlers.

For a new installation, the saved replay and offline demo work immediately. Durable live batches need PostgreSQL, the environment variables above, the schema migration, and a worker:

1. Set the hosted database URL in the deployment environment and run `npm.cmd run db:migrate` using that connection.
2. Production batch submission publishes one durable Vercel Queue message per job. The private consumer runs that job and acknowledges the message only when PostgreSQL records a terminal state. Deferred jobs retry with a delay determined by the shared controls.
3. A daily repair schedule at 08:00 UTC calls `GET /api/worker` using `Authorization: Bearer YOUR_CRON_SECRET` to republish unfinished jobs. This repairs a crash between the PostgreSQL commit and queue publication. **Resume saved batch** also retries publication. Message IDs are deduplicated and PostgreSQL leases fence duplicate deliveries.
4. For local development or an external host, `npm.cmd run worker` polls PostgreSQL directly.

The queue consumer has no public URL. Messages retain delivery eligibility for seven days. PostgreSQL retains jobs and replays beyond that window, and repair can publish a fresh message after expiry. Queue and function use count toward Vercel plan allowances.

## Operational boundaries

Control values live in the singleton `gh_control` row. Defaults are 20 active attempts, 100 live jobs per UTC day, and a 15,000 ms minimum interval between model calls across workers. A job consumes one allowance when first claimed that day. Pacing deferrals and retries reuse that allowance. Cancellation aborts an active model request when the worker next checks the database. A provider may still charge a request already in flight.

Results are committed only by the worker that still owns the job's valid lease. A retried worker restores the saved game inputs, trace, and accumulated usage. It continues navigation from that state. Per-attempt usage is stored separately to avoid counting tokens twice. A crash before a response is checkpointed can still repeat that model request and its charge.

The model sees the synthetic game's map and tool results. Its API key and operator token stay out of traces and saved samples. A sample result is a recording and is labelled as such.

The hosted offline reference workload completed all 25 expanded cases at every concurrency: 26.70 seconds at one slot, 14.04 seconds at five, and 7.88 seconds at twenty. Each cohort found all 16 labelled regressions with no false alarms. The [reference report](public/benchmark-reference.json) measures queue and game-engine performance without model calls; its expanded workload differs from the live benchmark.

## Engineering story

The hard part was making model work observable and recoverable across short-lived cloud functions. Jobs persist before dispatch, leases fence duplicate deliveries, and checkpoints retain moves, tool observations, and separately accounted token usage. The model chooses semantic landmarks; a deterministic navigator executes moves, and a separate verifier decides whether the candidate violates the game's completion or route-length contract.

The first scaling experiments exposed two different bottlenecks: a provider quota and repeated coordinate choices after resuming a job. The provider returned an explicit five-requests-per-minute limit for this team's GPT-4.1 mini route. A shared 15-second request interval leaves headroom below that limit. Named pressure-plate and exit tools reduce coordinate ambiguity. Three subsequent hosted live checks passed: an impossible completion regression, a healthy alternate route, and a solvable detour that violates its move allowance.

Concurrency slots are worker capacity, not a promise of linear model throughput. All workers share the same provider allowance. Published reports retain incomplete outcomes and cost estimates so the limits are visible. This is an instrumented game testbed; adapting it to arbitrary browser games would require new observation and action adapters.

## Architecture diagram

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
