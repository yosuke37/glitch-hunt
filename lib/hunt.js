import { gameVersion, levels, moves, replay, start, step } from "../public/game.js";

export const maxMoves = 28;
const directions = Object.keys(moves);

export function shortestPath(level, build, seed, scenario = "gate_reset", initial = start(level), target) {
  const frontier = [[initial, []]];
  const seen = new Set();
  const order = [...directions.slice(seed % 4), ...directions.slice(0, seed % 4)];
  for (const [state, inputs] of frontier) {
    if (target ? state.x === target.x && state.y === target.y : state.won) return inputs;
    const key = `${state.x},${state.y},${state.gateOpen}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const move of order) {
      const next = step(level, state, move, build, scenario);
      if (next !== state) frontier.push([next, [...inputs, move]]);
    }
  }
  return null;
}

export function offlineProbe(level, seed, scenario = "gate_reset") {
  const inputs = shortestPath(level, "baseline", seed) ?? [];
  const assessment = verify(level, inputs, seed, scenario);
  if (assessment.verified || assessment.candidate.at(-1).won) return inputs;
  const recovery = shortestPath(level, "candidate", seed, scenario, assessment.candidate.at(-1));
  return [...inputs, ...(recovery ?? [])].slice(0, maxMoves);
}

export function verify(level, inputs, seed, scenario = "gate_reset") {
  const baseline = replay(level, inputs, "baseline");
  const candidate = replay(level, inputs, "candidate", scenario);
  const baselineWon = baseline.at(-1).won;
  const candidateWon = candidate.at(-1).won;
  const baselineRoute = shortestPath(level, "baseline", seed);
  const candidateRoute = shortestPath(level, "candidate", seed, scenario);
  const candidateHasPath = candidateRoute !== null;
  const exceedsBudget = level.maxExtraMoves !== undefined && baselineRoute !== null && candidateHasPath &&
    candidateRoute.length > baselineRoute.length + level.maxExtraMoves;
  const verified = baselineWon && (!candidateHasPath || exceedsBudget);
  const outcome = verified ? "regression_found" :
    baselineWon && candidateWon ? "no_regression_found" : "agent_incomplete";
  const evidence = {
    reason: verified ? (candidateHasPath ? "route_budget_exceeded" : "completion_impossible")
      : baselineWon && candidateWon ? "both_completed" : "unfinished",
    baselineShortestMoves: baselineRoute?.length ?? null,
    candidateShortestMoves: candidateRoute?.length ?? null,
    maxExtraMoves: level.maxExtraMoves ?? null,
  };
  return { inputs, baseline, candidate, verified, candidateHasPath, outcome, evidence };
}

export async function hunt({ levelId, seed, scenario = "gate_reset", probe, signal }) {
  const level = levels[levelId];
  const started = performance.now();
  const result = await probe(level, seed, signal, scenario);
  return {
    seed, levelId, scenario, gameVersion,
    ...verify(level, result.inputs, seed, scenario),
    usage: result.usage,
    trace: result.trace ?? [],
    model: result.model,
    stopReason: result.stopReason,
    costUsd: result.costUsd ?? null,
    elapsedMs: performance.now() - started,
  };
}
