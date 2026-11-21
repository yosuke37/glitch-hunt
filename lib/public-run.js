import { levels } from "../public/game.js";
import { verify } from "./hunt.js";
import { observe, describeAttempts } from "./observation.js";

// Publish a projection, never the job input, provider errors, or attempt records.
export function publicRun(job) {
  const { levelId, seed, scenario = "gate_reset", mode } = job.input;
  const result = job.result;
  const level = levels[levelId];
  const assessment = verify(level, result.inputs, seed, scenario);
  const trace = (result.trace ?? []).map((entry) => {
    const args = Object.fromEntries(["waypoint", "build", "x", "y"].filter((key) => entry.arguments?.[key] !== undefined).map((key) => [key, entry.arguments[key]]));
    const moves = result.inputs.slice(entry.frameStart, entry.frameEnd);
    const feedback = Object.fromEntries(["baseline", "candidate"].map((build) => [build, {
      ...observe(level, assessment[build][entry.frameEnd], build, scenario),
      attempts: describeAttempts(level, assessment[build], moves, entry.frameStart),
    }]));
    return { call: entry.call, tool: entry.tool, arguments: args, moves,
      frameStart: entry.frameStart, frameEnd: entry.frameEnd,
      baseline: assessment.baseline[entry.frameEnd], candidate: assessment.candidate[entry.frameEnd], feedback,
      elapsedMs: entry.elapsedMs, scheduledWaitMs: entry.scheduledWaitMs ?? 0,
      inputTokens: entry.inputTokens, outputTokens: entry.outputTokens };
  });
  return { id: job.public_id, completedAt: job.completed_at, mode, levelId, seed, scenario,
    gameVersion: result.gameVersion, ...assessment, trace,
    usage: result.usage && { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, modelCalls: result.usage.modelCalls },
    model: result.model, stopReason: result.stopReason, costUsd: result.costUsd ?? null, elapsedMs: result.elapsedMs };
}
