import type { AiMode, AiQuota } from "./ai";

/**
 * Unified computer-operation executor contract, shared by the server
 * (server/ai/computerExecutor.ts), the renderer loop
 * (src/features/tongpin-ai/computerExecutor.ts) and — through parity tests —
 * the Electron main-process host (electron/computer-agent*.cjs).
 *
 * Architecture (owner-specified): instruction → tier LLM once → structured
 * task spec → ONE native consent (permissions + scope) → loop {Cua Driver
 * observation → immutable closed candidate set → Jev (TypeSafe System One)
 * chooses one candidate id → main-process authorization/scope check → Cua
 * Driver executes → re-observe/verify} until done, abstain, limits or Stop.
 *
 * The closed-candidate decision pattern (immutable candidates, reserved
 * `reobserve`/`abstain`, answers restricted to supplied ids, capture binding,
 * outcome classes, never replaying an uncertain action) is adapted from the
 * MIT-licensed trycua/cua `libs/cua-driver/examples/jev-use` example; see
 * THIRD_PARTY_NOTICES.md.
 */
export const COMPUTER_AGENT_LIMITS = Object.freeze({
  defaultMaxSteps: 30,
  maxStepsCeiling: 50,
  defaultMaxMinutes: 6,
  maxMinutesCeiling: 15,
  maxCandidates: 32,
  maxApps: 3,
  maxParameters: 6,
  maxParameterChars: 200,
  maxGoalChars: 200,
  maxSummaryChars: 120,
  maxSuccessCheckChars: 200,
  maxLabelChars: 20,
  maxInstructionChars: 2000,
  maxContextHintChars: 2000,
  maxHistory: 8,
  maxGuidance: 3,
  maxGuidanceChars: 300,
  maxObservationElements: 60,
  maxObservationTexts: 40,
  maxObservationTextChars: 80,
  maxDescriptionChars: 400,
  maxCandidateLabelChars: 120,
  maxResultSummaryChars: 600,
  defaultMinConfidence: 0.5,
  /** A candidate that sends, deletes or pays needs more than the generic floor. */
  irreversibleMinConfidence: 0.7,
});

export const COMPUTER_ACTION_KINDS = ["activate_app", "click", "type", "key", "scroll"] as const;
export type ComputerActionKind = typeof COMPUTER_ACTION_KINDS[number];
export const COMPUTER_PARAMETER_ROLES = ["recipient", "message", "search", "text"] as const;
export type ComputerParameterRole = typeof COMPUTER_PARAMETER_ROLES[number];
export const COMPUTER_IRREVERSIBLE_KINDS = ["send_message", "submit", "delete", "payment", "other"] as const;
export type ComputerIrreversibleKind = typeof COMPUTER_IRREVERSIBLE_KINDS[number];

export interface ComputerTaskApp { name: string; bundleId?: string }
export interface ComputerTaskParameter { id: string; role: ComputerParameterRole; label: string; value: string }
export interface ComputerTaskIrreversible {
  kind: ComputerIrreversibleKind;
  /** Plain Chinese sentence shown in the consent dialog, e.g. 发送消息给「姐姐」：中秋快乐. */
  summary: string;
  recipient?: string;
  content?: string;
}
/** Structured task produced once per run by the tier LLM and shown in the consent dialog. */
export interface ComputerTaskSpec {
  goal: string;
  apps: ComputerTaskApp[];
  parameters: ComputerTaskParameter[];
  successCheck: string;
  irreversible: ComputerTaskIrreversible | null;
  actionKinds: ComputerActionKind[];
}
export type ComputerTaskPlan =
  | { kind: "computer_task"; task: ComputerTaskSpec }
  | { kind: "clarification"; question: string };

export interface ComputerRunLimits {
  maxSteps: number;
  maxMinutes: number;
  minConfidence: number;
}

