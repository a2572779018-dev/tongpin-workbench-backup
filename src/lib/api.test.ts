import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiRequestError,
  isNetworkUnavailable,
  publicRequest,
} from "./api";

describe("API network handling", () => {
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
});
