import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "server/**/*.test.ts",
      "cloudflare/src/**/*.test.ts",
      "electron/**/*.test.mjs",
      "src/**/*.test.ts",
      "src/**/*.test.mjs",
    ],
    testTimeout: 15_000,
    // File-backed SQLite fixtures contend heavily on hosted Windows disks.
    // Bound CI parallelism; setup timeout is not a user-request latency SLA.
    maxWorkers: process.env.CI && process.platform === "win32" ? 2 : undefined,
    hookTimeout: process.platform === "win32" ? 60_000 : 10_000,
    sequence: {
      concurrent: false,
    },
  },
});
