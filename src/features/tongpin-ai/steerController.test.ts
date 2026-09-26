import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiRunGuidanceStatus } from "../../../shared/aiRunGuidance";
import { ApiRequestError } from "../../lib/api";
import { runGuidanceClient, SteerController, type RunGuidanceClient, type SteerHost, type SteerSendResult } from "./steerController";

const RUN = "plan-request-000000000001";

function setup(options: { guidance?: boolean; maxRetries?: number } = {}) {
  const responding = new Set<string>();
  const activeRuns = new Set<string>();
  const results: SteerSendResult[] = [];
  const restored: Array<{ conversationId: string; text: string; reason: string }> = [];
  const recorded: Array<{ conversationId: string; text: string }> = [];
  const notices: string[] = [];
  const server = new Map<string, { runRequestId: string; text: string; status: AiRunGuidanceStatus }>();
  const failures = { post: undefined as Error | undefined, list: undefined as Error | undefined };
  let postGate: Promise<void> | undefined;
  const guidance: RunGuidanceClient = {
    post: vi.fn(async (runRequestId: string, input: { id: string; text: string }) => {
      await postGate;
      if (failures.post) throw failures.post;
      server.set(input.id, { runRequestId, text: input.text, status: "pending" });
      return { id: input.id, status: "pending" as const, createdAt: 1 };
    }),
    cancel: vi.fn(async (_runRequestId: string, id: string) => {
      const row = server.get(id);
      if (!row) throw new ApiRequestError(404, "AI_GUIDANCE_NOT_FOUND", "没有找到这条补充");
      if (row.status === "delivered") throw new ApiRequestError(409, "AI_GUIDANCE_DELIVERED", "AI 已读取这条补充，无法撤回");
      row.status = "cancelled";
      return { id, status: "cancelled" as const, createdAt: 1 };
    }),
    list: vi.fn(async (runRequestId: string) => {
      if (failures.list) throw failures.list;
      return [...server].filter(([, row]) => row.runRequestId === runRequestId).map(([id, row]) => ({ id, status: row.status, createdAt: 1 }));
    }),
  };
  const sendFollowUp = vi.fn(async (_conversationId: string, _text: string): Promise<SteerSendResult> => results.shift() ?? { status: "sent" });
  const host: SteerHost = {
    sendFollowUp,
    restoreDraft: (conversationId, text, reason) => { restored.push({ conversationId, text, reason }); },
    recordDelivered: (conversationId, text) => { recorded.push({ conversationId, text }); },
    isResponding: conversationId => responding.has(conversationId),
    isRunActive: (conversationId, runRequestId) => activeRuns.has(`${conversationId}:${runRequestId}`),
    notify: message => { notices.push(message); },
    ...(options.guidance === false ? {} : { guidance }),
  };
  let sequence = 0;
  const controller = new SteerController(() => host, {
    newId: () => `steer-item-${String(++sequence).padStart(8, "0")}`,
    now: () => sequence * 10,
    retryDelayMs: attempt => attempt * 100,
    maxRetries: options.maxRetries ?? 3,
    watchMs: 50,
  });
  // The run takes its pending guidance before its next model call.
  const take = (runRequestId = RUN) => { for (const row of server.values()) if (row.runRequestId === runRequestId && row.status === "pending") row.status = "delivered"; };
  const gatePost = () => { let open!: () => void; postGate = new Promise<void>(resolve => { open = resolve; }); return () => { postGate = undefined; open(); }; };
  return { controller, responding, activeRuns, results, restored, recorded, notices, server, guidance, sendFollowUp, failures, take, gatePost };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("steer follow-up queue", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("waits while the reply runs, then sends every supplement as ONE follow-up turn when it completes", async () => {
    const steer = setup();
    steer.responding.add("c1");
    expect(steer.controller.add("c1", "  改成英文 ", { kind: "followup" })).toMatchObject({ ok: true });
    expect(steer.controller.add("c1", "再加一段总结", { kind: "followup" })).toMatchObject({ ok: true });
    steer.controller.sync();
    await flush();
    expect(steer.sendFollowUp).not.toHaveBeenCalled();
    expect(steer.controller.bubbles("c1")).toEqual([
      { id: "steer-item-00000001", text: "改成英文", status: "queued", cancellable: true },
      { id: "steer-item-00000002", text: "再加一段总结", status: "queued", cancellable: true },
    ]);
    expect(steer.controller.bubbles("c2")).toEqual([]);

    steer.responding.delete("c1");
    steer.controller.sync();
    expect(steer.controller.bubbles("c1").map(item => item.status)).toEqual(["sending", "sending"]);
    await flush();
    expect(steer.sendFollowUp).toHaveBeenCalledTimes(1);
    expect(steer.sendFollowUp).toHaveBeenCalledWith("c1", "改成英文\n再加一段总结");
    expect(steer.controller.list("c1")).toEqual([]);
    expect(steer.restored).toEqual([]);
  });

  it("sends after a failed reply too, and after a stop once the server has finished the old request", async () => {
    const steer = setup();
    steer.responding.add("failed").add("stopped");
    steer.controller.add("failed", "换个角度", { kind: "followup" });
    steer.controller.add("stopped", "只要三点", { kind: "followup" });
    // Failed reply: the conversation is simply no longer busy.
    steer.responding.delete("failed");
    steer.controller.sync();
    await flush();
    expect(steer.sendFollowUp).toHaveBeenLastCalledWith("failed", "换个角度");

    // Stopped reply: the stopped request may still be finishing server-side.
    steer.results.push({ status: "retry", reason: "还有一条请求正在处理" }, { status: "retry" });
    steer.responding.delete("stopped");
    steer.controller.sync();
    await flush();
    expect(steer.sendFollowUp).toHaveBeenCalledTimes(2);
    expect(steer.controller.bubbles("stopped")).toMatchObject([{ status: "queued", text: "只要三点" }]);
    steer.controller.sync();
    await flush();
    expect(steer.sendFollowUp).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(steer.sendFollowUp).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(200);
    expect(steer.sendFollowUp).toHaveBeenCalledTimes(4);
    expect(steer.sendFollowUp).toHaveBeenLastCalledWith("stopped", "只要三点");
    expect(steer.controller.list("stopped")).toEqual([]);
    expect(steer.restored).toEqual([]);
  });

  it("puts the text back into the composer with the reason when the turn cannot be sent", async () => {
    const steer = setup();
    steer.results.push({ status: "failed", reason: "AI 额度不足，补充内容已放回输入框" });
    // The reply already ended, so the supplement goes out right away.
    steer.controller.add("c1", "补充一", { kind: "followup" });
    await flush();
    expect(steer.restored).toEqual([{ conversationId: "c1", text: "补充一", reason: "AI 额度不足，补充内容已放回输入框" }]);
    expect(steer.controller.list("c1")).toEqual([]);

    steer.sendFollowUp.mockRejectedValueOnce(new Error("网络连接中断"));
    steer.controller.add("c1", "补充二", { kind: "followup" });
    await flush();
    expect(steer.restored.at(-1)).toEqual({ conversationId: "c1", text: "补充二", reason: "网络连接中断" });
  });

  it("gives up after bounded retries and restores the text", async () => {
    const steer = setup({ maxRetries: 2 });
    steer.results.push({ status: "retry" }, { status: "retry" }, { status: "retry" });
    steer.controller.add("c1", "补充", { kind: "followup" });
    await flush();
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);
    expect(steer.sendFollowUp).toHaveBeenCalledTimes(3);
    expect(steer.restored).toEqual([{ conversationId: "c1", text: "补充", reason: "上一条回复仍在处理，补充内容已放回输入框" }]);
    expect(steer.controller.list("c1")).toEqual([]);
  });

  it("lets a queued supplement be withdrawn before delivery and bounds the queue", async () => {
    const steer = setup();
    steer.responding.add("c1");
    const first = steer.controller.add("c1", "撤回我", { kind: "followup" });
    for (let index = 2; index <= 5; index += 1) expect(steer.controller.add("c1", `第${index}条`, { kind: "followup" }).ok).toBe(true);
    expect(steer.controller.add("c1", "第6条", { kind: "followup" })).toEqual({ ok: false, reason: "最多暂存 5 条补充，请等当前回复结束后再发送" });
    expect(steer.controller.add("c1", "   ", { kind: "followup" })).toEqual({ ok: false, reason: "请先输入补充内容" });
    // The merged follow-up must still fit in one request message.
    expect(steer.controller.add("c2", "字".repeat(24_001), { kind: "followup" })).toEqual({ ok: false, reason: "补充内容过长，请缩短后再发送" });
    if (!first.ok) throw new Error("first supplement rejected");
    steer.controller.cancel(first.id);
    steer.responding.delete("c1");
    steer.controller.sync();
    await flush();
    expect(steer.sendFollowUp).toHaveBeenCalledWith("c1", "第2条\n第3条\n第4条\n第5条");
  });

  it("re-checks on its own when the busy flag clears without a render", async () => {
    const steer = setup();
    steer.responding.add("c1");
    steer.controller.add("c1", "补充", { kind: "followup" });
    await flush();
    steer.responding.delete("c1");
    expect(steer.sendFollowUp).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(steer.sendFollowUp).toHaveBeenCalledWith("c1", "补充");
  });

  it("stops timers when detached and resumes on attach", async () => {
    const steer = setup();
    steer.results.push({ status: "retry" });
    steer.controller.add("c1", "补充", { kind: "followup" });
    await flush();
    steer.controller.detach();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(steer.sendFollowUp).toHaveBeenCalledTimes(1);
    steer.controller.attach();
    await flush();
    expect(steer.sendFollowUp).toHaveBeenCalledTimes(2);
  });
});

