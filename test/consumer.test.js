import assert from "node:assert/strict";
import test from "node:test";
import { consume } from "../lib/consumer.js";

const jobId = "12345678-1234-1234-1234-123456789012";

test("duplicate messages for completed jobs do not rerun the agent", async () => {
  let runs = 0;
  await consume({ jobId }, async () => { runs++; }, async () => ({ done: true }));
  assert.equal(runs, 0);
});

test("a claimed job is acknowledged only after its result is saved", async () => {
  let done = false;
  await consume({ jobId }, async (id) => {
    assert.equal(id, jobId);
    done = true;
  }, async () => ({ done }));
  assert.equal(done, true);
});

test("deferred jobs return a provider retry delay instead of being acknowledged", async () => {
  await assert.rejects(
    () => consume({ jobId }, async () => {}, async () => ({ done: false, retryAfterSeconds: 60 })),
    (error) => error.retryAfterSeconds === 60,
  );
});
