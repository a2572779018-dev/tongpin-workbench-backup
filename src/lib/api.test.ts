import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiRequestError,
  isNetworkUnavailable,
  publicRequest,
} from "./api";

describe("API network handling", () => {
  it("hands an SSE response to the caller without consuming its body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('data: {"type":"run_started"}\n\n', {
      headers: { "Content-Type": "text/event-stream" },
    })));
    const response = await publicRequest<Response>("/api/ai/chat/stream", {}, 1000, "stream");
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toBe('data: {"type":"run_started"}\n\n');
  });
  it("restores JPEG references with an explicit image mode without weakening video validation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(new Uint8Array([255, 216, 255, 217]), { headers: { "Content-Type": "image/jpeg" } })));
    const image = await publicRequest<Blob>("/api/video-reference/test", {}, 1000, "image");
    expect(image.type).toBe("image/jpeg");
    expect(image.size).toBe(4);
    await expect(publicRequest("/api/videos/content", {}, 1000, "blob")).rejects.toMatchObject({ code: "INVALID_VIDEO" });
  });
  it("rejects HTML and oversized responses while restoring reference pictures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("error", { headers: { "Content-Type": "text/html" } })));
    await expect(publicRequest("/api/video-reference/test", {}, 1000, "image")).rejects.toMatchObject({ code: "INVALID_IMAGE" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array(300001), { headers: { "Content-Type": "image/jpeg" } })));
    await expect(publicRequest("/api/video-reference/test", {}, 1000, "image")).rejects.toMatchObject({ code: "IMAGE_TOO_LARGE" });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("turns an unreachable host into a reader-facing network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );

    const request = publicRequest("/api/health");

    await expect(request).rejects.toMatchObject({
      status: 0,
      code: "NETWORK_UNAVAILABLE",
    });
    await request.catch((error) => {
      expect(error).toBeInstanceOf(ApiRequestError);
      expect(isNetworkUnavailable(error)).toBe(true);
    });
  });

  it("stops waiting when the request exceeds its timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          }),
      ),
    );

    await expect(publicRequest("/api/health", {}, 5)).rejects.toMatchObject({
      status: 0,
      code: "NETWORK_UNAVAILABLE",
    });
  });

  it("reports malformed successful responses without calling them a network outage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("not-json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(publicRequest("/api/auth/login")).rejects.toMatchObject({
      status: 200,
      code: "INVALID_RESPONSE",
      message: "服务器返回异常，请稍后重试",
    });
  });

  function stalledBodyFetch(status = 200) {
    return vi.fn(async (_url: string, init?: RequestInit) => new Response(
      new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("aborted", "AbortError"));
          }, { once: true });
        },
      }),
      { status, headers: { "Content-Type": "application/json" } },
    ));
  }

  it.each([200, 502])("keeps the timeout active while reading a %s response body", async (status) => {
    vi.stubGlobal("fetch", stalledBodyFetch(status));
    await expect(publicRequest("/api/ai/chat", {}, 5)).rejects.toMatchObject({
      status: 0,
      code: "NETWORK_UNAVAILABLE",
    });
  });

  it("honors stop while waiting for the response body", async () => {
    vi.stubGlobal("fetch", stalledBodyFetch());
    const controller = new AbortController();
    const request = publicRequest("/api/ai/chat", { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(request).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
  });
});
