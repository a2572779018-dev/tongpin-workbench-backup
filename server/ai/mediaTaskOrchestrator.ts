import type { AiAttachment, AiChatResponse, AiMode } from "../../shared/ai";
import { AI_MEDIA_LIMITS } from "../../shared/aiMedia";
import type { AiVideoJob } from "../../shared/aiVideo";
import { validateImageBase64 } from "./capabilities";
import { readGeneratedAssetReference } from "./generatedAssetReference";
import {
  MediaTaskRuntime,
  type MediaTaskAuthorizationScope,
  type MediaTaskCreateInput,
  type MediaTaskContextMessage,
  type MediaTaskEntrypoint,
  type MediaTaskExecutionGuard,
  type MediaTaskRun,
  type MediaTaskSnapshot,
  type MediaTaskVideoParameters,
} from "./mediaTaskRuntime";
import { AiError } from "./security";
import type { AiService } from "./service";
import { tenantStorageKey } from "./tenant";
import { validateToolPlan } from "./toolPlans";
import { AiWorkspaceRepository } from "./workspace";

const MAX_TASK_LIFETIME_MS = 30 * 60_000;
const VIDEO_POLL_MS = 10_000;
const MAX_CONTEXT_MESSAGES = 12;
const MAX_CONTEXT_CHARACTERS = 6000;
const MAX_CONTEXT_MESSAGE_CHARACTERS = 1200;
const URL_IN_HISTORY = /(?:https?:\/\/|file:\/\/|ftp:\/\/|data:|javascript:|www\.)[^\s<>()\[\]{}"']+/gi;

export interface SubmitMediaTask {
  requestId: string;
  conversationId: string;
  entrypoint: MediaTaskEntrypoint;
  tier: AiMode;
  intent: "image" | "video";
  requestText: string;
  /** Generated image asset IDs for image editing; uploaded reference IDs for video. */
  sourceAssetIds: string[];
  videoParameters?: MediaTaskVideoParameters;
  deadlineAt?: number;
  /** Only the authenticated Send action may provide this. A natural-language
   * request must independently pass the deterministic explicit-action gate. */
  confirmedMediaExecution?: MediaTaskConfirmation;
}

/** Only a route that has authenticated the member and recorded an affirmative
 * click may call this. Nothing in the model response or a timer can create it. */
export interface MediaTaskConfirmation {
  confirmed: true;
  maxPointsPerTool: number;
  automaticChoice?: boolean;
  expiresAt?: number;
}

type MediaTaskService = Pick<AiService, "store" | "chat" | "generateImage" | "getRequestResult" | "video" | "status">;

function rejected(code: string, message: string, status = 409): never {
  throw new AiError(status, code, message);
}
async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}
function expectedRun(runtime: MediaTaskRuntime, userId: string, runId: string): MediaTaskRun {
  const run = runtime.get(userId, runId);
  if (!run) throw new AiError(404, "AI_MEDIA_TASK_NOT_FOUND", "没有找到这条任务");
  return run;
}
function safeErrorCode(error: unknown): string {
  return error instanceof AiError && /^[a-zA-Z0-9._:-]{1,120}$/.test(error.code) ? error.code : "AI_MEDIA_TASK_FAILED";
}
function normalizedText(value: string): string { return value.replace(/\s+/g, " ").trim(); }
function explicitMediaAction(intent: "image" | "video", requestText: string): boolean {
  const statement = normalizedText(requestText);
  if (/^(?:为什么|为何|怎么|如何|是否|是不是|能否|可不可以|请问|你能不能)/.test(statement)
    || /(?:失败|报错|错误|提示词|教程|方案|能不能|可以吗|行吗|[?？])/.test(statement)
    || /(?:不要|别|不想|不需要|不用|无需|禁止|取消|停止|暂不|先不|先别)\s*(?:帮我|给我|为我)?\s*(?:生成|创建|制作|绘制|画|做)/.test(statement)) return false;
  const noun = intent === "image" ? /(?:图片|图像|插画|海报|照片|画作)/ : /(?:视频|短片|动画|宣传片|影片)/;
  // Permit a short factual preface ("这是 logo，帮我生成视频") and negative
  // creative constraints ("生成视频，不要字幕"), but never a negated action.
  const action = /(?:^|[,，。;；]\s*)(?:请\s*)?(?:帮我|给我|为我|直接|现在|马上|立刻)?\s*(?:生成|创建|制作|绘制|画|做)(.{0,50})/g;
  for (const match of statement.matchAll(action)) if (noun.test(match[1])) return true;
  // A reference-first request is still an explicit action, not a discussion:
  // “用刚才同一个人物做视频”. Keep the prefix narrow; a question or negated
  // action has already been rejected above, and no model text may mint consent.
  const referenceFirst = statement.match(/^(?:用|把)(?:刚才|上面|上一张|这张|这个|同一张|同一个|相同的).{0,40}?(?:生成|制作|做)(.{0,50})/);
  if (referenceFirst && noun.test(referenceFirst[1])) return true;
  return false;
}

