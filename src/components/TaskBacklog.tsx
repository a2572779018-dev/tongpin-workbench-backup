import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { CalendarDays, X } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useNoticeCenter } from "./NoticeCenter";
import { daySelectionSources, syncPastTaskGroups, type DayCarryoverResponse, type TaskSource } from "../lib/taskCarryoverClient";
import { addDays, toDateKey } from "../lib/date";
import type { Task } from "../types";
import "./task-backlog.css";

interface BacklogPage { tasks: Task[]; targetDate: string; total: number; nextCursor: string | null }
export function TaskBacklog({ onViewDate, selected, setSelected, businessToday, submitting }: {
  onViewDate: (date: string) => void;
  businessToday: string;
  submitting: boolean;
  selected: Map<string, TaskSource>;
  setSelected: Dispatch<SetStateAction<Map<string, TaskSource>>>;
}) {
  const { api, session } = useAuth(), { notify } = useNoticeCenter();
  const [page, setPage] = useState<BacklogPage>({ tasks: [], targetDate: "", total: 0, nextCursor: null });
  const [open, setOpen] = useState(false), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const [knownDays, setKnownDays] = useState<Record<string, TaskSource[]>>({});
  const [jumpDate, setJumpDate] = useState("");
  const [error, setError] = useState("");
  const state = useRef({ open, busy }), requestId = useRef(0), alive = useRef(true), dialog = useRef<HTMLElement>(null);
  state.current = { open, busy };
  const load = useCallback(async (cursor = "") => {
    const id = ++requestId.current;
    setLoading(true); setError("");
    try {
      const result = await api<BacklogPage>(`/api/tasks/backlog?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (!alive.current || id !== requestId.current) return;
      setPage(previous => ({ ...result, tasks: cursor ? [...new Map([...previous.tasks, ...result.tasks].map(task => [task.id, task])).values()] : result.tasks }));
      if (!cursor) setKnownDays({});
    } catch (caught) { if (alive.current && id === requestId.current) setError(caught instanceof Error ? caught.message : "往日任务加载失败"); }
    finally { if (alive.current && id === requestId.current) setLoading(false); }
  }, [api]);
  useEffect(() => {
    alive.current = true; void load();
    const refresh = () => { if (!state.current.open && !state.current.busy && document.visibilityState === "visible") void load(); };
    window.addEventListener("focus", refresh); window.addEventListener("tongpin:task-sync", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { alive.current = false; requestId.current++; window.removeEventListener("focus", refresh); window.removeEventListener("tongpin:task-sync", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [load, session?.user.id]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !state.current.busy) { setOpen(false); return; }
      if (event.key !== "Tab") return;
      const items = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)') ?? [])];
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keyboard);
    return () => { document.removeEventListener("keydown", keyboard); if (previous?.isConnected) previous.focus(); };
  }, [open]);
  async function sync() {
    if (state.current.busy || selected.size === 0) return;
    state.current.busy = true; setBusy(true); setError("");
    const generation = requestId.current;
    try {
      const result = await syncPastTaskGroups(api, [...selected.values()], session!.user.id);
      if (!alive.current || requestId.current !== generation) return;
      const handled = new Set(result.handledIds);
      const settled = new Set([...handled, ...result.rejectedIds]);
      setSelected(previous => new Map([...previous].filter(([id]) => !settled.has(id))));
      setKnownDays({});
      setPage(previous => ({ ...previous, targetDate: result.targetDate || previous.targetDate, tasks: previous.tasks.filter(task => !settled.has(task.id)), total: Math.max(0, previous.total - settled.size) }));
      setError(result.errors.join("；"));
      if (handled.size) {
        window.dispatchEvent(new Event("tongpin:task-sync"));
        notify({ title: result.createdCount ? `已结转至今日 ${result.createdCount} 项` : "任务已在今日清单", body: "", tone: "success", duration: 5000,
          actions: [{ label: "查看今日", onSelect: () => { setOpen(false); onViewDate(result.targetDate || page.targetDate); } }] });
      }
    } finally { if (alive.current) { state.current.busy = false; setBusy(false); } }
  }
  const groups = new Map<string, Task[]>();
  for (const task of page.tasks) {
    const rows = groups.get(task.date);
    if (rows) rows.push(task);
    else groups.set(task.date, [task]);
  }
  const lastDate = page.tasks.at(-1)?.date;
  const completeRows = (date: string, visible: Task[]) => knownDays[date] ?? (date === lastDate && page.nextCursor ? null : visible);
  function selectRows(rows: TaskSource[], checked: boolean) {
    setSelected(previous => {
      const next = new Map(previous);
      for (const row of rows) {
        if (checked) next.set(row.id, { id: row.id, date: row.date });
        else next.delete(row.id);
      }
      return next;
    });
  }
  async function toggleDay(date: string, visible: Task[]) {
    if (state.current.busy) return;
    let rows = completeRows(date, visible);
    if (!rows) {
      state.current.busy = true; setBusy(true); setError("");
      try {
        // A date can span several backlog pages. Fetch just that date once.
        const day = await api<DayCarryoverResponse>(`/api/tasks/sync-to-today?sourceDate=${date}`,
          { headers: { "X-Tongpin-Account": session!.user.id } });
        if (!alive.current) return;
        rows = [...daySelectionSources(day)].filter(([id, source]) => id === source.id).map(([, source]) => source);
        const dayRows = rows;
        setKnownDays(current => ({ ...current, [date]: dayRows }));
        const liveIds = new Set(rows.map(source => source.id));
        const removedIds = new Set(visible.filter(task => !liveIds.has(task.id)).map(task => task.id));
        if (removedIds.size) {
          setPage(current => ({ ...current, tasks: current.tasks.filter(task => !removedIds.has(task.id)), total: Math.max(0, current.total - removedIds.size) }));
          setSelected(current => new Map([...current].filter(([, source]) => source.date !== date || liveIds.has(source.id))));
        }
      } catch (caught) {
        if (alive.current) setError(caught instanceof Error ? caught.message : "当日待办读取失败");
        return;
      } finally {
        if (alive.current) { state.current.busy = false; setBusy(false); }
      }
    }
    selectRows(rows, !rows.every(row => selected.has(row.id)));
  }
  const allVisibleSelected = page.tasks.length > 0 && page.tasks.every(task => selected.has(task.id));
  function viewDate(date: string) {
    if (!date || state.current.busy) return;
    setOpen(false); onViewDate(date);
  }
  return <>
    <div className="task-backlog-entry">
      <button type="button" disabled={submitting} onClick={() => { setOpen(true); if (!state.current.busy && !loading) void load(); }} aria-label={`往日未完成 ${page.total} 项`}><CalendarDays size={17} />往日未完成 <b>{loading && !page.tasks.length ? "…" : error && !open ? "重试" : page.total}</b></button>
    </div>
    {open && <div className="task-backlog-overlay" onClick={event => { if (event.target === event.currentTarget && !state.current.busy) setOpen(false); }}>
      <section ref={dialog} className="task-backlog-panel" role="dialog" aria-modal="true" aria-labelledby="task-backlog-title">
        <header><h2 id="task-backlog-title">往日未完成 <small>{page.total}</small></h2><button type="button" aria-label="关闭往日未完成" disabled={busy} onClick={() => setOpen(false)}><X size={20} /></button></header>
        <div className="task-backlog-toolbar">
          <input aria-label="历史任务日期" type="date" value={jumpDate}
            max={toDateKey(addDays(businessToday, -1))}
            onChange={event => setJumpDate(event.target.value)} />
          <button type="button" disabled={busy || !jumpDate || jumpDate >= businessToday} onClick={() => viewDate(jumpDate)}>查看当日</button>
          <button type="button" disabled={busy || loading} onClick={() => void load()}>刷新</button>
        </div>
        <div className="task-backlog-toolbar">
          <button type="button" disabled={busy || loading || !page.tasks.length} onClick={() => selectRows(page.tasks, !allVisibleSelected)}>{allVisibleSelected ? "取消选择已加载项" : `全选已加载项（${page.tasks.length}）`}</button>
          <span>已选 {selected.size} 项</span>
        </div>
        {error && <div className="inline-error" role="alert">{error}</div>}
        <div className="task-backlog-list">{[...groups].map(([date, tasks]) => {
          const rows = completeRows(date, tasks);
          const allSelected = rows && rows.length > 0 && rows.every(task => selected.has(task.id));
          return <section key={date}>
            <div className="task-backlog-day">
              <h3><button type="button" disabled={busy} aria-label={`查看 ${date} 的任务`} onClick={() => viewDate(date)}>{date}</button></h3>
              <button type="button" aria-label={`${allSelected ? "取消全选" : "全选"} ${date}`} disabled={busy || loading} onClick={() => void toggleDay(date, tasks)}>{allSelected ? "取消当日全选" : "全选当日"}</button>
            </div>
            {tasks.map(task => <label key={task.id}><input type="checkbox" disabled={busy} checked={selected.has(task.id)} onChange={event => selectRows([task], event.target.checked)} /><span>{task.title}</span></label>)}
          </section>;
        })}
          {!page.tasks.length && !error && <p>{loading ? "加载中…" : "暂无往日未完成任务"}</p>}
          {page.nextCursor && <button className="task-backlog-more" type="button" disabled={loading || busy} onClick={() => void load(page.nextCursor!)}>{loading ? "加载中…" : "加载更多"}</button>}
        </div>
        <footer><button type="button" onClick={() => viewDate(businessToday)} disabled={busy}>查看今日</button><button className="task-backlog-primary" type="button" disabled={busy || loading || !selected.size} onClick={() => void sync()}>{busy ? "结转中…" : `结转至今日（${selected.size}）`}</button></footer>
      </section>
    </div>}
  </>;
}
