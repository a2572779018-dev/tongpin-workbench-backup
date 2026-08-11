import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  UPDATE_CHECK_ERROR_NOTICE_THROTTLE_MS,
  UPDATE_RETRY_DELAYS_MS,
  classifyUpdateError,
  getUpdateRetryDelayMs,
  shouldShowUpdateError,
}: {
  UPDATE_CHECK_ERROR_NOTICE_THROTTLE_MS: number;
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
    nowMs: number;
    channelMissingShown?: boolean;
    lastShownAtMs?: number;
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
    expect(result.message).toContain("不影响任务同步和老板通知");
    expect(result.message).not.toMatch(/404|Headers|token|secret/i);
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
    expect(result.message).toBe(
      "暂时无法检查软件更新，不影响任务同步和老板通知，软件会自动重试。",
    );
    expect(result.message).not.toMatch(/Authorization|Bearer|private/i);
  });

  it("shows a missing manifest only once per app session", () => {
    const errorClass = classifyUpdateError(
      new Error("latest-mac.yml returned 404"),
      "checking",
    );

    expect(
      shouldShowUpdateError({
        errorClass,
        nowMs: 1_000,
        channelMissingShown: false,
      }),
    ).toBe(true);
    expect(
      shouldShowUpdateError({
        errorClass,
        nowMs: 2_000,
        channelMissingShown: true,
      }),
    ).toBe(false);
  });

  it("throttles each check-error class for six hours", () => {
    const errorClass = classifyUpdateError(
      Object.assign(new Error("offline"), { code: "ENOTFOUND" }),
      "checking",
    );
    const shownAt = 10_000;

    expect(
      shouldShowUpdateError({
        errorClass,
        nowMs: shownAt + UPDATE_CHECK_ERROR_NOTICE_THROTTLE_MS - 1,
        lastShownAtMs: shownAt,
      }),
    ).toBe(false);
    expect(
      shouldShowUpdateError({
        errorClass,
        nowMs: shownAt + UPDATE_CHECK_ERROR_NOTICE_THROTTLE_MS,
        lastShownAtMs: shownAt,
      }),
    ).toBe(true);
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
        shouldShowUpdateError({
          errorClass,
          nowMs: 1_001,
          lastShownAtMs: 1_000,
          channelMissingShown: true,
        }),
      ).toBe(true);
    },
  );
});
