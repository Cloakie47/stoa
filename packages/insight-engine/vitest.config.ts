import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 120_000, // generous default for integration tests that hit real LLMs
  },
});
