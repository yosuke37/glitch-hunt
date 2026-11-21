import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { POST } from "../api/hunt.js";
import { makeGatewayProbe } from "../lib/gateway.js";
import { offlineProbe, verify } from "../lib/hunt.js";
import { runBatch } from "../public/batch.js";
import { levels, scenarios, cases } from "../public/game.js";
import { replay, start } from "../public/game.js";
import { observe, describeAttempts } from "../lib/observation.js";

test("the published live recording reproduces its saved game states", async () => {
  const sample = JSON.parse(await readFile(new URL("../public/sample-run.json", import.meta.url), "utf8"));
  const result = verify(levels[sample.levelId], sample.inputs, sample.seed, sample.scenario);
  assert.deepEqual(sample.baseline, result.baseline);
  assert.deepEqual(sample.candidate, result.candidate);
  assert.equal(result.outcome, "regression_found");
  assert.deepEqual(sample.trace.flatMap((entry) => entry.moves), sample.inputs);
});

test("observations distinguish walls, closed gates, and completed moves", () => {
  const level = { rows: ["#######", "#SP.GE#", "#######"] };
  const inputs = ["north", "east", "east", "east", "east", "west"];
  const baseline = replay(level, inputs, "baseline");
  const candidate = replay(level, inputs, "candidate");
  assert.equal(observe(level, start(level)).nearby.find((tile) => tile.direction === "north").blocked, true);
  const original = describeAttempts(level, baseline, inputs, 0);
  const changed = describeAttempts(level, candidate, inputs, 0);
  assert.equal(original[0].outcome, "blocked_wall_or_boundary");
  assert.equal(original[1].gateOpen, true);
  assert.equal(original[4].won, true);
  assert.equal(original[5].outcome, "already_completed");
  assert.equal(changed[3].outcome, "blocked_closed_gate");
  const gate = observe(level, candidate[3]).nearby.find((tile) => tile.direction === "east");
  assert.deepEqual(gate, { direction: "east", x: 4, y: 1, tile: "gate", blocked: true });
  assert.equal(describeAttempts(level, baseline, inputs.slice(3), 3)[0].outcome, "moved");
});

test("each offline route reproduces the regression across every seed ordering", () => {
  for (const level of levels) {
    for (const seed of [0, 1, 2, 3]) {
      const result = verify(level, offlineProbe(level, seed), seed);
      assert.equal(result.baseline.at(-1).won, true, level.name);
      assert.equal(result.candidate.at(-1).won, false);
      assert.equal(result.candidateHasPath, false);
      assert.equal(result.verified, true);
    }
  }
});

test("a failed or incomplete trace does not establish a regression", () => {
  assert.equal(verify(levels[0], [], 0).verified, false);
});

test("three regressions and a healthy build have distinct verified outcomes on all levels", () => {
  for (const level of levels) {
    for (const scenario of scenarios) {
      const expected = cases.find((item) => item.levelId === levels.indexOf(level) && item.scenario === scenario.id).expectedRegression;
      const result = verify(level, offlineProbe(level, 0, scenario.id), 0, scenario.id);
      assert.equal(result.outcome, expected ? "regression_found" : "no_regression_found",
        `${level.name} / ${scenario.id}`);
      assert.equal(result.verified, expected);
      assert.equal(verify(level, [], 0, scenario.id).outcome, "agent_incomplete");
    }
  }
});

test("a failed candidate replay does not prove a blocked level if another route exists", () => {
  const level = { rows: ["#######", "#SP.GE#", "#.....#", "#######"] };
  const result = verify(level, ["east", "east", "east", "east"], 0);
  assert.equal(result.baseline.at(-1).won, true);
  assert.equal(result.candidate.at(-1).won, false);
  assert.equal(result.candidateHasPath, true);
  assert.equal(result.verified, false);
});

test("gateway tool results return observed game state on the next model call", async () => {
  const level = levels[0];
  const path = offlineProbe(level, 0);
  const inputs = [path.slice(0, 3), path.slice(3)];
  let requests = 0;
  const probe = makeGatewayProbe({
    apiKey: "fake",
    model: "fake",
    request: async (_url, { body }) => {
      const { messages } = JSON.parse(body);
      const index = requests++;
      if (index === 1) {
        const tool = messages.at(-1);
        assert.equal(tool.role, "tool");
        assert.equal(tool.tool_call_id, "call-0");
        assert.equal(JSON.parse(tool.content).baseline.gateOpen, true);
        const feedback = JSON.parse(tool.content);
        assert.equal(feedback.baseline.blockedMoves.length, 0);
        assert.equal(feedback.baseline.nearby.length, 4);
        assert.equal(feedback.movesRemaining, 25);
        assert.equal(feedback.callsRemaining, 5);
      }
      return Response.json({
        choices: [{ message: { tool_calls: [{
          id: `call-${index}`, type: "function",
          function: { name: "apply_moves", arguments: JSON.stringify({ moves: inputs[index] }) },
        }] } }],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      });
    },
  });
  const result = await probe(level, 0);
  assert.equal(requests, 2);
  assert.deepEqual(result.usage, { modelCalls: 2, inputTokens: 8, outputTokens: 4 });
  assert.equal(verify(level, result.inputs, 0).verified, true);
  assert.equal(result.model, "fake");
  assert.equal(result.stopReason, "baseline_completed");
  assert.equal(result.trace.length, 2);
  assert.equal(result.trace[0].frameStart, 0);
  assert.equal(result.trace[0].frameEnd, 3);
  assert.equal(result.trace[0].baseline.gateOpen, true);
  assert.equal(result.trace[1].baseline.won, true);
  assert.equal(result.trace[1].candidate.won, false);
  assert.equal(result.trace[1].frameEnd, path.length);
  assert.equal(result.trace[1].inputTokens, 4);
  assert.equal(result.trace[1].feedback.baseline.attempts.at(-1).won, true);
  assert.equal(JSON.stringify(result).includes("Bearer"), false);
});

