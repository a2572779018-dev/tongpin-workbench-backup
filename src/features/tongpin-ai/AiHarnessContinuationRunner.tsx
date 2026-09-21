import { useEffect } from "react";
import type { AiHarnessTrace } from "../../../shared/ai";
import type { AiVideoJob } from "../../../shared/aiVideo";
import type { AiWorkspaceSnapshot } from "../../../shared/aiWorkspace";
import { useAuth } from "../../auth/AuthContext";
import { ApiRequestError } from "../../lib/api";
import { registerAiWorkspaceActivityListener } from "./workspaceLeaveGuard";

const POLL_DELAY_MS = 10_000;
const IDLE_SCAN_DELAY_MS = 60_000;
const MISSING_RECORD_GRACE_MS = 15_000;
const MAX_BACKGROUND_ITEMS = 48;
const MAX_POLL_BATCH = 4;
const SAFE_ID = /^[A-Za-z0-9_-]{16,100}$/;
const TERMINAL_RUN = new Set<AiHarnessTrace["status"]>(["succeeded", "failed", "cancelled", "uncertain"]);
const TERMINAL_VIDEO = new Set<AiVideoJob["status"]>(["completed", "failed", "uncertain"]);

export interface BackgroundAiWork {
  runRequestIds: string[];
  videoJobIds: string[];
}

export interface BackgroundAiPollClient {
  refreshVideo(jobId: string): Promise<AiVideoJob | null>;
  readRun(requestId: string): Promise<AiHarnessTrace | null>;
  resumeRun(requestId: string): Promise<AiHarnessTrace>;
}

export type BackgroundAiApi = <T>(path: string, init?: RequestInit, timeoutMs?: number) => Promise<T>;

/** Read only the bounded identifiers needed to recover server-owned work.
 * Conversation text, attachments and provider details never leave the snapshot. */
export function collectBackgroundAiWork(snapshot: AiWorkspaceSnapshot): BackgroundAiWork {
  const runRequestIds: string[] = [];
  const runSeen = new Set<string>();
  const addRun = (requestId: unknown) => {
    if (runRequestIds.length >= MAX_BACKGROUND_ITEMS || typeof requestId !== "string" || !SAFE_ID.test(requestId) || runSeen.has(requestId)) return;
    runSeen.add(requestId);
    runRequestIds.push(requestId);
  };
  const videoJobIds: string[] = [];
  const videoSeen = new Set<string>();
  // A generated-video artifact stores the execution job ID and the parent
  // approved plan ID separately. The planning trace may not be rendered as a
  // conversation message, so recover the parent Harness run here first.
  for (const artifact of [...(snapshot.state?.artifacts ?? [])].reverse()) {
    addRun(artifact.data?.harnessPlanRequestId);
    if (artifact.kind !== "视频") continue;
    const request = artifact.data?.videoRequest;
    if (request && typeof request === "object" && !Array.isArray(request)) addRun(request.planRequestId);
    const jobId = typeof artifact.data?.videoJobId === "string" ? artifact.data.videoJobId : "";
    if (!SAFE_ID.test(jobId) || videoSeen.has(jobId) || videoJobIds.length >= MAX_BACKGROUND_ITEMS) continue;
    videoSeen.add(jobId);
    videoJobIds.push(jobId);
  }
  for (const conversation of [...(snapshot.state?.conversations ?? [])].reverse()) {
    for (const message of [...conversation.messages].reverse()) {
      const requestId = message.requestId;
      addRun(message.harnessPlanRequestId);
      // Tool execution IDs remain useful to the page's result-recovery path,
      // but they are not the parent Harness run. When the explicit parent is
      // present, polling the execution ID would either track the wrong PPT run
      // or spend the 404 grace window on an image request that has no run.
      if (message.harnessPlanRequestId) continue;
      const activeWithoutTrace = !message.trace && (message.status === "thinking" || message.status === "typing");
      if (!activeWithoutTrace && (!message.trace || TERMINAL_RUN.has(message.trace.status))) continue;
      addRun(requestId);
      if (runRequestIds.length >= MAX_BACKGROUND_ITEMS) break;
    }
    if (runRequestIds.length >= MAX_BACKGROUND_ITEMS) break;
  }
  return { runRequestIds, videoJobIds };
}

