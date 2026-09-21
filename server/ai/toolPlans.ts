import type { AiAttachment, AiChatResponse, AiToolPlan, AiToolPlanKind } from "../../shared/ai";
import type { AiStore, StoredRequest } from "./storage";
import { AiError } from "./security";

const TOOL_PLAN_TTL_MS = 30 * 60 * 1000;

export async function toolPlanContextFingerprint(projectContext?: string, attachments?: AiAttachment[]): Promise<string> {
  const canonical = JSON.stringify({ projectContext: projectContext ?? "", attachments: attachments ?? [] });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function planLabel(kind: AiToolPlanKind): string {
  return kind === "image" ? "图片" : kind === "video" ? "视频" : "PPT";
}

/**
 * A generated tool plan is an expiring, account-bound approval draft. It is
 * not itself permission to perform the same paid action more than once.
 */
export function validateToolPlan(
  store: AiStore,
  userId: string,
  planRequestId: string | undefined,
  kind: AiToolPlanKind,
  prompt: string,
  options: { contextFingerprint?: string; consumerRequestId?: string } = {},
): StoredRequest & { status: "completed"; result: Omit<AiChatResponse, "quota"> & { toolPlan: AiToolPlan } } {
  if (!planRequestId) throw new AiError(409, "AI_TOOL_PLAN_REQUIRED", `请先让同频 AI 整理${planLabel(kind)}任务，再确认生成`);
  const planned = store.request(userId, planRequestId);
  if (planned?.status !== "completed" || planned.result?.toolPlan?.kind !== kind || planned.result.toolPlan.prompt !== prompt) {
    throw new AiError(409, "AI_TOOL_PLAN_MISMATCH", "生成内容与已确认的同频 AI 方案不一致，请重新整理后确认");
  }
  if (options.contextFingerprint !== undefined && planned.toolPlanContextFingerprint !== options.contextFingerprint) {
    throw new AiError(409, "AI_TOOL_PLAN_CONTEXT_MISMATCH", "附件或项目上下文已改变，请让同频 AI 重新整理后确认");
  }
  const expiresAt = planned.toolPlanExpiresAt ?? Date.parse(planned.createdAt) + TOOL_PLAN_TTL_MS;
  if ((!Number.isFinite(expiresAt) || expiresAt <= Date.now()) && planned.toolPlanConsumedBy !== options.consumerRequestId) {
    throw new AiError(409, "AI_TOOL_PLAN_EXPIRED", "这份同频 AI 方案已过期，请重新整理后确认");
  }
  if (planned.toolPlanConsumedBy && planned.toolPlanConsumedBy !== options.consumerRequestId) {
    throw new AiError(409, "AI_TOOL_PLAN_CONSUMED", "这份同频 AI 方案已用于一次生成，请重新整理后确认");
  }
  return planned as StoredRequest & { status: "completed"; result: Omit<AiChatResponse, "quota"> & { toolPlan: AiToolPlan } };
}

/** Must be called inside the same transaction that persists the paid request. */
export function claimToolPlan(
  store: AiStore,
  userId: string,
  planRequestId: string | undefined,
  kind: AiToolPlanKind,
  prompt: string,
  consumerRequestId: string,
  contextFingerprint?: string,
): void {
  const planned = validateToolPlan(store, userId, planRequestId, kind, prompt, { contextFingerprint, consumerRequestId });
  if (planned.toolPlanConsumedBy === consumerRequestId) return;
  planned.toolPlanConsumedBy = consumerRequestId;
  planned.toolPlanConsumedAt = new Date().toISOString();
  store.saveRequest(planned);
}

export function toolPlanExpiry(): number {
  return Date.now() + TOOL_PLAN_TTL_MS;
}
