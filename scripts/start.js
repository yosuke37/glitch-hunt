import { spawn } from "node:child_process";
import { migrate, closeDatabase } from "../lib/db.js";

await migrate();
await closeDatabase();
const worker = spawn(process.execPath, ["--env-file-if-exists=.env.local", "scripts/worker.js"], {
  stdio: "inherit", windowsHide: true,
});
process.on("exit", () => worker.kill());
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
await import("./dev.js");
