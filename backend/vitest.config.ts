import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The workload simulator has its own Node test runner (test:simulation).
    include: ["src/**/*.test.ts"],
  },
});
