import type { AgentOfficeSnapshot, AgentOfficeStatus } from "./types";

export const STATUS_LABELS: Record<AgentOfficeStatus, string> = {
  queued: "排队中",
  thinking: "思考中",
  working: "处理中",
  searching: "联网搜索中",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

export const PHASE_LABELS: Record<AgentOfficeSnapshot["phase"], string> = {
  planning: "拆解任务中",
  dispatching: "分派任务中",
  working: "处理中",
  synthesizing: "综合结果中",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

/** "12 秒" / "1 分 05 秒". No `startedAt` → not started yet → null (the
 *  caller renders that as "--", not "0 秒"). */
export function formatElapsed(startedAt?: number, finishedAt?: number, now: number = Date.now()): string | null {
  if (startedAt === undefined || !Number.isFinite(startedAt)) return null;
  const end = finishedAt ?? now;
  const totalSec = Math.max(0, Math.round((end - startedAt) / 1000));
  if (totalSec < 60) return `${totalSec} 秒`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min} 分 ${String(sec).padStart(2, "0")} 秒`;
}

export interface FallbackRow {
  id: string;
  label: string;
  task: string;
  statusText: string;
  elapsedText: string | null;
  resultSummary: string | null;
  sourceCount: number | null;
}

/** Same information the canvas scene shows, as plain rows — used for both the
 *  no-WebGL/context-lost DOM fallback and the hover/click detail card, so the
 *  two surfaces can never drift apart on what a worker's card says. */
export function buildFallbackRows(snapshot: AgentOfficeSnapshot, now: number = Date.now()): FallbackRow[] {
  const rows: FallbackRow[] = [
    {
      id: "__coordinator__",
      label: "协调员",
      task: snapshot.coordinator.activity?.trim() || PHASE_LABELS[snapshot.phase],
      statusText: STATUS_LABELS[snapshot.coordinator.status],
      elapsedText: null,
      resultSummary: null,
      sourceCount: null,
    },
  ];
  for (const worker of snapshot.workers) {
    rows.push({
      id: worker.id,
      label: worker.role,
      task: worker.task,
      statusText: STATUS_LABELS[worker.status],
      elapsedText: formatElapsed(worker.startedAt, worker.finishedAt, now),
      resultSummary: worker.resultSummary?.trim() || null,
      sourceCount: typeof worker.sourceCount === "number" ? worker.sourceCount : null,
    });
  }
  return rows;
}
