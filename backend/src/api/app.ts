import { sql } from "drizzle-orm";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { readWorkerReport } from "../worker-status.js";
import { type StatusDto, toCompetitorDto, toSnapshotDto } from "./dto.js";
import {
  addCompetitor,
  competitorExists,
  getQueueCounts,
  listCompetitors,
  listSnapshots,
  removeCompetitor,
} from "./store.js";

export interface AppOptions {
  db: Db;
  log: FastifyBaseLogger;
  config: Pick<Config, "POLL_INTERVAL_SECONDS" | "LLM_DAILY_CAP">;
}

/** The worker reports every 10 seconds. Silent for this long means it is not running. */
const WORKER_SILENT_AFTER_MS = 30_000;

const competitorId = z
  .string()
  .trim()
  .min(1, "id must not be empty")
  .max(100, "id must be at most 100 characters")
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "id may contain letters, digits, '.', '_' and '-', and must start with a letter or digit",
  );

const addCompetitorBody = z.object({ id: competitorId });

const snapshotsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  changedOnly: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

interface IdParams {
  Params: { id: string };
}

const errorBody = (code: string, message: string) => ({ error: { code, message } });

const firstIssue = (error: z.ZodError): string => error.issues[0]?.message ?? "Invalid request";

export function buildApp({ db, log, config }: AppOptions): FastifyInstance {
  const app = Fastify({ loggerInstance: log });

  app.setErrorHandler((error: { statusCode?: number; message: string }, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err: error }, "request failed");
      return reply.code(500).send(errorBody("internal_error", "Something went wrong."));
    }
    // Client errors raised by Fastify itself, e.g. a body that is not valid JSON.
    return reply.code(status).send(errorBody("bad_request", error.message));
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send(errorBody("not_found", "No such route.")),
  );

  app.get("/api/health", async () => {
    await db.execute(sql`SELECT 1`);
    return { ok: true };
  });

  app.get("/api/competitors", async () => {
    const now = new Date();
    const rows = await listCompetitors(db);
    return rows.map(({ competitor, title }) => toCompetitorDto(competitor, title, now));
  });

  app.post("/api/competitors", async (request, reply) => {
    const body = addCompetitorBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send(errorBody("invalid_id", firstIssue(body.error)));
    }
    // The id is not checked against the source here. The source cannot say in advance
    // which ids exist, a 404 there can be temporary (a delisted competitor comes back),
    // and a slow or failing source should not make this request slow or fail. The first
    // poll happens within about a second and the timeline shows what it found.
    const created = await addCompetitor(db, body.data.id);
    if (created === null) {
      return reply
        .code(409)
        .send(errorBody("already_tracked", `"${body.data.id}" is already tracked.`));
    }
    return reply.code(201).send(toCompetitorDto(created, null, new Date()));
  });

  app.delete<IdParams>("/api/competitors/:id", async (request, reply) => {
    const removed = await removeCompetitor(db, request.params.id);
    if (!removed) {
      return reply.code(404).send(errorBody("not_tracked", "This competitor is not tracked."));
    }
    return reply.code(204).send();
  });

  app.get<IdParams>("/api/competitors/:id/snapshots", async (request, reply) => {
    const query = snapshotsQuery.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send(errorBody("invalid_query", firstIssue(query.error)));
    }
    const { id } = request.params;
    if (!(await competitorExists(db, id))) {
      return reply.code(404).send(errorBody("not_tracked", "This competitor is not tracked."));
    }
    const rows = await listSnapshots(db, id, query.data);
    return rows.map(toSnapshotDto);
  });

  app.get("/api/status", async (): Promise<StatusDto> => {
    const now = new Date();
    const [counts, worker] = await Promise.all([getQueueCounts(db, now), readWorkerReport(db)]);
    return {
      now,
      polling: {
        competitors: counts.competitors,
        intervalSeconds: config.POLL_INTERVAL_SECONDS,
        overdue: counts.overdue,
        oldestOverdueSeconds: counts.oldestOverdueSeconds,
      },
      summaries: {
        pending: counts.pendingSummaries,
        llmCallsToday: counts.llmCallsToday,
        llmDailyCap: config.LLM_DAILY_CAP,
      },
      worker:
        worker === null
          ? null
          : {
              running: now.getTime() - worker.updatedAt.getTime() < WORKER_SILENT_AFTER_MS,
              lastSeenAt: worker.updatedAt,
              ...worker.report,
            },
    };
  });

  return app;
}
