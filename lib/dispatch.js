import { sendBatch } from "@vercel/queue";
import { database } from "./db.js";

export async function dispatch(batchId = null, send = sendBatch) {
  if (process.env.VERCEL_ENV !== "production") return { sent: 0, externalWorker: true };
  const jobs = (await database().query(`
    SELECT id FROM gh_jobs WHERE status IN ('queued','running')
      AND ($1::uuid IS NULL OR batch_id=$1) ORDER BY available_at LIMIT 200
  `, [batchId])).rows;
  let sent = 0;
  for (let offset = 0; offset < jobs.length; offset += 100) {
    const chunk = jobs.slice(offset, offset + 100);
    const results = await send("glitch-hunt-trials", chunk.map((job) => ({
      payload: { jobId: job.id }, idempotencyKey: job.id, retentionSeconds: 604800,
    })), { region: "iad1" });
    if (results.some((result) => result.status === "failed")) {
      throw new Error("Some worker messages were not accepted. Retry dispatch.");
    }
    sent += results.length;
  }
  return { sent };
}
