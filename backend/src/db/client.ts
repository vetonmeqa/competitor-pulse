import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

/**
 * `onIdleError` is told when a connection that was sitting idle in the pool breaks, which
 * is what happens to every open connection when the database restarts.
 */
export function createDb(
  databaseUrl: string,
  maxConnections = 10,
  onIdleError: (error: Error) => void = () => undefined,
) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: maxConnections });
  // The pool already discards the broken connection and opens a new one for the next
  // query. The listener must exist all the same: Node ends the process on an "error"
  // event that nobody listens for, so without it a database restart would take us down.
  pool.on("error", onIdleError);
  const db = drizzle({ client: pool, schema });
  return { db, pool };
}

export type Db = ReturnType<typeof createDb>["db"];

/** The transaction handle passed to `db.transaction(async (tx) => ...)`. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
