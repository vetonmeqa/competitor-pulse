import { configDefaults, defineConfig } from "vitest/config";

// Unit tests: no database, no network beyond localhost. Run with `npm test`.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "test/integration/**"],
  },
});
