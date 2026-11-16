import { buildApp } from "./api/app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { createLogger } from "./logger.js";

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL, "api");
const { db, pool } = createDb(config.DATABASE_URL);
const app = buildApp({ db, log, config });

for (const signalName of ["SIGINT", "SIGTERM"] as const) {
  process.once(signalName, () => {
    log.info({ signal: signalName }, "shutting down");
    // Stops accepting connections, lets requests in progress finish, then frees the pool.
    void app
      .close()
      .then(() => pool.end())
      .then(() => {
        log.info("api stopped");
      });
  });
}

await app.listen({ port: config.PORT, host: "0.0.0.0" });
