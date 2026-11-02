export interface CarryoverRef {
  id: string;
  userId: string;
  date: string;
  status: string;
  sourceTaskId: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/** Deleted snapshots are lineage links only, never candidates for recreation. */
export function indexTaskCarryover<T extends CarryoverRef>(tasks: T[], deleted: CarryoverRef[], userId: string) {
  const valid = (task: CarryoverRef) => task && task.userId === userId && typeof task.id === "string" && typeof task.date === "string" && (task.sourceTaskId === null || typeof task.sourceTaskId === "string");
  const own = tasks.filter(valid);
  const links = new Map([...deleted, ...own].filter(valid).map(task => [task.id, task]));
  const covered = new Set([...links.values()].flatMap(task => task.sourceTaskId ? [task.sourceTaskId] : []));
  const roots = new Map<string, string>();
  const rootOf = (id: string): string => {
    const path: string[] = [], seen = new Set<string>();
    let current = id;
    while (true) {
      if (roots.has(current)) { current = roots.get(current)!; break; }
      if (seen.has(current)) { current = `cycle:${[...seen].sort()[0]}`; break; }
      seen.add(current); path.push(current);
      const parent = links.get(current)?.sourceTaskId;
      if (!parent) break;
      current = parent;
    }
    for (const item of path) roots.set(item, current);
    return current;
  };
  const latest = new Map<string, T>();
  for (const task of own) {
    if (covered.has(task.id)) continue;
    const root = rootOf(task.id), previous = latest.get(root);
    const order = previous ? task.date.localeCompare(previous.date)
      || (task.updatedAt ?? task.createdAt ?? "").localeCompare(previous.updatedAt ?? previous.createdAt ?? "")
      || (task.createdAt ?? "").localeCompare(previous.createdAt ?? "") || task.id.localeCompare(previous.id) : 1;
    if (order > 0) latest.set(root, task);
  }
  return { own, rootOf, latest, userId };
}

export function taskBacklogPage<T extends CarryoverRef>(index: ReturnType<typeof indexTaskCarryover<T>>, today: string, limit: number, cursor = "") {
  const all = [...index.latest.values()].filter(task => task.date < today && task.status !== "done")
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  const remaining = cursor ? all.filter(task => {
    const [, , date, id] = cursor.split("/");
    return task.date < date || (task.date === date && task.id > id);
  }) : all;
  const tasks = remaining.slice(0, limit), last = tasks.at(-1);
  return { targetDate: today, tasks, total: all.length, nextCursor: remaining.length > tasks.length && last ? `${index.userId}/${today}/${last.date}/${last.id}` : null };
}

/** A stale request may only create the effective unfinished leaf. */
export function classifyTaskCarryover<T extends CarryoverRef>(index: ReturnType<typeof indexTaskCarryover<T>>, taskIds: string[], sourceDate: string, today: string) {
  const todayRoots = new Set(index.own.filter(task => task.date === today).map(task => index.rootOf(task.id)));
  const eligible: T[] = [], skippedTaskIds: string[] = [], rejectedTaskIds: string[] = [];
  for (const id of new Set(taskIds)) {
    const task = index.own.find(item => item.id === id);
    if (!task || task.date !== sourceDate || task.date >= today || task.status === "done") { rejectedTaskIds.push(id); continue; }
    const root = index.rootOf(id);
    if (todayRoots.has(root)) { skippedTaskIds.push(id); continue; }
    if (index.latest.get(root)?.id !== id) { rejectedTaskIds.push(id); continue; }
    eligible.push(task); todayRoots.add(root);
  }
  return { eligible, skippedTaskIds, rejectedTaskIds };
}
