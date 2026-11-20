import { timingSafeEqual } from "node:crypto";

export function authorized(request, secret = process.env.HUNT_RUN_TOKEN) {
  const actual = request.headers.get("Authorization");
  if (!actual || !secret) return false;
  const first = Buffer.from(actual);
  const second = Buffer.from(`Bearer ${secret}`);
  return first.length === second.length && timingSafeEqual(first, second);
}
