import { moves, replay, start } from "../public/game.js";
import { maxMoves, shortestPath } from "./hunt.js";
import { observe, describeAttempts } from "./observation.js";

const directions = Object.keys(moves);
const tools = [{
  type: "function",
  function: {
    name: "navigate_to",
    description: "Choose a waypoint by x column and y row. A deterministic navigator finds a baseline route and applies those same moves to both builds. Visit the pressure plate before the exit.",
    parameters: {
      type: "object",
      properties: { x: { type: "integer" }, y: { type: "integer" } },
      required: ["x", "y"], additionalProperties: false,
    },
  },
}, {
  type: "function",
  function: {
    name: "apply_moves",
    description: "Apply up to seven moves on both builds. Returns each move's outcome, positions, gate state, and neighboring tiles. Blocked moves consume a move. Use short batches near obstacles.",
    parameters: {
      type: "object",
      properties: {
        moves: { type: "array", items: { type: "string", enum: directions }, minItems: 1, maxItems: 7 },
      },
      required: ["moves"],
      additionalProperties: false,
    },
  },
}];

export function makeGatewayProbe({ apiKey, model, request = fetch, onStep = async () => {}, beforeCall = async () => {} }) {
  return async function probe(level, seed, signal, scenario = "gate_reset") {
    const inputs = [];
    const usage = { inputTokens: 0, outputTokens: 0, modelCalls: 0 };
    const trace = [];
    let stopReason = "call_limit";
    const messages = [
      { role: "system", content: "You playtest two versions of a grid game. Reach the exit in the baseline and inspect whether the candidate diverges. Prefer navigate_to: first choose the pressure plate waypoint, then the exit waypoint. The deterministic navigator handles individual moves. # wall, S start, P pressure plate, G gate, E exit. Coordinates are zero-based (x column, y row). Once baseline reaches the exit the test ends. Tool output is authoritative." },
      { role: "user", content: `Seed ${seed}. Both builds start with the gate closed. Initial observation: ${JSON.stringify(observe(level, start(level)))}. Map:\n${level.rows.map((row, y) => `${y}: ${row}`).join("\n")}` },
    ];

    for (let round = 0; round < 6 && inputs.length < maxMoves; round++) {
      const started = performance.now();
      await beforeCall();
      const response = await request("https://ai-gateway.vercel.sh/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model, messages, tools, tool_choice: { type: "function", function: { name: "navigate_to" } },
          parallel_tool_calls: false, max_completion_tokens: 600,
        }),
        signal,
      });
      if (!response.ok) {
        const error = new Error(`AI Gateway rejected the request (HTTP ${response.status}).`);
        if (response.status === 429) {
          const retryAfter = response.headers.get("retry-after");
          const seconds = Number(retryAfter) || (Date.parse(retryAfter) - Date.now()) / 1000 || 60;
          error.retryAfterSeconds = Math.min(300, Math.max(60, Math.ceil(seconds)));
        }
        throw error;
      }
      const result = await response.json();
      usage.modelCalls++;
      usage.inputTokens += result.usage?.prompt_tokens ?? 0;
      usage.outputTokens += result.usage?.completion_tokens ?? 0;
      const calls = result.choices?.[0]?.message?.tool_calls;
      const call = calls?.[0];
      if (calls?.length !== 1 || !["apply_moves", "navigate_to"].includes(call.function?.name) || !call.id) {
        stopReason = "missing_tool_call";
        break;
      }
      const args = JSON.parse(call.function.arguments);
      let proposed;
      let navigation = null;
      if (call.function.name === "navigate_to") {
        if (!Number.isInteger(args.x) || !Number.isInteger(args.y)) {
          throw new Error("The agent returned invalid moves.");
        }
        const current = replay(level, inputs, "baseline").at(-1);
        proposed = shortestPath(level, "baseline", seed, scenario, current, args);
        navigation = { target: { x: args.x, y: args.y }, reachable: proposed !== null };
        proposed ??= [];
      } else {
        proposed = args.moves;
      }
      if (!Array.isArray(proposed) || (call.function.name === "apply_moves" && (proposed.length < 1 || proposed.length > 7)) ||
          !proposed.every((move) => directions.includes(move))) {
        throw new Error("The agent returned invalid moves.");
      }
      const applied = proposed.slice(0, maxMoves - inputs.length);
      const frameStart = inputs.length;
      inputs.push(...applied);
      const baselineFrames = replay(level, inputs, "baseline");
      const candidateFrames = replay(level, inputs, "candidate", scenario);
      const baseline = baselineFrames.at(-1);
      const candidate = candidateFrames.at(-1);
      const feedback = {
        baseline: {
          ...observe(level, baseline),
          attempts: describeAttempts(level, baselineFrames, applied, frameStart),
        },
        candidate: {
          ...observe(level, candidate, "candidate", scenario),
          attempts: describeAttempts(level, candidateFrames, applied, frameStart),
        },
        movesRemaining: maxMoves - inputs.length,
        callsRemaining: 5 - round,
        navigation,
      };
      trace.push({
        call: round + 1, tool: call.function.name, arguments: args, moves: applied,
        frameStart, frameEnd: inputs.length, baseline, candidate, feedback,
        elapsedMs: Math.round(performance.now() - started),
        inputTokens: result.usage?.prompt_tokens ?? null,
        outputTokens: result.usage?.completion_tokens ?? null,
      });
      await onStep({ inputs: [...inputs], usage: { ...usage }, trace: [...trace], model });
      if (baseline.won) {
        stopReason = "baseline_completed";
        break;
      }
      if (inputs.length === maxMoves) stopReason = "move_limit";
      messages.push(
        { role: "assistant", content: null, tool_calls: calls },
        { role: "tool", tool_call_id: call.id, content: JSON.stringify({
          baseline: { ...observe(level, baseline), blockedMoves: feedback.baseline.attempts.filter((a) => a.outcome.startsWith("blocked")) },
          candidate: { ...observe(level, candidate, "candidate", scenario), blockedMoves: feedback.candidate.attempts.filter((a) => a.outcome.startsWith("blocked")) },
          movesRemaining: feedback.movesRemaining, callsRemaining: feedback.callsRemaining, navigation,
        }) },
      );
    }
    const costUsd = model === "openai/gpt-4.1-mini"
      ? (usage.inputTokens * 0.4 + usage.outputTokens * 1.6) / 1_000_000 : null;
    return { inputs, usage, trace, model, stopReason, costUsd };
  };
}
