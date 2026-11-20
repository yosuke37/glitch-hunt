import { setTimeout } from "node:timers/promises";
import { closeDatabase } from "../lib/db.js";
import { workOne } from "../lib/worker.js";

let stopped = false;
process.on("SIGINT", () => { stopped = true; });
process.on("SIGTERM", () => { stopped = true; });
console.log("Glitch Hunt worker running. Shared limits come from PostgreSQL.");
async function slot() {
  while (!stopped) {
    try {
      if (!await workOne()) await setTimeout(1000);
    } catch {
      console.error("Worker database unavailable. Retrying in 3 seconds.");
      await setTimeout(3000);
    }
  }
}
await Promise.all(Array.from({ length: 20 }, slot));
await closeDatabase();