/** Refresh existing video jobs first because a terminal refresh can settle its
 * approved Harness tool. Only a server trace that explicitly requests resume
 * can cause the idempotent continuation POST. Rejected reads stay active for a
 * later retry; `null` means the account-scoped server record no longer exists. */
export async function pollBackgroundAiWork(work: BackgroundAiWork, client: BackgroundAiPollClient): Promise<BackgroundAiWork> {
  const videoBatch = work.videoJobIds.slice(0, MAX_POLL_BATCH);
  const videoResults = await Promise.allSettled(videoBatch.map(async id => ({ id, job: await client.refreshVideo(id) })));
  const processedVideoJobIds = videoResults.flatMap((result, index) => {
    if (result.status === "rejected") return [videoBatch[index]];
    return result.value.job && !TERMINAL_VIDEO.has(result.value.job.status) ? [result.value.id] : [];
  });
  // Unvisited entries move to the front so long-running first entries cannot
  // starve later jobs across repeated ticks.
  const videoJobIds = [...work.videoJobIds.slice(MAX_POLL_BATCH), ...processedVideoJobIds];
  const runBatch = work.runRequestIds.slice(0, MAX_POLL_BATCH);
  const runResults = await Promise.allSettled(runBatch.map(async id => {
    let trace = await client.readRun(id);
    if (trace?.nextAction === "resume") trace = await client.resumeRun(id);
    return { id, trace };
  }));
  const processedRunRequestIds = runResults.flatMap((result, index) => {
    if (result.status === "rejected") return [runBatch[index]];
    return result.value.trace && !TERMINAL_RUN.has(result.value.trace.status) ? [result.value.id] : [];
  });
  const runRequestIds = [...work.runRequestIds.slice(MAX_POLL_BATCH), ...processedRunRequestIds];
  return { runRequestIds, videoJobIds };
}

/** Starts one account-bound background session. The returned cleanup aborts
 * every in-flight request, which is also how a React account/view change
 * prevents the old account from continuing after unmount. */
