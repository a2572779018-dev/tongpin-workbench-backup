import { describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "./api";
import { readTaskDay } from "./readTaskDay";
import { TaskReconcileGate } from "./taskReconcile";

const date = "2026-11-24";
const source = { id: "copy", sourceTaskId: "prior", status: "todo" };
const independent = { id: "plain", sourceTaskId: null, status: "todo" };
const finished = { ...source, status: "done" };

describe("daily task read and carryover verification", () => {
  it.each([
    [date, [independent, finished]],
    ["2026-10-24", [source]],
  ] as const)("reads %s without an unnecessary correction", async (day, tasks) => {
    const api = vi.fn().mockResolvedValue({ tasks });
    await expect(readTaskDay(api, new TaskReconcileGate(), "me", day, date)).resolves.toEqual({ tasks, issue: null });
    expect(api.mock.calls).toEqual([[`/api/tasks?date=${day}`, { headers: { "X-Tongpin-Account": "me" } }]]);
  });

  it("retains the readable list when correction fails, then verifies and re-reads the committed result", async () => {
    const gate = new TaskReconcileGate();
    const api = vi.fn()
      .mockResolvedValueOnce({ tasks: [source] })
      .mockRejectedValueOnce(new ApiRequestError(0, "NETWORK_UNAVAILABLE", "network"))
      .mockResolvedValueOnce({ tasks: [source] })
      .mockResolvedValueOnce({ tasks: [finished] })
      .mockResolvedValueOnce({ tasks: [finished] });
    await expect(readTaskDay(api, gate, "me", date, date)).resolves.toMatchObject({
      tasks: [source], issue: { transient: true, message: "历史任务承接状态待核实" },
    });
    expect(gate.isVerified(`me/${date}`)).toBe(false);
    await expect(readTaskDay(api, gate, "me", date, date)).resolves.toEqual({ tasks: [finished], issue: null });
    expect(api.mock.calls[3]).toEqual(["/api/tasks/reconcile-carryover", { method: "POST", headers: { "X-Tongpin-Account": "me" }, body: "{}" }]);
  });

  it("avoids a second list download for an active copy that required no correction", async () => {
    const gate = new TaskReconcileGate();
    const api = vi.fn().mockResolvedValueOnce({ tasks: [source] }).mockResolvedValueOnce({ tasks: [] });
    await expect(readTaskDay(api, gate, "me", date, date)).resolves.toEqual({ tasks: [source], issue: null });
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("re-reads a slow snapshot taken before a concurrent correction committed", async () => {
    const gate = new TaskReconcileGate();
    let finishRead!: (value: { tasks: typeof source[] }) => void;
    const slow = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }))
      .mockResolvedValueOnce({ tasks: [finished] });
    const pending = readTaskDay(slow, gate, "me", date, date);
    await gate.ensure(`me/${date}`, async () => true);
    finishRead({ tasks: [source] });
    await expect(pending).resolves.toEqual({ tasks: [finished], issue: null });
    expect(slow.mock.calls[1][0]).toBe(`/api/tasks?date=${date}`);
  });

  it("propagates a failed primary read; no empty list or successful mutation is synthesized", async () => {
    const failure = new Error("list unavailable");
    const api = vi.fn().mockRejectedValue(failure);
    await expect(readTaskDay(api, new TaskReconcileGate(), "me", date, date)).rejects.toBe(failure);
    expect(api).toHaveBeenCalledTimes(1);
  });
});
