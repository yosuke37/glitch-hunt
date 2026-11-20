import { authorized } from "../lib/auth.js";
import { levels, scenarios } from "../public/game.js";
import { hunt, offlineProbe } from "../lib/hunt.js";

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON request." }, { status: 400 });
  }
  const { levelId, seed, mode, scenario = "gate_reset" } = body ?? {};
  if (!Number.isInteger(levelId) || levelId < 0 || levelId >= levels.length ||
      !Number.isInteger(seed) || seed < 0 || seed > 999999 ||
      !["offline", "live"].includes(mode) || !scenarios.some((item) => item.id === scenario)) {
    return Response.json({ error: "Invalid level, seed, or mode." }, { status: 400 });
  }

  const probe = (level, seed, _signal, scenario) => ({ inputs: offlineProbe(level, seed, scenario) });
  if (mode === "live") {
    if (!authorized(request)) {
      return Response.json({ error: "Live runs require the operator token." }, { status: 401 });
    }
    return Response.json({ error: "Submit live trials through the durable batch queue." }, { status: 409 });
  }

  try {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(35_000)]);
    return Response.json({ mode, ...await hunt({ levelId, seed, scenario, probe, signal }) });
  } catch (error) {
    const message = error.message?.startsWith("AI Gateway rejected") ||
      error.message === "The agent returned invalid moves."
      ? error.message : "The agent run failed or timed out.";
    return Response.json({ error: message }, { status: 502 });
  }
}
