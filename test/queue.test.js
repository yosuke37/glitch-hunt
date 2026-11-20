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
    } finally {
      await closeDatabase();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
