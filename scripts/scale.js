import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { enqueue, getBatch, cancel } from "../lib/queue.js";
import { closeDatabase } from "../lib/db.js";
import { scenarios, cases } from "../public/game.js";

const mode = process.argv.includes("--live") ? "live" : "offline";
const cloud = process.argv.includes("--cloud");
const expanded = process.argv.includes("--expanded");
const timeoutSeconds = Number(process.argv.find((arg) => arg.startsWith("--timeout-seconds="))?.split("=")[1] ?? 600);
if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 1800) throw new Error("Use a timeout of 30–1800 seconds.");
async function remote(method, id, body) {
  const response = await fetch(`${process.env.HUNT_URL ?? "https://glitch-hunt.vercel.app"}/api/batches${id ? `?id=${id}` : ""}`, {
    method, headers: { Authorization: `Bearer ${process.env.HUNT_RUN_TOKEN}`, "Content-Type": "application/json" },
    ...(body && { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Batch HTTP ${response.status}`);
  return result;
}
async function create(inputs, concurrency) {
  const key = randomUUID();
  return cloud ? (await remote("POST", null, { inputs, concurrency, requestKey: key })).id
    : enqueue(inputs, concurrency, key);
}
const inputs = expanded ? cases.map((item, index) => ({
  mode, seed: index + 1, levelId: item.levelId, scenario: item.scenario,
})) : Array.from({ length: 20 }, (_, index) => ({
  mode, seed: index + 1, levelId: index % 3, scenario: scenarios[index % 4].id,
}));
const report = {
  measuredAt: new Date().toISOString(), mode, trialsPerCohort: inputs.length,
  cohortTimeoutSeconds: timeoutSeconds,
  workloadVersion: expanded ? "expanded-25" : "original-20",
  workload: inputs, model: mode === "live" ? process.env.HUNT_MODEL : "offline-bfs",
  costBasis: "Estimated uncached list rates for openai/gpt-4.1-mini: $0.40/M input, $1.60/M output. Check actual billed cost in Vercel.",
  environment: cloud ? "Neon PostgreSQL and Vercel Queues cloud workers. Model requests use Vercel AI Gateway."
    : "Local PostgreSQL queue and independent Node worker. Model requests use Vercel AI Gateway.",
  cohorts: [],
  notes: `Cohorts run sequentially and share provider limits and the application request schedule. Each cohort has a ${timeoutSeconds}-second deadline. Completed trials exclude failed, cancelled, and unfinished runs. Misses include unfinished bug trials. Cost estimates can omit interrupted requests. Earlier results used a 180-second deadline.`,
};
try {
  for (const concurrency of [1, 5, 20]) {
    const id = await create(inputs, concurrency);
    console.log(`Queued ${mode} cohort ${id} with ${concurrency} slots.`);
    const started = performance.now();
    let batch;
    do {
      if (performance.now() - started > timeoutSeconds * 1000) {
        if (cloud) await remote("DELETE", id);
        else await cancel(id);
        batch = cloud ? await remote("GET", id) : await getBatch(id);
        break;
      }
      await setTimeout(cloud ? 1500 : 250);
      batch = cloud ? await remote("GET", id) : await getBatch(id);
    } while (batch.jobs.some((job) => ["queued", "running"].includes(job.status)));
    const durationSeconds = (performance.now() - started) / 1000;
    const completed = batch.jobs.filter((job) => job.result?.outcome !== "agent_incomplete" && job.status === "succeeded");
    const times = completed.filter((job) => job.completed_at)
      .map((job) => new Date(job.completed_at) - new Date(batch.created_at)).sort((a, b) => a - b);
    let truePositives = 0, falseNegatives = 0, falsePositives = 0, trueNegatives = 0, incomplete = 0;
    for (const job of batch.jobs) {
      const expected = cases.find((item) => item.levelId === job.input.levelId && item.scenario === job.input.scenario).expectedRegression;
      const outcome = job.result?.outcome;
      if (!outcome || outcome === "agent_incomplete") incomplete++;
      if (expected && outcome === "regression_found") truePositives++;
      if (expected && outcome !== "regression_found") falseNegatives++;
      if (!expected && outcome === "regression_found") falsePositives++;
      if (!expected && outcome === "no_regression_found") trueNegatives++;
    }
    const usage = batch.attempts.reduce((sum, attempt) => ({
      inputTokens: sum.inputTokens + (attempt.progress?.usage?.inputTokens ?? 0),
      outputTokens: sum.outputTokens + (attempt.progress?.usage?.outputTokens ?? 0),
    }), { inputTokens: 0, outputTokens: 0 });
    const costUsd = mode === "offline" ? 0 : report.model === "openai/gpt-4.1-mini"
      ? (usage.inputTokens * 0.4 + usage.outputTokens * 1.6) / 1_000_000 : null;
    const cohort = {
      id, concurrency, durationSeconds, completed: completed.length,
      completionRate: completed.length / inputs.length,
      trialsPerSecond: batch.jobs.length / durationSeconds,
      completedPerSecond: completed.length / durationSeconds,
      p95CompletionMs: times[Math.ceil(times.length * 0.95) - 1] ?? null,
      truePositives, falseNegatives, falsePositives, trueNegatives, incomplete,
      costUsd, costPerFindingUsd: costUsd === null || !truePositives ? null : costUsd / truePositives,
      usage, attempts: batch.attempts.length, batch,
      requestSpacingMs: batch.control.model_interval_ms,
      errors: batch.attempts.filter((attempt) => attempt.error).map((attempt) => attempt.error),
      cancelled: batch.jobs.filter((job) => job.status === "cancelled").length,
    };
    report.cohorts.push(cohort);
    console.log(`${concurrency} slots · ${completed.length}/${inputs.length} complete · ${truePositives} verified findings · ${durationSeconds.toFixed(2)}s · estimated $${costUsd?.toFixed(4) ?? "unknown"}`);
    await mkdir(new URL("../output/", import.meta.url), { recursive: true });
    await writeFile(new URL(`../output/benchmark-${mode}${cloud ? "-cloud" : ""}${expanded ? "-expanded" : ""}.json`, import.meta.url), JSON.stringify(report, null, 2));
  }
  // Publish aggregate metrics only. Full evidence stays in PostgreSQL and output/.
  const publicReport = { ...report, cohorts: report.cohorts.map(({ batch, ...cohort }) => cohort) };
  if (mode === "live") {
    await writeFile(new URL("../public/benchmark.json", import.meta.url), JSON.stringify(publicReport, null, 2));
  }
} finally {
  await closeDatabase();
}
