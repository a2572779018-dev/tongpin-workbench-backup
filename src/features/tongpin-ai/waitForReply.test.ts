import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AiChatResponse, AiImageResponse, AiRequestResult } from "../../../shared/ai";
import { ApiRequestError } from "../../lib/api";
import { ReplyWaiting } from "./ReplyWaiting";
import { shouldRecoverReply, waitForReply } from "./waitForReply";

const pending: AiRequestResult = { requestId: "original", status: "pending" };
const result = { requestId: "original", content: "你好" } as AiChatResponse;
describe("waiting for the original AI request", () => {
  afterEach(() => vi.useRealTimers());
  it("keeps reading pending requests until completion", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce(pending).mockResolvedValueOnce(pending)
      .mockResolvedValue({ ...pending, status: "completed", result });
    const waiting = waitForReply(read, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(waiting).resolves.toBe(result);
    expect(read).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("returns recovered images without generating another image", async () => {
    const imageResult = { requestId: "original", images: [] } as unknown as AiImageResponse;
    await expect(waitForReply(async () => ({ ...pending, status: "completed", imageResult }), new AbortController().signal)).resolves.toBe(imageResult);
  });
  it("surfaces real provider rejection and uncertain billing immediately", async () => {
    for (const [status, code] of [[403, "AI_GATEWAY_BLOCKED"], [504, "AI_REQUEST_UNCERTAIN"]] as const) {
      const read = vi.fn().mockResolvedValue({ ...pending, status: "failed", error: { status, code, message: "真实错误" } });
      await expect(waitForReply(read, new AbortController().signal)).rejects.toMatchObject({ status, code, message: "真实错误" });
      expect(read).toHaveBeenCalledTimes(1);
    }
  });
  it("recovers transient disconnected reads", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValueOnce(new ApiRequestError(0, "NETWORK_UNAVAILABLE", "断线"))
      .mockResolvedValue({ ...pending, status: "completed", result });
    const waiting = waitForReply(read, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(waiting).resolves.toBe(result);
  });
  it("stops polling immediately on user cancellation", async () => {
    vi.useFakeTimers();
    const controller = new AbortController(), read = vi.fn().mockResolvedValue(pending);
    const waiting = waitForReply(read, controller.signal);
    const assertion = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await assertion;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not accept results that arrive after account change or cancellation", async () => {
    const controller = new AbortController();
    await expect(waitForReply(async () => {
      controller.abort(); return { ...pending, status: "completed", result };
    }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
  it("bounds waiting rather than showing a spinner forever", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue(pending);
    const assertion = expect(waitForReply(read, new AbortController().signal, Date.now() + 3_000)).rejects.toMatchObject({ code: "AI_WAIT_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;
    expect(read).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not keep waiting on an uncreated request or authorization error", async () => {
    for (const status of [401, 403, 404]) {
      const read = vi.fn().mockRejectedValue(new ApiRequestError(status, "REQUEST_FAILED", "不能读取"));
      await expect(waitForReply(read, new AbortController().signal)).rejects.toMatchObject({ status });
      expect(read).toHaveBeenCalledTimes(1);
    }
  });
  it("rejects incomplete terminal records", async () => {
    await expect(waitForReply(async () => ({ ...pending, status: "completed" }), new AbortController().signal)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
  it("only automatically recovers pending and interrupted transport, not 403", () => {
    for (const code of ["AI_REQUEST_IN_PROGRESS", "NETWORK_UNAVAILABLE"]) expect(shouldRecoverReply(new ApiRequestError(409, code, "等待"))).toBe(true);
    expect(shouldRecoverReply(new ApiRequestError(403, "AI_GATEWAY_BLOCKED", "拦截"))).toBe(false);
    expect(shouldRecoverReply(new Error("unknown"))).toBe(false);
  });
  it("renders elapsed waiting text without a retry error or per-second announcements", () => {
    const html = renderToStaticMarkup(createElement(ReplyWaiting));
    expect(html).toContain("等待模型响应 · 已用时 0 秒");
    expect(html).toContain('aria-live="off"');
    expect(html).not.toContain("重新获取");
  });
});