function submissionMayCarryGrant(input: SubmitMediaTask): boolean {
  if (!input.confirmedMediaExecution || input.confirmedMediaExecution.confirmed !== true) return false;
  if (input.entrypoint === "natural") return explicitMediaAction(input.intent, input.requestText);
  return input.entrypoint === "menu" || input.entrypoint === "mention_image" && input.intent === "image"
    || input.entrypoint === "mention_video" && input.intent === "video";
}

/** Capture only text from this account's already-saved conversation. A link
 * in historical content is untrusted input, not a fetch instruction. */
function frozenConversationContext(service: MediaTaskService, userId: string, conversationId: string, requestText: string): {
  contextMessages: MediaTaskContextMessage[]; contextRevision?: number;
} {
  const saved = new AiWorkspaceRepository(service.store.sql).read(userId, service.store.tenantId);
  const conversation = saved.state?.conversations.find(item => item.id === conversationId);
  if (!conversation) return { contextMessages: [] };
  const eligible = conversation.messages.filter(item => (item.role === "user" || item.role === "assistant")
    && (item.status === undefined || item.status === "ready") && typeof item.content === "string" && item.content.trim());
  // The client may have already persisted the current message. Keep only the
  // prior conversation and append requestText once as the active user turn.
  if (eligible.at(-1)?.role === "user" && normalizedText(eligible.at(-1)!.content) === normalizedText(requestText)) eligible.pop();
  const collected: MediaTaskContextMessage[] = [];
  let remaining = MAX_CONTEXT_CHARACTERS;
  for (let index = eligible.length - 1; index >= 0 && collected.length < MAX_CONTEXT_MESSAGES && remaining >= 50; index--) {
    const message = eligible[index];
    const content = message.content.replace(URL_IN_HISTORY, "[链接已省略]").replace(/\u0000/g, "").trim();
    if (!content) continue;
    const clipped = content.slice(0, Math.min(MAX_CONTEXT_MESSAGE_CHARACTERS, remaining)).trim();
    if (!clipped) continue;
    collected.push({ sourceMessageId: message.id, role: message.role, content: clipped });
    remaining -= clipped.length;
  }
  return { contextMessages: collected.reverse(), contextRevision: saved.revision };
}

/** Concrete bridge to the existing one-time chat plan, image reservation and
 * video job APIs. The runtime owns state; only AiService owns paid transport.
 * This class intentionally has no generic retry of an accepted paid call. */
export class AiServiceMediaTaskOrchestrator {
  readonly runtime: MediaTaskRuntime;
  constructor(private readonly service: MediaTaskService, private readonly now: () => number = () => Date.now()) {
    this.runtime = new MediaTaskRuntime(service.store, now);
  }

  private async configurationVersion(intent: "image" | "video", tier: AiMode): Promise<string> {
    if (intent === "video") return this.service.video.configurationVersion(tier);
    // Include encrypted provider keys and verified model routes in the digest,
    // but never expose either one in member-visible task state.
    return digest({ tenantId: this.service.store.tenantId, tier, provider: this.service.store.provider(), harness: this.service.store.harness() });
  }

  private async budgetVersion(userId: string): Promise<string> {
    const quota = this.service.store.quota(userId);
    return digest({ tenantId: this.service.store.tenantId, userId, limitTokens: quota.limitTokens, access: this.service.store.hasAccess(userId) });
  }

