import { mkdir, writeFile } from "node:fs/promises";
import { execute } from "../lib/execution.js";

const required = ["HUNT_RUN_TOKEN", "HUNT_MODEL"];
if (!(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN) ||
    required.some((name) => !process.env[name])) {
  console.error("Configure AI_GATEWAY_API_KEY, HUNT_MODEL, and HUNT_RUN_TOKEN in .env.local.");
  process.exitCode = 1;
} else {
  try {
    const result = await execute({ mode: "live", seed: 1, levelId: 0 }, AbortSignal.timeout(35_000));
    const directory = new URL("../output/", import.meta.url);
    await mkdir(directory, { recursive: true });
    await writeFile(new URL("live-run.json", directory), JSON.stringify(result, null, 2));
    console.log(`${result.verified ? "VERIFIED" : "INCONCLUSIVE"} · ${result.model} · ${result.usage.modelCalls} model calls`);
    for (const entry of result.trace) {
      console.log(`Call ${entry.call}: ${entry.moves.join(" → ")} | baseline (${entry.baseline.x},${entry.baseline.y}) | candidate (${entry.candidate.x},${entry.candidate.y}) | ${entry.elapsedMs} ms`);
    }
    console.log("Saved replay and activity trace to output/live-run.json.");
    if (!result.verified) process.exitCode = 1;
  } catch {
    console.error("Live trial failed. Check Gateway access and model availability.");
    process.exitCode = 1;
  }
}