test("fan-out bounds the active trials and retains successful results on failure", async () => {
  let active = 0;
  let peak = 0;
  const results = await runBatch([0, 1, 2, 3], 2, async (number) => {
    peak = Math.max(peak, ++active);
    await setTimeout(2);
    active--;
    if (number === 2) throw new Error("test failure");
    return number;
  });
  assert.equal(peak, 2);
  assert.deepEqual(results, [{ value: 0 }, { value: 1 }, { error: "test failure" }, { value: 3 }]);
});

test("the agent chooses waypoints while deterministic navigation records reproducible moves", async () => {
  const targets = [{ x: 2, y: 3 }, { x: 7, y: 3 }];
  let index = 0;
  const saved = [];
  const probe = makeGatewayProbe({
    apiKey: "fake", model: "fake", onStep: (progress) => saved.push(progress),
    request: async () => Response.json({
      choices: [{ message: { tool_calls: [{
        id: `waypoint-${index}`, type: "function",
        function: { name: "navigate_to", arguments: JSON.stringify(targets[index++]) },
      }] } }],
    }),
  });
  const result = await probe(levels[0], 1);
  assert.equal(result.stopReason, "baseline_completed");
  assert.equal(result.trace.length, 2);
  assert.equal(saved.length, 4);
  assert.equal(verify(levels[0], result.inputs, 1).outcome, "regression_found");
  assert.deepEqual(result.trace[0].arguments, targets[0]);
});

test("Gateway throttling exposes a bounded retry delay without retrying inside the agent loop", async () => {
  let calls = 0;
  const probe = makeGatewayProbe({
    apiKey: "fake", model: "fake",
    request: async () => {
      calls++;
      return new Response("", { status: 429, headers: { "retry-after": "9000" } });
    },
  });
  await assert.rejects(() => probe(levels[0], 0),
    (error) => error.retryAfterSeconds === 300 && error.message.includes("429"));
  assert.equal(calls, 1);
});

test("a deferred live attempt resumes from the checkpoint with separate attempt accounting", async () => {
  let saved;
  let permissions = 0;
  const reply = (target) => Response.json({
    choices: [{ message: { tool_calls: [{
      id: "waypoint", type: "function",
      function: { name: "navigate_to", arguments: JSON.stringify(target) },
    }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
  const first = makeGatewayProbe({
    apiKey: "fake", model: "fake", onStep: (progress) => { saved = progress; },
    beforeCall: async () => {
      if (permissions++) { const error = new Error("pause"); error.deferred = true; throw error; }
    },
    request: async () => reply({ x: 2, y: 3 }),
  });
  await assert.rejects(() => first(levels[0], 0), /pause/);
  assert.equal(saved.trace.length, 1);
  const second = makeGatewayProbe({
    apiKey: "fake", model: "fake", resume: saved, onStep: (progress) => { saved = progress; },
    request: async (_url, { body }) => {
      assert.ok(JSON.parse(body).messages[1].content.includes('"gateOpen":true'));
      return reply({ x: 7, y: 3 });
    },
  });
  const result = await second(levels[0], 0);
  assert.equal(result.trace.length, 2);
  assert.equal(result.usage.modelCalls, 2);
  assert.equal(saved.usage.modelCalls, 1);
  assert.equal(saved.totalUsage.modelCalls, 2);
  assert.equal(verify(levels[0], result.inputs, 0).verified, true);
});

test("the agent can finish a healthy candidate through a different route", async () => {
  const targets = [
    { waypoint: "pressure_plate", build: "baseline" },
    { waypoint: "exit", build: "baseline" },
    { waypoint: "exit", build: "candidate" },
  ];
  let index = 0;
  const probe = makeGatewayProbe({
    apiKey: "fake", model: "fake",
    request: async () => Response.json({ choices: [{ message: { tool_calls: [{
      id: `reroute-${index}`, type: "function",
      function: { name: "navigate_to", arguments: JSON.stringify(targets[index++]) },
    }] } }] }),
  });
  const result = await probe(levels[3], 0, undefined, "corridor_blocked");
  const assessment = verify(levels[3], result.inputs, 0, "corridor_blocked");
  assert.equal(index, 3);
  assert.equal(assessment.outcome, "no_regression_found");
  assert.equal(assessment.evidence.candidateShortestMoves, 14);
  assert.equal(assessment.evidence.baselineShortestMoves, 10);
});

test("the HTTP handler validates requests and protects paid runs", async () => {
  const send = (body) => POST(new Request("http://localhost/api/hunt", {
    method: "POST", body: JSON.stringify(body),
  }));
  assert.equal((await send({ mode: "offline", seed: 0, levelId: -1 })).status, 400);
  assert.equal((await send({ mode: "live", seed: 0, levelId: 0 })).status, 401);
  const response = await send({ mode: "offline", seed: 0, levelId: 0 });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).verified, true);
});
