import pg from "pg";
import { readFile } from "node:fs/promises";

let pool;
export function database() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured.");
  const connection = new URL(process.env.DATABASE_URL);
  if (["require", "prefer", "verify-ca"].includes(connection.searchParams.get("sslmode"))) {
    connection.searchParams.set("sslmode", "verify-full");
  }
  pool ??= new pg.Pool({
    connectionString: connection.href,
    max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000,
  });
  return pool;
}

export async function migrate() {
  const sql = await readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
  await database().query(sql);
}

export async function closeDatabase() {
  if (pool) await pool.end();
  pool = undefined;
}

export async function transaction(work) {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    // Serializes control decisions across processes without holding a connection during model calls.
    await client.query("SELECT pg_advisory_xact_lock(734921008)");
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
