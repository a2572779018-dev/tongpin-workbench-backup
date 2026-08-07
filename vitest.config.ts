import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "server/**/*.test.ts",
      "cloudflare/src/**/*.test.ts",
      "src/**/*.test.ts",
    ],
    testTimeout: 15_000,
    sequence: {
      concurrent: false,
    },
  },
});
