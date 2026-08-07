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
});