export function startBackgroundAiContinuation(
  api: BackgroundAiApi,
  accountId: string,
  timing: { pollDelayMs?: number; idleScanDelayMs?: number; missingRecordGraceMs?: number } = {},
): () => void {
  let live = true;
  let inFlight = false;
  let wakePending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let nextWorkspaceScan = 0;
  const controller = new AbortController();
  const runIds = new Set<string>();
  const videoIds = new Set<string>();
  const finishedRuns = new Set<string>();
  const finishedVideos = new Set<string>();
  const missingRuns = new Map<string, number>();
  const missingVideos = new Map<string, number>();
  const pollDelayMs = timing.pollDelayMs ?? POLL_DELAY_MS;
  const idleScanDelayMs = timing.idleScanDelayMs ?? IDLE_SCAN_DELAY_MS;
  const missingRecordGraceMs = timing.missingRecordGraceMs ?? MISSING_RECORD_GRACE_MS;
  const headers = { "X-Tongpin-Account": accountId };

  async function discoverWork() {
    const snapshot = await api<AiWorkspaceSnapshot>("/api/ai/workspace", { headers, signal: controller.signal }, 30_000);
    if (!live) return;
    const discovered = collectBackgroundAiWork(snapshot);
    for (const id of discovered.runRequestIds) if (!finishedRuns.has(id)) runIds.add(id);
    for (const id of discovered.videoJobIds) if (!finishedVideos.has(id)) videoIds.add(id);
  }

  function tolerateMissing(map: Map<string, number>, id: string, error: ApiRequestError): null {
    const firstSeen = map.get(id);
    if (firstSeen === undefined) {
      map.set(id, Date.now());
      throw error;
    }
    if (Date.now() - firstSeen < missingRecordGraceMs) throw error;
    map.delete(id);
    return null;
  }

  const client: BackgroundAiPollClient = {
    async refreshVideo(jobId) {
      try {
        const job = (await api<{ job: AiVideoJob }>(`/api/ai/videos/${encodeURIComponent(jobId)}`, { headers, signal: controller.signal }, 30_000)).job;
        missingVideos.delete(jobId);
        return job;
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 404) return tolerateMissing(missingVideos, jobId, error);
        throw error;
      }
    },
    async readRun(requestId) {
      try {
        const trace = (await api<{ trace: AiHarnessTrace }>(`/api/ai/runs/${encodeURIComponent(requestId)}`, { headers, signal: controller.signal }, 30_000)).trace;
        missingRuns.delete(requestId);
        return trace;
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 404) return tolerateMissing(missingRuns, requestId, error);
        throw error;
      }
    },
    async resumeRun(requestId) {
      return (await api<{ trace: AiHarnessTrace }>(`/api/ai/runs/${encodeURIComponent(requestId)}/resume`, { method: "POST", headers, signal: controller.signal }, 130_000)).trace;
    },
  };

  async function tick() {
    if (!live || inFlight) { wakePending = true; return; }
    inFlight = true;
    wakePending = false;
    try {
      if (Date.now() >= nextWorkspaceScan) {
        // Set the retry boundary before I/O so a failed initial discovery
        // cannot collapse into a 1 ms retry storm.
        nextWorkspaceScan = Date.now() + idleScanDelayMs;
        await discoverWork();
      }
      const before = { runRequestIds: [...runIds], videoJobIds: [...videoIds] };
      const remaining = await pollBackgroundAiWork(before, client);
      if (!live) return;
      const remainingRuns = new Set(remaining.runRequestIds), remainingVideos = new Set(remaining.videoJobIds);
      for (const id of before.runRequestIds.slice(0, MAX_POLL_BATCH)) if (!remainingRuns.has(id)) finishedRuns.add(id);
      for (const id of before.videoJobIds.slice(0, MAX_POLL_BATCH)) if (!remainingVideos.has(id)) finishedVideos.add(id);
      runIds.clear(); videoIds.clear();
      for (const id of remaining.runRequestIds) runIds.add(id);
      for (const id of remaining.videoJobIds) videoIds.add(id);
    } catch {
      // Connectivity/auth recovery remains owned by AuthContext. Retrying a
      // read is safe; this runner never recreates an external tool request.
    } finally {
      inFlight = false;
      if (live) {
        if (wakePending) {
          timer = setTimeout(() => void tick(), 0);
          return;
        }
        const delay = runIds.size || videoIds.size
          ? pollDelayMs
          : Math.max(1, nextWorkspaceScan - Date.now());
        timer = setTimeout(() => void tick(), delay);
      }
    }
  }

  const unregisterWake = registerAiWorkspaceActivityListener(accountId, () => {
    if (!live) return;
    nextWorkspaceScan = 0;
    wakePending = true;
    clearTimeout(timer);
    if (!inFlight) void tick();
  });
  void tick();
  return () => {
    live = false;
    unregisterWake();
    controller.abort();
    clearTimeout(timer);
  };
}

/**
 * Lives above the conditionally mounted AI page. It never creates a tool job:
 * it only refreshes already-persisted jobs and claims a server-planned,
 * idempotent Harness continuation. This keeps work moving while another app
 * module is visible without relying on unsafe Worker fire-and-forget tasks.
 */
export function AiHarnessContinuationRunner({ accountId, aiViewActive }: { accountId: string; aiViewActive: boolean }) {
  const { api } = useAuth();

  useEffect(() => {
    return startBackgroundAiContinuation(api, accountId);
    // Leaving the AI view restarts the runner after App has flushed the latest
    // workspace, so newly-created work is discovered immediately.
  }, [accountId, aiViewActive, api]);

  return null;
}
