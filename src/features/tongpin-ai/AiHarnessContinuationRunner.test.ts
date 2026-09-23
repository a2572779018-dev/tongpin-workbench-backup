import { describe, expect, it, vi } from "vitest";
import type { AiHarnessTrace } from "../../../shared/ai";
import type { AiVideoJob } from "../../../shared/aiVideo";
import type { AiWorkspaceSnapshot } from "../../../shared/aiWorkspace";
import { ApiRequestError } from "../../lib/api";
import { collectBackgroundAiWork, pollBackgroundAiWork, startBackgroundAiContinuation, type BackgroundAiApi } from "./AiHarnessContinuationRunner";
import { notifyAiWorkspaceSaved } from "./workspaceLeaveGuard";

function trace(status: AiHarnessTrace["status"]): AiHarnessTrace {
  return {
    runId: `run-${status}`, tier: "quick", strategy: "plan_execute", status,
    reasoningSummary: "安全进度摘要", nextAction: status === "planned" ? "resume" : status === "running" ? "poll" : "none",
    toolBudget: { used: 1, max: 3, remaining: 2 }, steps: [],
  };
}

function snapshot(): AiWorkspaceSnapshot {
  return {
    revision: 4, schemaVersion: 1, updatedAt: "2026-09-21T00:00:00.000Z",
    state: {
      view: "chat", mode: "quick", projects: [], drafts: {}, activeConversationId: "conversation-1",
      activeProjectId: null, enabledSkillIds: [],
      conversations: [{ id: "conversation-1", title: "任务", timeLabel: "刚刚", messages: [
        { id: "a", role: "assistant", content: "处理中", time: "10:00", requestId: "11111111-1111-4111-8111-111111111111", trace: trace("running") },
        { id: "b", role: "assistant", content: "已完成", time: "10:01", requestId: "22222222-2222-4222-8222-222222222222", trace: trace("succeeded") },
        { id: "c", role: "assistant", content: "待续跑", time: "10:02", requestId: "33333333-3333-4333-8333-333333333333", trace: trace("planned") },
        { id: "d", role: "assistant", content: "坏标识", time: "10:03", requestId: "../private", trace: trace("running") },
      ] }],
      artifacts: [
        { id: "artifact-1", conversationId: "conversation-1", title: "视频", kind: "视频", updatedLabel: "刚刚", summary: "", sections: [], data: { videoJobId: "44444444-4444-4444-8444-444444444444" } },
        { id: "artifact-2", conversationId: "conversation-1", title: "文档", kind: "文档", updatedLabel: "刚刚", summary: "", sections: [], data: { videoJobId: "55555555-5555-4555-8555-555555555555" } },
      ],
    },
  };
}

