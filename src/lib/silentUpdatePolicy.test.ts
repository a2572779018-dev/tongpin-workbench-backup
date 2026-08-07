import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  shouldInstallSilently,
}: {
  shouldInstallSilently(options: {
    updateReady: boolean;
    installRequested: boolean;
    now: Date;
    idleSeconds: number;
  }): boolean;
} = require("../../electron/silent-update-policy.cjs");

describe("silent update policy", () => {
  it("installs an available update during the overnight idle window", () => {
    expect(
      shouldInstallSilently({
        updateReady: true,
        installRequested: false,
        now: new Date(2026, 6, 30, 3, 15),
        idleSeconds: 10 * 60,
      }),
    ).toBe(true);
  });

  it("does not interrupt employees during work hours", () => {
    expect(
      shouldInstallSilently({
        updateReady: true,
        installRequested: false,
        now: new Date(2026, 6, 30, 10, 0),
        idleSeconds: 8 * 60 * 60,
      }),
    ).toBe(false);
  });

  it("waits until the computer has been idle for ten minutes", () => {
    expect(
      shouldInstallSilently({
        updateReady: true,
        installRequested: false,
        now: new Date(2026, 6, 30, 3, 15),
        idleSeconds: 9 * 60 + 59,
      }),
    ).toBe(false);
  });

  it("does not schedule the same installer twice", () => {
    expect(
      shouldInstallSilently({
        updateReady: true,
        installRequested: true,
        now: new Date(2026, 6, 30, 3, 15),
        idleSeconds: 60 * 60,
      }),
    ).toBe(false);
  });
});
