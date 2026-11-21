import { claim, checkpoint, finish, heartbeat, coolDown, checkModelAccess } from "./queue.js";
import { execute } from "./execution.js";
import { setTimeout } from "node:timers/promises";

export async function workOne(jobId = null) {
  const job = await claim(jobId);
  if (!job) return false;
  const controller = new AbortController();
  const deadline = performance.now() + 50_000;
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(50_000)]);
  const beforeCall = async () => {
    while (true) {
      try { await checkModelAccess(); return; }
      catch (error) {
        const delay = error.retryAfterSeconds * 1000;
        if (!error.deferred || delay > 15000 || deadline - performance.now() < delay + 5000) throw error;
        await setTimeout(delay, undefined, { signal });
      }
    }
  };
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
    const result = await execute(job.input, signal, (progress) => checkpoint(job, progress), beforeCall, job.resume);
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
