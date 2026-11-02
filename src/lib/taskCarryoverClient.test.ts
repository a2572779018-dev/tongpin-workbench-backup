import { describe, expect, it } from "vitest";
import { syncPastTaskGroups } from "./taskCarryoverClient";

describe("history batch result reconciliation", () => {
  it("keeps the failed date selected, without resending an earlier successful date", async () => {
    const input = [{ id: "a", date: "2026-10-30" }, { id: "b", date: "2026-10-20" }];
    const result = await syncPastTaskGroups(async <T>(_path: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      if (request.sourceDate === "2026-10-20") throw new Error("暂时失败");
      return { targetDate: "2026-11-02", created: [{ sourceTaskId: "a" }], skippedTaskIds: [], rejectedTaskIds: [] } as T;
    }, input, "account-a");
    expect(result.handledIds).toEqual(["a"]); expect(result.failedIds).toEqual(["b"]); expect(result.createdCount).toBe(1);
    expect(result.errors[0]).toContain("暂时失败");
  });
  it("never marks rejected ids, foreign returned ids or a missing result as successful", async () => {
    const result = await syncPastTaskGroups(async <T>() => ({ targetDate: "2026-11-02", created: [{ sourceTaskId: "foreign" }], skippedTaskIds: ["a"], rejectedTaskIds: ["b"] }) as T, [{ id: "a", date: "2026-10-30" }, { id: "b", date: "2026-10-30" }], "account-a");
    expect(result.handledIds).toEqual(["a"]); expect(result.failedIds).toEqual(["b"]); expect(result.createdCount).toBe(0);
  });
  it("chunks at 100 and deduplicates selected ids without losing results", async () => {
    let largest = 0;
    const records = Array.from({ length: 101 }, (_, n) => ({ id: String(n), date: "2026-10-30" }));
    const result = await syncPastTaskGroups(async <T>(_path: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)); largest = Math.max(largest, request.taskIds.length);
      return { targetDate: "2026-11-02", created: request.taskIds.map((sourceTaskId: string) => ({ sourceTaskId })), skippedTaskIds: [], rejectedTaskIds: [] } as T;
    }, [...records, records[0]], "account-a");
    expect(largest).toBe(100); expect(result.createdCount).toBe(101); expect(result.handledIds).toHaveLength(101); expect(result.failedIds).toEqual([]);
  });
  it("binds every date group to the starting account so auth rejects a switched session before transport", async () => {
    const accounts: (string | null)[] = [];
    await syncPastTaskGroups(async <T>(_path: string, init?: RequestInit) => {
      accounts.push(new Headers(init?.headers).get("X-Tongpin-Account"));
      return { targetDate: "2026-11-02", created: [], skippedTaskIds: JSON.parse(String(init?.body)).taskIds, rejectedTaskIds: [] } as T;
    }, [{ id: "a", date: "2026-10-30" }, { id: "b", date: "2026-10-20" }], "account-a");
    expect(accounts).toEqual(["account-a", "account-a"]);
  });
});