  private async scopedSources(userId: string, input: { intent: "image" | "video"; conversationId: string; sourceAssetIds: string[] }): Promise<{ valid: true; attachments: AiAttachment[]; fingerprints: string[] }> {
    if (input.intent === "video") {
      const fingerprints = await this.service.video.referenceFingerprintsForTask(userId, input.sourceAssetIds, input.conversationId);
      return { valid: true, attachments: [], fingerprints };
    }
    if (input.sourceAssetIds.length > 5) rejected("AI_ATTACHMENT_INVALID", "图片任务最多使用五张参考图", 400);
    const attachments: AiAttachment[] = [];
    const fingerprints: string[] = [];
    const saved = new AiWorkspaceRepository(this.service.store.sql).read(userId, this.service.store.tenantId);
    const conversation = saved.state?.conversations.find(item => item.id === input.conversationId);
    let totalBytes = 0;
    for (const assetId of input.sourceAssetIds) {
      const matchingDocuments = (conversation?.messages ?? [])
        .filter(message => message.role === "user" && (message.status === undefined || message.status === "ready"))
        .flatMap(message => message.attachments ?? []).filter(document => document.id === assetId);
      if (matchingDocuments.length > 1 || matchingDocuments.length && this.service.store.asset(userId, assetId)) {
        rejected("AI_MEDIA_TASK_SOURCE_AMBIGUOUS", "参考图片标识重复，请重新选择", 409);
      }
      if (matchingDocuments.length === 1) {
        const document = matchingDocuments[0];
        const dataUrl = document.media?.kind === "image" && document.media.frames.length === 1
          ? document.media.frames[0].dataUrl : null;
        const match = dataUrl && /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
        if (!match || document.mimeType !== match[1]) rejected("AI_MEDIA_TASK_SOURCE_INVALID", "参考图片格式无效，请重新添加", 400);
        const verified = validateImageBase64(match[2], AI_MEDIA_LIMITS.frameBytes, 400);
        if (verified.mimeType !== match[1] || verified.width > AI_MEDIA_LIMITS.frameDimension || verified.height > AI_MEDIA_LIMITS.frameDimension) {
          rejected("AI_MEDIA_TASK_SOURCE_INVALID", "参考图片内容无效，请重新添加", 400);
        }
        totalBytes += verified.byteLength;
        attachments.push({ name: document.name.slice(0, 160), mediaType: verified.mimeType, dataUrl });
        fingerprints.push(await digest({ mediaType: verified.mimeType, base64: verified.base64 }));
        continue;
      }
      const asset = await readGeneratedAssetReference(this.service.store, userId, { assetId, conversationId: input.conversationId });
      const verified = validateImageBase64(asset.base64, AI_MEDIA_LIMITS.requestBytes, 400);
      totalBytes += verified.byteLength;
      attachments.push({ name: `参考图 ${attachments.length + 1}`, mediaType: asset.mimeType, dataUrl: `data:${asset.mimeType};base64,${asset.base64}` });
      fingerprints.push(asset.sourceFingerprint);
    }
    if (totalBytes > AI_MEDIA_LIMITS.requestBytes) rejected("AI_ATTACHMENT_INVALID", "参考图片总大小不能超过 1 MiB", 400);
    return { valid: true, attachments, fingerprints };
  }

  private async guard(userId: string, run: MediaTaskRun): Promise<MediaTaskExecutionGuard> {
    const snapshot = this.runtime.snapshot(userId, run.runId);
    if (!snapshot) rejected("AI_MEDIA_TASK_SNAPSHOT_MISSING", "任务快照不存在");
    let sourceAssetsValid = false;
    try {
      const source = await this.scopedSources(userId, snapshot);
      sourceAssetsValid = snapshot.sourceFingerprints === undefined
        ? snapshot.sourceAssetIds.length === 0
        : JSON.stringify(source.fingerprints) === JSON.stringify(snapshot.sourceFingerprints);
    } catch { /* A stale or foreign source never authorizes a paid call. */ }
    return {
      modelConfigVersion: await this.configurationVersion(snapshot.intent, snapshot.tier),
      budgetVersion: await this.budgetVersion(userId),
      availablePoints: this.service.store.quota(userId).remainingTokens,
      sourceAssetsValid,
    };
  }

  private estimatedPoints(userId: string, intent: "image" | "video"): number {
    let amount: number;
    if (intent === "video") {
      const settings = this.service.video.settings();
      if (!settings.enabled) rejected("AI_MEDIA_TASK_NOT_CONFIGURED", "管理员尚未启用视频生成");
      amount = settings.quotaPoints;
    } else {
      const status = this.service.status(userId);
      if (!status.imageEnabled) rejected("AI_MEDIA_TASK_NOT_CONFIGURED", "管理员尚未启用图片生成");
      amount = status.imageQuotaTokens ?? 0;
    }
    if (!Number.isSafeInteger(amount) || amount <= 0) rejected("AI_MEDIA_TASK_NOT_CONFIGURED", "管理员尚未配置该媒体能力的额度");
    return amount;
  }

