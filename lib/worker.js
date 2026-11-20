import { claim, checkpoint, finish, heartbeat, coolDown, checkModelAccess } from "./queue.js";
import { execute } from "./execution.js";

export async function workOne(jobId = null) {
  const job = await claim(jobId);
  if (!job) return false;
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(35_000)]);
  let checking = false;
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      if (!await heartbeat(job)) controller.abort();
    } catch {
      controller.abort();
    } finally {
      checking = false;
    }
  }, 1000);
  try {
    const result = await execute(job.input, signal, (progress) => checkpoint(job, progress), checkModelAccess, job.resume);
    await finish(job, result);
  } catch (error) {
    let message = error.deferred || error.message?.startsWith("AI Gateway rejected")
      ? error.message : "Trial failed, cancelled, or timed out.";
    if (error.details) message += ` ${error.details}`;
    if (error.providerThrottle) await coolDown(error.retryAfterSeconds);
    await finish(job, null, message, error.retryAfterSeconds ?? 2, error.deferred ?? false);
  } finally {
    clearInterval(timer);
  }
  return true;
}
