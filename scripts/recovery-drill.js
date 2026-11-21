import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout } from "node:timers/promises";
import { writeFile } from "node:fs/promises";
import pg from "pg";
import { database, migrate, closeDatabase } from "../lib/db.js";
import { enqueue, claim, cancel, checkpoint, heartbeat, finish, getBatch } from "../lib/queue.js";
import { workOne } from "../lib/worker.js";
import { consume } from "../lib/consumer.js";
import { publicRun } from "../lib/public-run.js";

if (!process.argv.includes("--live")) throw new Error("Use --live to authorize this bounded real-model recovery drill.");
const originalUrl = process.env.DATABASE_URL;
if (!["127.0.0.1", "localhost"].includes(new URL(originalUrl).hostname)) throw new Error("Recovery drills require a local test database.");
const schema = `gh_drill_${randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({ connectionString: originalUrl });
const events = [];
const record = (name, detail) => { events.push({ at: new Date().toISOString(), name, detail }); console.log(name); };
let child;
try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(originalUrl);
  url.searchParams.set("options", `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.href;
  await migrate();
  const input = { mode: "live", levelId: 5, seed: 1, scenario: "healthy" };
  const batchId = await enqueue([input], 1, randomUUID());
  child = spawn(process.execPath, ["scripts/worker.js"], { env: process.env, stdio: "ignore", windowsHide: true });
  let saved;
  const deadline = Date.now() + 90_000;
  do {
    await setTimeout(100);
    saved = (await database().query("SELECT a.progress,j.id FROM gh_attempts a JOIN gh_jobs j ON j.id=a.job_id WHERE j.batch_id=$1 AND jsonb_array_length(a.progress->'inputs')>0 ORDER BY a.started_at DESC LIMIT 1", [batchId])).rows[0];
    if (Date.now() > deadline) throw new Error("No model checkpoint within 90 seconds.");
  } while (!saved);
  record("checkpoint_persisted", { moves: saved.progress.inputs.length, modelCalls: saved.progress.totalUsage.modelCalls });
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  record("worker_process_terminated", { method: "OS process termination after persisted moves" });
  // Accelerate the normal 90-second lease timeout only inside this disposable schema.
  await database().query("UPDATE gh_attempts SET lease_until=now()-interval '1 second' WHERE job_id=$1 AND status='running'", [saved.id]);
  record("lease_expiry_accelerated", { normalLeaseSeconds: 90, isolatedTestSchema: true });
  for (let attempt = 0; attempt < 4; attempt++) {
    await workOne(saved.id);
    const batch = await getBatch(batchId);
    if (batch.jobs[0].status === "succeeded") break;
    await setTimeout(16000);
  }
  const batch = await getBatch(batchId);
  const job = batch.jobs[0];
  assert.equal(job.status, "succeeded");
  assert.equal(job.result.outcome, "no_regression_found");
  assert.deepEqual(job.result.inputs.slice(0, saved.progress.inputs.length), saved.progress.inputs);
  assert.equal(job.result.trace[0].arguments.waypoint, "key");
  const usage = batch.attempts.reduce((n, a) => n + (a.progress?.usage?.modelCalls ?? 0), 0);
  assert.equal(usage, job.result.usage.modelCalls);
  record("checkpoint_resumed", { retainedMoves: saved.progress.inputs.length, totalMoves: job.result.inputs.length, modelCalls: usage, outcome: job.result.outcome });
  await consume({ jobId: job.id });
  const after = await getBatch(batchId);
  assert.equal(after.attempts.length, batch.attempts.length);
  record("duplicate_delivery_ignored", { attemptsBefore: batch.attempts.length, attemptsAfter: after.attempts.length });
  const cancellation = await enqueue([{ ...input, mode: "offline" }], 1, randomUUID());
  const cancelled = await claim();
  await checkpoint(cancelled, { inputs: [], trace: [] });
  await cancel(cancellation);
  assert.equal(await heartbeat(cancelled), false);
  await assert.rejects(() => checkpoint(cancelled, {}), /cancelled/);
  assert.equal(await finish(cancelled, { outcome: "incorrect" }), false);
  record("cancelled_worker_fenced", { heartbeatAccepted: false, checkpointAccepted: false, staleResultAccepted: false });
  const evidence = { measuredAt: new Date().toISOString(), environment: "Local PostgreSQL and real Vercel AI Gateway model; disposable test schema", model: job.result.model,
    method: "Terminate a real worker after its first move checkpoint, accelerate its 90-second lease expiry in isolation, then resume in another process. Cancellation and duplicate delivery exercise the same production queue functions.",
    events, passed: true, modelCalls: usage, costUsd: job.result.costUsd, attempts: batch.attempts.length };
  await writeFile(new URL("../public/recovery-evidence.json", import.meta.url), JSON.stringify(evidence, null, 2));
  await writeFile(new URL("../public/recovery-run.json", import.meta.url), JSON.stringify({ ...publicRun({ ...job, input, public_id: "recovery" }), recording: { environment: evidence.environment } }, null, 2));
  record("evidence_saved", { publicArtifacts: ["recovery-evidence.json", "recovery-run.json"] });
} finally {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  await closeDatabase();
  process.env.DATABASE_URL = originalUrl;
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}
