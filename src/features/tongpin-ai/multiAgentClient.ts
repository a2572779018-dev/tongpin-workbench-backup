type CancelApi = <T>(path: string, init?: RequestInit, timeoutMs?: number) => Promise<T>;

/**
 * 停止 for a 多 Agent 协作 reply: asks the server to abort the run's in-flight
 * coordinator, sub-agent and synthesis calls. Best effort and harmless for an
 * ordinary reply (the server answers `{ cancelled: false }` and that run keeps
 * its usual "stop waiting" behaviour). The caller still aborts its own stream.
 * Resolves true only when the server stopped a multi-agent run.
 */
export async function requestMultiAgentStop(api: CancelApi, accountId: string, requestId: string | undefined): Promise<boolean> {
  if (!requestId || requestId.startsWith("draft-")) return false;
  try {
    const result = await api<{ cancelled?: unknown }>(`/api/ai/requests/${encodeURIComponent(requestId)}/cancel`,
      { method: "POST", headers: { "X-Tongpin-Account": accountId } }, 10_000);
    return result?.cancelled === true;
  } catch {
    return false;
  }
}
