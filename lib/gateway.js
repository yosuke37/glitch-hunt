import { moves, replay } from "../public/game.js";
import { maxMoves, shortestPath, verify } from "./hunt.js";
import { observe, describeAttempts } from "./observation.js";

const directions = Object.keys(moves);
const tools = [{
  type: "function",
  function: {
    name: "navigate_to",
    description: "Navigate to a named landmark. Use pressure_plate to open the baseline gate, then exit. Once baseline has completed, candidate exit tests an alternate route. The navigator resolves coordinates and applies the same inputs to both builds.",
    parameters: {
      type: "object",
      properties: { waypoint: { type: "string", enum: ["pressure_plate", "exit"] }, build: { type: "string", enum: ["baseline", "candidate"] } },
      required: ["waypoint", "build"], additionalProperties: false,
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

export function makeGatewayProbe({ apiKey, model, request = fetch, onStep = async () => {}, beforeCall = async () => {}, resume }) {
  return async function probe(level, seed, signal, scenario = "gate_reset") {
    const inputs = [...(resume?.inputs ?? [])];
    const usage = { inputTokens: 0, outputTokens: 0, modelCalls: 0, ...(resume?.totalUsage ?? resume?.usage) };
    const attemptUsage = { inputTokens: 0, outputTokens: 0, modelCalls: 0 };
    const trace = [...(resume?.trace ?? [])];
    const save = () => onStep({
      inputs: [...inputs], usage: { ...attemptUsage }, totalUsage: { ...usage }, trace: [...trace], model,
    });
    let stopReason = "call_limit";
    const current = replay(level, inputs, "baseline").at(-1);
    const landmarks = {};
    for (const [y, row] of level.rows.entries()) {
      for (const [x, tile] of [...row].entries()) {
        if (tile === "P") landmarks.pressure_plate = { x, y };
        if (tile === "E") landmarks.exit = { x, y };
      }
    }
    const initiallyComplete = current.won && verify(level, inputs, seed, scenario).outcome !== "agent_incomplete";
    if (initiallyComplete) stopReason = "baseline_completed";
    const messages = [
      { role: "system", content: "You playtest two versions of a grid game. Navigate the baseline to the pressure plate if its gate is closed, then to the exit. If baseline has completed but candidate has not, use navigate_to with build=candidate and target the exit to test an alternate route. Continue from the supplied current state after a resumed attempt. The navigator handles individual moves and can route through the plate on the way to an exit. # wall, S start, P plate, G gate, E exit, X corridor that may be blocked in the candidate. Coordinates are zero-based (x column, y row). Tool output is authoritative." },
      { role: "user", content: `Seed ${seed}. Landmarks: ${JSON.stringify(landmarks)}. Current baseline: ${JSON.stringify(observe(level, current))}. Current candidate: ${JSON.stringify(observe(level, replay(level, inputs, "candidate", scenario).at(-1), "candidate", scenario))}. Current objective: ${current.won ? "candidate exit" : current.gateOpen ? "baseline exit" : "baseline pressure_plate"}. Map:\n${level.rows.map((row, y) => `${y}: ${row}`).join("\n")}` },
    ];

    for (let round = usage.modelCalls; round < 6 && inputs.length < maxMoves && !initiallyComplete; round++) {
      const queued = performance.now();
      await beforeCall();
      const started = performance.now();
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
          error.deferred = true;
          error.providerThrottle = true;
          const detail = await response.json().catch(() => ({}));
          const providerMessage = String(detail.error?.message ?? detail.message ?? "");
          error.details = providerMessage.replaceAll(apiKey, "[redacted]").slice(0, 500);
        }
        throw error;
      }
      const result = await response.json();
      usage.modelCalls++;
      usage.inputTokens += result.usage?.prompt_tokens ?? 0;
      usage.outputTokens += result.usage?.completion_tokens ?? 0;
      attemptUsage.modelCalls++;
      attemptUsage.inputTokens += result.usage?.prompt_tokens ?? 0;
      attemptUsage.outputTokens += result.usage?.completion_tokens ?? 0;
      await save();
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
        // Coordinate arguments remain valid for recordings and earlier clients.
        const target = args.waypoint ? landmarks[args.waypoint] : args;
        if (!target || !Number.isInteger(target.x) || !Number.isInteger(target.y)) {
          throw new Error("The agent returned invalid moves.");
        }
        const build = args.build ?? "baseline";
        if (!["baseline", "candidate"].includes(build)) throw new Error("The agent returned invalid moves.");
        const current = replay(level, inputs, build, scenario).at(-1);
        proposed = shortestPath(level, build, seed, scenario, current, target);
        navigation = { target: { x: target.x, y: target.y }, build, reachable: proposed !== null };
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
        scheduledWaitMs: Math.round(started - queued),
        inputTokens: result.usage?.prompt_tokens ?? null,
        outputTokens: result.usage?.completion_tokens ?? null,
      });
      await save();
      const assessment = baseline.won ? verify(level, inputs, seed, scenario) : null;
      if (assessment && assessment.outcome !== "agent_incomplete") {
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
