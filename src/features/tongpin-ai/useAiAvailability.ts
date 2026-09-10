import { useCallback, useEffect, useRef, useState } from "react";
import type { AiAvailability, AiAvailabilityCheck, AiStatus } from "../../../shared/ai";
import { ApiRequestError } from "../../lib/api";

type Api = <T>(path: string, init?: RequestInit, timeoutMs?: number) => Promise<T>;
export function generationAvailabilityFailure(error: unknown): AiAvailabilityCheck | null {
  if (!(error instanceof ApiRequestError) || ![
    "AI_PROVIDER_AUTH", "AI_PROVIDER_GATEWAY_BLOCK", "AI_PROVIDER_PERMISSION", "AI_PROVIDER_LIMIT",
    "AI_PROVIDER_REDIRECT", "AI_PROVIDER_UNAVAILABLE", "AI_CONNECTION_FAILED", "AI_DNS_FAILED", "AI_HOST_NOT_ALLOWED",
  ].includes(error.code)) return null;
  return { state: "unavailable", code: error.code, message: error.message, checkedAt: new Date().toISOString() };
}

export function useAiAvailability(api: Api, accountId: string, target: "chat" | "image", onStatus: (status: AiStatus) => void) {
  const identity = `${accountId}:${target}`;
  const [snapshot, setSnapshot] = useState<{ identity: string; check: AiAvailabilityCheck } | null>(null);
  const [checking, setChecking] = useState(true);
  const [failures, setFailures] = useState<Record<string, AiAvailabilityCheck>>({});
  const active = useRef<{ controller: AbortController; identity: string } | null>(null);
  const refresh = useCallback(async () => {
    active.current?.controller.abort();
    const run = { controller: new AbortController(), identity };
    active.current = run; setChecking(true);
    try {
      const response = await api<AiAvailability>(`/api/ai/availability?target=${target}`, {
        headers: { "X-Tongpin-Account": accountId }, signal: run.controller.signal,
      }, 12_000);
      if (run.controller.signal.aborted || active.current !== run) return;
      if (!response?.status || !response.check || !["reachable", "unavailable", "unverified"].includes(response.check.state)) {
        throw new ApiRequestError(502, "AI_CHECK_INVALID", "服务检测结果不完整，请重新检测或联系管理员更新服务。");
      }
      onStatus(response.status); setSnapshot({ identity, check: response.check });
    } catch (error) {
      if (run.controller.signal.aborted || active.current !== run) return;
      setSnapshot({ identity, check: { state: "unavailable", code: error instanceof ApiRequestError ? error.code : "AI_CHECK_FAILED",
        message: error instanceof ApiRequestError && error.status === 404 ? "当前服务器尚未支持服务检测，请联系管理员更新服务。" : error instanceof Error ? error.message : "服务检查暂时无法完成，请重新检测。", checkedAt: new Date().toISOString() } });
    } finally { if (active.current === run && !run.controller.signal.aborted) setChecking(false); }
  }, [api, accountId, identity, target, onStatus]);
  useEffect(() => {
    void refresh();
    return () => { active.current?.controller.abort(); };
  }, [refresh]);
  const check = snapshot?.identity === identity ? snapshot.check : null;
  return {
    checking: checking || !check, check, failures,
    refresh: (scope: string) => {
      setFailures(current => { const next = { ...current }; delete next[scope]; return next; });
      return refresh();
    },
    recordFailure: (scope: string, error: unknown) => {
      const failure = generationAvailabilityFailure(error);
      if (failure) setFailures(current => ({ ...current, [scope]: failure }));
    },
  };
}
