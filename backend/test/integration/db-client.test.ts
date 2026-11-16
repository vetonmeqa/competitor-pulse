import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "../../src/db/client.js";
import { openTestDb, TEST_DATABASE_URL, waitFor } from "./test-db.js";

const { pool: admin } = openTestDb();

afterAll(async () => {
  await admin.end();
});

describe("createDb", () => {
  it("survives an idle connection being dropped, as on a database restart", async () => {
    const dropped: Error[] = [];
    const { pool } = createDb(TEST_DATABASE_URL, 1, (error) => dropped.push(error));

    // Open one connection, let it go idle, then have Postgres terminate it.
    const { rows } = await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    await admin.query("SELECT pg_terminate_backend($1)", [rows[0]?.pid]);
    await waitFor(() => dropped.length === 1);

    // The process is still here, and the pool reconnects for the next query.
    const next = await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    expect(next.rows[0]?.pid).not.toBe(rows[0]?.pid);
    await pool.end();
  });

  it("does not need a listener to be passed in", async () => {
    const { pool } = createDb(TEST_DATABASE_URL, 1);
    const { rows } = await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    await admin.query("SELECT pg_terminate_backend($1)", [rows[0]?.pid]);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect((await pool.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
    await pool.end();
  });
});
