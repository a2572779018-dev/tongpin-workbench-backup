import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarDays, X } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useNoticeCenter } from "./NoticeCenter";
import { syncPastTaskGroups } from "../lib/taskCarryoverClient";
import type { Task } from "../types";
import "./task-backlog.css";

interface BacklogPage { tasks: Task[]; targetDate: string; total: number; nextCursor: string | null }
export function TaskBacklog({ onViewToday }: { onViewToday: (date: string) => void }) {
  const { api, session } = useAuth(), { notify } = useNoticeCenter();
  const [page, setPage] = useState<BacklogPage>({ tasks: [], targetDate: "", total: 0, nextCursor: null });
  const [open, setOpen] = useState(false), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string[]>([]), [error, setError] = useState("");
  const state = useRef({ open, busy }), requestId = useRef(0), alive = useRef(true), dialog = useRef<HTMLElement>(null);
  state.current = { open, busy };
  const load = useCallback(async (cursor = "") => {
    const id = ++requestId.current;
    setLoading(true); setError("");
    try {
      const result = await api<BacklogPage>(`/api/tasks/backlog?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (!alive.current || id !== requestId.current) return;
      setPage(previous => ({ ...result, tasks: cursor ? [...new Map([...previous.tasks, ...result.tasks].map(task => [task.id, task])).values()] : result.tasks }));
      if (!cursor) setSelected([]);
    } catch (caught) { if (alive.current && id === requestId.current) setError(caught instanceof Error ? caught.message : "往日任务加载失败"); }
    finally { if (alive.current && id === requestId.current) setLoading(false); }
  }, [api]);
  useEffect(() => {
    alive.current = true; void load();
    const refresh = () => { if (!state.current.open && !state.current.busy && document.visibilityState === "visible") void load(); };
    const timer = window.setInterval(refresh, 60000);
    window.addEventListener("focus", refresh); window.addEventListener("tongpin:task-sync", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { alive.current = false; requestId.current++; clearInterval(timer); window.removeEventListener("focus", refresh); window.removeEventListener("tongpin:task-sync", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [load, session?.user.id]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); return; }
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
    if (state.current.busy || selected.length === 0) return;
    state.current.busy = true; setBusy(true); setError("");
    const generation = requestId.current;
    try {
      const result = await syncPastTaskGroups(api, page.tasks.filter(task => selected.includes(task.id)), session!.user.id);
      if (!alive.current || requestId.current !== generation) return;
      const handled = new Set(result.handledIds);
      setSelected(result.failedIds);
      setPage(previous => ({ ...previous, targetDate: result.targetDate || previous.targetDate, tasks: previous.tasks.filter(task => !handled.has(task.id)), total: Math.max(0, previous.total - handled.size) }));
      setError(result.errors.join("；"));
      if (handled.size) {
        window.dispatchEvent(new Event("tongpin:task-sync"));
        notify({ title: result.createdCount ? `已加入今日 ${result.createdCount} 项` : "任务已在今日清单", body: "", tone: "success", duration: 5000,
          actions: [{ label: "查看今日", onSelect: () => { setOpen(false); onViewToday(result.targetDate || page.targetDate); } }] });
      }
    } finally { if (alive.current) { state.current.busy = false; setBusy(false); } }
  }
  const dates = [...new Set(page.tasks.map(task => task.date))];
  return <>
    <div className="task-backlog-entry">
      <button type="button" onClick={() => { setOpen(true); if (!state.current.busy && !loading) void load(); }} aria-label={`往日未完成 ${page.total} 项`}><CalendarDays size={17} />往日未完成 <b>{loading && !page.tasks.length ? "…" : error && !open ? "重试" : page.total}</b></button>
    </div>
    {open && <div className="task-backlog-overlay" onClick={event => { if (event.target === event.currentTarget) setOpen(false); }}>
      <section ref={dialog} className="task-backlog-panel" role="dialog" aria-modal="true" aria-labelledby="task-backlog-title">
        <header><h2 id="task-backlog-title">往日未完成 <small>{page.total}</small></h2><button type="button" aria-label="关闭往日未完成" onClick={() => setOpen(false)}><X size={20} /></button></header>
        <div className="task-backlog-toolbar"><button type="button" disabled={busy || loading || !page.tasks.length} onClick={() => setSelected(selected.length === page.tasks.length ? [] : page.tasks.map(task => task.id))}>{selected.length === page.tasks.length && page.tasks.length ? "取消全选" : `全选这 ${page.tasks.length} 项`}</button><span>已选 {selected.length} 项</span><button type="button" disabled={busy || loading} onClick={() => void load()}>刷新</button></div>
        {error && <div className="inline-error" role="alert">{error}</div>}
        <div className="task-backlog-list">{dates.map(date => <section key={date}><h3>{date}</h3>{page.tasks.filter(task => task.date === date).map(task => <label key={task.id}><input type="checkbox" disabled={busy} checked={selected.includes(task.id)} onChange={event => setSelected(previous => event.target.checked ? [...previous, task.id] : previous.filter(id => id !== task.id))} /><span>{task.title}</span></label>)}</section>)}
          {!page.tasks.length && <p>{loading ? "加载中…" : "暂无往日未完成任务"}</p>}
          {page.nextCursor && <button className="task-backlog-more" type="button" disabled={loading || busy} onClick={() => void load(page.nextCursor!)}>{loading ? "加载中…" : "加载更多"}</button>}
        </div>
        <footer><button type="button" onClick={() => { setOpen(false); onViewToday(page.targetDate); }} disabled={!page.targetDate}>查看今日</button><button className="task-backlog-primary" type="button" disabled={busy || loading || !selected.length} onClick={() => void sync()}>{busy ? "加入中…" : `加入今天（${selected.length}）`}</button></footer>
      </section>
    </div>}
  </>;
}
