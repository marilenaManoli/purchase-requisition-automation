import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Tests must never depend on a running Ollama or mock ERP; those are
    // replaced by fakes behind the same interfaces.
    testTimeout: 10_000,
  },
});
