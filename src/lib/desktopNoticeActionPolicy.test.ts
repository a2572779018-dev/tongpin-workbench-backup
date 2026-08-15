import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { normalizeDesktopNoticeAction } = require(
  "../../electron/desktop-notice-action-policy.cjs",
) as { normalizeDesktopNoticeAction(value: unknown): unknown };

describe("desktop notice action policy", () => {
  it("allows the internal LORA dashboard action", () => {
    expect(
      normalizeDesktopNoticeAction({
        type: "open-lora-dashboard",
        reportDate: "2026-08-14",
      }),
    ).toEqual({ type: "open-lora-dashboard", reportDate: "2026-08-14" });
  });

  it("rejects arbitrary actions and malformed dates", () => {
    expect(
      normalizeDesktopNoticeAction({
        type: "open-url",
        url: "https://example.com",
      }),
    ).toBeNull();
    expect(
      normalizeDesktopNoticeAction({
        type: "open-lora-dashboard",
        reportDate: "2026-8-14",
      }),
    ).toBeNull();
  });
});
