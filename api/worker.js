import { authorized } from "../lib/auth.js";
import { workOne } from "../lib/worker.js";

export async function GET(request) {
  if (!authorized(request, process.env.CRON_SECRET)) {
    return Response.json({ error: "Worker authentication required." }, { status: 401 });
  }
  try {
    const worked = await Promise.all(Array.from({ length: 20 }, () => workOne()));
    return Response.json({ processed: worked.filter(Boolean).length });
  } catch {
    return Response.json({ error: "Worker unavailable." }, { status: 503 });
  }
}