describe("steer guidance for an active multi-step run", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("hands the supplement to the run and keeps what the run took in the conversation", async () => {
    const steer = setup();
    steer.responding.add("c1");
    steer.activeRuns.add(`c1:${RUN}`);
    steer.controller.add("c1", "第二张改成竖版", { kind: "guidance", runRequestId: RUN });
    expect(steer.controller.bubbles("c1")).toMatchObject([{ status: "queued", cancellable: false }]);
    await flush();
    expect(steer.guidance.post).toHaveBeenCalledWith(RUN, { id: "steer-item-00000001", text: "第二张改成竖版" });
    expect(steer.controller.bubbles("c1")).toEqual([{ id: "steer-item-00000001", text: "第二张改成竖版", status: "handed", cancellable: true }]);

    steer.take();
    steer.responding.delete("c1");
    steer.controller.sync();
    await flush();
    // Still active in the background: nothing is resolved yet.
    expect(steer.guidance.list).not.toHaveBeenCalled();
    steer.activeRuns.clear();
    steer.controller.sync();
    await flush();
    expect(steer.recorded).toEqual([{ conversationId: "c1", text: "第二张改成竖版" }]);
    expect(steer.sendFollowUp).not.toHaveBeenCalled();
    expect(steer.controller.list("c1")).toEqual([]);
  });

  it("withdraws what the run never took and sends it as the follow-up turn instead", async () => {
    const steer = setup();
    steer.responding.add("c1");
    steer.activeRuns.add(`c1:${RUN}`);
    steer.controller.add("c1", "改用蓝色", { kind: "guidance", runRequestId: RUN });
    await flush();
    steer.controller.add("c1", "字体再大些", { kind: "followup" });
    steer.responding.delete("c1");
    steer.activeRuns.clear();
    steer.controller.sync();
    await flush();
    expect(steer.guidance.cancel).toHaveBeenCalledWith(RUN, "steer-item-00000001");
    expect(steer.server.get("steer-item-00000001")?.status).toBe("cancelled");
    expect(steer.sendFollowUp).toHaveBeenCalledTimes(1);
    expect(steer.sendFollowUp).toHaveBeenCalledWith("c1", "改用蓝色\n字体再大些");
    expect(steer.recorded).toEqual([]);
  });

  it("falls back to the follow-up when the run refuses guidance", async () => {
    const steer = setup();
    steer.responding.add("c1");
    steer.failures.post = new ApiRequestError(409, "AI_RUN_NOT_ACTIVE", "这次任务已结束");
    steer.controller.add("c1", "补充", { kind: "guidance", runRequestId: RUN });
    await flush();
    expect(steer.controller.bubbles("c1")).toMatchObject([{ status: "queued", cancellable: true }]);
    steer.responding.delete("c1");
    steer.controller.sync();
    await flush();
    expect(steer.sendFollowUp).toHaveBeenCalledWith("c1", "补充");
    expect(steer.guidance.list).not.toHaveBeenCalled();
  });

  it("replays a hand-off whose response was lost instead of sending the text twice", async () => {
    const steer = setup();
    steer.responding.add("c1");
    steer.activeRuns.add(`c1:${RUN}`);
    vi.mocked(steer.guidance.post).mockImplementationOnce(async (runRequestId, input) => {
      steer.server.set(input.id, { runRequestId, text: input.text, status: "pending" });
      throw new ApiRequestError(0, "NETWORK_UNAVAILABLE", "网络不可用");
    });
    steer.controller.add("c1", "只要三页", { kind: "guidance", runRequestId: RUN });
    await flush();
    expect(steer.guidance.post).toHaveBeenCalledTimes(2);
    expect(steer.controller.bubbles("c1")).toMatchObject([{ status: "handed" }]);
    steer.take();
    steer.responding.delete("c1");
    steer.activeRuns.clear();
    steer.controller.sync();
    await flush();
    expect(steer.recorded).toEqual([{ conversationId: "c1", text: "只要三页" }]);
    expect(steer.sendFollowUp).not.toHaveBeenCalled();
  });

  it("reconciles a hand-off that stayed unknown when the run ends", async () => {
    const steer = setup();
    steer.responding.add("c1");
    steer.activeRuns.add(`c1:${RUN}`);
    vi.mocked(steer.guidance.post).mockRejectedValueOnce(new ApiRequestError(502, "AI_SERVER_ERROR", "服务暂不可用"))
      .mockRejectedValueOnce(new ApiRequestError(0, "NETWORK_UNAVAILABLE", "网络不可用"));
    steer.controller.add("c1", "改成竖版", { kind: "guidance", runRequestId: RUN });
    await flush();
    expect(steer.controller.bubbles("c1")).toMatchObject([{ status: "handed" }]);
    steer.responding.delete("c1");
    steer.activeRuns.clear();
    steer.controller.sync();
    await flush();
    // The server never stored it, so it goes out as the follow-up turn.
    expect(steer.sendFollowUp).toHaveBeenCalledWith("c1", "改成竖版");
    expect(steer.recorded).toEqual([]);
  });

  it("never auto-sends when it cannot tell whether the run took the text", async () => {
    const steer = setup();
    steer.responding.add("c1");
    steer.activeRuns.add(`c1:${RUN}`);
    steer.controller.add("c1", "只要三页", { kind: "guidance", runRequestId: RUN });
    await flush();
    steer.failures.list = new ApiRequestError(0, "NETWORK_UNAVAILABLE", "网络不可用");
    steer.responding.delete("c1");
    steer.activeRuns.clear();
    steer.controller.sync();
    await flush();
    expect(steer.sendFollowUp).not.toHaveBeenCalled();
    expect(steer.restored).toEqual([{ conversationId: "c1", text: "只要三页", reason: "补充的送达状态暂时无法确认，已放回输入框，请核对后再发送" }]);
  });

  it("withdraws a handed supplement before the run takes it, and refuses once it has", async () => {
    const steer = setup();
    steer.responding.add("c1");
    steer.activeRuns.add(`c1:${RUN}`);
    const first = steer.controller.add("c1", "撤回我", { kind: "guidance", runRequestId: RUN });
    const second = steer.controller.add("c1", "已被读取", { kind: "guidance", runRequestId: RUN });
    await flush();
    if (!first.ok || !second.ok) throw new Error("supplement rejected");
    steer.controller.cancel(first.id);
    await flush();
    expect(steer.server.get(first.id)?.status).toBe("cancelled");
    steer.take();
    steer.controller.cancel(second.id);
    await flush();
    expect(steer.notices).toEqual(["AI 已读取这条补充，无法撤回"]);
    expect(steer.controller.bubbles("c1")).toEqual([{ id: second.id, text: "已被读取", status: "handed", cancellable: true }]);
  });

  it("drops a supplement withdrawn while its hand-off was still in flight", async () => {
    const steer = setup();
    steer.responding.add("c1");
    steer.activeRuns.add(`c1:${RUN}`);
    const open = steer.gatePost();
    const added = steer.controller.add("c1", "发错了", { kind: "guidance", runRequestId: RUN });
    if (!added.ok) throw new Error("supplement rejected");
    steer.controller.cancel(added.id);
    expect(steer.controller.bubbles("c1")).toEqual([]);
    open();
    await flush();
    expect(steer.server.get(added.id)?.status).toBe("cancelled");
    steer.responding.delete("c1");
    steer.activeRuns.clear();
    steer.controller.sync();
    await flush();
    expect(steer.sendFollowUp).not.toHaveBeenCalled();
    expect(steer.recorded).toEqual([]);
  });

  it("uses the follow-up path when the workspace offers no guidance client", async () => {
    const steer = setup({ guidance: false });
    steer.controller.add("c1", "补充", { kind: "guidance", runRequestId: RUN });
    await flush();
    expect(steer.guidance.post).not.toHaveBeenCalled();
    expect(steer.sendFollowUp).toHaveBeenCalledWith("c1", "补充");
  });
});

describe("run guidance client", () => {
  it("calls the account-bound guidance endpoints", async () => {
    const api = vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") return { guidance: { id: "g", status: "pending", createdAt: 1 } };
      if (init?.method === "DELETE") return { guidance: { id: "g", status: "cancelled", createdAt: 1 } };
      return { guidance: [] };
    });
    const client = runGuidanceClient(api as never, "member-a");
    await client.post("run/1", { id: "guidance-000000000001", text: "补充" });
    await client.cancel("run/1", "guidance-000000000001");
    await client.list("run/1");
    expect(api.mock.calls.map(call => [call[0], (call[1] as RequestInit).method ?? "GET", (call[1] as RequestInit).headers])).toEqual([
      ["/api/ai/requests/run%2F1/guidance", "POST", { "X-Tongpin-Account": "member-a" }],
      ["/api/ai/requests/run%2F1/guidance/guidance-000000000001", "DELETE", { "X-Tongpin-Account": "member-a" }],
      ["/api/ai/requests/run%2F1/guidance", "GET", { "X-Tongpin-Account": "member-a" }],
    ]);
    expect(JSON.parse(String((api.mock.calls[0][1] as RequestInit).body))).toEqual({ id: "guidance-000000000001", text: "补充" });
  });
});
