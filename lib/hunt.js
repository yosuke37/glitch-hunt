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

export function offlineProbe(level, seed) {
  return shortestPath(level, "baseline", seed) ?? [];
}

export function verify(level, inputs, seed, scenario = "gate_reset") {
  const baseline = replay(level, inputs, "baseline");
  const candidate = replay(level, inputs, "candidate", scenario);
  const baselineWon = baseline.at(-1).won;
  const candidateWon = candidate.at(-1).won;
  const candidateHasPath = shortestPath(level, "candidate", seed, scenario) !== null;
  const verified = baselineWon && !candidateWon && !candidateHasPath;
  const outcome = verified ? "regression_found" :
    baselineWon && candidateWon ? "no_regression_found" : "agent_incomplete";
  return { inputs, baseline, candidate, verified, candidateHasPath, outcome };
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
