import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReplyWaiting } from "./ReplyWaiting";

describe("ReplyWaiting", () => {
  afterEach(() => vi.useRealTimers());

  it("uses the persisted request start time after a conversation remount", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T12:00:30.000Z"));
    const html = renderToStaticMarkup(createElement(ReplyWaiting, {
      startedAt: Date.parse("2026-09-21T12:00:00.000Z"),
    }));
    expect(html).toContain("已用时 30 秒");
  });
});
