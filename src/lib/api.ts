import type { ApiErrorPayload } from "../types";

export const API_URL =
  (typeof window !== "undefined" ? window.tongpin?.apiUrl : undefined) ||
  import.meta.env.VITE_API_URL ||
  "http://127.0.0.1:4318";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function isNetworkUnavailable(
  error: unknown,
): error is ApiRequestError {
  return (
    error instanceof ApiRequestError &&
    error.code === "NETWORK_UNAVAILABLE"
  );
}

export async function publicRequest<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  responseMode: "json" | "blob" | "image" | "stream" = "json",
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const sourceSignal = init.signal;
  const abortFromSource = () => controller.abort();
  if (sourceSignal?.aborted) {
    controller.abort();
  } else {
    sourceSignal?.addEventListener("abort", abortFromSource, { once: true });
  }

  try {
    const response = await fetch(`${API_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      let payload: ApiErrorPayload = {};
      try {
        payload = (await response.json()) as ApiErrorPayload;
      } catch (error) {
        if (controller.signal.aborted) throw error;
        // 接口若没有 JSON 错误体，使用统一兜底文案。
      }
      throw new ApiRequestError(
        response.status,
        payload.error?.code ?? "REQUEST_FAILED",
        payload.error?.message ?? "请求失败，请稍后重试",
      );
    }

    if (response.status === 204) return undefined as T;
    // The caller owns bounded decoding, cancellation and the body timeout.
    if (responseMode === "stream") return response as T;
    if (responseMode === "blob" || responseMode === "image") {
      const image = responseMode === "image";
      const mime = image ? "image/jpeg" : "video/mp4";
      const validType = image ? /^image\/jpeg(?:;|$)/i : /^video\/mp4(?:;|$)/i;
      if (!response.body || !validType.test(response.headers.get("content-type") ?? "")) throw new ApiRequestError(502, image ? "INVALID_IMAGE" : "INVALID_VIDEO", image ? "服务器未返回有效参考图" : "服务器未返回有效视频");
      const reader = response.body.getReader(), chunks: BlobPart[] = []; let size = 0;
      try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > (image ? 300000 : 64 * 1024 * 1024)) { await reader.cancel(); throw new ApiRequestError(413, image ? "IMAGE_TOO_LARGE" : "VIDEO_TOO_LARGE", image ? "参考图大小超出限制" : "视频超过 64 MB 限制"); } chunks.push(value); } }
      finally { reader.releaseLock(); }
      return new Blob(chunks, { type: mime }) as T;
    }
    try {
      return (await response.json()) as T;
    } catch (error) {
      if (controller.signal.aborted || error instanceof TypeError) throw error;
      throw new ApiRequestError(
        response.status,
        "INVALID_RESPONSE",
        "服务器返回异常，请稍后重试",
      );
    }
  } catch (error) {
    if (
      controller.signal.aborted ||
      error instanceof TypeError
    ) {
      throw new ApiRequestError(
        0,
        "NETWORK_UNAVAILABLE",
        "连接不上公司服务器，请检查网络后重试",
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    sourceSignal?.removeEventListener("abort", abortFromSource);
  }
}