/** Admin view of the "Jev 决策服务" section. The API key never leaves the server. */
export interface AiComputerSettings extends ComputerRunLimits {
  enabled: boolean;
  apiKeyConfigured: boolean;
  /** TypeSafe model or alias, e.g. `jev-latest` or a pinned `jev-1.13.0`. */
  model: string;
  /** 同频点 charged per 1,000 Jev input / output tokens (TypeSafe reports both). */
  inputPointsPer1k: number;
  outputPointsPer1k: number;
  updatedAt: string | null;
  verifiedAt: string | null;
  availableModels: string[];
}
export interface AiComputerSettingsInput extends Partial<ComputerRunLimits> {
  enabled: boolean;
  apiKey?: string;
  model?: string;
  inputPointsPer1k: number;
  outputPointsPer1k: number;
}

export type ComputerRunOutcome = "verified" | "refuted" | "unknown" | "abstained" | "budget_exhausted";
export const COMPUTER_RUN_OUTCOMES: readonly ComputerRunOutcome[] = ["verified", "refuted", "unknown", "abstained", "budget_exhausted"];
export type ComputerRunReason =
  | "goal_verified" | "goal_refuted" | "action_uncertain" | "jev_abstained" | "low_confidence" | "needs_user"
  | "authorization_denied" | "consent_denied" | "permission_missing" | "user_stopped" | "step_limit" | "time_limit"
  | "repeated_failures" | "clarification" | "error";

export interface ComputerRunStart {
  runId: string;
  taskRequestId: string;
  mode: AiMode;
  task: ComputerTaskSpec;
  limits: ComputerRunLimits;
  decisionModel: string;
}
export type ComputerTaskResponse =
  | { kind: "run"; run: ComputerRunStart; quota: AiQuota }
  | { kind: "clarification"; question: string; quota: AiQuota };

/* ------------------------------------------------------------------ */
/* Candidates and observations produced by the Electron main process. */
/* ------------------------------------------------------------------ */

export const COMPUTER_RESERVED_CANDIDATES = ["reobserve", "abstain", "done"] as const;
export type ComputerReservedCandidate = typeof COMPUTER_RESERVED_CANDIDATES[number];
export type ComputerCandidateKind = "activate_app" | "click" | "point" | "type" | "key" | "hotkey" | "scroll" | "reserved";
export type ComputerCandidateRisk = "none" | "send" | "submit" | "delete" | "payment" | "irreversible";
export const COMPUTER_CANDIDATE_ID = /^[a-z][a-z0-9_]{0,47}$/;

/** Public projection of one immutable candidate. Execution details (tokens,
 * coordinates, text) never leave the main process; only the id is echoed back. */
export interface ComputerCandidate {
  id: string;
  kind: ComputerCandidateKind;
  /** Complete, self-contained English sentence for Jev (screen labels quoted). */
  description: string;
  /** Plain Chinese label for the member-visible timeline. */
  label: string;
  risk: ComputerCandidateRisk;
  /** Expected visible effect, used as the next step's verification question. */
  expect?: string;
}

export interface ComputerObservationElement {
  ref: string;
  role: string;
  label?: string;
  value?: string;
  editable?: true;
  secure?: true;
  selected?: true;
  disabled?: true;
  searchBox?: true;
  messageBox?: true;
}
/** Application-built, bounded description of the target window. Every screen
 * string inside is untrusted observation data, never an instruction. */
export interface ComputerObservation {
  trust: "untrusted_screen_content";
  app: string | null;
  windowTitle: string | null;
  axSparse: boolean;
  elementsTotal: number;
  elements: ComputerObservationElement[];
  texts: string[];
}
/** Application-authored facts from the executor (trusted, not screen text). */
export interface ComputerExecutorFacts {
  focus: "none" | "search" | "conversation" | "field";
  typedIntoSearch?: string;
  typedIntoMessageBox?: string;
  conversationOpenedFor?: string;
  irreversibleDone: boolean;
  /** After an executed send: occurrences of the sent text before/after and whether the input still holds it. */
  sendEvidence?: { before: number; after: number; inputStillHasText: boolean | null };
  targetApp?: string;
  appRunning?: boolean;
  /** Whether the granted app has a usable window: "hidden" = minimized, on another Space or no main window. */
  targetWindow?: "visible" | "hidden" | "none";
  /**
   * Only on the first observation after text was typed "into focus": where it
   * was seen. "elsewhere" = only an input box of the other kind gained it (a
   * search literal in a chat's message box); the run stops without Return.
   */
  typedLanding?: { field: "search" | "message" | "field"; text: string; landed: "expected" | "elsewhere" | "unknown" };
}
export interface ComputerObserveResult {
  observationId: string;
  observation: ComputerObservation;
  candidates: ComputerCandidate[];
  facts: ComputerExecutorFacts;
  display: { app: string | null; title: string | null; elementCount: number; axSparse: boolean; screenshotUsed: boolean };
}

