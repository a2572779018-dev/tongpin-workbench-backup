/** Client-visible task shape. Keep this independent of server internals so a
 * saved conversation can recover its task with GET alone after a restart. */
export type MediaTaskStatus =
  | "queued" | "planning" | "awaiting_input" | "awaiting_authorization"
  | "running" | "partial" | "completed" | "failed" | "cancelled" | "unknown";

export type MediaTaskIntent = "image" | "video";

export interface MediaTaskRun {
  requestId: string;
  runId: string;
  conversationId: string;
  userId: string;
  version: number;
  status: MediaTaskStatus;
  createdAt: number;
  updatedAt: number;
  deadlineAt: number;
  /** Next server step; null when nothing is scheduled. */
  dueAt?: number | null;
  authorization?: { grantId: string };
  freeQuestion?: { questionId: string; prompt: string; deadlineAt: number; answer?: string };
  tool?: {
    capability: MediaTaskIntent;
    estimatedPoints: number;
    serviceRequestId?: string;
    artifactIds?: string[];
    partialArtifactIds?: string[];
    errorCode?: string;
  };
  errorCode?: string;
  cancelRequested?: boolean;
}

const statuses = new Set<MediaTaskStatus>([
  "queued", "planning", "awaiting_input", "awaiting_authorization",
  "running", "partial", "completed", "failed", "cancelled", "unknown",
]);

/**
 * Whether a saved media artifact still waits on its task, so the page keeps
 * reading the task by request id: the task has not finished, or it completed
 * and its results have not reached the artifact yet (the images, the video's
 * service request). A failed or cancelled task has no results to wait for and
 * is not read again (it used to be re-read every 12 s for as long as the page
 * stayed open).
 */
export function mediaArtifactAwaitsTask(artifact: { kind: string; data?: { [key: string]: unknown } }): boolean {
  const data = artifact.data;
  if (typeof data?.mediaTaskRequestId !== "string" || data.mediaTaskSubmitError) return false;
  const status = String(data.mediaTaskStatus);
  if (status === "failed" || status === "cancelled") return false;
  // An image run marked unknown is final on the server (no scheduler pass and
  // no read advances it); an unknown video is re-queried by the read itself.
  if (status === "unknown" && artifact.kind === "图片") return false;
  if (status !== "completed") return true;
  if (artifact.kind === "图片") return !Array.isArray(data.images);
  if (artifact.kind === "视频") return !data.mediaTaskServiceRequestId;
  return false;
}

export const mediaTaskReadPath = (requestId: string): string =>
  `/api/ai/media-tasks/by-request/${encodeURIComponent(requestId)}`;

export const mediaTaskAnswerPath = (runId: string): string =>
  `/api/ai/media-tasks/${encodeURIComponent(runId)}/answer`;

export const mediaTaskAuthorizePath = (runId: string): string =>
  `/api/ai/media-tasks/${encodeURIComponent(runId)}/authorize`;

export const mediaTaskCancelPath = (runId: string): string =>
  `/api/ai/media-tasks/${encodeURIComponent(runId)}`;

export function parseMediaTaskResponse(
  response: unknown,
  expected: { requestId: string; runId?: string; conversationId?: string; accountId: string; intent: MediaTaskIntent },
): MediaTaskRun {
  const task = response && typeof response === "object" && "task" in response ? response.task : null;
  if (!task || typeof task !== "object") throw new Error("任务响应不完整，请重新查询原任务");
  const value = task as Partial<MediaTaskRun>;
  if (value.requestId !== expected.requestId || expected.runId && value.runId !== expected.runId || expected.conversationId && value.conversationId !== expected.conversationId ||
    value.userId !== expected.accountId || typeof value.runId !== "string" || !value.runId ||
    typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version < 1 ||
    !statuses.has(value.status as MediaTaskStatus) ||
    value.tool?.capability && value.tool.capability !== expected.intent) {
    throw new Error("任务响应与当前对话或账号不匹配，请重新打开工作台");
  }
  return value as MediaTaskRun;
}

export function mediaTaskIsSettled(status: MediaTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "unknown";
}

export function mediaTaskNeedsPolling(status: MediaTaskStatus): boolean {
  return !mediaTaskIsSettled(status);
}

export function mediaTaskStatusText(status: MediaTaskStatus, intent: MediaTaskIntent): string {
  const kind = intent === "video" ? "视频" : "图片";
  switch (status) {
    case "queued": return "请求已保存，等待规划";
    case "planning": return `正在规划${kind}任务`;
    case "awaiting_input": return "需要补充信息后才能继续";
    case "awaiting_authorization": return "方案已就绪，等待确认生成额度";
    case "running": return `正在生成${kind}`;
    case "partial": return "已取得部分结果，仍在核对任务";
    case "completed": return `${kind}已生成`;
    case "failed": return `${kind}未生成`;
    case "cancelled": return "任务已取消";
    case "unknown": return "生成结果待核对，请勿重复提交";
  }
}

export function mediaTaskImageIds(task: MediaTaskRun): string[] {
  if (task.tool?.capability !== "image" || !["partial", "completed"].includes(task.status)) return [];
  const ids = task.status === "completed" ? task.tool.artifactIds : task.tool.partialArtifactIds;
  return [...new Set((ids ?? []).filter(id => typeof id === "string" && /^[A-Za-z0-9_-]{8,160}$/.test(id)))];
}

/** A confirmed grant the server is still carrying out. A grant the server
 * paused (budget, grant or sources changed) has no next step scheduled and
 * needs a fresh confirmation; older servers kept such a grant on the task. */
export function mediaTaskGrantActive(task: MediaTaskRun): boolean {
  return task.status === "awaiting_authorization" && Boolean(task.authorization) && task.dueAt !== null;
}

export function mediaTaskAuthorizationAmount(task: MediaTaskRun): number | null {
  const amount = task.tool?.estimatedPoints;
  return task.status === "awaiting_authorization" && !mediaTaskGrantActive(task) && typeof amount === "number" &&
    Number.isSafeInteger(amount) && amount > 0 && amount <= 10_000_000 ? amount : null;
}

const AUTHORIZATION_NOTICES: Record<string, string> = {
  AI_MEDIA_GRANT_BUDGET_CHANGED: "额度有变化，请重新确认生成",
  AI_MEDIA_GRANT_NOT_AUTHORIZED: "上次确认已失效，请重新确认生成",
  AI_MEDIA_GRANT_CONFIGURATION_CHANGED: "生成设置已变化，请重新发送任务",
  AI_MEDIA_GRANT_SOURCE_UNAVAILABLE: "参考素材已变化，请重新发送任务",
  // The paid step was refused before anything was sent or charged.
  AI_REQUEST_IN_PROGRESS: "对话正忙，稍后再确认生成",
  AI_CAPACITY_BUSY: "生成任务较多，稍后再确认生成",
  AI_VIDEO_BUSY: "生成任务较多，稍后再确认生成",
  AI_QUOTA_EXHAUSTED: "额度不足，补充后再确认生成",
  AI_QUOTA_INSUFFICIENT: "额度不足，补充后再确认生成",
  AI_ASSET_CAPACITY: "图片空间已满，删除旧图后再确认生成",
};

/** Why a task is waiting for confirmation again, when the server said why. */
export function mediaTaskAuthorizationNotice(task: MediaTaskRun): string | null {
  if (task.status !== "awaiting_authorization" || mediaTaskGrantActive(task) || !task.errorCode) return null;
  return AUTHORIZATION_NOTICES[task.errorCode] ?? null;
}
