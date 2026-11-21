import test from "node:test";
import assert from "node:assert/strict";
import { publicRun } from "../lib/public-run.js";
import { execute } from "../lib/execution.js";
import { GET, POST, DELETE } from "../api/runs.js";
import { levels, start, step } from "../public/game.js";

test("public replay projection excludes private input, errors, and attempt metadata", async () => {
  const result = await execute({ mode: "offline", levelId: 0, seed: 0 });
  const data = publicRun({ public_id: "public", input: { mode: "offline", levelId: 0, seed: 0, token: "PRIVATE" },
    result: { ...result, providerError: "PRIVATE" }, error: "PRIVATE", lease_token: "PRIVATE" });
  assert.equal(JSON.stringify(data).includes("PRIVATE"), false);
  assert.deepEqual(data.inputs, result.inputs);
  assert.equal(data.outcome, "regression_found");
});
test("sharing mutations require authentication and malformed public IDs are rejected", async () => {
  for (const handler of [POST, DELETE]) assert.equal((await handler(new Request("http://localhost/api/runs", { method: "POST" }))).status, 401);
  assert.equal((await GET(new Request("http://localhost/api/runs?id=bad"))).status, 400);
});
test("locked doors require a collected key and the broken key stays unavailable", () => {
  const level = levels[5];
  let state = step(level, start(level), "east", "baseline");
  assert.equal(step(level, state, "east", "baseline"), state);
  for (const build of ["baseline", "candidate"]) {
    let current = start(level);
    for (const move of ["south", "south", "north", "north", "east", "east"]) current = step(level, current, move, build, "key_missing");
    assert.equal(current.hasKey, build === "baseline");
    assert.equal(current.x, build === "baseline" ? 3 : 2);
  }
});
