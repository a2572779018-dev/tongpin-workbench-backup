import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  UPDATE_RETRY_DELAYS_MS,
  classifyUpdateError,
  getUpdateRetryDelayMs,
  shouldShowUpdateError,
}: {
  UPDATE_RETRY_DELAYS_MS: number[];
  classifyUpdateError(
    error: unknown,
    phase?: "checking" | "downloading" | "installing" | "idle",
  ): {
    kind: string;
    scope: "check" | "critical";
    retry: "backoff" | "normal";
    title: string;
    message: string;
  };
  getUpdateRetryDelayMs(failureCount: number): number;
  shouldShowUpdateError(options: {
    errorClass: { kind: string; scope: "check" | "critical" };
  }): boolean;
} = require("../../electron/update-error-policy.cjs");

describe("update error policy", () => {
  it("treats a missing platform manifest as a normal-cycle channel issue", () => {
    const result = classifyUpdateError(
      new Error(
        'Cannot find channel "latest-mac.yml" update info: HttpError: 404 Headers: token=secret',
      ),
      "checking",
    );

    expect(result).toMatchObject({
      kind: "channel-missing",
      scope: "check",
      retry: "normal",
    });
    expect(result.message).not.toMatch(/404|Headers|token|secret/i);
    expect(shouldShowUpdateError({ errorClass: result })).toBe(false);
  });

  it("uses the requested exponential backoff for transient check failures", () => {
    expect(UPDATE_RETRY_DELAYS_MS).toEqual([
      2 * 60 * 1000,
      10 * 60 * 1000,
      30 * 60 * 1000,
      2 * 60 * 60 * 1000,
    ]);
    expect([1, 2, 3, 4, 5].map(getUpdateRetryDelayMs)).toEqual([
      2 * 60 * 1000,
      10 * 60 * 1000,
      30 * 60 * 1000,
      2 * 60 * 60 * 1000,
      2 * 60 * 60 * 1000,
    ]);
  });

  it("classifies network checks without exposing the raw error", () => {
    const result = classifyUpdateError(
      Object.assign(new Error("socket hang up; Authorization: Bearer private"), {
        code: "ECONNRESET",
      }),
      "checking",
    );

    expect(result).toMatchObject({
      kind: "check-network",
      scope: "check",
      retry: "backoff",
    });
    expect(result.message).toBe("软件会自动重试。");
    expect(result.message).not.toMatch(/Authorization|Bearer|private/i);
    expect(shouldShowUpdateError({ errorClass: result })).toBe(false);
  });

  it.each([
    "unexpected updater failure",
    "ERR_UPDATER_INVALID_SIGNATURE",
    "sha512 checksum mismatch",
    "download failed",
  ])("keeps every checking-phase error silent: %s", (message) => {
    const errorClass = classifyUpdateError(new Error(message), "checking");
    expect(errorClass.scope).toBe("check");
    expect(shouldShowUpdateError({ errorClass })).toBe(false);
  });

  it.each([
    ["downloading", "download failed", "download"],
    ["downloading", "sha512 checksum mismatch", "validation"],
    ["idle", "ERR_UPDATER_INVALID_SIGNATURE", "signature"],
    ["installing", "could not start installer", "install"],
  ] as const)(
    "shows %s-phase %s errors immediately",
    (phase, message, expectedKind) => {
      const errorClass = classifyUpdateError(new Error(message), phase);
      expect(errorClass).toMatchObject({
        kind: expectedKind,
        scope: "critical",
      });
      expect(
        shouldShowUpdateError({ errorClass }),
      ).toBe(true);
      expect(`${errorClass.title}${errorClass.message}`).not.toMatch(
        /https?:|headers?|token|authorization|bearer/i,
      );
    },
  );

  it("never copies sensitive critical-error details into display text", () => {
    const errorClass = classifyUpdateError(
      new Error(
        "ERR_UPDATER_INVALID_SIGNATURE https://secret.example/update Headers: Authorization=Bearer token-value",
      ),
      "downloading",
    );

    expect(errorClass.kind).toBe("signature");
    expect(`${errorClass.title}${errorClass.message}`).toBe(
      "更新签名校验失败更新签名校验未通过，已停止安装。",
    );
  });
});
