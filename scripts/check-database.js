if (!process.env.DATABASE_URL) throw new Error("Configure DATABASE_URL first.");
process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
await import("../test/queue.test.js");
