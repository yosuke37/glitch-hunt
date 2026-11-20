import { authorized } from "../lib/auth.js";
import { workOne } from "../lib/worker.js";
import { dispatch } from "../lib/dispatch.js";

export async function GET(request) {
  if (!authorized(request, process.env.CRON_SECRET)) {
    return Response.json({ error: "Worker authentication required." }, { status: 401 });
  }
  try {
    if (process.env.VERCEL_ENV === "production") return Response.json(await dispatch());
    const worked = await Promise.all(Array.from({ length: 20 }, () => workOne()));
    return Response.json({ processed: worked.filter(Boolean).length });
  } catch {
    return Response.json({ error: "Worker unavailable." }, { status: 503 });
  }
}
