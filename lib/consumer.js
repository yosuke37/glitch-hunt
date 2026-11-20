import { workOne } from "./worker.js";
import { deliveryState } from "./queue.js";

export async function consume(message, run = workOne, state = deliveryState) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(message?.jobId ?? "")) return;
  if ((await state(message.jobId)).done) return;
  await run(message.jobId);
  const result = await state(message.jobId);
  if (!result.done) {
    const error = new Error("Job is deferred by the shared queue controls.");
    error.retryAfterSeconds = result.retryAfterSeconds;
    throw error;
  }
}
