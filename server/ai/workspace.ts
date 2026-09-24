import { AI_WORKSPACE_LIMITS as LIMITS, type AiWorkspaceArtifact, type AiWorkspaceConversation, type AiWorkspaceProject, type AiWorkspaceSaveRequest, type AiWorkspaceSnapshot, type AiWorkspaceState } from "../../shared/aiWorkspace";
import { AiError } from "./security";
import { AiStore, type AiSql } from "./storage";
import { AI_MEDIA_LIMITS } from "../../shared/aiMedia";
import { validateImageBase64 } from "./capabilities";
import { DEFAULT_AI_TENANT_ID, normalizeAiTenantId, tenantStorageKey } from "./tenant";
import { AI_WORKFLOW_VERSION, aiWorkflowTemplate } from "../../shared/aiWorkflows";
import { videoModel } from "../../shared/aiVideoModels";

export const AI_WORKSPACE_SCHEMA = `
CREATE TABLE IF NOT EXISTS ai_workspaces (
  user_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_AI_TENANT_ID}',
  revision INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_workspace_mutations (
  user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_AI_TENANT_ID}',
  mutation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY(user_id, mutation_id)
);
CREATE TABLE IF NOT EXISTS ai_workspace_chunks (
  user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_AI_TENANT_ID}',
  chunk_index INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY(user_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS ai_workspace_mutations_revision ON ai_workspace_mutations(user_id, revision DESC);
CREATE TABLE IF NOT EXISTS ai_workspace_v2_shadow_meta (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  staged_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,user_id)
);
CREATE TABLE IF NOT EXISTS ai_workspace_v2_shadow_segments (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY(tenant_id,user_id,kind,entity_id,chunk_index)
);
`;

const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHUNK_MARKER = "@chunks-v1";
const forbiddenKeys = new Set(["__proto__", "constructor", "prototype"]);
const HARNESS_TIERS = new Set(["quick", "standard", "deep", "pro"]);
const HARNESS_STRATEGIES = new Set(["direct", "react", "plan_execute"]);
const HARNESS_RUN_STATUSES = new Set(["planned", "running", "waiting_approval", "succeeded", "failed", "cancelled", "uncertain"]);
const HARNESS_NEXT_ACTIONS = new Set(["none", "poll", "approve_tool", "resume"]);
const HARNESS_STEP_KINDS = new Set(["strategy", "route", "workflow", "plan", "model", "tool", "approval", "result"]);
const LEGACY_HARNESS_STEP_KINDS = new Set(["route", "model", "tool", "approval", "result"]);
const HARNESS_CAPABILITIES = new Set(["chat", "vision", "web_search", "image", "video", "presentation", "computer"]);
const HARNESS_STEP_STATUSES = new Set(["planned", "waiting_approval", "running", "succeeded", "failed", "cancelled"]);
const HARNESS_APPROVAL_STATUSES = new Set(["not_required", "waiting", "approved", "consumed", "cancelled"]);
const HARNESS_STEP_FIELDS = [
  "id", "kind", "capability", "title", "summary", "status", "createdAt", "updatedAt",
  "strategy", "maxToolSteps", "workflowId", "workflowVersion", "workflowStepId",
  "proposalId", "sequence", "requiresApproval", "approvalStatus", "executionRequestId",
] as const;
type ObjectValue = Record<string, unknown>;

/** Reuse the exact V1 field rules when a future V2 protocol writes one entity. */
export function validateAiWorkspaceDraft(value: unknown): string {
  string(value, "草稿", LIMITS.draftCharacters);
  return value;
}

export function validateAiWorkspaceVideoDraftSetting(value: unknown): Record<string, unknown> {
  const draft = record(value, "视频草稿参数", ["model", "seconds", "resolution", "aspectRatio"]);
  if (draft.model !== undefined && (typeof draft.model !== "string" || !videoModel(draft.model))) invalid("视频草稿模型无效");
  boundedInteger(draft.seconds, "视频草稿时长", 1, 30);
  if (!["480p", "720p", "768p", "1080p"].includes(String(draft.resolution))) invalid("视频草稿清晰度无效");
  if (!["16:9", "9:16", "1:1"].includes(String(draft.aspectRatio))) invalid("视频草稿画幅无效");
  return draft;
}