describe("App-root AI continuation discovery", () => {
  it("finds only bounded non-terminal runs and existing video jobs", () => {
    expect(collectBackgroundAiWork(snapshot())).toEqual({
      runRequestIds: ["33333333-3333-4333-8333-333333333333", "11111111-1111-4111-8111-111111111111"],
      videoJobIds: ["44444444-4444-4444-8444-444444444444"],
    });
  });

  it("recovers a parent Harness plan from a video artifact even without a rendered message trace", () => {
    const value = snapshot();
    value.state!.conversations = [];
    value.state!.artifacts[0].data = {
      videoJobId: "44444444-4444-4444-8444-444444444444",
      videoRequest: { planRequestId: "88888888-8888-4888-8888-888888888888" },
    };
    expect(collectBackgroundAiWork(value)).toEqual({
      runRequestIds: ["88888888-8888-4888-8888-888888888888"],
      videoJobIds: ["44444444-4444-4444-8444-444444444444"],
    });
  });

  it("collects validated parent plan IDs for image, presentation and video results", () => {
    const value = snapshot(); value.state!.conversations = [];
    value.state!.artifacts = [
      { id: "image", conversationId: "conversation-1", title: "图片", kind: "图片", updatedLabel: "刚刚", summary: "", sections: [], data: { harnessPlanRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } },
      { id: "ppt", conversationId: "conversation-1", title: "PPT", kind: "PPT", updatedLabel: "刚刚", summary: "", sections: [], data: { harnessPlanRequestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } },
      { id: "video", conversationId: "conversation-1", title: "视频", kind: "视频", updatedLabel: "刚刚", summary: "", sections: [], data: { videoJobId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", harnessPlanRequestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" } },
    ];
    expect(collectBackgroundAiWork(value)).toEqual({
      runRequestIds: ["dddddddd-dddd-4ddd-8ddd-dddddddddddd", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
      videoJobIds: ["cccccccc-cccc-4ccc-8ccc-cccccccccccc"],
    });
  });

  it("collects a pre-submit placeholder parent when no result artifact exists yet", () => {
    const value = snapshot(); value.state!.artifacts = [];
    value.state!.conversations[0].messages = [{
      id: "pending", role: "assistant", content: "", time: "10:00", status: "thinking",
      requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      harnessPlanRequestId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    }];
    expect(collectBackgroundAiWork(value)).toEqual({
      runRequestIds: ["ffffffff-ffff-4fff-8fff-ffffffffffff"],
      videoJobIds: [],
    });
  });

  it("does not expose conversation bodies when there is no recoverable work", () => {
    const value = snapshot();
    value.state!.conversations[0].messages = [{ id: "done", role: "assistant", content: "private prompt", time: "10:00", requestId: "66666666-6666-4666-8666-666666666666", trace: trace("failed") }];
    value.state!.artifacts = [];
    expect(collectBackgroundAiWork(value)).toEqual({ runRequestIds: [], videoJobIds: [] });
  });

  it("awaits an existing video refresh, then reads a planned run without resuming it", async () => {
    const events: string[] = [];
    const completedVideo = { id: "video-1", status: "completed" } as AiVideoJob;
    const planned = trace("planned");
    const result = await pollBackgroundAiWork({ videoJobIds: ["video-1"], runRequestIds: ["request-1"] }, {
      refreshVideo: async id => { events.push(`video:${id}`); return completedVideo; },
      readRun: async id => { events.push(`run:${id}`); return planned; },
    });
    expect(events).toEqual(["video:video-1", "run:request-1"]);
    expect(result).toEqual({ videoJobIds: [], runRequestIds: ["request-1"] });
  });

  it("reads polling or approval states without mutation and stops when no work exists", async () => {
    const running = trace("running");
    expect(await pollBackgroundAiWork({ videoJobIds: [], runRequestIds: ["request-1"] }, {
      refreshVideo: async () => null, readRun: async () => running,
    })).toEqual({ videoJobIds: [], runRequestIds: ["request-1"] });
    expect(await pollBackgroundAiWork({ videoJobIds: [], runRequestIds: [] }, {
      refreshVideo: async () => { throw new Error("must not read"); }, readRun: async () => { throw new Error("must not read"); },
    })).toEqual({ videoJobIds: [], runRequestIds: [] });
  });

  it("limits each refresh phase to four items and carries the rest to the next tick", async () => {
    const videoReads: string[] = [], runReads: string[] = [];
    const work = {
      videoJobIds: ["v1", "v2", "v3", "v4", "v5"],
      runRequestIds: ["r1", "r2", "r3", "r4", "r5"],
    };
    const result = await pollBackgroundAiWork(work, {
      refreshVideo: async id => { videoReads.push(id); return { id, status: "completed" } as AiVideoJob; },
      readRun: async id => { runReads.push(id); return trace("succeeded"); },
    });
    expect(videoReads).toEqual(["v1", "v2", "v3", "v4"]);
    expect(runReads).toEqual(["r1", "r2", "r3", "r4"]);
    expect(result).toEqual({ videoJobIds: ["v5"], runRequestIds: ["r5"] });
  });

  it("rotates long-running batches so the fifth video and run are observed on the next tick", async () => {
    const videoReads: string[] = [], runReads: string[] = [];
    const client = {
      refreshVideo: async (id: string) => { videoReads.push(id); return { id, status: "processing" } as AiVideoJob; },
      readRun: async (id: string) => { runReads.push(id); return trace("running"); },
    };
    const first = await pollBackgroundAiWork({ videoJobIds: ["v1", "v2", "v3", "v4", "v5"], runRequestIds: ["r1", "r2", "r3", "r4", "r5"] }, client);
    await pollBackgroundAiWork(first, client);
    expect(videoReads).toContain("v5"); expect(runReads).toContain("r5");
  });

  it("mounting or remounting a planned trace only reads persisted state", async () => {
    const paths: Array<{ path: string; method: string; account: string | null }> = [];
    let providerCalls = 0;
    const api: BackgroundAiApi = async <T,>(path: string, init?: RequestInit) => {
      paths.push({ path, method: init?.method ?? "GET", account: new Headers(init?.headers).get("X-Tongpin-Account") });
      if (init?.method === "POST") providerCalls += 1;
      if (path === "/api/ai/workspace") return snapshot() as T;
      if (path.startsWith("/api/ai/videos/")) return { job: { id: "44444444-4444-4444-8444-444444444444", status: "completed" } as AiVideoJob } as T;
      return { trace: trace("planned") } as T;
    };
    const stopFirst = startBackgroundAiContinuation(api, "member-a");
    await vi.waitFor(() => expect(paths.filter(item => item.path.startsWith("/api/ai/runs/"))).toHaveLength(2));
    stopFirst();
    const firstMount = [
      { path: "/api/ai/workspace", method: "GET", account: "member-a" },
      { path: "/api/ai/videos/44444444-4444-4444-8444-444444444444", method: "GET", account: "member-a" },
      { path: "/api/ai/runs/33333333-3333-4333-8333-333333333333", method: "GET", account: "member-a" },
      { path: "/api/ai/runs/11111111-1111-4111-8111-111111111111", method: "GET", account: "member-a" },
    ];
    expect(paths).toEqual(firstMount);
    const stopSecond = startBackgroundAiContinuation(api, "member-a");
    await vi.waitFor(() => expect(paths.length).toBe(firstMount.length * 2));
    stopSecond();
    expect(paths.slice(firstMount.length)).toEqual(firstMount);
    expect(providerCalls).toBe(0);
  });

  it("reads the parent video plan when only the persisted artifact links it", async () => {
    const value = snapshot(); value.state!.conversations = [];
    value.state!.artifacts[0].data = {
      videoJobId: "44444444-4444-4444-8444-444444444444",
      harnessPlanRequestId: "88888888-8888-4888-8888-888888888888",
    };
    const calls: string[] = [];
    const api: BackgroundAiApi = async <T,>(path: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/api/ai/workspace") return value as T;
      if (path.startsWith("/api/ai/videos/")) return { job: { id: "44444444-4444-4444-8444-444444444444", status: "completed" } as AiVideoJob } as T;
      return { trace: trace("planned") } as T;
    };
    const stop = startBackgroundAiContinuation(api, "member-a");
    await vi.waitFor(() => expect(calls).toContain("GET /api/ai/runs/88888888-8888-4888-8888-888888888888"));
    stop();
    expect(calls).toEqual([
      "GET /api/ai/workspace",
      "GET /api/ai/videos/44444444-4444-4444-8444-444444444444",
      "GET /api/ai/runs/88888888-8888-4888-8888-888888888888",
    ]);
  });

  it("observes a persisted parent plan after page unload without invoking the model", async () => {
    const value = snapshot(); value.state!.artifacts = [];
    value.state!.conversations[0].messages = [{
      id: "execution-placeholder", role: "assistant", content: "", time: "10:00", status: "thinking",
      requestId: "77777777-7777-4777-8777-777777777777",
      harnessPlanRequestId: "88888888-8888-4888-8888-888888888888",
      trace: trace("waiting_approval"),
    }];
    const calls: string[] = [];
    const api: BackgroundAiApi = async <T,>(path: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/api/ai/workspace") return value as T;
      return { trace: trace("planned") } as T;
    };
    const stop = startBackgroundAiContinuation(api, "member-a");
    await vi.waitFor(() => expect(calls).toContain("GET /api/ai/runs/88888888-8888-4888-8888-888888888888"));
    stop();
    expect(calls).not.toContain("GET /api/ai/runs/77777777-7777-4777-8777-777777777777");
    expect(calls.every(call => call.startsWith("GET "))).toBe(true);
  });

  it("backs off after an initial workspace failure instead of retrying every millisecond, then recovers", async () => {
    vi.useFakeTimers();
    try {
      let workspaceReads = 0;
      const api: BackgroundAiApi = async <T,>(path: string) => {
        if (path !== "/api/ai/workspace") throw new Error("unexpected request");
        workspaceReads += 1;
        if (workspaceReads === 1) throw new Error("offline");
        const empty = snapshot(); empty.state!.conversations = []; empty.state!.artifacts = [];
        return empty as T;
      };
      const stop = startBackgroundAiContinuation(api, "member-a", { idleScanDelayMs: 50 });
      await vi.advanceTimersByTimeAsync(0);
      expect(workspaceReads).toBe(1);
      await vi.advanceTimersByTimeAsync(49);
      expect(workspaceReads).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(workspaceReads).toBe(2);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a bounded 404 creation grace and later reads the same persisted job without recreating it", async () => {
    vi.useFakeTimers();
    try {
      const value = snapshot(); value.state!.conversations = [];
      value.state!.artifacts[0].data = {
        videoJobId: "44444444-4444-4444-8444-444444444444",
        harnessPlanRequestId: "88888888-8888-4888-8888-888888888888",
      };
      let videoReads = 0, runReads = 0;
      const calls: string[] = [];
      const api: BackgroundAiApi = async <T,>(path: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${path}`);
        if (path === "/api/ai/workspace") return value as T;
        if (path.startsWith("/api/ai/videos/")) {
          if (++videoReads === 1) throw new ApiRequestError(404, "NOT_FOUND", "not created yet");
          return { job: { id: "44444444-4444-4444-8444-444444444444", status: "completed" } as AiVideoJob } as T;
        }
        if (++runReads === 1) throw new ApiRequestError(404, "NOT_FOUND", "not created yet");
        return { trace: trace("planned") } as T;
      };
      const stop = startBackgroundAiContinuation(api, "member-a", { pollDelayMs: 5, idleScanDelayMs: 1_000, missingRecordGraceMs: 100 });
      await vi.advanceTimersByTimeAsync(0);
      expect(videoReads).toBe(1); expect(runReads).toBe(1);
      await vi.advanceTimersByTimeAsync(5);
      expect(videoReads).toBe(2); expect(runReads).toBe(2);
      expect(calls).toContain("GET /api/ai/runs/88888888-8888-4888-8888-888888888888");
      expect(calls.every(call => call.startsWith("GET "))).toBe(true);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops records that remain missing beyond the creation grace and does not rediscover them from stale workspace state", async () => {
    vi.useFakeTimers();
    try {
      const value = snapshot(); value.state!.conversations = [];
      value.state!.artifacts[0].data = {
        videoJobId: "44444444-4444-4444-8444-444444444444",
        harnessPlanRequestId: "88888888-8888-4888-8888-888888888888",
      };
      let videoReads = 0, runReads = 0, workspaceReads = 0;
      const api: BackgroundAiApi = async <T,>(path: string) => {
        if (path === "/api/ai/workspace") { workspaceReads += 1; return value as T; }
        if (path.startsWith("/api/ai/videos/")) videoReads += 1;
        else if (path.startsWith("/api/ai/runs/")) runReads += 1;
        throw new ApiRequestError(404, "NOT_FOUND", "still missing");
      };
      const stop = startBackgroundAiContinuation(api, "member-a", { pollDelayMs: 5, idleScanDelayMs: 30, missingRecordGraceMs: 10 });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5);
      await vi.advanceTimersByTimeAsync(5);
      expect({ videoReads, runReads }).toEqual({ videoReads: 3, runReads: 3 });
      await vi.advanceTimersByTimeAsync(60);
      expect(workspaceReads).toBeGreaterThan(1);
      expect({ videoReads, runReads }).toEqual({ videoReads: 3, runReads: 3 });
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts every old-account request when the root runner is replaced", async () => {
    const seen: { signal?: AbortSignal } = {};
    const oldApi: BackgroundAiApi = async <T,>(_path: string, init?: RequestInit) => {
      if (init?.signal) seen.signal = init.signal;
      return await new Promise<T>((_resolve, reject) => seen.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    };
    const stopOldAccount = startBackgroundAiContinuation(oldApi, "member-a");
    await vi.waitFor(() => expect(seen.signal).toBeDefined());
    stopOldAccount();
    expect(seen.signal?.aborted).toBe(true);
  });

  it("wakes from an idle workspace and discovers a task created before an in-page conversation switch", async () => {
    let workspaceReads = 0;
    const calls: string[] = [];
    const empty = snapshot(); empty.state!.conversations = []; empty.state!.artifacts = [];
    const late = snapshot(); late.state!.artifacts = [];
    late.state!.conversations[0].messages = [{ id: "late", role: "assistant", content: "处理中", time: "10:00", requestId: "77777777-7777-4777-8777-777777777777", trace: trace("planned") }];
    const api: BackgroundAiApi = async <T,>(path: string) => {
      calls.push(path);
      if (path === "/api/ai/workspace") return (++workspaceReads === 1 ? empty : late) as T;
      return { trace: trace("planned") } as T;
    };
    const stop = startBackgroundAiContinuation(api, "member-a", { pollDelayMs: 1, idleScanDelayMs: 1 });
    await vi.waitFor(() => expect(calls).toContain("/api/ai/runs/77777777-7777-4777-8777-777777777777"));
    stop();
    expect(workspaceReads).toBeGreaterThanOrEqual(2);
  });

  it("wakes immediately only for the saved account and removes the wake listener on cleanup", async () => {
    let workspaceReads = 0;
    const calls: string[] = [];
    const empty = snapshot(); empty.state!.conversations = []; empty.state!.artifacts = [];
    const late = snapshot(); late.state!.artifacts = [];
    late.state!.conversations[0].messages = [{ id: "late", role: "assistant", content: "处理中", time: "10:00", requestId: "77777777-7777-4777-8777-777777777777", trace: trace("planned") }];
    const api: BackgroundAiApi = async <T,>(path: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/api/ai/workspace") return (++workspaceReads === 1 ? empty : late) as T;
      return { trace: trace("planned") } as T;
    };
    const stop = startBackgroundAiContinuation(api, "member-a", { idleScanDelayMs: 60_000 });
    await vi.waitFor(() => expect(workspaceReads).toBe(1));
    notifyAiWorkspaceSaved("member-b");
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(workspaceReads).toBe(1);
    notifyAiWorkspaceSaved("member-a");
    await vi.waitFor(() => expect(calls).toContain("GET /api/ai/runs/77777777-7777-4777-8777-777777777777"));
    stop();
    const readsAfterStop = workspaceReads;
    notifyAiWorkspaceSaved("member-a");
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(workspaceReads).toBe(readsAfterStop);
  });
});
