import { createHash, randomUUID } from "node:crypto";
import { database, transaction } from "./db.js";
import { gameVersion } from "../public/game.js";

export async function enqueue(inputs, concurrency, requestKey) {
  const fingerprint = createHash("sha256").update(JSON.stringify({ inputs, concurrency })).digest("hex");
  return transaction(async (db) => {
    const existing = (await db.query("SELECT * FROM gh_batches WHERE request_key = $1", [requestKey])).rows[0];
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("Request key was used for different inputs.");
      return existing.id;
    }
    const pending = (await db.query("SELECT count(*)::int AS n FROM gh_jobs WHERE status IN ('queued','running')")).rows[0].n;
    if (pending + inputs.length > 200) throw new Error("Queue is full.");
    const batchId = randomUUID();
    await db.query("INSERT INTO gh_batches (id, request_key, fingerprint, concurrency) VALUES ($1,$2,$3,$4)",
      [batchId, requestKey, fingerprint, concurrency]);
    for (const [ordinal, input] of inputs.entries()) {
      await db.query("INSERT INTO gh_jobs (id,batch_id,ordinal,input) VALUES ($1,$2,$3,$4)",
        [randomUUID(), batchId, ordinal, { ...input, gameVersion }]);
    }
    return batchId;
  });
}

export async function claim(jobId = null) {
  return transaction(async (db) => {
    await db.query(`
      UPDATE gh_attempts SET status = 'expired', finished_at = now(), error = 'Worker lease expired'
      WHERE status = 'running' AND lease_until <= now()
    `);
    await db.query(`
      UPDATE gh_jobs j SET status = CASE WHEN failure_count < 1 THEN 'queued' ELSE 'failed' END,
        failure_count = failure_count + 1,
        error = 'Worker lease expired', available_at = now(), lease_token = NULL,
        completed_at = CASE WHEN failure_count < 1 THEN NULL ELSE now() END
      WHERE j.status = 'running' AND NOT EXISTS (
        SELECT 1 FROM gh_attempts a WHERE a.token = j.lease_token AND a.status = 'running'
      )
    `);
    await db.query(`
      UPDATE gh_control SET budget_day = (now() AT TIME ZONE 'UTC')::date, live_attempts = 0
      WHERE budget_day < (now() AT TIME ZONE 'UTC')::date
    `);
    const control = (await db.query("SELECT * FROM gh_control WHERE id = 1")).rows[0];
    const active = (await db.query("SELECT count(*)::int AS n FROM gh_attempts WHERE status = 'running'")).rows[0].n;
    if (active >= control.concurrency) return null;
    const job = (await db.query(`
      SELECT j.* FROM gh_jobs j JOIN gh_batches b ON b.id = j.batch_id
      WHERE j.status = 'queued' AND j.available_at <= now()
        AND ($2::uuid IS NULL OR j.id = $2)
        AND (($1 OR j.budget_charged_on = (now() AT TIME ZONE 'UTC')::date) OR j.input->>'mode' <> 'live')
        AND ($3 OR j.input->>'mode' <> 'live')
        AND (SELECT count(*) FROM gh_attempts a JOIN gh_jobs k ON k.id = a.job_id
             WHERE k.batch_id = b.id AND a.status = 'running') < b.concurrency
      ORDER BY b.created_at, j.ordinal LIMIT 1 FOR UPDATE OF j SKIP LOCKED
    `, [control.live_attempts < control.daily_live_limit, jobId,
      new Date(control.model_cooldown_until).getTime() <= Date.now()])).rows[0];
    if (!job) return null;
    const token = randomUUID();
    await db.query("UPDATE gh_jobs SET status = 'running', attempts = attempts + 1, lease_token = $2 WHERE id = $1",
      [job.id, token]);
    await db.query("INSERT INTO gh_attempts (token,job_id) VALUES ($1,$2)", [token, job.id]);
    if (job.input.mode === "live") {
      const charged = await db.query(`
        UPDATE gh_jobs SET budget_charged_on=(now() AT TIME ZONE 'UTC')::date
        WHERE id=$1 AND budget_charged_on IS DISTINCT FROM (now() AT TIME ZONE 'UTC')::date RETURNING id
      `, [job.id]);
      if (charged.rowCount) await db.query("UPDATE gh_control SET live_attempts = live_attempts + 1 WHERE id = 1");
    }
    const previous = (await db.query(`
      SELECT progress FROM gh_attempts WHERE job_id=$1 AND progress IS NOT NULL
      ORDER BY started_at DESC LIMIT 1
    `, [job.id])).rows[0];
    return { ...job, lease_token: token, resume: previous?.progress };
  });
}

export async function heartbeat(job) {
  const result = await database().query(`
    UPDATE gh_attempts a SET lease_until = now() + interval '90 seconds'
    FROM gh_jobs j WHERE a.token = $1 AND a.job_id = j.id AND a.status = 'running'
      AND a.lease_until > now() AND j.status = 'running' AND j.lease_token = a.token
    RETURNING a.token
  `, [job.lease_token]);
  return result.rowCount === 1;
}

export async function checkpoint(job, progress) {
  const result = await database().query(`
    UPDATE gh_attempts a SET progress = $2 FROM gh_jobs j
    WHERE a.token = $1 AND a.status = 'running' AND a.lease_until > now()
      AND j.id = a.job_id AND j.status = 'running' AND j.lease_token = a.token
    RETURNING a.token
  `, [job.lease_token, progress]);
  if (!result.rowCount) throw new Error("Job cancelled or lease lost.");
}

