import { runBatch } from "../public/batch.js";
import { levels } from "../public/game.js";

const origin = process.env.HUNT_URL ?? "http://127.0.0.1:4317";
const inputs = Array.from({ length: 60 }, (_, seed) => ({
  mode: "offline", levelId: seed % levels.length, seed,
}));

console.log(`Offline HTTP benchmark · ${origin} · ${inputs.length} trials per batch`);
for (const slots of [1, 5, 20]) {
  const started = performance.now();
  const results = await runBatch(inputs, slots, async (input) => {
    const sent = performance.now();
    const response = await fetch(new URL("/api/hunt", origin), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    return { verified: result.verified, elapsedMs: performance.now() - sent };
  });
  const duration = (performance.now() - started) / 1000;
  const values = results.flatMap(({ value }) => value ? [value] : []);
  const times = values.map(({ elapsedMs }) => elapsedMs).sort((a, b) => a - b);
  const p95 = times[Math.ceil(times.length * 0.95) - 1];
  const verified = values.filter((value) => value.verified).length;
  console.log(`${slots} slots | ${verified}/${inputs.length} verified | ${(values.length / duration).toFixed(1)} trials/s | p95 ${p95?.toFixed(1) ?? "n/a"} ms`);
  const failure = results.find((result) => result.error);
  if (failure) console.error(`Example failed trial: ${failure.error}`);
  if (verified !== inputs.length) process.exitCode = 1;
}
