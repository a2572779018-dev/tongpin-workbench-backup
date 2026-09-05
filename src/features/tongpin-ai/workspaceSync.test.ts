import { describe, expect, it, vi } from "vitest";
import type { AiWorkspaceSaveRequest, AiWorkspaceSnapshot, AiWorkspaceState } from "../../../shared/aiWorkspace";
import { ApiRequestError } from "../../lib/api";
import { WorkspaceSaveQueue, workspaceSaveOptions } from "./workspaceSync";

function state(title = "项目"): AiWorkspaceState {
  return { view: "project", mode: "quick", projects: [{ id: "project-a", title, timeLabel: "刚刚" }], conversations: [], artifacts: [], drafts: {}, activeProjectId: "project-a", activeConversationId: null, enabledSkillIds: [] };
}
function initial(value: AiWorkspaceState | null = null): AiWorkspaceSnapshot {
  return { revision: value ? 4 : 0, schemaVersion: 1, updatedAt: value ? "2026-09-05T00:00:00Z" : null, state: value };
}
function acknowledge(request: AiWorkspaceSaveRequest): AiWorkspaceSnapshot {
  return { revision: request.expectedRevision + 1, schemaVersion: 1, updatedAt: "2026-09-05T01:00:00Z", state: JSON.parse(JSON.stringify(request.state)) as AiWorkspaceState };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

describe("workspace serialized save queue", () => {
  it("does not write an unchanged snapshot and does not retain mutable caller references", async () => {
    const baseline = state(); const write = vi.fn(async (body: AiWorkspaceSaveRequest) => acknowledge(body));
    const queue = new WorkspaceSaveQueue(initial(baseline), write, vi.fn());
    baseline.projects[0].title = "外部改动";
    expect(queue.isDirty()).toBe(false);
    queue.setState(state()); await queue.flush();
    expect(write).not.toHaveBeenCalled();
  });
  it("writes sequential revisions, coalesces intermediate edits, and shares one in-flight promise", async () => {
    const first = deferred<AiWorkspaceSnapshot>();
    const write = vi.fn<(body: AiWorkspaceSaveRequest) => Promise<AiWorkspaceSnapshot>>().mockImplementationOnce(() => first.promise).mockImplementation(async body => acknowledge(body));
    const changed = vi.fn(); const queue = new WorkspaceSaveQueue(initial(), write, changed);
    queue.setState(state("甲")); const flight = queue.flush();
    expect(queue.flush()).toBe(flight); await Promise.resolve();
    queue.setState(state("乙")); queue.setState(state("丙"));
    expect(write).toHaveBeenCalledTimes(1);
    first.resolve(acknowledge(write.mock.calls[0][0])); await flight;
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls.map(([body]) => [body.expectedRevision, body.state.projects[0].title])).toEqual([[0, "甲"], [1, "丙"]]);
    expect(queue.isDirty()).toBe(false); expect(changed).toHaveBeenLastCalledWith("saved");
  });
  it("keeps the pending snapshot immutable if a caller mutates its object", async () => {
    const response = deferred<AiWorkspaceSnapshot>(); const write = vi.fn((_body: AiWorkspaceSaveRequest) => response.promise);
    const queue = new WorkspaceSaveQueue(initial(), write, vi.fn()); const desired = state("原始");
    queue.setState(desired); desired.projects[0].title = "篡改"; await Promise.resolve();
    const body = write.mock.calls[0][0] as unknown as AiWorkspaceSaveRequest;
    expect(body.state.projects[0].title).toBe("原始");
    response.resolve(acknowledge(body)); await queue.flush(); expect(queue.isDirty()).toBe(false);
  });
  it("retries unknown results with the exact UUID and body before sending newer edits", async () => {
    const write = vi.fn<(body: AiWorkspaceSaveRequest) => Promise<AiWorkspaceSnapshot>>().mockRejectedValueOnce(new ApiRequestError(0, "NETWORK_UNAVAILABLE", "网络中断")).mockImplementation(async body => acknowledge(body));
    const queue = new WorkspaceSaveQueue(initial(), write, vi.fn());
    expect(await queue.saveNow(state("首次"))).toBe(false);
    const unknown = JSON.stringify(write.mock.calls[0][0]);
    queue.setState(state("稍后修改")); expect(write).toHaveBeenCalledTimes(1);
    await queue.flush();
    expect(JSON.stringify(write.mock.calls[1][0])).toBe(unknown);
    expect(write.mock.calls[2][0].mutationId).not.toBe(write.mock.calls[0][0].mutationId);
    expect(write.mock.calls[2][0]).toMatchObject({ expectedRevision: 1, state: { projects: [{ title: "稍后修改" }] } });
    expect(queue.isDirty()).toBe(false);
  });
  it.each(["NETWORK_UNAVAILABLE", "INVALID_RESPONSE", "AI_WORKSPACE_ERROR", "REQUEST_FAILED"])("keeps uncertain %s pending until explicit retry", async code => {
    const write = vi.fn<(body: AiWorkspaceSaveRequest) => Promise<AiWorkspaceSnapshot>>().mockRejectedValueOnce(new ApiRequestError(502, code, "暂时不可用")).mockImplementation(async body => acknowledge(body));
    const queue = new WorkspaceSaveQueue(initial(), write, vi.fn());
    expect(await queue.saveNow(state())).toBe(false); const request = write.mock.calls[0][0];
    queue.setState(state("修改后")); await Promise.resolve(); expect(write).toHaveBeenCalledTimes(1);
    await queue.flush(); expect(write.mock.calls[1][0]).toBe(request);
  });
  it.each(["AI_WORKSPACE_CONFLICT", "AI_WORKSPACE_MUTATION_CONFLICT", "AI_WORKSPACE_VERSION_UNSUPPORTED", "AI_WORKSPACE_ACCOUNT_CHANGED", "AI_ACCOUNT_CHANGED"])("freezes %s without overwriting or retrying into another account", async code => {
    const changed = vi.fn(); const write = vi.fn(async () => { throw new ApiRequestError(409, code, "冲突"); });
    const queue = new WorkspaceSaveQueue(initial(), write, changed);
    expect(await queue.saveNow(state())).toBe(false);
    queue.setState(state("不能覆盖")); await queue.flush();
    expect(await queue.saveNow(state("仍不能覆盖"))).toBe(false);
    expect(write).toHaveBeenCalledTimes(1); expect(changed.mock.calls.at(-1)?.[0]).toBe("conflict"); expect(queue.isDirty()).toBe(true);
  });
  it("freezes a replay acknowledgement whose revision jumped beyond this mutation", async () => {
    const changed = vi.fn(); const write = vi.fn(async (body: AiWorkspaceSaveRequest) => ({ ...acknowledge(body), revision: body.expectedRevision + 2 }));
    const queue = new WorkspaceSaveQueue(initial(), write, changed);
    expect(await queue.saveNow(state())).toBe(false); await queue.flush();
    expect(write).toHaveBeenCalledTimes(1); expect(changed.mock.calls.at(-1)?.[0]).toBe("conflict");
  });
  it("does not claim saved if the server acknowledges different content", async () => {
    const changed = vi.fn(); const write = vi.fn(async (body: AiWorkspaceSaveRequest) => ({ ...acknowledge(body), state: state("不属于本次保存") }));
    const queue = new WorkspaceSaveQueue(initial(), write, changed);
    expect(await queue.saveNow(state())).toBe(false); expect(changed.mock.calls.at(-1)?.[0]).toBe("conflict");
  });
  it.each(["AI_WORKSPACE_INVALID", "AI_WORKSPACE_TOO_LARGE"])("allows correcting a definitively rejected %s snapshot with a new UUID", async code => {
    const write = vi.fn<(body: AiWorkspaceSaveRequest) => Promise<AiWorkspaceSnapshot>>().mockRejectedValueOnce(new ApiRequestError(400, code, "请修正内容")).mockImplementation(async body => acknowledge(body));
    const queue = new WorkspaceSaveQueue(initial(), write, vi.fn());
    expect(await queue.saveNow(state("错误内容"))).toBe(false);
    expect(await queue.saveNow(state("修正后内容"))).toBe(true);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1][0].expectedRevision).toBe(0);
    expect(write.mock.calls[1][0].mutationId).not.toBe(write.mock.calls[0][0].mutationId);
    expect(write.mock.calls[1][0].state.projects[0].title).toBe("修正后内容");
  });
  it("can stage edits without writing, then flush immediately before generation", async () => {
    const write = vi.fn(async (body: AiWorkspaceSaveRequest) => acknowledge(body)); const generate = vi.fn();
    const queue = new WorkspaceSaveQueue(initial(), write, vi.fn());
    expect(queue.setState(state(), { flush: false })).toBe(true);
    expect(write).not.toHaveBeenCalled();
    if (await queue.saveNow(state())) generate();
    expect(write).toHaveBeenCalledTimes(1); expect(generate).toHaveBeenCalledTimes(1);
  });
  it("does not allow a generation after saving fails", async () => {
    const generate = vi.fn(); const write = vi.fn(async () => { throw new ApiRequestError(0, "NETWORK_UNAVAILABLE", "离线"); });
    const queue = new WorkspaceSaveQueue(initial(), write, vi.fn());
    if (await queue.saveNow(state())) generate();
    expect(generate).not.toHaveBeenCalled(); expect(queue.isDirty()).toBe(true);
  });
  it("flushSaved waits for the latest edit without replacing it with a stale event snapshot", async () => {
    const response = deferred<AiWorkspaceSnapshot>();
    const write = vi.fn<(body: AiWorkspaceSaveRequest) => Promise<AiWorkspaceSnapshot>>().mockImplementationOnce(() => response.promise).mockImplementation(async body => acknowledge(body));
    const queue = new WorkspaceSaveQueue(initial(), write, vi.fn());
    queue.setState(state("点击时")); const saved = queue.flushSaved(); await Promise.resolve();
    queue.setState(state("等待时的新修改"), { flush: false });
    response.resolve(acknowledge(write.mock.calls[0][0]));
    expect(await saved).toBe(true);
    expect(write.mock.calls.at(-1)?.[0].state.projects[0].title).toBe("等待时的新修改");
  });
  it("does not launch parallel writes when an adapter synchronously stages more state", async () => {
    let queue!: WorkspaceSaveQueue;
    const write = vi.fn(async (body: AiWorkspaceSaveRequest) => {
      if (body.expectedRevision === 0) queue.setState(state("同步适配器追加"));
      return acknowledge(body);
    });
    queue = new WorkspaceSaveQueue(initial(), write, vi.fn());
    expect(await queue.saveNow(state("最初"))).toBe(true);
    expect(write.mock.calls.map(([body]) => body.expectedRevision)).toEqual([0, 1]);
  });
  it("builds a serialized request bound to the originating member id", () => {
    const body = { expectedRevision: 0, mutationId: crypto.randomUUID(), state: state() };
    const options = workspaceSaveOptions("member-origin", body);
    body.state.projects[0].title = "后来的修改";
    expect(options.method).toBe("PUT");
    expect(new Headers(options.headers).get("X-Tongpin-Account")).toBe("member-origin");
    expect(JSON.parse(String(options.body)).state.projects[0].title).toBe("项目");
    expect(new Headers(options.headers).has("Authorization")).toBe(false);
  });
});