function invalid(message: string): never { throw new AiError(400, "AI_WORKSPACE_INVALID", message); }
function tooLarge(message: string): never { throw new AiError(413, "AI_WORKSPACE_TOO_LARGE", message); }
function record(value: unknown, label: string, keys?: readonly string[]): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label}格式不正确`);
  const result = value as ObjectValue;
  for (const key of Object.keys(result)) {
    if (forbiddenKeys.has(key) || (keys && !keys.includes(key))) invalid(`${label}包含不支持的字段，请更新客户端后重试`);
  }
  return result;
}
function string(value: unknown, label: string, max: number, nonempty = false): asserts value is string {
  if (typeof value !== "string" || (nonempty && !value.trim()) || value.includes("\u0000")) invalid(`${label}格式不正确`);
  if (value.length > max) tooLarge(`${label}过长，原记录未被更改`);
}
function id(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !ID.test(value) || forbiddenKeys.has(value)) invalid(`${label}标识无效`);
}
function optionalId(value: unknown, label: string): void { if (value !== undefined) id(value, label); }
function harnessStepId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 160 || (!ID.test(value) && !(value.startsWith("result:") && ID.test(value.slice("result:".length))))) invalid("处理步骤标识无效");
}
function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) invalid(`${label}格式不正确`);
}
function isoTimestamp(value: unknown, label: string): asserts value is string {
  string(value, label, 80, true);
  try {
    if (new Date(value).toISOString() !== value) invalid(`${label}格式不正确`);
  } catch { invalid(`${label}格式不正确`); }
}
function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value)) invalid(`${label}格式不正确`);
  if (value.length > max) tooLarge(`${label}数量超过上限，原记录未被更改`);
  return value;
}
function unique(value: string, set: Set<string>, label: string): void {
  if (set.has(value)) invalid(`${label}标识重复`);
  set.add(value);
}
function jsonValue(value: unknown, depth = 0): void {
  if (depth > 12) invalid("结构化内容嵌套过深");
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach(item => jsonValue(item, depth + 1)); return; }
  if (typeof value === "object" && value) {
    const item = record(value, "结构化内容");
    for (const child of Object.values(item)) jsonValue(child, depth + 1);
    return;
  }
  invalid("工作台只能保存有效 JSON 内容");
}
function documents(value: unknown, label: string): void {
  if (value === undefined) return;
  const ids = new Set<string>();
  for (const raw of array(value, label, LIMITS.documentsPerContainer)) {
    const doc = record(raw, label, ["id", "name", "mimeType", "content", "createdAt", "media"]);
    id(doc.id, label); unique(doc.id, ids, label);
    string(doc.name, "文件名称", 240, true);
    string(doc.mimeType, "文件类型", 160, true);
    string(doc.content, "文件内容", LIMITS.documentCharacters);
    if (doc.createdAt !== undefined) string(doc.createdAt, "文件时间", 80);
    if (doc.media !== undefined) {
      const media = record(doc.media, "视觉附件", ["kind", "frames", "durationSeconds", "selectedFrameIndex"]);
      if (media.kind !== "image" && media.kind !== "video") invalid("视觉附件类型无效");
      if (media.kind === "video") {
        if (typeof media.durationSeconds !== "number" || !Number.isFinite(media.durationSeconds) || media.durationSeconds <= 0 || media.durationSeconds > AI_MEDIA_LIMITS.videoSeconds) invalid("视频时长无效");
      } else if (media.durationSeconds !== undefined) invalid("图片不能包含视频时长");
      const frames = array(media.frames, "采样画面", media.kind === "image" ? 1 : AI_MEDIA_LIMITS.videoFrames);
      if (!frames.length) invalid("视觉附件缺少画面");
      if (media.selectedFrameIndex !== undefined && (media.kind !== "video" || !Number.isInteger(media.selectedFrameIndex) || Number(media.selectedFrameIndex) < 0 || Number(media.selectedFrameIndex) >= frames.length)) invalid("视频参考帧选择无效");
      let previousTime = -1;
      for (const rawFrame of frames) {
        const frame = record(rawFrame, "采样画面", ["dataUrl", "timeSeconds"]);
        string(frame.dataUrl, "图片数据", Math.ceil(AI_MEDIA_LIMITS.frameBytes / 3) * 4 + 40, true);
        const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(frame.dataUrl);
        if (!match) invalid("视觉附件只能保存压缩后的 PNG、JPEG 或 WebP 画面");
        const image = validateImageBase64(match[2], AI_MEDIA_LIMITS.frameBytes, 400);
        if (image.mimeType !== match[1] || image.width > AI_MEDIA_LIMITS.frameDimension || image.height > AI_MEDIA_LIMITS.frameDimension) invalid("视觉附件格式或尺寸无效");
        if (media.kind === "video") {
          if (typeof frame.timeSeconds !== "number" || !Number.isFinite(frame.timeSeconds) || frame.timeSeconds < 0 || frame.timeSeconds <= previousTime || frame.timeSeconds >= Number(media.durationSeconds)) invalid("视频采样时间无效");
          previousTime = frame.timeSeconds;
        } else if (frame.timeSeconds !== undefined) invalid("图片不能包含视频采样时间");
      }
    }
  }
}
function usage(value: unknown): void {
  if (value === undefined) return;
  const item = record(value, "消息用量", ["inputTokens", "outputTokens", "totalTokens", "estimated", "convertedTokens", "billingKind", "searchCalls", "tokenUsageEstimated"]);
  for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    if (!Number.isSafeInteger(item[key]) || Number(item[key]) < 0) invalid("消息用量格式不正确");
  }
  if (item.convertedTokens !== undefined && (!Number.isSafeInteger(item.convertedTokens) || Number(item.convertedTokens) < 0)) invalid("消息折算用量格式不正确");
  if (item.searchCalls !== undefined && (!Number.isSafeInteger(item.searchCalls) || Number(item.searchCalls) < 0 || Number(item.searchCalls) > 3)) invalid("消息搜索次数格式不正确");
  if (item.tokenUsageEstimated !== undefined && typeof item.tokenUsageEstimated !== "boolean") invalid("消息文本用量核对状态格式不正确");
  if (item.billingKind !== undefined && !["tokens", "image_conversion", "tokens_with_search"].includes(String(item.billingKind))) invalid("消息计量类型格式不正确");
  if (Number(item.inputTokens) + Number(item.outputTokens) + Number(item.convertedTokens ?? 0) !== item.totalTokens || typeof item.estimated !== "boolean") invalid("消息用量格式不正确");
  // Display metadata only: quota accounting must exclusively use the server AI ledger.
}
function harnessTrace(value: unknown): void {
  if (value === undefined) return;
  const trace = record(value, "处理过程", ["runId", "tier", "strategy", "status", "reasoningSummary", "nextAction", "toolBudget", "steps"]);
  id(trace.runId, "处理过程");
  if (!HARNESS_TIERS.has(String(trace.tier))) invalid("处理档位无效");
  if (!HARNESS_RUN_STATUSES.has(String(trace.status))) invalid("处理状态无效");
  string(trace.reasoningSummary, "处理摘要", 1000, true);
  const legacy = trace.strategy === undefined && trace.nextAction === undefined && trace.toolBudget === undefined;
  if (!legacy && (trace.strategy === undefined || trace.nextAction === undefined || trace.toolBudget === undefined)) invalid("处理过程版本不完整，请更新客户端后重试");
  if (!legacy && !HARNESS_STRATEGIES.has(String(trace.strategy))) invalid("处理策略无效");
  if (!legacy && !HARNESS_NEXT_ACTIONS.has(String(trace.nextAction))) invalid("处理下一步状态无效");
  const stepIds = new Set<string>();
  const steps = array(trace.steps, "处理步骤", LIMITS.harnessStepsPerTrace);
  let toolSteps = 0;
  let publicSchemaUsed = false;
  let strategySteps = 0;
  let strategyMaxToolSteps: number | undefined;
  for (const rawStep of steps) {
    const step = record(rawStep, "处理步骤", HARNESS_STEP_FIELDS);
    harnessStepId(step.id); unique(step.id, stepIds, "处理步骤");
    if (!HARNESS_STEP_KINDS.has(String(step.kind))) invalid("处理步骤类型无效");
    if (!HARNESS_CAPABILITIES.has(String(step.capability))) invalid("处理步骤能力无效");
    if (!HARNESS_STEP_STATUSES.has(String(step.status))) invalid("处理步骤状态无效");
    string(step.title, "处理步骤标题", 160, true); string(step.summary, "处理步骤摘要", 500, true);
    isoTimestamp(step.createdAt, "处理步骤时间"); isoTimestamp(step.updatedAt, "处理步骤时间");
    if (Date.parse(step.updatedAt) < Date.parse(step.createdAt)) invalid("处理步骤时间顺序无效");

    const hasStrategyFields = step.strategy !== undefined || step.maxToolSteps !== undefined;
    const hasWorkflowFields = step.workflowId !== undefined || step.workflowVersion !== undefined || step.workflowStepId !== undefined;
    const hasProposalFields = step.proposalId !== undefined || step.sequence !== undefined || step.requiresApproval !== undefined || step.approvalStatus !== undefined || step.executionRequestId !== undefined;
    publicSchemaUsed ||= !LEGACY_HARNESS_STEP_KINDS.has(String(step.kind)) || hasStrategyFields || hasWorkflowFields || hasProposalFields;

    if (step.kind === "strategy") {
      strategySteps += 1;
      if (!HARNESS_STRATEGIES.has(String(step.strategy))) invalid("处理步骤策略无效");
      boundedInteger(step.maxToolSteps, "处理步骤工具上限", 1, 8);
      if (step.strategy === "direct" && step.maxToolSteps !== 1) invalid("直接执行策略只能包含一个工具步骤");
      strategyMaxToolSteps = step.maxToolSteps;
    } else if (hasStrategyFields) invalid("仅策略步骤可以包含策略快照");

    if (hasWorkflowFields) {
      if (step.kind !== "strategy" && step.kind !== "workflow") invalid("处理步骤包含无效的工作流字段");
      const template = aiWorkflowTemplate(step.workflowId);
      if (!template || step.workflowVersion !== AI_WORKFLOW_VERSION) invalid("处理步骤工作流无效");
      if (step.kind === "workflow") {
        if (typeof step.workflowStepId !== "string" || !template.steps.some(item => item.id === step.workflowStepId)) invalid("处理步骤工作流节点无效");
      } else if (step.workflowStepId !== undefined) invalid("策略步骤不能包含工作流节点");
    } else if (step.kind === "workflow") invalid("工作流步骤缺少代码拥有的模板快照");

    if (hasProposalFields) {
      if (step.kind !== "tool" && step.kind !== "approval" && step.kind !== "result") invalid("处理步骤包含无效的工具提案字段");
      optionalId(step.proposalId, "工具提案"); optionalId(step.executionRequestId, "工具执行请求");
      if (step.sequence !== undefined) boundedInteger(step.sequence, "工具步骤序号", 1, 8);
      if (step.requiresApproval !== undefined && typeof step.requiresApproval !== "boolean") invalid("工具确认要求格式不正确");
      if (step.approvalStatus !== undefined && !HARNESS_APPROVAL_STATUSES.has(String(step.approvalStatus))) invalid("工具确认状态无效");
    }
    if (step.kind === "tool") toolSteps += 1;
  }
  if (legacy) {
    if (publicSchemaUsed) invalid("处理过程版本不完整，请更新客户端后重试");
    return;
  }
  if (strategySteps !== 1 || strategyMaxToolSteps === undefined) invalid("处理过程缺少唯一的策略快照");
  if (trace.strategy !== (steps.find(raw => (raw as ObjectValue).kind === "strategy") as ObjectValue | undefined)?.strategy) invalid("处理策略与步骤快照不一致");
  const budget = record(trace.toolBudget, "处理工具预算", ["used", "max", "remaining"]);
  boundedInteger(budget.used, "处理工具已用步数", 0, 8);
  boundedInteger(budget.max, "处理工具上限", 1, 8);
  boundedInteger(budget.remaining, "处理工具剩余步数", 0, 8);
  if (trace.strategy === "direct" && budget.max !== 1) invalid("直接执行策略只能包含一个工具步骤");
  if (budget.max !== strategyMaxToolSteps || budget.used !== toolSteps || budget.remaining !== budget.max - budget.used) invalid("处理工具预算不一致");
  const expectedAction = trace.status === "waiting_approval" ? "approve_tool" : trace.status === "running" ? "poll" : trace.status === "planned" ? "resume" : "none";
  if (trace.nextAction !== expectedAction) invalid("处理下一步状态与任务状态不一致");
}

/** Keep all field rules shared; only the legacy whole-account write enforces
 * the 8 MiB aggregate cap. V2 still needs independent per-entity size caps. */
function validatedWorkspaceState(value: unknown, enforceAggregateLimit: boolean): AiWorkspaceState {
  const state = record(value, "工作台", ["view", "mode", "conversations", "projects", "artifacts", "drafts", "draftAttachments", "videoDraftSettings", "composerTool", "webSearch", "activeConversationId", "activeProjectId", "enabledSkillIds", "sidebarCollapsed"]);
  if (!["chat", "project", "skills"].includes(String(state.view)) || !["quick", "standard", "deep", "pro"].includes(String(state.mode))) invalid("工作台页面或模式无效");
  if (state.sidebarCollapsed !== undefined && typeof state.sidebarCollapsed !== "boolean") invalid("侧栏状态无效");
  if (state.composerTool !== undefined && !["text", "presentation", "image"].includes(String(state.composerTool))) invalid("生成模式无效");
  if (state.webSearch !== undefined && typeof state.webSearch !== "boolean") invalid("联网搜索状态无效");
  const projectIds = new Set<string>();
  for (const raw of array(state.projects, "项目", LIMITS.projects)) {
    const project = record(raw, "项目", ["id", "title", "timeLabel", "instructions", "contextDocuments"]);
    id(project.id, "项目"); unique(project.id, projectIds, "项目");
    string(project.title, "项目名称", LIMITS.titleCharacters, true);
    string(project.timeLabel, "项目时间", 80);
    if (project.instructions !== undefined) string(project.instructions, "项目说明", LIMITS.instructionsCharacters);
    documents(project.contextDocuments, "项目资料");
  }
  const conversationIds = new Set<string>();
  const messageIds = new Set<string>();
  const conversationProjects = new Map<string, string | undefined>();
  const messageArtifactRefs: Array<{ conversationId: string; artifactId: string }> = [];
  let totalMessages = 0;
  for (const raw of array(state.conversations, "对话", LIMITS.conversations)) {
    const conversation = record(raw, "对话", ["id", "title", "timeLabel", "projectId", "messages"]);
    id(conversation.id, "对话"); unique(conversation.id, conversationIds, "对话");
    string(conversation.title, "对话名称", LIMITS.titleCharacters, true);
    string(conversation.timeLabel, "对话时间", 80);
    optionalId(conversation.projectId, "所属项目");
    if (conversation.projectId !== undefined && !projectIds.has(conversation.projectId as string)) invalid("对话所属项目不存在，请同步最新记录");
    conversationProjects.set(conversation.id, conversation.projectId as string | undefined);
    const messages = array(conversation.messages, "对话消息", LIMITS.messagesPerConversation);
    totalMessages += messages.length;
    if (totalMessages > LIMITS.totalMessages) tooLarge("消息总数超过上限，原记录未被更改");
    for (const entry of messages) {
      const message = record(entry, "消息", ["id", "role", "content", "analysisSummary", "completion", "retryDisposition", "taskPhase", "time", "startedAt", "status", "artifactId", "requestId", "harnessPlanRequestId", "model", "usage", "attachments", "sources", "trace"]);
      if (message.retryDisposition !== undefined && !["recover", "regenerate"].includes(String(message.retryDisposition))) invalid("回复重试方式无效");
      id(message.id, "消息"); unique(message.id, messageIds, "消息");
      if (message.role !== "user" && message.role !== "assistant") invalid("消息角色无效");
      string(message.content, "消息内容", LIMITS.messageCharacters);
      if (message.analysisSummary !== undefined) string(message.analysisSummary, "分析摘要", 1000, true);
      if (message.taskPhase !== undefined && !["queued", "planning", "awaiting_input", "awaiting_authorization", "running", "partial", "completed", "failed", "cancelled", "unknown"].includes(String(message.taskPhase))) invalid("任务阶段无效");
      if (message.completion !== undefined) {
        const completion = record(message.completion, "回复状态", ["state", "reason", "canContinue"]);
        if (completion.state !== "partial" || !["output_limit", "stream_interrupted"].includes(String(completion.reason)) || typeof completion.canContinue !== "boolean") invalid("回复状态无效");
      }
      string(message.time, "消息时间", 80);
      if (message.startedAt !== undefined && (!Number.isSafeInteger(message.startedAt) || Number(message.startedAt) < 0)) invalid("消息计时格式不正确");
      if (message.status !== undefined && !["thinking", "typing", "ready", "error", "stopped"].includes(String(message.status))) invalid("消息状态无效");
      optionalId(message.artifactId, "成果"); optionalId(message.requestId, "请求"); optionalId(message.harnessPlanRequestId, "工具方案");
      if (message.model !== undefined) string(message.model, "模型名称", 160);
      usage(message.usage); documents(message.attachments, "消息附件"); harnessTrace(message.trace);
      if (message.sources !== undefined) {
        for (const rawSource of array(message.sources, "引用来源", 100)) {
          const source = record(rawSource, "引用来源", ["title", "url"]);
          string(source.title, "来源标题", 1000);
          string(source.url, "来源链接", 4096, true);
          let url: URL;
          try { url = new URL(source.url); } catch { invalid("来源链接格式不正确"); }
          if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) invalid("来源链接必须为不带账号密码的 HTTP(S) 地址");
        }
      }
      if (typeof message.artifactId === "string") messageArtifactRefs.push({ conversationId: conversation.id, artifactId: message.artifactId });
    }
  }
  const artifactIds = new Set<string>();
  const artifactConversations = new Map<string, string>();
  for (const raw of array(state.artifacts, "成果", LIMITS.artifacts)) {
    const artifact = record(raw, "成果", ["id", "conversationId", "projectId", "title", "kind", "updatedLabel", "summary", "sections", "data"]);
    id(artifact.id, "成果"); unique(artifact.id, artifactIds, "成果");
    id(artifact.conversationId, "成果所属对话"); optionalId(artifact.projectId, "成果所属项目");
    if (!conversationIds.has(artifact.conversationId)) invalid("成果所属对话不存在，请一并处理关联成果");
    if (artifact.projectId !== undefined && artifact.projectId !== conversationProjects.get(artifact.conversationId)) invalid("成果与对话的所属项目不一致");
    artifactConversations.set(artifact.id, artifact.conversationId);
    string(artifact.title, "成果名称", LIMITS.titleCharacters, true);
    string(artifact.kind, "成果类型", 80, true);
    string(artifact.updatedLabel, "成果时间", 80);
    string(artifact.summary, "成果摘要", 24000);
    for (const rawSection of array(artifact.sections, "成果章节", 100)) {
      const section = record(rawSection, "成果章节", ["heading", "lines"]);
      string(section.heading, "章节标题", 500);
      for (const line of array(section.lines, "章节内容", 500)) string(line, "章节内容", 24000);
    }
    if (artifact.data !== undefined) jsonValue(record(artifact.data, "成果数据"));
  }
  for (const reference of messageArtifactRefs) {
    if (artifactConversations.get(reference.artifactId) !== reference.conversationId) invalid("消息关联成果不存在或不属于该对话");
  }
  if (state.activeConversationId !== null) {
    id(state.activeConversationId, "当前对话");
    if (!conversationIds.has(state.activeConversationId)) invalid("当前对话不存在");
  }
  if (state.activeProjectId !== null) {
    id(state.activeProjectId, "当前项目");
    if (!projectIds.has(state.activeProjectId)) invalid("当前项目不存在");
  }
  if (state.view === "project" && state.activeProjectId === null) invalid("请先选择项目");
  const drafts = record(state.drafts, "草稿");
  if (Object.keys(drafts).length > LIMITS.conversations + LIMITS.projects + 1) tooLarge("草稿数量超过上限");
  for (const [key, draft] of Object.entries(drafts)) {
    if (key !== "new-conversation" && !conversationIds.has(key) && !(key.startsWith("new-project-conversation:") && projectIds.has(key.slice("new-project-conversation:".length)))) invalid("草稿所属对话或项目不存在");
    validateAiWorkspaceDraft(draft);
  }
  if (state.draftAttachments !== undefined) {
    const attachments = record(state.draftAttachments, "草稿附件");
    if (Object.keys(attachments).length > LIMITS.conversations + LIMITS.projects + 1) tooLarge("草稿附件数量超过上限");
    for (const [key, value] of Object.entries(attachments)) {
      if (key !== "new-conversation" && !conversationIds.has(key) && !(key.startsWith("new-project-conversation:") && projectIds.has(key.slice("new-project-conversation:".length)))) invalid("草稿附件所属对话或项目不存在");
      documents(value, "草稿附件");
    }
  }
  if (state.videoDraftSettings !== undefined) {
    const settings = record(state.videoDraftSettings, "视频草稿参数");
    if (Object.keys(settings).length > LIMITS.conversations + LIMITS.projects + 1) tooLarge("视频草稿数量超过上限");
    for (const [key, value] of Object.entries(settings)) {
      if (key !== "new-conversation" && !conversationIds.has(key) && !(key.startsWith("new-project-conversation:") && projectIds.has(key.slice("new-project-conversation:".length)))) invalid("视频草稿所属对话或项目不存在");
      validateAiWorkspaceVideoDraftSetting(value);
    }
  }
  const skillIds = new Set<string>();
  for (const skillId of array(state.enabledSkillIds, "已启用技能", 100)) {
    id(skillId, "技能"); unique(skillId, skillIds, "技能");
  }
  jsonValue(state);
  const serialized = JSON.stringify(state);
  if (enforceAggregateLimit && new TextEncoder().encode(serialized).byteLength > LIMITS.stateBytes) tooLarge("云端对话资料已达安全保存上限，请导出并整理历史记录后重试；原记录未被更改");
  // Isolate the validated request from caller mutations during the asynchronous hash.
  return JSON.parse(serialized) as AiWorkspaceState;
}

/** Validate the entire V1 snapshot before any write. */
export function validateAiWorkspaceState(value: unknown): AiWorkspaceState {
  return validatedWorkspaceState(value, true);
}

function entitySurrogate(projects: unknown[], conversations: unknown[], artifacts: unknown[]): unknown {
  return { view: "chat", mode: "standard", activeConversationId: null, activeProjectId: null,
    enabledSkillIds: [], projects, conversations, artifacts, drafts: {} };
}

/** One entity must fit an active V2 read by itself. Cross-entity batch and
 * account-wide count/reference rules remain the V2 store's responsibility. */
export const AI_WORKSPACE_V2_ENTITY_BYTES = {
  project: 8 * 1024 * 1024,
  conversation: 16 * 1024 * 1024,
  artifact: 8 * 1024 * 1024,
} as const;

function boundedEntity<T>(value: T, maxBytes: number): T {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maxBytes) tooLarge("单条工作台记录超出安全保存上限，原记录未被更改");
  return value;
}

/** The same V1 field rules for one V2 project, without reintroducing the
 * legacy aggregate cap. Cross-entity references are checked by its caller. */
export function validateAiWorkspaceProjectEntity(value: unknown): AiWorkspaceProject {
  return boundedEntity(validatedWorkspaceState(entitySurrogate([value], [], []), false).projects[0], AI_WORKSPACE_V2_ENTITY_BYTES.project);
}

/** Structural validation only. Placeholder artifacts allow the V1 message
 * rules to run; an authorized reader must still resolve their real records. */
export function validateAiWorkspaceConversationEntity(value: unknown): AiWorkspaceConversation {
  const source = record(value, "对话");
  const messages = array(source.messages, "对话消息", LIMITS.messagesPerConversation);
  const projectId = typeof source.projectId === "string" ? source.projectId : undefined;
  const projects = projectId ? [{ id: projectId, title: "关联项目", timeLabel: "" }] : [];
  const artifactIds = new Set(messages.flatMap(message => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return [];
    const artifactId = (message as ObjectValue).artifactId;
    return typeof artifactId === "string" ? [artifactId] : [];
  }));
  const artifacts = Array.from(artifactIds, artifactId => ({ id: artifactId, conversationId: source.id,
    ...(projectId ? { projectId } : {}), title: "关联成果", kind: "note", updatedLabel: "", summary: "", sections: [] }));
  return boundedEntity(validatedWorkspaceState(entitySurrogate(projects, [value], artifacts), false).conversations[0], AI_WORKSPACE_V2_ENTITY_BYTES.conversation);
}

/** Structural validation only; the real conversation and optional project
 * must still be resolved under the same account and tenant. */
export function validateAiWorkspaceArtifactEntity(value: unknown): AiWorkspaceArtifact {
  const source = record(value, "成果");
  const projectId = typeof source.projectId === "string" ? source.projectId : undefined;
  const projects = projectId ? [{ id: projectId, title: "关联项目", timeLabel: "" }] : [];
  const conversations = [{ id: source.conversationId, title: "关联对话", timeLabel: "", ...(projectId ? { projectId } : {}), messages: [] }];
  return boundedEntity(validatedWorkspaceState(entitySurrogate(projects, conversations, [value]), false).artifacts[0], AI_WORKSPACE_V2_ENTITY_BYTES.artifact);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Keep every SQLite row comfortably below the Durable Objects 2 MB row limit. */
function chunks(serialized: string): string[] {
  const result: string[] = [];
  for (let start = 0; start < serialized.length;) {
    let end = Math.min(start + 64000, serialized.length);
    const code = serialized.charCodeAt(end - 1);
    if (end < serialized.length && code >= 0xd800 && code <= 0xdbff) end -= 1;
    result.push(serialized.slice(start, end));
    start = end;
  }
  return result;
}

export class AiWorkspaceRepository {
  constructor(readonly sql: AiSql) {}

  /** Invoke from the existing Node/DO schema initialization, not during request handling. */
  initialize(): void {
    this.sql.exec(AI_WORKSPACE_SCHEMA);
    for (const table of ["ai_workspaces", "ai_workspace_mutations", "ai_workspace_chunks"] as const) {
      const columns = this.sql.all<{ name: string }>(`PRAGMA table_info(${table})`);
      if (!columns.some(column => column.name === "tenant_id")) this.sql.exec(`ALTER TABLE ${table} ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_AI_TENANT_ID}'`);
    }
    this.sql.exec("CREATE INDEX IF NOT EXISTS ai_workspaces_tenant_user ON ai_workspaces(tenant_id,user_id); CREATE INDEX IF NOT EXISTS ai_workspace_mutations_tenant_user ON ai_workspace_mutations(tenant_id,user_id,revision DESC);");
  }

  read(userId: string, tenantId: string = DEFAULT_AI_TENANT_ID): AiWorkspaceSnapshot {
    id(userId, "账号");
    const tenant = normalizeAiTenantId(tenantId);
    const storedUserId = tenantStorageKey(tenant, userId);
    new AiStore(this.sql, tenant).assertAccess(userId);
    const row = this.sql.all<{ revision: number; schema_version: number; updated_at: string; data: string }>("SELECT revision,schema_version,updated_at,data FROM ai_workspaces WHERE tenant_id=? AND user_id=?", tenant, storedUserId)[0];
    if (!row) return { revision: 0, schemaVersion: 1, updatedAt: null, state: null };
    if (row.schema_version !== 1) throw new AiError(409, "AI_WORKSPACE_VERSION_UNSUPPORTED", "工作台记录版本已更新，请升级客户端");
    let serialized = row.data;
    if (serialized === CHUNK_MARKER) {
      const rows = this.sql.all<{ chunk_index: number; data: string }>("SELECT chunk_index,data FROM ai_workspace_chunks WHERE tenant_id=? AND user_id=? ORDER BY chunk_index", tenant, storedUserId);
      if (!rows.length || rows.some((chunk, index) => chunk.chunk_index !== index)) throw new AiError(500, "AI_WORKSPACE_CORRUPT", "工作台记录不完整，请保留当前窗口并联系管理员");
      serialized = rows.map(chunk => chunk.data).join("");
    }
    return { revision: row.revision, schemaVersion: 1, updatedAt: row.updated_at, state: JSON.parse(serialized) as AiWorkspaceState };
  }

  async save(userId: string, value: unknown, tenantId: string = DEFAULT_AI_TENANT_ID): Promise<AiWorkspaceSnapshot> {
    id(userId, "账号");
    const tenant = normalizeAiTenantId(tenantId);
    const storedUserId = tenantStorageKey(tenant, userId);
    new AiStore(this.sql, tenant).assertAccess(userId);
    const body = record(value, "保存请求", ["expectedRevision", "mutationId", "state"]);
    if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0 || Number(body.expectedRevision) >= Number.MAX_SAFE_INTEGER) invalid("工作台版本无效，请重新同步");
    if (typeof body.mutationId !== "string" || !UUID.test(body.mutationId)) invalid("保存请求标识无效");
    const request: AiWorkspaceSaveRequest = { expectedRevision: Number(body.expectedRevision), mutationId: body.mutationId, state: validateAiWorkspaceState(body.state) };
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(request)));
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    // A save response is an acknowledgement of the submitted state, not a
    // canonical read. The 0.1.46 client requires an exact echo; it does not
    // know videoDraftSettings, which we merge into storage below. New clients
    // submit that field explicitly and still receive the canonical state.
    const acknowledge = (snapshot: AiWorkspaceSnapshot): AiWorkspaceSnapshot =>
      request.state.videoDraftSettings === undefined && snapshot.revision === request.expectedRevision + 1
        ? { ...snapshot, state: request.state }
        : snapshot;
    // Both adapters execute a synchronous transaction, with no external I/O or await inside.
    return this.sql.transaction(() => {
      const prior = this.sql.all<{ request_hash: string }>("SELECT request_hash FROM ai_workspace_mutations WHERE tenant_id=? AND user_id=? AND mutation_id=?", tenant, storedUserId, request.mutationId)[0];
      const current = this.read(userId, tenant);
      if (prior) {
        if (prior.request_hash !== hash) throw new AiError(409, "AI_WORKSPACE_MUTATION_CONFLICT", "保存请求标识已用于不同内容，请重新同步");
        // A delayed retry must not overwrite newer changes from this or another client.
        return acknowledge(current);
      }
      if (current.revision !== request.expectedRevision) throw new AiError(409, "AI_WORKSPACE_CONFLICT", "工作台已在其他窗口更新，本次未覆盖任何记录，请同步后重试");
      // Older clients do not know this optional draft field. Preserve it on
      // absent-field writes, but honor an explicit {} from newer clients and
      // remove keys whose conversation/project was intentionally deleted.
      let stateToSave = request.state;
      if (request.state.videoDraftSettings === undefined && current.state?.videoDraftSettings) {
        const allowed = new Set([
          "new-conversation",
          ...request.state.conversations.map(conversation => conversation.id),
          ...request.state.projects.map(project => `new-project-conversation:${project.id}`),
        ]);
        stateToSave = validateAiWorkspaceState({ ...request.state, videoDraftSettings: Object.fromEntries(
          Object.entries(current.state.videoDraftSettings).filter(([key]) => allowed.has(key)),
        ) });
      }
      const revision = current.revision + 1;
      const updatedAt = new Date().toISOString();
      this.sql.exec("INSERT INTO ai_workspaces(user_id,tenant_id,revision,schema_version,updated_at,data) VALUES(?,?,?,1,?,?) ON CONFLICT(user_id) DO UPDATE SET tenant_id=excluded.tenant_id,revision=excluded.revision,schema_version=excluded.schema_version,updated_at=excluded.updated_at,data=excluded.data", storedUserId, tenant, revision, updatedAt, CHUNK_MARKER);
      this.sql.exec("DELETE FROM ai_workspace_chunks WHERE tenant_id=? AND user_id=?", tenant, storedUserId);
      for (const [index, data] of chunks(JSON.stringify(stateToSave)).entries()) {
        this.sql.exec("INSERT INTO ai_workspace_chunks(user_id,tenant_id,chunk_index,data) VALUES(?,?,?,?)", storedUserId, tenant, index, data);
      }
      this.sql.exec("INSERT INTO ai_workspace_mutations(user_id,tenant_id,mutation_id,request_hash,revision) VALUES(?,?,?,?,?)", storedUserId, tenant, request.mutationId, hash, revision);
      // Compact receipts, not user records. Older requests still fail CAS and cannot replay writes.
      this.sql.exec("DELETE FROM ai_workspace_mutations WHERE tenant_id=? AND user_id=? AND revision<=?", tenant, storedUserId, Math.max(0, revision - 2048));
      return acknowledge({ revision, schemaVersion: 1, updatedAt, state: stateToSave });
    });
  }
}