export async function finish(job, result, error, retryAfterSeconds = 2, deferred = false) {
  return transaction(async (db) => {
    const current = (await db.query("SELECT status, lease_token, failure_count FROM gh_jobs WHERE id = $1 FOR UPDATE",
      [job.id])).rows[0];
    const attempt = (await db.query("SELECT * FROM gh_attempts WHERE token = $1 FOR UPDATE",
      [job.lease_token])).rows[0];
    if (!attempt || attempt.status !== "running" || current.lease_token !== job.lease_token) return false;
    const expired = new Date(attempt.lease_until).getTime() <= Date.now();
    const cancelled = current.status === "cancelled";
    const status = cancelled ? "cancelled" : expired ? "expired" : deferred ? "deferred" : error ? "failed" : "succeeded";
    await db.query("UPDATE gh_attempts SET status=$2, finished_at=now(), error=$3 WHERE token=$1",
      [job.lease_token, status, error ?? null]);
    if (cancelled) return false;
    const failed = expired || (Boolean(error) && !deferred);
    const retry = (deferred && !expired) || (failed && current.failure_count < 1);
    await db.query(`
      UPDATE gh_jobs SET status=$2, result=$3, error=$4, lease_token=NULL, failure_count=failure_count+$6,
        available_at=now() + make_interval(secs => $5),
        completed_at=CASE WHEN $2 = 'queued' THEN NULL ELSE now() END WHERE id=$1
    `, [job.id, retry ? "queued" : (error || expired) ? "failed" : "succeeded",
      (error || expired) ? null : result, error ?? (expired ? "Worker lease expired" : null),
      retryAfterSeconds, failed ? 1 : 0]);
    return !error && !expired;
  });
}

export async function coolDown(seconds) {
  await database().query(`
    UPDATE gh_control SET model_cooldown_until=GREATEST(model_cooldown_until,
      now() + make_interval(secs => $1)) WHERE id=1
  `, [seconds]);
}

export async function checkModelAccess() {
  const delay = await transaction(async (db) => {
    const control = (await db.query(`
      SELECT greatest(0,extract(epoch FROM greatest(model_cooldown_until,model_next_call_at)-now())) AS delay
      FROM gh_control WHERE id=1 FOR UPDATE
    `)).rows[0];
    if (Number(control.delay) > 0) return Math.ceil(Number(control.delay));
    await db.query("UPDATE gh_control SET model_next_call_at=now()+model_interval_ms*interval '1 millisecond' WHERE id=1");
    return 0;
  });
  if (delay) {
    const error = new Error("Waiting for the shared model request schedule or cooldown.");
    error.retryAfterSeconds = delay;
    error.deferred = true;
    throw error;
  }
}

export async function cancel(batchId) {
  await transaction((db) => db.query(`
    UPDATE gh_jobs SET status='cancelled', completed_at=now()
    WHERE batch_id=$1 AND status IN ('queued','running')
  `, [batchId]));
}

export async function getBatch(batchId) {
  const batch = (await database().query("SELECT id,concurrency,created_at FROM gh_batches WHERE id=$1", [batchId])).rows[0];
  if (!batch) return null;
  const jobs = (await database().query(`
    SELECT id,ordinal,input,status,attempts,result,error,completed_at FROM gh_jobs
    WHERE batch_id=$1 ORDER BY ordinal
  `, [batchId])).rows;
  const attempts = (await database().query(`
    SELECT a.job_id,a.status,a.started_at,a.finished_at,a.progress,a.error
    FROM gh_attempts a JOIN gh_jobs j ON j.id=a.job_id WHERE j.batch_id=$1 ORDER BY a.started_at
  `, [batchId])).rows;
  const control = (await database().query(`
    SELECT concurrency, daily_live_limit, live_attempts, budget_day, model_cooldown_until,model_next_call_at,model_interval_ms
    FROM gh_control WHERE id=1
  `)).rows[0];
  return { ...batch, jobs, attempts, control };
}

export async function deliveryState(jobId) {
  const job = (await database().query(`
    SELECT j.status,
      CASE WHEN j.input->>'mode'='live' THEN (
        SELECT count(*) * c.model_interval_ms / 1000.0 FROM gh_jobs k
        JOIN gh_batches kb ON kb.id=k.batch_id
        WHERE k.status IN ('queued','running') AND k.input->>'mode'='live'
          AND (kb.created_at,k.ordinal,k.id) < (b.created_at,j.ordinal,j.id)
      ) ELSE 0 END AS ahead,
      CASE WHEN j.input->>'mode' = 'live'
        AND c.budget_day = (now() AT TIME ZONE 'UTC')::date
        AND c.live_attempts >= c.daily_live_limit
        AND j.budget_charged_on IS DISTINCT FROM (now() AT TIME ZONE 'UTC')::date
      THEN extract(epoch FROM (((now() AT TIME ZONE 'UTC')::date + 1)::timestamp AT TIME ZONE 'UTC') - now())
      ELSE extract(epoch FROM GREATEST(j.available_at,
        CASE WHEN j.input->>'mode' = 'live' THEN greatest(c.model_cooldown_until,c.model_next_call_at) ELSE now() END) - now())
      END AS delay
    FROM gh_jobs j JOIN gh_batches b ON b.id=j.batch_id
    CROSS JOIN gh_control c WHERE j.id = $1 AND c.id=1
  `, [jobId])).rows[0];
  return {
    done: !job || ["succeeded", "failed", "cancelled"].includes(job.status),
    retryAfterSeconds: Math.max(5, Math.min(86400,
      Math.ceil(Math.max(Number(job?.delay) || 0, Number(job?.ahead) || 0)))),
  };
}