export type ComputerExecuteStatus = "delivered" | "unverified" | "no_effect" | "failed" | "blocked" | "unknown";
export interface ComputerExecuteResult {
  status: ComputerExecuteStatus;
  /** Application-authored Chinese sentence for the timeline. */
  message: string;
  code?: string;
  authorization: "allowed" | "extra_consent" | "denied";
  delivery?: "background" | "foreground";
}

export interface ComputerConsentInput { runId: string; task: ComputerTaskSpec; limits: ComputerRunLimits }
export interface ComputerConsentResult {
  runId: string;
  platform: "macos" | "windows";
  permissions: { accessibility: boolean; screenRecording: boolean };
  /** Screen Recording missing: tree-only observation, no coordinate fallback. */
  axOnly: boolean;
  apps: Array<{ name: string; running: boolean }>;
}
export type ComputerAgentEvent =
  | { type: "permission_wait"; missing: Array<"accessibility" | "screenRecording"> }
  | { type: "permission_ready"; axOnly: boolean }
  | { type: "extra_consent"; summary: string }
  | { type: "stopped"; reason: "esc" | "user" | "limit" | "window_closed" | "logout" };

export type ComputerAgentResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } };

/** Narrow bridge exposed by the preload script. Every call is re-validated in main. */
export interface ComputerAgentBridge {
  consent(input: ComputerConsentInput): Promise<ComputerAgentResult<ComputerConsentResult>>;
  observe(): Promise<ComputerAgentResult<ComputerObserveResult>>;
  execute(input: { observationId: string; candidateId: string }): Promise<ComputerAgentResult<ComputerExecuteResult>>;
  stop(): Promise<ComputerAgentResult<{ stopped: true }>>;
  onEvent?(listener: (event: ComputerAgentEvent) => void): () => void;
}

/* ------------------------------------------------------------------ */
/* Decisions (server ↔ renderer).                                      */
/* ------------------------------------------------------------------ */

export type ComputerStepResult = "delivered" | "unverified" | "no_effect" | "failed" | "blocked" | "reobserved" | "unknown";
export interface ComputerHistoryEntry { step: number; action: string; result: ComputerStepResult }
export interface ComputerDecisionRequest {
  step: number;
  observationId: string;
  observation: ComputerObservation;
  candidates: Array<Pick<ComputerCandidate, "id" | "description" | "risk">>;
  facts: ComputerExecutorFacts;
  history: ComputerHistoryEntry[];
  lastAction?: { action: string; expect: string };
  guidance?: string[];
}
export interface ComputerDecisionVerification {
  goalDone: number;
  needsUser: number;
  previousEffect?: number;
  recipientMatch?: number;
  contentMatch?: number;
}
export interface ComputerDecision {
  selectedId: string;
  confidence: number;
  probabilities: Record<string, number>;
  model: string;
  verification: ComputerDecisionVerification;
}
export interface ComputerDecisionResponse {
  step: number;
  decision: ComputerDecision;
  usage: { inputTokens: number; outputTokens: number; points: number; estimated: boolean };
  quota: AiQuota;
  replayed: boolean;
}
export interface ComputerFinishRequest { outcome: ComputerRunOutcome; reason: ComputerRunReason; summary: string; steps: number }
export interface ComputerRunView {
  runId: string;
  status: "planned" | "running" | ComputerRunOutcome;
  steps: number;
  maxSteps: number;
  summary?: string;
  reason?: ComputerRunReason;
}

