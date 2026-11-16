import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export function createDb(databaseUrl: string, maxConnections = 10) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: maxConnections });
  const db = drizzle({ client: pool, schema });
  return { db, pool };
}

export type Db = ReturnType<typeof createDb>["db"];

/** The transaction handle passed to `db.transaction(async (tx) => ...)`. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
