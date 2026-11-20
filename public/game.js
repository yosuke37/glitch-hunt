export const levels = [
  { name: "Switchback", rows: ["#########", "#S...#..#", "#.#..#..#", "#.P..G.E#", "#.#..#..#", "#....#..#", "#########"] },
  { name: "Cold Storage", rows: ["#########", "#....#E.#", "#.##.#..#", "#....G..#", "#.#..#..#", "#SP..#..#", "#########"] },
  { name: "Service Tunnel", rows: ["#########", "#S...#..#", "###..#..#", "#..P.G.E#", "#....#..#", "#....#..#", "#########"] },
  { name: "Side Passage", maxExtraMoves: 4, rows: ["###########", "#S.X..P#..#", "#.####.#E.#", "#......G..#", "#.####.#..#", "#......#..#", "###########"] },
  { name: "Long Way Round", maxExtraMoves: 4, rows: ["###########", "#S.X..P#..#", "#.####.#E.#", "#.####.G..#", "#.####.#..#", "#......#..#", "###########"] },
];

export const moves = {
  north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0],
};

export const gameVersion = "3";
export const scenarios = [
  { id: "gate_reset", name: "Gate forgets pressure plate", expectedRegression: true },
  { id: "healthy", name: "Healthy update", expectedRegression: false },
  { id: "gate_locked", name: "Gate stays locked", expectedRegression: true },
  { id: "exit_disabled", name: "Exit never completes", expectedRegression: true },
  { id: "corridor_blocked", name: "Corridor becomes blocked", expectedRegression: false },
];

export const cases = levels.flatMap((level, levelId) => scenarios.map((scenario) => ({
  id: `${levelId}/${scenario.id}`, levelId, scenario: scenario.id,
  expectedRegression: scenario.id === "corridor_blocked" ? levelId === 4 : scenario.expectedRegression,
})));

export function start(level) {
  const y = level.rows.findIndex((row) => row.includes("S"));
  return { x: level.rows[y].indexOf("S"), y, gateOpen: false, won: false };
}

export function step(level, state, move, build, scenario = "gate_reset") {
  const [dx, dy] = moves[move];
  const x = state.x + dx;
  const y = state.y + dy;
  const tile = level.rows[y]?.[x];
  const candidate = build === "candidate";
  if (state.won || !tile || tile === "#" ||
      (candidate && scenario === "corridor_blocked" && tile === "X") ||
      (tile === "G" && (!state.gateOpen || (candidate && scenario === "gate_locked")))) return state;
  return {
    x, y,
    gateOpen: tile === "P" || ((!candidate || scenario !== "gate_reset") && state.gateOpen),
    won: tile === "E" && !(candidate && scenario === "exit_disabled"),
  };
}

export function replay(level, inputs, build, scenario = "gate_reset") {
  const frames = [start(level)];
  for (const move of inputs) frames.push(step(level, frames.at(-1), move, build, scenario));
  return frames;
}