  /** Persist a frozen intent before model planning. The caller must already
   * have resolved natural language or an @ mention into image/video intent. */
  async submit(userId: string, input: SubmitMediaTask): Promise<MediaTaskRun> {
    this.service.store.assertAccess(userId);
    // A repeated HTTP delivery is a read of the original task, not another
    // plan or a new deadline. Resolve it before source links can expire.
    const prior = this.service.store.sql.all<{ run_id: string }>(
      "SELECT run_id FROM ai_media_task_runs WHERE tenant_id=? AND user_id=? AND request_id=?",
      this.service.store.tenantId, tenantStorageKey(this.service.store.tenantId, userId), input.requestId,
    )[0];
    if (prior) {
      const original = this.runtime.snapshot(userId, prior.run_id);
      if (!original || JSON.stringify({
        requestId: original.requestId, conversationId: original.conversationId, entrypoint: original.entrypoint,
        tier: original.tier, intent: original.intent, requestText: original.requestText,
        sourceAssetIds: original.sourceAssetIds, videoParameters: original.videoParameters,
        ...(input.deadlineAt !== undefined ? { deadlineAt: original.deadlineAt } : {}),
      }) !== JSON.stringify({
        requestId: input.requestId, conversationId: input.conversationId, entrypoint: input.entrypoint,
        tier: input.tier, intent: input.intent, requestText: input.requestText.trim(),
        sourceAssetIds: input.sourceAssetIds, videoParameters: input.videoParameters,
        ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
      })) rejected("AI_MEDIA_TASK_CONFLICT", "相同请求标识对应不同任务输入");
      return expectedRun(this.runtime, userId, prior.run_id);
    }
    if (input.intent === "video" && (!input.videoParameters || JSON.stringify(input.videoParameters.referenceIds) !== JSON.stringify(input.sourceAssetIds))) {
      rejected("AI_MEDIA_TASK_SOURCE_MISMATCH", "视频参数与参考图不一致", 400);
    }
    if (input.intent === "image" && input.videoParameters) rejected("AI_MEDIA_TASK_INVALID", "图片任务不能携带视频参数", 400);
    if (input.entrypoint === "mention_image" && input.intent !== "image" || input.entrypoint === "mention_video" && input.intent !== "video") {
      rejected("AI_MEDIA_TASK_INTENT_MISMATCH", "所选能力与任务类型不一致", 400);
    }
    const deadlineAt = input.deadlineAt ?? this.now() + MAX_TASK_LIFETIME_MS;
    if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= this.now() || deadlineAt > this.now() + MAX_TASK_LIFETIME_MS) {
      rejected("AI_MEDIA_TASK_DEADLINE", "任务期限无效", 400);
    }
    const source = await this.scopedSources(userId, input);
    const cost = this.estimatedPoints(userId, input.intent);
    if (input.intent === "video") this.service.video.bindPlanModel(input.tier, input.videoParameters!.model);
    const context = frozenConversationContext(this.service, userId, input.conversationId, input.requestText);
    const modelConfigVersion = await this.configurationVersion(input.intent, input.tier);
    let authorizationScope: MediaTaskAuthorizationScope | null = null;
    if (submissionMayCarryGrant(input)) {
      const confirmed = input.confirmedMediaExecution!;
      if (!Number.isSafeInteger(confirmed.maxPointsPerTool) || confirmed.maxPointsPerTool < cost || confirmed.maxPointsPerTool > 10_000_000) {
        rejected("AI_MEDIA_TASK_BUDGET_INVALID", "确认额度不足或超出范围", 400);
      }
      if (this.service.store.quota(userId).remainingTokens < cost) rejected("AI_QUOTA_INSUFFICIENT", "可用额度不足", 402);
      const expiresAt = Math.min(confirmed.expiresAt ?? this.now() + 5 * 60_000, deadlineAt, this.now() + 5 * 60_000);
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now()) rejected("AI_MEDIA_TASK_GRANT_EXPIRED", "确认已过期", 400);
      authorizationScope = {
        grantId: crypto.randomUUID(), capabilities: [input.intent], sourceAssetIds: [...input.sourceAssetIds],
        maxPointsPerTool: confirmed.maxPointsPerTool, budgetVersion: await this.budgetVersion(userId),
        modelConfigVersion, automaticChoice: confirmed.automaticChoice === true, expiresAt,
      };
    }
    const snapshot: MediaTaskCreateInput = {
      requestId: input.requestId, conversationId: input.conversationId, entrypoint: input.entrypoint,
      tier: input.tier, intent: input.intent, requestText: input.requestText,
      modelConfigVersion,
      sourceAssetIds: [...input.sourceAssetIds],
      sourceFingerprints: source.fingerprints,
      ...(context.contextMessages.length ? { contextMessages: context.contextMessages } : {}),
      ...(context.contextRevision !== undefined ? { contextRevision: context.contextRevision } : {}),
      ...(input.videoParameters ? { videoParameters: { ...input.videoParameters, referenceIds: [...input.videoParameters.referenceIds] } } : {}),
      authorizationScope, deadlineAt,
    };
    return this.runtime.submit(userId, snapshot);
  }

  get(userId: string, runId: string): MediaTaskRun {
    this.service.store.assertAccess(userId);
    return expectedRun(this.runtime, userId, runId);
  }

  getByRequest(userId: string, requestId: string): MediaTaskRun {
    this.service.store.assertAccess(userId);
    const row = this.service.store.sql.all<{ run_id: string }>(
      "SELECT run_id FROM ai_media_task_runs WHERE tenant_id=? AND user_id=? AND request_id=?",
      this.service.store.tenantId, tenantStorageKey(this.service.store.tenantId, userId), requestId,
    )[0];
    if (!row) throw new AiError(404, "AI_MEDIA_TASK_NOT_FOUND", "没有找到这条任务");
    return expectedRun(this.runtime, userId, row.run_id);
  }

  cancel(userId: string, runId: string): MediaTaskRun {
    this.service.store.assertAccess(userId);
    // A running provider call is only marked cancellation requested. The
    // existing provider API does not support acknowledged cancellation.
    return this.runtime.cancel(userId, runId);
  }

  answer(userId: string, runId: string, questionId: string, answer: string): MediaTaskRun {
    this.service.store.assertAccess(userId);
    return this.runtime.answerInput(userId, runId, questionId, answer);
  }

  dueCandidates(limit = 8): Array<{ tenantId: string; userId: string; runId: string }> {
    return this.runtime.dueCandidates(limit);
  }

  /** One scheduler step. claimPlanning CAS ensures only one planner request;
   * running steps only observe the original request/job. */
  async advance(userId: string, runId: string): Promise<MediaTaskRun> {
    this.service.store.assertAccess(userId);
    const run = expectedRun(this.runtime, userId, runId);
    if (run.status === "queued") return this.plan(userId, runId);
    if (run.status === "planning") return this.reconcilePlanning(userId, runId);
    if (run.status === "awaiting_input" && run.freeQuestion) return this.runtime.expireInput(userId, runId);
    if (run.status === "awaiting_authorization" && run.authorization) return this.executeAuthorized(userId, runId);
    if (run.status === "running" || run.status === "partial" || run.status === "unknown") return this.reconcile(userId, runId);
    return run;
  }

  private async plan(userId: string, runId: string): Promise<MediaTaskRun> {
    const claimed = this.runtime.claimPlanning(userId, runId);
    if (!claimed) return expectedRun(this.runtime, userId, runId);
    const snapshot = this.runtime.snapshot(userId, runId);
    if (!snapshot) rejected("AI_MEDIA_TASK_SNAPSHOT_MISSING", "任务快照不存在");
    try {
      const currentConfig = await this.configurationVersion(snapshot.intent, snapshot.tier);
      if (currentConfig !== snapshot.modelConfigVersion) rejected("AI_CONFIG_CHANGED", "任务配置已改变，请重新提交");
      const source = await this.scopedSources(userId, snapshot);
      if (snapshot.sourceAssetIds.length && snapshot.sourceFingerprints === undefined) {
        rejected("AI_MEDIA_TASK_SOURCE_UNVERIFIED", "旧任务缺少素材校验信息，请重新提交任务");
      }
      if (snapshot.sourceFingerprints !== undefined
        && JSON.stringify(source.fingerprints) !== JSON.stringify(snapshot.sourceFingerprints)) {
        rejected("AI_MEDIA_TASK_SOURCE_CHANGED", "参考素材内容已改变，请重新提交任务");
      }
      // A bare request has no scene, subject or reference to plan. Ask one
      // bounded question without spending a model call or executing a tool.
      // The answer is persisted as a new attempt before planning resumes.
      if (snapshot.intent === "image" && !snapshot.sourceAssetIds.length
        && !snapshot.contextMessages?.length && !claimed.inputAnswers?.length
        && /^(?:请)?(?:帮我|给我)?(?:生成|做|画)(?:一张|张)?(?:图片|图像|图)[。.!！]?$/.test(normalizedText(snapshot.requestText))) {
        return this.runtime.awaitInput(userId, runId, "你想生成什么内容的图片？可以说说主体、风格或用途。", Math.min(snapshot.deadlineAt, this.now() + 5 * 60_000));
      }
      // Every answered question creates a new persisted attempt. Reusing the
      // original request ID would replay its old clarification forever.
      const planRequestId = `plan-${claimed.stepId}`;
      const followup = (claimed.inputAnswers ?? []).map((item, index) => `补充 ${index + 1}: ${item.answer}`).join("\n");
      const planningText = `${snapshot.requestText}${followup ? `\n\n用户后续补充：\n${followup}` : ""}`;
      if (planningText.length > 12_000) rejected("AI_CONTEXT_TOO_LONG", "补充内容过长，请在新任务中简化描述", 400);
      const response: AiChatResponse = await this.service.chat(userId, {
        requestId: planRequestId, conversationId: snapshot.conversationId, mode: snapshot.tier,
        messages: [...(snapshot.contextMessages ?? []).map(item => ({ role: item.role, content: item.content })), { role: "user", content: planningText }],
        outputFormat: snapshot.intent === "image" ? "image_plan" : "video_plan",
        ...(source.attachments.length ? { attachments: source.attachments } : {}),
        ...(snapshot.videoParameters ? { videoParameters: {
          model: snapshot.videoParameters.model, seconds: snapshot.videoParameters.seconds,
          resolution: snapshot.videoParameters.resolution, aspectRatio: snapshot.videoParameters.aspectRatio,
          referenceCount: snapshot.videoParameters.referenceIds.length, referenceFingerprints: source.fingerprints,
        } } : {}),
      });
      return this.applyPlanResponse(userId, runId, snapshot, response, planRequestId);
    } catch (error) {
      // A provider response may have been billed even when the application
      // did not receive a valid plan. Inspect the journaled request rather
      // than replaying a possibly paid planner call.
      const current = this.runtime.get(userId, runId);
      if (current?.status !== "planning") return current ?? claimed;
      const request = this.service.store.request(userId, `plan-${claimed.stepId}`);
      const outcome = request?.status === "pending" || request?.status === "uncertain" ? "unknown" : "failed";
      return this.runtime.failPlanning(userId, runId, safeErrorCode(error), outcome);
    }
  }

  private async applyPlanResponse(userId: string, runId: string, snapshot: MediaTaskSnapshot,
    response: Pick<AiChatResponse, "toolPlan" | "toolClarification">, planRequestId: string): Promise<MediaTaskRun> {
    if (this.now() >= snapshot.deadlineAt) return this.runtime.failPlanning(userId, runId, "AI_MEDIA_TASK_DEADLINE");
    if (await this.configurationVersion(snapshot.intent, snapshot.tier) !== snapshot.modelConfigVersion) {
      return this.runtime.failPlanning(userId, runId, "AI_CONFIG_CHANGED");
    }
    const source = await this.scopedSources(userId, snapshot);
    if (snapshot.sourceAssetIds.length && (snapshot.sourceFingerprints === undefined
      || JSON.stringify(source.fingerprints) !== JSON.stringify(snapshot.sourceFingerprints))) {
      return this.runtime.failPlanning(userId, runId, "AI_MEDIA_TASK_SOURCE_CHANGED");
    }
    if (response.toolClarification) {
      return this.runtime.awaitInput(userId, runId, response.toolClarification, Math.min(snapshot.deadlineAt, this.now() + 5 * 60_000));
    }
    const plan = response.toolPlan;
    if (!plan || plan.kind !== snapshot.intent) rejected("AI_MEDIA_TASK_PLAN_INVALID", "AI 未返回完整的媒体方案");
    const cost = this.estimatedPoints(userId, snapshot.intent);
    const staged = this.runtime.stageTool(userId, runId, {
      capability: snapshot.intent, operationKey: planRequestId, estimatedPoints: cost,
      sourceAssetIds: [...snapshot.sourceAssetIds], planRequestId,
    });
    return staged.authorization ? this.executeAuthorized(userId, runId) : staged;
  }

  /** Recover a claimed plan from the durable AiService journal. Never post the
   * planner request again after a crash, even if the journal row is absent. */
  private async reconcilePlanning(userId: string, runId: string): Promise<MediaTaskRun> {
    const run = expectedRun(this.runtime, userId, runId);
    if (run.status !== "planning") return run;
    const snapshot = this.runtime.snapshot(userId, runId);
    if (!snapshot) return this.runtime.failPlanning(userId, runId, "AI_MEDIA_TASK_SNAPSHOT_MISSING", "unknown");
    const planRequestId = `plan-${run.stepId}`;
    try { this.service.getRequestResult(userId, planRequestId); } catch { /* An absent journal is handled below. */ }
    const request = this.service.store.request(userId, planRequestId);
    if (!request) return this.runtime.failPlanning(userId, runId, "AI_MEDIA_TASK_PLAN_UNRECORDED", "unknown");
    if (request.status === "failed") return this.runtime.failPlanning(userId, runId, request.error?.code ?? "AI_MEDIA_TASK_PLAN_FAILED");
    if (request.status === "uncertain") return this.runtime.failPlanning(userId, runId, request.error?.code ?? "AI_MEDIA_TASK_PLAN_UNCERTAIN", "unknown");
    if (request.status === "pending") {
      return this.now() >= run.deadlineAt
        ? this.runtime.failPlanning(userId, runId, "AI_MEDIA_TASK_PLAN_TIMEOUT", "unknown")
        : this.runtime.schedulePoll(userId, runId);
    }
    if (!request.result) return this.runtime.failPlanning(userId, runId, "AI_MEDIA_TASK_PLAN_RESULT_MISSING", "unknown");
    try { return await this.applyPlanResponse(userId, runId, snapshot, request.result, planRequestId); }
    catch (error) {
      const latest = expectedRun(this.runtime, userId, runId);
      return latest.status === "planning" ? this.runtime.failPlanning(userId, runId, safeErrorCode(error)) : latest;
    }
  }

  /** A successful explicit click creates a short-lived, server-derived grant.
   * The existing image/video service then performs its authoritative atomic
   * reservation; this precheck is advisory and cannot mint quota. */
  async authorizeAndExecute(userId: string, runId: string, confirmation: MediaTaskConfirmation): Promise<MediaTaskRun> {
    this.service.store.assertAccess(userId);
    if (confirmation?.confirmed !== true) rejected("AI_MEDIA_TASK_CONFIRMATION_REQUIRED", "请确认本次生成", 400);
    let run = expectedRun(this.runtime, userId, runId);
    if (["completed", "failed", "cancelled"].includes(run.status)) return run;
    if (run.status === "running" || run.status === "partial" || run.status === "unknown") return this.reconcile(userId, runId);
    if (run.status !== "awaiting_authorization" || !run.tool) rejected("AI_MEDIA_TASK_NOT_READY", "任务尚未准备好生成");
    const snapshot = this.runtime.snapshot(userId, runId);
    if (!snapshot) rejected("AI_MEDIA_TASK_SNAPSHOT_MISSING", "任务快照不存在");
    const current = await this.guard(userId, run);
    if (current.modelConfigVersion !== snapshot.modelConfigVersion) rejected("AI_CONFIG_CHANGED", "模型配置已改变，请重新整理任务");
    if (!current.sourceAssetsValid) rejected("AI_MEDIA_TASK_SOURCE_UNAVAILABLE", "参考素材已失效，请重新整理任务");
    const cost = this.estimatedPoints(userId, snapshot.intent);
    if (!Number.isSafeInteger(confirmation.maxPointsPerTool) || confirmation.maxPointsPerTool < cost || confirmation.maxPointsPerTool > 10_000_000) {
      rejected("AI_MEDIA_TASK_BUDGET_INVALID", "确认额度不足或超出范围", 400);
    }
    if (current.availablePoints < cost) rejected("AI_QUOTA_INSUFFICIENT", "可用额度不足", 402);
    const expiresAt = Math.min(confirmation.expiresAt ?? this.now() + 5 * 60_000, run.deadlineAt);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now()) rejected("AI_MEDIA_TASK_GRANT_EXPIRED", "确认已过期", 400);
    const grant: MediaTaskAuthorizationScope = {
      grantId: crypto.randomUUID(), capabilities: [snapshot.intent], sourceAssetIds: [...snapshot.sourceAssetIds],
      maxPointsPerTool: confirmation.maxPointsPerTool, budgetVersion: current.budgetVersion,
      modelConfigVersion: current.modelConfigVersion, automaticChoice: confirmation.automaticChoice === true,
      expiresAt,
    };
    this.runtime.grantAuthorization(userId, runId, grant);
    return this.executeAuthorized(userId, runId);
  }

  /** Consume only a persisted grant whose tenant, member, source, model and
   * budget still match. A stale grant becomes a waiting draft, never payment. */
  private async executeAuthorized(userId: string, runId: string): Promise<MediaTaskRun> {
    const run = expectedRun(this.runtime, userId, runId);
    const snapshot = this.runtime.snapshot(userId, runId);
    if (!snapshot) rejected("AI_MEDIA_TASK_SNAPSHOT_MISSING", "任务快照不存在");
    if (run.status !== "awaiting_authorization" || !run.tool || !run.authorization) return run;
    const started = this.runtime.beginTool(userId, runId, await this.guard(userId, run));
    if (started.kind === "already_started") return this.reconcile(userId, runId);
    if (started.kind !== "started") {
      if (started.kind === "expired" || started.kind === "unknown") return started.run;
      return this.runtime.pauseAuthorization(userId, runId, `AI_MEDIA_GRANT_${started.kind.toUpperCase()}`);
    }
    const tool = started.run.tool!;
    const toolCallId = tool.toolCallId!;
    try {
      const planRequestId = tool.planRequestId;
      if (!planRequestId) rejected("AI_MEDIA_TASK_PLAN_MISSING", "媒体方案不存在");
      const planned = this.service.store.request(userId, planRequestId);
      const prompt = planned?.result?.toolPlan?.prompt;
      if (!prompt) rejected("AI_MEDIA_TASK_PLAN_MISSING", "媒体方案不存在");
      validateToolPlan(this.service.store, userId, planRequestId, snapshot.intent, prompt, { consumerRequestId: toolCallId });
      if (snapshot.intent === "image") {
        const source = await this.scopedSources(userId, snapshot);
        const result = await this.service.generateImage(userId, {
          requestId: toolCallId, conversationId: snapshot.conversationId, prompt, planRequestId,
          ...(source.attachments.length ? { attachments: source.attachments } : {}),
        });
        return this.runtime.completeTool(userId, runId, toolCallId, result.images.map(item => item.assetId));
      }
      const params = snapshot.videoParameters;
      if (!params) rejected("AI_MEDIA_TASK_VIDEO_PARAMETERS", "视频参数不存在");
      const job = await this.service.video.submit(userId, {
        requestId: toolCallId, conversationId: snapshot.conversationId, prompt, planRequestId,
        model: params.model, seconds: params.seconds, resolution: params.resolution,
        aspectRatio: params.aspectRatio, referenceIds: params.referenceIds,
      });
      return this.applyVideoJob(userId, runId, toolCallId, job);
    } catch (error) {
      return this.reconcileAfterExecutionError(userId, runId, toolCallId, error);
    }
  }

  private async verifiedVideoArtifact(userId: string, jobId: string): Promise<boolean> {
    // A provider status flag is not a playable artifact. Read only the MP4
    // header through the already bounded video content route, then cancel the
    // stream. The video is not downloaded repeatedly or stored in this task.
    const response = await this.service.video.content(userId, jobId);
    if (!response.ok || !/^video\/mp4(?:;|$)/i.test(response.headers.get("content-type") ?? "") || !response.body) return false;
    const reader = response.body.getReader();
    const prefix: number[] = [];
    try {
      while (prefix.length < 32) {
        const part = await reader.read();
        if (part.done) break;
        for (const byte of part.value) {
          if (prefix.length < 32) prefix.push(byte);
        }
      }
    } finally { await reader.cancel().catch(() => {}); }
    return prefix.length >= 12 && prefix[4] === 0x66 && prefix[5] === 0x74 && prefix[6] === 0x79 && prefix[7] === 0x70;
  }

  private async applyVideoJob(userId: string, runId: string, toolCallId: string, job: AiVideoJob): Promise<MediaTaskRun> {
    if (job.id !== toolCallId) rejected("AI_MEDIA_TASK_JOB_MISMATCH", "视频任务标识不一致");
    if (job.status === "completed") {
      try {
        if (await this.verifiedVideoArtifact(userId, job.id)) return this.runtime.completeTool(userId, runId, toolCallId, [job.id]);
      } catch { /* Status alone is not proof of accessible bytes. */ }
      return this.runtime.failTool(userId, runId, toolCallId, "AI_VIDEO_CONTENT_UNVERIFIED", "unknown");
    }
    if (job.status === "failed") return this.runtime.failTool(userId, runId, toolCallId, "AI_VIDEO_FAILED", "failed");
    if (job.status === "uncertain") return this.runtime.failTool(userId, runId, toolCallId, "AI_VIDEO_UNCERTAIN", "unknown");
    return this.runtime.recordToolSubmission(userId, runId, toolCallId, job.id, this.now() + VIDEO_POLL_MS);
  }

  private async reconcileAfterExecutionError(userId: string, runId: string, toolCallId: string, error: unknown): Promise<MediaTaskRun> {
    const snapshot = this.runtime.snapshot(userId, runId);
    if (!snapshot) return this.runtime.failTool(userId, runId, toolCallId, "AI_MEDIA_TASK_SNAPSHOT_MISSING", "unknown");
    if (snapshot.intent === "image") {
      const request = this.service.store.request(userId, toolCallId);
      if (request?.imageResult?.images.length) return this.runtime.completeTool(userId, runId, toolCallId, request.imageResult.images.map(item => item.assetId));
      if (request?.status === "failed") return this.runtime.failTool(userId, runId, toolCallId, request.error?.code ?? safeErrorCode(error), "failed");
      return this.runtime.failTool(userId, runId, toolCallId, safeErrorCode(error), request ? "unknown" : "failed");
    }
    const job = this.service.video.list(userId, snapshot.tier).jobs.find(item => item.id === toolCallId);
    if (job) return this.applyVideoJob(userId, runId, toolCallId, job);
    return this.runtime.failTool(userId, runId, toolCallId, safeErrorCode(error), "unknown");
  }

  private async reconcile(userId: string, runId: string): Promise<MediaTaskRun> {
    const run = expectedRun(this.runtime, userId, runId);
    if (!run.tool?.toolCallId || !["running", "partial", "unknown"].includes(run.status)) return run;
    const toolCallId = run.tool.toolCallId;
    const snapshot = this.runtime.snapshot(userId, runId);
    if (!snapshot) return this.runtime.failTool(userId, runId, toolCallId, "AI_MEDIA_TASK_SNAPSHOT_MISSING", "unknown");
    if (snapshot.intent === "image") {
      try { this.service.getRequestResult(userId, toolCallId); } catch { /* An absent journal is handled below. */ }
      const request = this.service.store.request(userId, toolCallId);
      if (request?.imageResult?.images.length) return this.runtime.completeTool(userId, runId, toolCallId, request.imageResult.images.map(item => item.assetId));
      if (request?.status === "failed") return this.runtime.failTool(userId, runId, toolCallId, request.error?.code ?? "AI_IMAGE_FAILED", "failed");
      if (request?.status === "uncertain") return this.runtime.failTool(userId, runId, toolCallId, request.error?.code ?? "AI_IMAGE_UNCERTAIN", "unknown");
      if (!request) return this.runtime.failTool(userId, runId, toolCallId, "AI_MEDIA_TASK_UNRECORDED", "unknown");
      if (this.now() >= run.deadlineAt) return this.runtime.failTool(userId, runId, toolCallId, "AI_MEDIA_TASK_IMAGE_TIMEOUT", "unknown");
      return this.runtime.schedulePoll(userId, runId);
    }
    const job = this.service.video.list(userId, snapshot.tier).jobs.find(item => item.id === toolCallId);
    if (!job) return this.runtime.failTool(userId, runId, toolCallId, "AI_MEDIA_TASK_UNRECORDED", "unknown");
    if (["queued", "processing", "submitting"].includes(job.status) && run.status !== "unknown") {
      if (this.now() >= run.deadlineAt) return this.runtime.failTool(userId, runId, toolCallId, "AI_MEDIA_TASK_VIDEO_TIMEOUT", "unknown");
      try { return this.applyVideoJob(userId, runId, toolCallId, await this.service.video.refresh(userId, toolCallId)); }
      catch { return this.runtime.schedulePoll(userId, runId); /* Poll failures do not resubmit. */ }
    }
    if (run.status === "unknown" && ["queued", "processing", "submitting"].includes(job.status)) return run;
    return this.applyVideoJob(userId, runId, toolCallId, job);
  }
}

export function createAiServiceMediaTaskOrchestrator(service: AiService): AiServiceMediaTaskOrchestrator {
  return new AiServiceMediaTaskOrchestrator(service);
}
