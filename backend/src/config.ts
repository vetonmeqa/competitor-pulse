import { z } from "zod";

const positiveInt = z.coerce.number().int().positive();

const schema = z.object({
  DATABASE_URL: z.string().min(1).default("postgres://pulse:pulse@localhost:5432/pulse"),
  PORT: positiveInt.default(3000),
  LOG_LEVEL: z.string().default("info"),

  // Data source. Treated as an external website: only ever reached over HTTP.
  SOURCE_BASE_URL: z.url().default("http://localhost:4002"),
  SOURCE_RATE_LIMIT_PER_SEC: z.coerce.number().positive().default(5),
  SOURCE_TIMEOUT_MS: positiveInt.default(10_000),

  // Scheduler.
  POLL_INTERVAL_SECONDS: positiveInt.default(900),
  POLL_MAX_IN_FLIGHT: positiveInt.default(50),

  // LLM (any OpenAI Chat Completions compatible endpoint).
  LLM_BASE_URL: z.url().default("http://localhost:4001/v1"),
  LLM_API_KEY: z.string().default("mock"),
  LLM_MODEL: z.string().default("mock-llm"),
  LLM_TIMEOUT_MS: positiveInt.default(15_000),
  LLM_DAILY_CAP: z.coerce.number().int().nonnegative().default(2000),
  LLM_MAX_ATTEMPTS: positiveInt.default(3),
  LLM_CONCURRENCY: positiveInt.default(2),
  // A change nobody summarised within this window is no longer worth an LLM call.
  SUMMARY_MAX_AGE_HOURS: positiveInt.default(48),

  RETENTION_DAYS: positiveInt.default(90),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
