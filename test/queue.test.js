import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { migrate, database, closeDatabase } from "../lib/db.js";
import { enqueue, claim, checkpoint, heartbeat, finish, cancel, getBatch, coolDown, checkModelAccess } from "../lib/queue.js";

test("PostgreSQL queue handles concurrent workers, retries, fencing, and cancellation",
  { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
    const schema = `gh_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set("options", `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    try {
      await migrate();
      const input = { mode: "offline", levelId: 0, seed: 1, scenario: "gate_reset" };
      const key = randomUUID();
      const batchId = await enqueue(Array.from({ length: 4 }, () => input), 2, key);
      assert.equal(await enqueue(Array.from({ length: 4 }, () => input), 2, key), batchId);
      await assert.rejects(() => enqueue([input], 1, key), /different inputs/);
      await t.test("concurrent claims obey batch and global limits", async () => {
        await database().query("UPDATE gh_control SET concurrency=2");
        const claimed = (await Promise.all(Array.from({ length: 8 }, claim))).filter(Boolean);
        assert.equal(claimed.length, 2);
        await checkpoint(claimed[0], { usage: { modelCalls: 1 }, trace: [] });
        assert.equal(await heartbeat(claimed[0]), true);
        for (const job of claimed) assert.equal(await finish(job, { outcome: "regression_found" }), true);
      });
      await t.test("expired workers cannot overwrite a retried result", async () => {
        const old = await claim();
        await database().query("UPDATE gh_attempts SET lease_until=now()-interval '1 second' WHERE token=$1",
          [old.lease_token]);
        const retry = await claim();
        assert.equal(retry.id, old.id);
        assert.notEqual(retry.lease_token, old.lease_token);
        assert.equal(await finish(old, { outcome: "bad stale result" }), false);
        await finish(retry, { outcome: "regression_found" });
      });
      await t.test("cancellation stops the worker and preserves prior completed results", async () => {
        const running = await claim();
        await cancel(batchId);
        assert.equal(await heartbeat(running), false);
        await assert.rejects(() => checkpoint(running, {}), /cancelled/);
        assert.equal(await finish(running, { outcome: "late result" }), false);
        const batch = await getBatch(batchId);
        assert.equal(batch.jobs.filter((job) => job.status === "succeeded").length, 3);
        assert.equal(batch.jobs.filter((job) => job.status === "cancelled").length, 1);
        assert.equal(batch.attempts.filter((attempt) => attempt.status === "running").length, 0);
      });
      await t.test("daily live attempt budget is shared across workers", async () => {
        await database().query("UPDATE gh_control SET daily_live_limit=1, live_attempts=0");
        const id = await enqueue([{ ...input, mode: "live" }, { ...input, mode: "live" }], 2, randomUUID());
        const first = await claim();
        assert.ok(first);
        assert.equal(await claim(), null);
        await finish(first, { outcome: "agent_incomplete" });
        assert.equal(await claim(), null);
        await cancel(id);
      });
      await t.test("a shared Gateway cooldown pauses live claims but lets offline jobs run", async () => {
        await database().query("UPDATE gh_control SET live_attempts=0");
        const live = await enqueue([{ ...input, mode: "live" }], 1, randomUUID());
        const offline = await enqueue([input], 1, randomUUID());
        await coolDown(60);
        await assert.rejects(checkModelAccess, /cooldown/);
        const job = await claim();
        assert.equal(job.batch_id, offline);
        await finish(job, { outcome: "regression_found" });
        assert.equal(await claim(), null);
        await cancel(live);
      });
      await t.test("a targeted delivery claims only the requested job", async () => {
        const id = await enqueue([input, input], 2, randomUUID());
        const batch = await getBatch(id);
        const selected = await claim(batch.jobs[1].id);
        assert.equal(selected.id, batch.jobs[1].id);
        await finish(selected, { outcome: "regression_found" });
        assert.equal(await claim(batch.jobs[1].id), null);
        await cancel(id);
      });
      await t.test("pacing deferrals retain checkpoints, job allowance, and the real-failure budget", async () => {
        await database().query(`
          UPDATE gh_control SET daily_live_limit=1,live_attempts=0,model_interval_ms=1000,
            model_cooldown_until=now(),model_next_call_at=now()
        `);
        const id = await enqueue([{ ...input, mode: "live" }, { ...input, mode: "live" }], 2, randomUUID());
        const first = await claim();
        await checkpoint(first, { inputs: ["south"], usage: { modelCalls: 1 }, trace: [] });
        await checkModelAccess();
        await assert.rejects(checkModelAccess, (error) => error.deferred && error.retryAfterSeconds > 0);
        await finish(first, null, "Waiting for schedule", 0, true);
        const resumed = await claim(first.id);
        assert.deepEqual(resumed.resume.inputs, ["south"]);
        assert.equal(await claim(), null);
        const row = (await database().query("SELECT failure_count FROM gh_jobs WHERE id=$1", [first.id])).rows[0];
        assert.equal(row.failure_count, 0);
        await finish(resumed, { outcome: "regression_found" });
        await cancel(id);
      });
      await t.test("public links opt in, remain stable, and revoke without exposing job inputs", async () => {
        const { POST, GET, DELETE } = await import("../api/runs.js");
        const { execute } = await import("../lib/execution.js");
        const prior = process.env.HUNT_RUN_TOKEN;
        process.env.HUNT_RUN_TOKEN = "test-operator";
        try {
          const batch = await enqueue([{ ...input, privateValue: "PRIVATE" }], 1, randomUUID());
          const job = await claim();
          const result = await execute(input);
          await finish(job, result);
          const request = () => new Request("http://localhost/api/runs", { method: "POST", headers: { Authorization: "Bearer test-operator", "Content-Type": "application/json" }, body: JSON.stringify({ jobId: job.id }) });
          const published = await (await POST(request())).json();
          assert.equal((await (await POST(request())).json()).id, published.id);
          const publicRequest = () => new Request(`http://localhost/api/runs?id=${published.id}`);
          const response = await GET(publicRequest());
          assert.equal(response.status, 200);
          assert.equal(JSON.stringify(await response.json()).includes("PRIVATE"), false);
          assert.equal((await DELETE(request())).status, 200);
          assert.equal((await GET(publicRequest())).status, 404);
          assert.equal((await getBatch(batch)).jobs[0].status, "succeeded");
        } finally {
          if (prior === undefined) delete process.env.HUNT_RUN_TOKEN;
          else process.env.HUNT_RUN_TOKEN = prior;
        }
      });
    } finally {
      await closeDatabase();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
