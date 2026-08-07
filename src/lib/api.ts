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

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
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

  if (!response.ok) {
    let payload: ApiErrorPayload = {};
    try {
      payload = (await response.json()) as ApiErrorPayload;
    } catch {
      // 接口若没有 JSON 错误体，使用统一兜底文案。
    }
    throw new ApiRequestError(
      response.status,
      payload.error?.code ?? "REQUEST_FAILED",
      payload.error?.message ?? "请求失败，请稍后重试",
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}
