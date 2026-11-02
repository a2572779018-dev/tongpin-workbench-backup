type Api = <T>(path: string, init?: RequestInit) => Promise<T>;
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
  const handledIds: string[] = [], errors: string[] = [];
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
        if (taskIds.some(id => !handled.has(id))) errors.push(`${sourceDate}：任务已更新，请刷新后重试`);
      } catch (error) { errors.push(`${sourceDate}：${error instanceof Error ? error.message : "同步失败，请重试"}`); }
    }
  }
  const handled = new Set(handledIds);
  return { handledIds: [...handled], failedIds: [...new Set(tasks.map(task => task.id))].filter(id => !handled.has(id)), createdCount, errors, targetDate };
}
