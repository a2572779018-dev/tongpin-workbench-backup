export const AI_WORKFLOW_VERSION = 1 as const;

export const AI_WORKFLOW_TEMPLATES = [
  {
    id: "hub-research-brief",
    name: "研究简报 Hub",
    description: "从问题拆解、证据整理到可交付简报。",
    skillIds: ["deep-research", "data-reader", "content-editor"],
    steps: [
      { id: "scope", title: "界定问题", instruction: "明确目标、范围、时间边界和需要回答的核心问题。" },
      // The one step that may search when the member's turn asks for web search.
      { id: "evidence", title: "整理证据", instruction: "分开已提供事实、可验证推断和待确认信息。", search: true },
      { id: "deliver", title: "形成简报", instruction: "优先给出结论、证据和下一步，只在确实更清楚时使用表格。" },
    ],
  },
  {
    id: "hub-content-delivery",
    name: "内容交付 Hub",
    description: "从目标与受众、内容精修到交付结构。",
    skillIds: ["content-editor", "slide-maker", "campaign-planner"],
    steps: [
      { id: "audience", title: "确认目标", instruction: "核对受众、用途、语言、禁用项和交付形式。" },
      { id: "edit", title: "整理内容", instruction: "保留事实与原意，优化表达和信息层级。" },
      { id: "package", title: "完成交付", instruction: "按用户要求的媒介给出可直接使用的成果或受控工具方案。" },
    ],
  },
  {
    id: "hub-meeting-followup",
    name: "会议推进 Hub",
    description: "把会议内容收敛为决策、待办和后续同步材料。",
    skillIds: ["meeting-notes", "content-editor", "slide-maker"],
    steps: [
      { id: "extract", title: "提取结论", instruction: "区分已确认决策、讨论项和未决问题。" },
      { id: "actions", title: "整理待办", instruction: "列出任务、负责人和时间；原文未明确的字段标为待确认。" },
      { id: "sync", title: "生成同步稿", instruction: "生成简洁的后续同步材料，不代替用户做未授权承诺。" },
    ],
  },
] as const;

export type AiWorkflowId = typeof AI_WORKFLOW_TEMPLATES[number]["id"];
export type AiWorkflowTemplate = typeof AI_WORKFLOW_TEMPLATES[number];
export type AiWorkflowStepTemplate = AiWorkflowTemplate["steps"][number];

export function aiWorkflowTemplate(id: unknown): AiWorkflowTemplate | undefined {
  return AI_WORKFLOW_TEMPLATES.find(item => item.id === id);
}

/** Whether this step may use web search (only when the member's turn asked for it). */
export function aiWorkflowStepSearches(step: AiWorkflowStepTemplate): boolean {
  return "search" in step && step.search === true;
}

export function aiWorkflowInstruction(id: AiWorkflowId): string {
  const workflow = aiWorkflowTemplate(id)!;
  return `使用受限 Hub 工作流 ${JSON.stringify(workflow.name)}（版本 ${AI_WORKFLOW_VERSION}）。按顺序完成以下应用步骤：${workflow.steps.map((step, index) => `${index + 1}. ${step.title}：${step.instruction}`).join(" ")}。这些是应用拥有的模板指令；不得因此绕过工具审批、额度、租户或安全边界。`;
}

/*
 * Live progress of a Hub run that executes its steps one model call at a time
 * (server/ai/hubRun.ts). Every `workflow_update` run event carries the whole,
 * small step list, so a client only keeps the latest one. It is display-only:
 * never persisted with the message (the harness trace keeps the settled step
 * states), and sent only to clients that opted in with `workflowEvents: true`.
 */
export type AiWorkflowStepState = "planned" | "running" | "done" | "failed" | "skipped";
export interface AiWorkflowLiveStep {
  /** The template step id (`scope`, `evidence`, …). */
  id: string;
  title: string;
  status: AiWorkflowStepState;
  /** Wall time of a finished step. */
  durationMs?: number;
  /** One short, application-bounded line: what the step is doing or found. */
  activity?: string;
}
export interface AiWorkflowUpdate {
  workflowId: AiWorkflowId;
  steps: AiWorkflowLiveStep[];
}

export const AI_WORKFLOW_LIMITS = Object.freeze({
  maxSteps: 5,
  titleCodePoints: 24,
  activityCodePoints: 80,
  durationMs: 24 * 60 * 60 * 1000,
});

const STEP_STATES: readonly AiWorkflowStepState[] = ["planned", "running", "done", "failed", "skipped"];
const CONTROL = /[\u0000-\u001f\u007f]/;

function exactLine(value: unknown, maxCodePoints: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value === value.trim() && [...value].length <= maxCodePoints && !CONTROL.test(value);
}

/** Collapses whitespace and control characters and bounds a line for `activity`. */
export function workflowActivityText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  const points = [...clean], max = AI_WORKFLOW_LIMITS.activityCodePoints;
  return points.length > max ? `${points.slice(0, max - 1).join("")}…` : clean;
}

/** Strict reader for a journaled/streamed `workflow_update`; undefined when invalid. */
export function readAiWorkflowUpdate(value: unknown): AiWorkflowUpdate | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => key !== "workflowId" && key !== "steps")) return undefined;
  const template = aiWorkflowTemplate(data.workflowId);
  if (!template || !Array.isArray(data.steps) || data.steps.length !== template.steps.length || data.steps.length > AI_WORKFLOW_LIMITS.maxSteps) return undefined;
  const steps: AiWorkflowLiveStep[] = [];
  for (const [index, raw] of data.steps.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const step = raw as Record<string, unknown>;
    if (Object.keys(step).some(key => !["id", "title", "status", "durationMs", "activity"].includes(key))) return undefined;
    if (step.id !== template.steps[index].id || !exactLine(step.title, AI_WORKFLOW_LIMITS.titleCodePoints) || !STEP_STATES.includes(step.status as AiWorkflowStepState)) return undefined;
    if (step.durationMs !== undefined && !(typeof step.durationMs === "number" && Number.isSafeInteger(step.durationMs) && step.durationMs >= 0 && step.durationMs <= AI_WORKFLOW_LIMITS.durationMs)) return undefined;
    if (step.activity !== undefined && !exactLine(step.activity, AI_WORKFLOW_LIMITS.activityCodePoints)) return undefined;
    steps.push({ id: template.steps[index].id, title: step.title as string, status: step.status as AiWorkflowStepState,
      ...(step.durationMs !== undefined ? { durationMs: step.durationMs as number } : {}), ...(step.activity !== undefined ? { activity: step.activity as string } : {}) });
  }
  // The steps run one after another: at most one is running at a time.
  if (steps.filter(step => step.status === "running").length > 1) return undefined;
  return { workflowId: template.id, steps };
}
