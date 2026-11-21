import { hunt, offlineProbe } from "./hunt.js";
import { makeGatewayProbe } from "./gateway.js";
import { gameVersion, levels, scenarios } from "../public/game.js";

export function validInput(input) {
  return input && Number.isInteger(input.levelId) && input.levelId >= 0 && input.levelId < levels.length &&
    Number.isInteger(input.seed) && input.seed >= 0 && input.seed <= 999999 &&
    ["offline", "live"].includes(input.mode) &&
    scenarios.some((scenario) => scenario.id === (input.scenario ?? "gate_reset"));
}

export async function execute(input, signal, onStep, beforeCall, resume) {
  if (input.gameVersion && ![gameVersion, "2", "3"].includes(input.gameVersion)) {
    throw new Error("Job uses an unsupported game version.");
  }
  let probe = (level, seed, _signal, scenario) => ({ inputs: offlineProbe(level, seed, scenario) });
  if (input.mode === "live") {
    const apiKey = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN;
    const model = process.env.HUNT_MODEL;
    if (!apiKey || !model) throw new Error("Live credentials are not configured.");
    probe = makeGatewayProbe({ apiKey, model, onStep, beforeCall, resume });
  }
  return { mode: input.mode, ...await hunt({ ...input, probe, signal }) };
}
