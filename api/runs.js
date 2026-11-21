import { randomUUID } from "node:crypto";
import { database } from "../lib/db.js";
import { authorized } from "../lib/auth.js";
import { publicRun } from "../lib/public-run.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
export async function GET(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!uuid.test(id)) return json({ error: "Invalid run ID." }, 400);
  try {
    const job = (await database().query("SELECT public_id,input,result,completed_at FROM gh_jobs WHERE public_id=$1 AND status='succeeded' AND result IS NOT NULL", [id])).rows[0];
    return job ? json(publicRun(job)) : json({ error: "Shared run not found." }, 404);
  } catch { return json({ error: "Could not load shared run." }, 503); }
}
async function change(request, sharing) {
  if (!authorized(request)) return json({ error: "Operator token required." }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Expected JSON." }, 400); }
  if (!uuid.test(body?.jobId)) return json({ error: "Invalid job ID." }, 400);
  try {
    const result = await database().query(sharing
      ? "UPDATE gh_jobs SET public_id=coalesce(public_id,$2) WHERE id=$1 AND status='succeeded' AND result IS NOT NULL RETURNING public_id"
      : "UPDATE gh_jobs SET public_id=NULL WHERE id=$1 RETURNING public_id",
    sharing ? [body.jobId, randomUUID()] : [body.jobId]);
    if (!result.rowCount) return json({ error: "Completed run not found." }, 404);
    return json({ id: result.rows[0].public_id, shared: sharing });
  } catch { return json({ error: "Could not update sharing." }, 503); }
}
export const POST = (request) => change(request, true);
export const DELETE = (request) => change(request, false);
