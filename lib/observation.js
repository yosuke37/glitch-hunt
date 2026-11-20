import { moves } from "../public/game.js";

const names = { "#": "wall", ".": "floor", S: "start", P: "pressure plate", G: "gate", E: "exit" };

export function observe(level, state, build = "baseline", scenario = "gate_reset") {
  const nearby = Object.entries(moves).map(([direction, [dx, dy]]) => {
    const x = state.x + dx;
    const y = state.y + dy;
    const tile = level.rows[y]?.[x];
    const blocked = !tile || tile === "#" ||
      (tile === "G" && (!state.gateOpen || (build === "candidate" && scenario === "gate_locked")));
    return { direction, x, y, tile: names[tile] ?? "boundary", blocked };
  });
  return { ...state, nearby };
}

export function describeAttempts(level, frames, inputs, offset) {
  return inputs.map((move, index) => {
    const before = frames[offset + index];
    const after = frames[offset + index + 1];
    const [dx, dy] = moves[move];
    const tile = level.rows[before.y + dy]?.[before.x + dx];
    const moved = before.x !== after.x || before.y !== after.y;
    let outcome = "moved";
    if (before.won) outcome = "already_completed";
    else if (!moved) outcome = tile === "G" ? "blocked_closed_gate" : "blocked_wall_or_boundary";
    return {
      move, from: { x: before.x, y: before.y }, to: { x: after.x, y: after.y },
      outcome, gateOpen: after.gateOpen, won: after.won,
    };
  });
}