/* ------------------------------------------------------------------ */
/* Validation (shared by server and — via parity tests — main).        */
/* ------------------------------------------------------------------ */

const CONTROL = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u;
/** Never type or persist credential-like parameters. */
export const COMPUTER_SECRET_PATTERN = /(?:密码|口令|验证码|校验码|动态码|支付密码|密钥|私钥|助记词|银行卡号|信用卡号|身份证号|password|passcode|passwd|one[\s_-]*time[\s_-]*code|verification[\s_-]*code|api[\s_-]*key|secret|private[\s_-]*key|seed[\s_-]*phrase|mnemonic|\bcvv\b|\botp\b|\bpin\b)/iu;
const PARAMETER_ID = /^[a-z][a-z0-9_]{0,15}$/;
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function singleLine(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/\s+/gu, " ").trim();
  if (!clean || CONTROL.test(clean) || [...clean].length > max) return null;
  return clean;
}
/** Literal text keeps inner spacing; only surrounding whitespace is removed. */
function literal(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  if (!clean || CONTROL.test(clean) || [...clean].length > max) return null;
  return clean;
}

export type ComputerTaskValidation = { ok: true; task: ComputerTaskSpec } | { ok: false; code: "invalid" | "secret"; message: string };

export function validateComputerTaskSpec(value: unknown): ComputerTaskValidation {
  const root = record(value);
  const fail = (message: string): ComputerTaskValidation => ({ ok: false, code: "invalid", message });
  if (!root) return fail("任务结构不正确");
  const goal = singleLine(root.goal, COMPUTER_AGENT_LIMITS.maxGoalChars);
  if (!goal) return fail("任务目标缺失或过长");
  if (!Array.isArray(root.apps) || !root.apps.length || root.apps.length > COMPUTER_AGENT_LIMITS.maxApps) return fail("目标应用需为 1 到 3 个");
  const apps: ComputerTaskApp[] = [];
  for (const raw of root.apps) {
    const item = record(raw);
    const name = item ? singleLine(item.name, 40) : null;
    if (!item || !name) return fail("目标应用名称不正确");
    let bundleId: string | undefined;
    if (item.bundleId !== undefined && item.bundleId !== null && item.bundleId !== "") {
      if (typeof item.bundleId !== "string" || item.bundleId.length > 150 || !BUNDLE_ID.test(item.bundleId)) return fail("目标应用标识不正确");
      bundleId = item.bundleId;
    }
    if (apps.some(app => app.name === name || (bundleId && app.bundleId === bundleId))) return fail("目标应用重复");
    apps.push({ name, ...(bundleId ? { bundleId } : {}) });
  }
  if (root.parameters !== undefined && !Array.isArray(root.parameters)) return fail("任务参数格式不正确");
  const rawParameters = Array.isArray(root.parameters) ? root.parameters : [];
  if (rawParameters.length > COMPUTER_AGENT_LIMITS.maxParameters) return fail("任务参数最多 6 个");
  const parameters: ComputerTaskParameter[] = [];
  for (const raw of rawParameters) {
    const item = record(raw);
    if (!item || typeof item.id !== "string" || !PARAMETER_ID.test(item.id) || parameters.some(parameter => parameter.id === item.id)) return fail("任务参数编号不正确");
    if (!(COMPUTER_PARAMETER_ROLES as readonly unknown[]).includes(item.role)) return fail("任务参数类型不正确");
    const label = singleLine(item.label, COMPUTER_AGENT_LIMITS.maxLabelChars);
    const text = literal(item.value, COMPUTER_AGENT_LIMITS.maxParameterChars);
    if (!label || !text) return fail("任务参数内容缺失、过长或包含换行");
    if (COMPUTER_SECRET_PATTERN.test(label) || COMPUTER_SECRET_PATTERN.test(text)) {
      return { ok: false, code: "secret", message: "电脑操作不会输入密码、验证码、密钥等敏感信息，请自行完成这一步" };
    }
    parameters.push({ id: item.id, role: item.role as ComputerParameterRole, label, value: text });
  }
  const successCheck = singleLine(root.successCheck, COMPUTER_AGENT_LIMITS.maxSuccessCheckChars);
  if (!successCheck) return fail("完成标准缺失或过长");
  let irreversible: ComputerTaskIrreversible | null = null;
  if (root.irreversible !== undefined && root.irreversible !== null) {
    const item = record(root.irreversible);
    if (!item || !(COMPUTER_IRREVERSIBLE_KINDS as readonly unknown[]).includes(item.kind)) return fail("不可逆操作类型不正确");
    const summary = singleLine(item.summary, COMPUTER_AGENT_LIMITS.maxSummaryChars);
    if (!summary) return fail("不可逆操作说明缺失或过长");
    const values = new Set(parameters.map(parameter => parameter.value));
    const bound = (field: unknown): string | undefined | null => {
      if (field === undefined || field === null || field === "") return undefined;
      const text = literal(field, COMPUTER_AGENT_LIMITS.maxParameterChars);
      return text && values.has(text) ? text : null;
    };
    const recipient = bound(item.recipient);
    const content = bound(item.content);
    if (recipient === null || content === null) return fail("不可逆操作的对象或内容必须与任务参数完全一致");
    if (item.kind === "send_message" && (!recipient || !content)) return fail("发送消息必须写明接收人和消息内容");
    irreversible = { kind: item.kind as ComputerIrreversibleKind, summary, ...(recipient ? { recipient } : {}), ...(content ? { content } : {}) };
  }
  if (!Array.isArray(root.actionKinds) || !root.actionKinds.length) return fail("允许的动作类型缺失");
  const actionKinds: ComputerActionKind[] = [];
  for (const kind of root.actionKinds) {
    if (!(COMPUTER_ACTION_KINDS as readonly unknown[]).includes(kind)) return fail("允许的动作类型不正确");
    if (!actionKinds.includes(kind as ComputerActionKind)) actionKinds.push(kind as ComputerActionKind);
  }
  // Opening the named app is always part of operating it; typing needs a literal.
  if (!actionKinds.includes("activate_app")) actionKinds.unshift("activate_app");
  const allowed = actionKinds.filter(kind => kind !== "type" || parameters.length > 0);
  return { ok: true, task: { goal, apps, parameters, successCheck, irreversible, actionKinds: allowed } };
}

