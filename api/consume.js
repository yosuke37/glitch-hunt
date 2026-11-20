import { handleCallback } from "@vercel/queue";
import { consume } from "../lib/consumer.js";

export const POST = handleCallback((message) => consume(message), {
  visibilityTimeoutSeconds: 90,
  retry: (error) => ({ afterSeconds: error.retryAfterSeconds ?? 60 }),
});
