import { defineConfig } from "vitest/config";

// Integration tests: need Postgres. Run with `npm run test:integration`.
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    globalSetup: "test/integration/global-setup.ts",
    // The files share one database, so they must not run at the same time.
    fileParallelism: false,
  },
});
