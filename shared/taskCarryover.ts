export interface CarryoverRef {
  id: string;
  userId: string;
  date: string;
  status: string;
  sourceTaskId: string | null;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
}

export interface CarryoverStateEvent { taskId: string; userId: string; action: string; createdAt: string }

/** Deleted snapshots are lineage links only, never candidates for recreation. */
export function indexTaskCarryover<T extends CarryoverRef>(tasks: T[], deleted: CarryoverRef[], userId: string, events: CarryoverStateEvent[] = []) {
  const valid = (task: CarryoverRef) => task && task.userId === userId && typeof task.id === "string" && typeof task.date === "string" && (task.sourceTaskId === null || typeof task.sourceTaskId === "string");
  const own = tasks.filter(valid);
  const links = new Map([...deleted, ...own].filter(valid).map(task => [task.id, task]));
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
  // A completion closes the whole continuation, even when an older copy is
  // still todo. Only a real done -> todo/doing audit can open a new generation.
  type State = { taskId: string; action: string; createdAt: string; order: number };
  const states = new Map<string, State>(), completions = new Map<string, State>();
  const reliable = events.filter(event => event && event.userId === userId && links.has(event.taskId) && Number.isFinite(Date.parse(event.createdAt)));
  const auditedCompletions = new Set(reliable.filter(event => event.action === "completed").map(event => event.taskId));
  const births = new Map<string, State>();
  const put = (state: State) => {
    const root = rootOf(state.taskId), previous = states.get(root);
    const newer = (a: State, b?: State) => !b || a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.order > b.order);
    if (newer(state, previous)) states.set(root, state);
    if (state.action === "completed" && newer(state, completions.get(root))) completions.set(root, state);
  };
  for (const task of links.values()) if (task.status === "done" && (task.completedAt || !auditedCompletions.has(task.id))) put({ taskId: task.id, action: "completed", createdAt: task.completedAt ?? task.updatedAt ?? "", order: -1 });
  reliable.forEach((event, order) => {
    if (["created", "carried_over"].includes(event.action)) births.set(event.taskId, { ...event, order });
    if (["completed", "reopened"].includes(event.action)) put({ ...event, order });
  });
  const isCurrent = (task: CarryoverRef) => {
    const state = states.get(rootOf(task.id));
    if (!state) return true;
    if (state.action === "completed") return false;
    if (task.id === state.taskId) return true;
    if (!task.createdAt || task.createdAt < state.createdAt) return false;
    const birth = births.get(task.id);
    if (task.createdAt === state.createdAt && birth && birth.order < state.order) return false;
    let parent = task.sourceTaskId;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      if (parent === state.taskId) return true;
      seen.add(parent); parent = links.get(parent)?.sourceTaskId ?? null;
    }
    return false;
  };
  const covered = new Set([...links.values()].filter(isCurrent).flatMap(task => task.sourceTaskId ? [task.sourceTaskId] : []));
  const latest = new Map<string, T>();
  for (const task of own) {
    if (!isCurrent(task) || covered.has(task.id)) continue;
    const root = rootOf(task.id), previous = latest.get(root);
    const order = previous ? task.date.localeCompare(previous.date)
      || (task.updatedAt ?? task.createdAt ?? "").localeCompare(previous.updatedAt ?? previous.createdAt ?? "")
      || (task.createdAt ?? "").localeCompare(previous.createdAt ?? "") || task.id.localeCompare(previous.id) : 1;
    if (order > 0) latest.set(root, task);
  }
  return { own, rootOf, latest, userId, isCurrent, completions };
}

/** Repair only today's obsolete continuation copies; never delete history or
 * change unrelated, independently created same-title tasks. */
export function completedCarryoverCopies<T extends CarryoverRef>(index: ReturnType<typeof indexTaskCarryover<T>>, today: string) {
  return index.own.filter(task => task.date === today && task.sourceTaskId && task.status !== "done" && !index.isCurrent(task))
    .flatMap(task => { const completion = index.completions.get(index.rootOf(task.id)); return completion ? [{ task, completedAt: completion.createdAt || null }] : []; });
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
  const todayRoots = new Set(index.own.filter(task => task.date === today && (index.isCurrent(task) || (task.status === "done" && !index.latest.has(index.rootOf(task.id))))).map(task => index.rootOf(task.id)));
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

/** A historical card may point to a later unfinished copy. The write API still
 * accepts only the effective source and revalidates it at commit time. */
export function dayCarryoverStatus<T extends CarryoverRef>(index: ReturnType<typeof indexTaskCarryover<T>>, dayTasks: CarryoverRef[], sourceDate: string, today: string) {
  const { skippedTaskIds, rejectedTaskIds } = classifyTaskCarryover(index, dayTasks.map(task => task.id), sourceDate, today);
  const rejected = new Set(rejectedTaskIds);
  const continuationSources: Record<string, { id: string; date: string }> = {};
  for (const task of dayTasks) {
    if (!rejected.has(task.id) || task.userId !== index.userId || task.status === "done" || !index.isCurrent(task)) continue;
    const current = index.latest.get(index.rootOf(task.id));
    if (current && current.id !== task.id && current.date < today && current.status !== "done") {
      continuationSources[task.id] = { id: current.id, date: current.date };
    }
  }
  // Older clients only understand the original unavailable list.
  return { syncedTaskIds: skippedTaskIds, unavailableTaskIds: rejectedTaskIds, continuationSources };
}
