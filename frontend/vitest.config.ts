import { defineConfig } from "vitest/config";

export default defineConfig({
  // The automatic JSX runtime, so test files need no React import.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    css: { modules: { classNameStrategy: "non-scoped" } },
  },
});
