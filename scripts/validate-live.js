import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

const origin = process.env.HUNT_URL ?? "https://glitch-hunt.vercel.app";
async function api(method, id, body) {
  const response = await fetch(`${origin}/api/batches${id ? `?id=${id}` : ""}`, {
    method, headers: { Authorization: `Bearer ${process.env.HUNT_RUN_TOKEN}`, "Content-Type": "application/json" },
    ...(body && { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}
const inputs = [
  { mode: "live", seed: 1, levelId: 0, scenario: "gate_reset" },
  { mode: "live", seed: 2, levelId: 3, scenario: "corridor_blocked" },
  { mode: "live", seed: 3, levelId: 4, scenario: "corridor_blocked" },
];
const { id } = await api("POST", null, { inputs, concurrency: 1, requestKey: randomUUID() });
console.log(`Validating three live cases: ${id}`);
let batch;
try {
  const deadline = Date.now() + 300_000;
  do {
    await setTimeout(3000);
    batch = await api("GET", id);
    if (Date.now() > deadline) throw new Error("Live validation exceeded five minutes.");
  } while (batch.jobs.some((job) => ["queued", "running"].includes(job.status)));
  await mkdir(new URL("../output/", import.meta.url), { recursive: true });
  await writeFile(new URL("../output/semantic-live-validation.json", import.meta.url), JSON.stringify(batch, null, 2));
  const expected = ["regression_found", "no_regression_found", "regression_found"];
  for (const [index, job] of batch.jobs.entries()) {
    console.log(`${job.input.levelId}: ${job.status} / ${job.result?.outcome} / ${job.result?.usage?.modelCalls ?? 0} calls`);
    if (job.status !== "succeeded" || job.result.outcome !== expected[index]) throw new Error("Live outcome did not match its labelled case.");
  }
  console.log(`Daily live jobs: ${batch.control.live_attempts}/${batch.control.daily_live_limit}.`);
} finally {
  if (!batch || batch.jobs.some((job) => ["queued", "running"].includes(job.status))) await api("DELETE", id);
}
