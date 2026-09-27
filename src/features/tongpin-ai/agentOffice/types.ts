// Data contract for the AI-employee office visualization. This file is the
// integration boundary with the Pro multi-agent run: whatever process drives
// the coordinator/worker run only needs to produce values shaped like this.
//
// Kept dependency-free (no pixi.js, no React) so it can be imported by the
// adapter that will wire real run data into <AgentOfficeView> without pulling
// in the renderer.

export type AgentOfficeStatus =
  | "queued"
  | "thinking"
  | "working"
  | "searching"
  | "done"
  | "failed"
  | "cancelled";

export type AgentOfficePhase =
  | "planning"
  | "dispatching"
  | "working"
  | "synthesizing"
  | "done"
  | "failed"
  | "cancelled";

export interface AgentOfficeWorker {
  id: string;
  /** Chinese role label as supplied by the run data, e.g. "研究员". Rendered verbatim. */
  role: string;
  /** The aspect this worker owns (the plan's subtask title), e.g. "长辈的礼物". */
  title?: string;
  task: string;
  status: AgentOfficeStatus;
  activity?: string;
  startedAt?: number;
  finishedAt?: number;
  resultSummary?: string;
  sourceCount?: number;
}

export interface AgentOfficeSnapshot {
  runId: string;
  phase: AgentOfficePhase;
  coordinator: {
    name: string;
    status: AgentOfficeStatus;
    activity?: string;
  };
  workers: AgentOfficeWorker[];
  updatedAt: number;
}