/** Parse the tier model's reply. Only syntax around one JSON object is tolerated. */
export function parseComputerTaskPlan(content: string): ComputerTaskPlan | { error: string; code: "invalid" | "secret" } {
  let text = content.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
  if (!text.startsWith("{")) {
    const start = text.indexOf("{"), end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return { error: "模型没有返回任务 JSON", code: "invalid" };
    text = text.slice(start, end + 1);
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { error: "任务 JSON 无法解析", code: "invalid" }; }
  const root = record(value);
  if (!root) return { error: "任务结构不正确", code: "invalid" };
  if (root.kind === "clarification") {
    const question = singleLine(root.question, 300);
    return question ? { kind: "clarification", question } : { error: "补充问题不正确", code: "invalid" };
  }
  if (root.kind !== "computer_task") return { error: "任务类型不正确", code: "invalid" };
  const validated = validateComputerTaskSpec(root);
  return validated.ok ? { kind: "computer_task", task: validated.task } : { error: validated.message, code: validated.code };
}

/** Strict bounds for the admin-owned run limits (absent → defaults). */
export function computerRunLimits(value: Partial<ComputerRunLimits> | undefined): ComputerRunLimits {
  const steps = Number.isInteger(value?.maxSteps) ? Number(value!.maxSteps) : COMPUTER_AGENT_LIMITS.defaultMaxSteps;
  const minutes = Number.isInteger(value?.maxMinutes) ? Number(value!.maxMinutes) : COMPUTER_AGENT_LIMITS.defaultMaxMinutes;
  const confidence = typeof value?.minConfidence === "number" && Number.isFinite(value.minConfidence) ? value.minConfidence : COMPUTER_AGENT_LIMITS.defaultMinConfidence;
  return {
    maxSteps: Math.max(1, Math.min(COMPUTER_AGENT_LIMITS.maxStepsCeiling, steps)),
    maxMinutes: Math.max(1, Math.min(COMPUTER_AGENT_LIMITS.maxMinutesCeiling, minutes)),
    minConfidence: Math.max(0.3, Math.min(0.95, Math.round(confidence * 100) / 100)),
  };
}

