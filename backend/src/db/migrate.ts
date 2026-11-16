import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { loadConfig } from "../config.js";
import { createDb } from "./client.js";

// Resolves to backend/drizzle from both src/db (tsx) and dist/db (compiled).
const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

const { db, pool } = createDb(loadConfig().DATABASE_URL, 1);

try {
  await migrate(db, { migrationsFolder });
  console.log("Migrations applied.");
} catch (error) {
  console.error("Migration failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
