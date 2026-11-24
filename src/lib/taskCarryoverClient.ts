type Api = <T>(path: string, init?: RequestInit) => Promise<T>;
export interface TaskSource { id: string; date: string }
export interface DayCarryoverResponse {
  tasks: (TaskSource & { status: string })[];
  syncedTaskIds: string[];
  unavailableTaskIds?: string[];
  continuationSources?: Record<string, TaskSource>;
}

export function daySelectionSources(result: DayCarryoverResponse) {
  const synced = new Set(result.syncedTaskIds), unavailable = new Set(result.unavailableTaskIds);
  const sources = new Map<string, TaskSource>();
  for (const task of result.tasks) {
    if (task.status === "done" || synced.has(task.id)) continue;
    const continuation = result.continuationSources?.[task.id];
    if (continuation) sources.set(task.id, continuation);
    else if (!unavailable.has(task.id)) sources.set(task.id, { id: task.id, date: task.date });
  }
  return sources;
}

interface SyncResult {
  targetDate: string;
  created: { sourceTaskId: string | null }[];
  skippedTaskIds: string[];
  rejectedTaskIds: string[];
}

/** Each date is its own idempotent batch. Never claim rejected/unsent ids succeeded. */
export async function syncPastTaskGroups(api: Api, tasks: { id: string; date: string }[], accountId: string) {
  const groups = new Map<string, Set<string>>();
  for (const task of tasks) {
    if (!groups.has(task.date)) groups.set(task.date, new Set());
    groups.get(task.date)!.add(task.id);
  }
  const handledIds: string[] = [], rejectedIds: string[] = [], errors: string[] = [];
  let createdCount = 0, targetDate = "";
  for (const [sourceDate, ids] of groups) {
    const all = [...ids];
    for (let offset = 0; offset < all.length; offset += 100) {
      const taskIds = all.slice(offset, offset + 100), requested = new Set(taskIds);
      try {
        const result = await api<SyncResult>("/api/tasks/sync-to-today", { method: "POST", headers: { "X-Tongpin-Account": accountId }, body: JSON.stringify({ sourceDate, taskIds }) });
        targetDate = result.targetDate;
        const created = new Set(result.created.map(task => task.sourceTaskId).filter((id): id is string => Boolean(id) && requested.has(id!)));
        const handled = new Set([...created, ...result.skippedTaskIds.filter(id => requested.has(id))]);
        handledIds.push(...handled); createdCount += created.size;
        const rejected = new Set(result.rejectedTaskIds.filter(id => requested.has(id) && !handled.has(id)));
        rejectedIds.push(...rejected);
        if (rejected.size) errors.push(`${sourceDate} 有 ${rejected.size} 项状态已变更，已移出选择`);
        if (taskIds.some(id => !handled.has(id) && !rejected.has(id))) errors.push(`${sourceDate}：部分任务未返回结果，请重试`);
      } catch (error) { errors.push(`${sourceDate}：${error instanceof Error ? error.message : "同步失败，请重试"}`); }
    }
  }
  const handled = new Set(handledIds);
  return { handledIds: [...handled], rejectedIds, failedIds: [...new Set(tasks.map(task => task.id))].filter(id => !handled.has(id)), createdCount, errors, targetDate };
}
