import { authorized } from "../lib/auth.js";
import { validInput } from "../lib/execution.js";
import { enqueue, getBatch, cancel } from "../lib/queue.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request) {
  if (!authorized(request)) return Response.json({ error: "Operator token required." }, { status: 401 });
  if (!process.env.DATABASE_URL) return Response.json({ error: "PostgreSQL is not configured." }, { status: 503 });
  let body;
  try { body = await request.json(); } catch {
    return Response.json({ error: "Expected JSON." }, { status: 400 });
  }
  if (!body || !Array.isArray(body.inputs) || body.inputs.length < 1 || body.inputs.length > 60 ||
      !body.inputs.every(validInput) || !Number.isInteger(body.concurrency) ||
      body.concurrency < 1 || body.concurrency > 20 || !uuid.test(body.requestKey)) {
    return Response.json({ error: "Invalid batch. Use 1–60 trials and 1–20 slots." }, { status: 400 });
  }
  try {
    const id = await enqueue(body.inputs, body.concurrency, body.requestKey);
    return Response.json({ id }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const known = ["Queue is full.", "Request key was used for different inputs."].includes(error.message);
    return Response.json({ error: known ? error.message : "Could not save batch." }, { status: known ? 409 : 503 });
  }
}

export async function GET(request) {
  if (!authorized(request)) return Response.json({ error: "Operator token required." }, { status: 401 });
  const id = new URL(request.url).searchParams.get("id");
  if (!uuid.test(id)) return Response.json({ error: "Invalid batch ID." }, { status: 400 });
  try {
    const batch = await getBatch(id);
    return Response.json(batch ?? { error: "Batch not found." },
      { status: batch ? 200 : 404, headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Could not load batch." }, { status: 503 });
  }
}

export async function DELETE(request) {
  if (!authorized(request)) return Response.json({ error: "Operator token required." }, { status: 401 });
  const id = new URL(request.url).searchParams.get("id");
  if (!uuid.test(id)) return Response.json({ error: "Invalid batch ID." }, { status: 400 });
  try {
    await cancel(id);
    return Response.json({ cancelled: true });
  } catch {
    return Response.json({ error: "Could not cancel batch." }, { status: 503 });
  }
}