/* ------------------------------------------------------------------ */
/* Deterministic intent: a direct request to operate an app on the     */
/* member's computer. Used for the tier notice (client, before any     */
/* model call) and as a dispatch hint (server). Conservative: questions */
/* and writing requests are never classified as computer operations.   */
/* ------------------------------------------------------------------ */

const DEVICE_CUE = /(?:我的电脑|这台电脑|本机|电脑上|电脑里|电脑版|桌面版|桌面端|客户端|在电脑|用电脑|操作电脑|控制电脑|Mac\s*上|computer\s*use)/iu;
const APP_NAMES = "(?:微信|WeChat|企业微信|QQ|钉钉|DingTalk|飞书|Lark|Feishu|备忘录|Notes|提醒事项|日历|访达|Finder|Safari|Chrome|谷歌浏览器|浏览器|邮件|Mail|Outlook|Word|Excel|PowerPoint|WPS|计算器|音乐|网易云音乐|QQ音乐|系统设置)";
const APP_OPERATION = new RegExp(`(?:用|在|打开|通过|去|切到|切换到)\\s*(?:我的)?\\s*${APP_NAMES}|${APP_NAMES}\\s*(?:里|上|中)\\s*(?:给|把|帮|搜|打开|点|发|回复|新建|输入)|发(?:一|个|条)?(?:条|个)?\\s*(?:微信|钉钉|飞书)(?:消息)?\\s*给|给[^，。,.!！?？]{1,12}?发(?:一|个|条)?(?:条|个)?\\s*(?:微信|钉钉|飞书|QQ)`, "iu");
const ACTION_VERB = /(?:发送|发(?:一|个|条)|发给|给[^，。,.!！?？]{1,12}?发|回复|打开|点击|点一下|输入|填写|搜索|查找|新建|创建|关闭|切换|播放|暂停|提交|转发|发消息|发个)/u;
const QUESTION_OR_HOWTO = /[?？]|怎么|怎样|如何|为什么|为啥|能不能|可不可以|是否|教程|步骤是|什么是|是什么|吗\s*[。.!！]*$/u;
const WRITING_REQUEST = /(?:^|[，,。\s])(?:帮我|请|给我)?\s*(?:写|起草|拟|编写|润色|翻译|总结|概括|解释|介绍)(?:一|个|段|条|篇|下)?/u;

export function computerOperationIntent(text: string): boolean {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > COMPUTER_AGENT_LIMITS.maxInstructionChars) return false;
  if (/(?:^|\s)@computer(?=\s|$|[，。！？,:;])/iu.test(normalized)) return true;
  if (QUESTION_OR_HOWTO.test(normalized)) return false;
  const device = DEVICE_CUE.test(normalized);
  if (!device && WRITING_REQUEST.test(normalized)) return false;
  if (!ACTION_VERB.test(normalized)) return false;
  return device || APP_OPERATION.test(normalized);
}

/* ------------------------------------------------------------------ */
/* Member-facing labels.                                               */
/* ------------------------------------------------------------------ */

export const COMPUTER_OUTCOME_LABELS: Record<ComputerRunOutcome, string> = {
  verified: "已完成并核实",
  refuted: "未达成（已核实）",
  unknown: "结果未确认",
  abstained: "已停止",
  budget_exhausted: "已达上限",
};
export const COMPUTER_ACTION_KIND_LABELS: Record<ComputerActionKind, string> = {
  activate_app: "打开或切换应用",
  click: "点击界面元素",
  type: "输入指定文字",
  key: "按键（⌘F、回车、Esc、Tab、方向键、退格）",
  scroll: "滚动列表",
};
export const COMPUTER_IRREVERSIBLE_LABELS: Record<ComputerIrreversibleKind, string> = {
  send_message: "发送消息", submit: "提交", delete: "删除", payment: "付款", other: "不可逆操作",
};
