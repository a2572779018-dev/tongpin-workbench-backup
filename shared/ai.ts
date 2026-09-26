import type { AiWorkspaceStorageUsage } from "./aiWorkspace";
import type { AiWorkflowId } from "./aiWorkflows";
import type { AiImageEditCapability, AiImageGenerationCapability } from "./aiImageCapabilities";

/** Browser-safe contract. API credentials and prompts never appear in admin usage records. */
export type AiProtocol = "chat_completions" | "responses";
/** Member-facing service levels. Provider names and model IDs stay admin-only. */
export type AiMode = "quick" | "standard" | "deep" | "pro";
export type AiReasoningEffort = "" | "low" | "medium" | "high";
export const AI_BUSINESS_TIERS: readonly AiMode[] = ["quick", "standard", "deep", "pro"] as const;
export const AI_BUSINESS_TIER_LABELS: Record<AiMode, string> = {
  quick: "快速",
  standard: "标准",
  deep: "深度",
  pro: "Pro",
};
export type AiHarnessCapability = "chat" | "vision" | "web_search" | "image" | "video" | "presentation" | "computer";
/** Plain-Chinese capability names shared by admin monitoring and alert messages. */
export const AI_HARNESS_CAPABILITY_LABELS: Record<AiHarnessCapability, string> = {
  chat: "文字对话", vision: "图片理解", web_search: "联网搜索", image: "图片生成", video: "视频生成", presentation: "演示文稿", computer: "电脑操作",
};
export type AiHarnessStrategy = "direct" | "react" | "plan_execute";
export interface AiHarnessProviderInput {
  id: string;
  name: string;
  baseUrl: string;
  protocol: AiProtocol;
  apiKey?: string;
  enabled: boolean;
}
export interface AiHarnessProviderConfig extends Omit<AiHarnessProviderInput, "apiKey"> {
  apiKeyConfigured: boolean;
  modelsVerified: boolean;
  availableModels: string[];
  modelsVerifiedAt: string | null;
}
export interface AiHarnessTierRoute {
  /** Text / planning route. Members only see the business tier label. */
  providerId: string;
  modelId: string;
  protocol: AiProtocol;
  maxOutputTokens: number;
  reasoningEffort: AiReasoningEffort;
  capabilities: AiHarnessCapability[];
  enabled: boolean;
  /** OpenAI-compatible Images API route for this business tier. */
  imageProviderId?: string;
  imageModelId?: string;
  /** Admin-confirmed generation request shape bound to the exact media URL and model. */
  imageGenerationCapability?: AiImageGenerationCapability;
  /** Admin-confirmed edit protocol bound to this exact media URL and model. */
  imageEditCapability?: AiImageEditCapability;
  /** 75API video route for this business tier. Other video protocols fail closed. */
  videoProviderId?: string;
  videoModelId?: string;
}
export interface AiHarnessPolicy {
  strategy: AiHarnessStrategy;
  maxToolSteps: number;
  requireApproval: boolean;
  autoWebSearch: boolean;
}
export interface AiHarnessInput {
  providers: AiHarnessProviderInput[];
  tiers: Record<AiMode, AiHarnessTierRoute>;
  policy: AiHarnessPolicy;
}
export interface AiHarnessConfig extends Omit<AiHarnessInput, "providers"> {
  providers: AiHarnessProviderConfig[];
  updatedAt: string | null;
  migratedFromLegacy: boolean;
}
export type AiHarnessRunStatus = "planned" | "running" | "waiting_approval" | "succeeded" | "failed" | "cancelled" | "uncertain";
export type AiHarnessStepStatus = "planned" | "waiting_approval" | "running" | "succeeded" | "failed" | "cancelled";
export type AiHarnessApprovalStatus = "not_required" | "waiting" | "approved" | "consumed" | "cancelled";
export type AiHarnessNextAction = "none" | "poll" | "approve_tool" | "resume";
export interface AiHarnessStep {
  id: string;
  kind: "strategy" | "route" | "workflow" | "plan" | "model" | "tool" | "approval" | "result";
  capability: AiHarnessCapability;
  title: string;
  summary: string;
  status: AiHarnessStepStatus;
  createdAt: string;
  updatedAt: string;
  /** Immutable strategy snapshot stored with the run. */
  strategy?: AiHarnessStrategy;
  maxToolSteps?: number;
  /** Code-owned workflow snapshot. It never contains user prompts or model reasoning. */
  workflowId?: AiWorkflowId;
  workflowVersion?: number;
  workflowStepId?: string;
  /** Persisted before an autonomous follow-up model call. A restart never
   * silently replays the same external request. */
  continuationRequestId?: string;
  /** Tool proposal metadata. Prompts and model reasoning are never stored here. */
  proposalId?: string;
  sequence?: number;
  requiresApproval?: boolean;
  approvalStatus?: AiHarnessApprovalStatus;
  /** Binds a one-time approval to one persisted execution request. */
  executionRequestId?: string;
}
/** Public/workspace projection. Restart-only continuation identifiers never cross the API boundary. */
export type AiHarnessPublicStep = Omit<AiHarnessStep, "continuationRequestId">;
export interface AiHarnessTrace {
  runId: string;
  tier: AiMode;
  strategy: AiHarnessStrategy;
  status: AiHarnessRunStatus;
  reasoningSummary: string;
  nextAction: AiHarnessNextAction;
  toolBudget: { used: number; max: number; remaining: number };
  steps: AiHarnessPublicStep[];
}
export interface AiObservabilitySlice {
  tier: AiMode | "all";
  provider: string;
  capability: AiHarnessCapability;
  operation: "planning" | "execution" | "all";
  requests: number;
  successes: number;
  failures: number;
  successRate: number;
  errorRate: number;
  averageLatencyMs: number;
  maxLatencyMs: number;
  /** Count only replies that emitted a visible text delta while streaming. */
  firstVisibleSamples: number;
  /** Accepted request to first visible answer fragment; null when unsampled. */
  averageFirstVisibleMs: number | null;
  errors: Array<{ code: string; count: number }>;
}
export interface AiObservabilityAlert {
  id: string;
  severity: "warning" | "critical";
  code: "HIGH_ERROR_RATE" | "HIGH_LATENCY" | "PROVIDER_UNAVAILABLE";
  message: string;
  tier: AiMode | "all";
  provider: string;
  capability: AiHarnessCapability;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  /** Live metrics of the slice that raised an active alert (absent once the slice leaves the window). */
  detail?: AiObservabilityAlertDetail;
}
export interface AiObservabilityAlertDetail {
  operation: AiObservabilitySlice["operation"];
  requests: number;
  failures: number;
  errorRate: number;
  maxLatencyMs: number;
  errors: Array<{ code: string; count: number }>;
}
export interface AiObservabilityDashboard {
  generatedAt: string;
  windowMinutes: number;
  totals: AiObservabilitySlice;
  slices: AiObservabilitySlice[];
  alerts: AiObservabilityAlert[];
  alertHistory: AiObservabilityAlert[];
}
export interface AiProviderInput {
  name: string;
  baseUrl: string;
  protocol: AiProtocol;
  apiKey?: string;
  quickModel: string;
  deepModel: string;
  maxOutputTokens: number;
  reasoningEffort: AiReasoningEffort;
  enabled: boolean;
  /** Optional capabilities remain disabled for older saved configurations. */
  imageModel?: string;
  imageBaseUrl?: string;
  imageApiKey?: string;
  imageQuotaTokens?: number;
  /** Opt-in standard Images API SSE; independent of text protocol and quick/deep mode. */
  imageStream?: boolean;
  visionEnabled?: boolean;
  /** Per-image reservation estimate, not actual usage nor an upstream token ceiling. */
  visionInputReserveTokens?: number;
  webSearchEnabled?: boolean;
  webSearchQuotaTokens?: number;
  /** Explicit relay compatibility. Standard sends max_tool_calls; compatible uses a local bounded search budget. */
  webSearchProtocol?: "standard" | "compatible";
}
export interface AiProviderConfig extends Omit<AiProviderInput, "apiKey" | "imageApiKey"> {
  apiKeyConfigured: boolean;
  imageApiKeyConfigured?: boolean;
  /** B.AI Agent model discovery is bound to the currently saved config and key. */
  modelsVerified?: boolean;
  /** Only deployment-allowlisted models returned by the current key's /models response. */
  availableModels?: string[];
  modelsVerifiedAt?: string | null;
  updatedAt: string | null;
}
export interface AiQuota {
  limitTokens: number;
  usedTokens: number;
  reservedTokens: number;
  remainingTokens: number;
  inputTokens: number;
  outputTokens: number;
}
export interface AiMember {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  quota: AiQuota;
  /** Admin-only, informational: size of the member's V1 AI workspace snapshot. Absent when unknown. */
  workspaceStorage?: AiWorkspaceStorageUsage;
}
export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimated: boolean;
  /** Quota units explicitly configured by an administrator, not provider token counts. */
  convertedTokens?: number;
  billingKind?: "tokens" | "image_conversion" | "video_conversion" | "tokens_with_search";
  /** Observed provider search invocations, never inferred from generated text or citations. */
  searchCalls?: number;
  /** Separates actual text-token reporting from administrator-defined tool conversion estimates. */
  tokenUsageEstimated?: boolean;
}
/** Sanitized metadata only: never the provider's message, request body, URL or credentials. */
export interface AiProviderDiagnostic {
  operation: "chat" | "image" | "video" | "models";
  httpStatus: number;
  category: "authentication" | "permission" | "access_denied" | "gateway_block" | "rate_limit" | "redirect" | "invalid_request" | "timeout" | "conflict" | "upstream_unavailable" | "rejected";
  /** Local settlement assessment, not a claim about the provider's final invoice. */
  billing: "rejected" | "unknown";
  code?: string;
  param?: string;
  responseKind?: "json" | "html" | "text" | "empty" | "unknown";
  gatewaySignal?: "cloudflare_challenge" | "cloudflare_block_page";
  /** Strictly validated upstream correlation ID, not proof of a gateway block by itself. */
  cfRay?: string;
}
export interface AiUsageEntry extends AiUsage {
  id: string;
  userId: string;
  requestId: string | null;
  kind: "chat" | "image" | "video" | "quota";
  status: "completed" | "failed" | "uncertain" | "adjusted";
  model: string | null;
  mode: AiMode | null;
  createdAt: string;
  reason: string;
  limitTokens: number | null;
  actorId: string | null;
  diagnostic?: AiProviderDiagnostic;
  /** Admin-only protocol diagnostics, never prompts or raw provider payloads. */
  generation?: AiGenerationDiagnostic;
}
export interface AiGenerationDiagnostic {
  protocol: "responses" | "chat_completions";
  outputLimit: number;
  durationMs: number;
  status: "completed" | "incomplete" | "failed" | "unknown";
  finishReason?: "stop" | "length" | "content_filter" | "tool_calls";
  incompleteReason?: "max_output_tokens" | "content_filter" | "stream_interrupted" | "unknown";
  reasoningTokens?: number;
  actualUsage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  providerRequestId?: string;
}
export interface AiStatus {
  /** Server-owned entitlement: a positive quota was granted, even if now exhausted. */
  accessGranted: boolean;
  configured: boolean;
  quickModel: string;
  deepModel: string;
  maxOutputTokens: number;
  quota: AiQuota;
  imageEnabled?: boolean;
  /** Verified business routes with an explicitly configured image edit adapter. */
  imageEditTiers?: AiMode[];
  /** Business tiers whose route allows @computer. Absent on legacy (no-tier) setups. */
  computerTiers?: AiMode[];
  imageQuotaTokens?: number;
  visionEnabled?: boolean;
  webSearchEnabled?: boolean;
  webSearchQuotaTokens?: number;
  /** Business tiers only. Provider and model identities are intentionally absent. */
  availableTiers?: AiMode[];
  quickAgent?: boolean;
}
/** A non-generating connection probe is not proof that inference/tools will succeed. */
export interface AiAvailabilityCheck {
  state: "reachable" | "unavailable" | "unverified";
  code: string;
  message: string;
  checkedAt: string;
}
export interface AiAvailability {
  status: AiStatus;
  check: AiAvailabilityCheck;
}
export interface AiAttachment { name: string; text?: string; mediaType?: string; dataUrl?: string }
export interface AiPresentation {
  title: string;
  subtitle?: string;
  slides: Array<{ title: string; bullets: string[]; notes?: string }>;
}
export type AiToolPlanKind = "image" | "video" | "presentation";
export interface AiVideoPlanParameters {
  /** Filled and persisted by the server-side business-tier router. */
  model?: string;
  seconds: number;
  resolution: string;
  aspectRatio: "16:9" | "9:16";
  referenceCount: number;
  /** SHA-256 of each normalized reference data URL, in the submitted order. */
  referenceFingerprints: string[];
}
export type AiComputerPlanAction =
  | { kind: "click"; elementToken: string }
  | { kind: "type"; elementToken: string; text: string }
  | { kind: "scroll"; elementToken: string; direction: "up" | "down" | "left" | "right"; amount: 1 | 2 | 3 }
  | { kind: "key"; elementToken: string; key: "escape" | "up" | "down" | "left" | "right" };
export interface AiComputerPlan {
  kind: "computer";
  summary: string;
  action: AiComputerPlanAction;
}
/** A model-authored proposal. The application must validate it and obtain an
 * explicit confirmation before invoking a paid or state-changing service. */
export interface AiToolPlan {
  kind: AiToolPlanKind;
  summary: string;
  prompt: string;
  /** Server-attached immutable parameters from the planning request. */
  videoParameters?: AiVideoPlanParameters;
  /** Added by the client from the persisted planning response; never model-authored. */
  planRequestId?: string;
  /** Public application-owned execution progress attached after plan validation. */
  trace?: AiHarnessTrace;
}
/** A first-turn server decision only. Tool decisions never authorize or execute
 * a paid/state-changing action; the client must enter the existing plan and
 * explicit-confirmation flow. */
export type AiDispatchToolKind = "image" | "video" | "presentation" | "computer";
export const AI_DISPATCH_TOOL_KINDS: readonly AiDispatchToolKind[] = ["image", "video", "presentation", "computer"];
export type AiDispatchDecision =
  | { kind: "text"; content: string; /** Optional public evidence summary, never hidden reasoning. */ analysisSummary?: string }
  | { kind: "image" | "video" | "presentation" | "computer"; prompt: string; clarification?: string };
export interface AiSource { title: string; url: string }
/** A provider-reported `url_citation`, positioned in the final `content`.
 * `end` is an exact UTF-16 offset where the marker belongs, `sourceIndex`
 * indexes `sources`, and `n` is that source's 1-based number in the
 * deduplicated source list. Never model-authored or inferred from text. */
export interface AiCitation { n: number; sourceIndex: number; end: number }
export interface AiChatRequest {
  requestId: string;
  /** Explicit user retry creates a new attempt; polling never does. */
  retryOf?: string;
  retryMode?: "regenerate" | "continue";
  mode: AiMode;
  /** Stable local conversation identity; allows bounded parallel conversations. */
  conversationId?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  skillIds?: string[];
  /** A versioned, code-owned Hub template invoked from an explicit @ mention. */
  workflowId?: AiWorkflowId;
  projectContext?: string;
  attachments?: AiAttachment[];
  outputFormat?: "text" | "dispatch" | "presentation" | "presentation_plan" | "image_plan" | "video_plan" | "computer_plan";
  /** Required when executing a presentation plan; the server binds it to the
   * exact model-authored prompt before asking the model for slide data. */
  toolPlanRequestId?: string;
  /** Accepted only for video_plan and copied into the persisted plan by the server. */
  videoParameters?: AiVideoPlanParameters;
  webSearch?: boolean;
  webSearchMode?: "auto";
  /** Server-owned: tool kinds the resolved tier actually permits. Never read
   * from the client body; set after route resolution. Undefined = legacy (all). */
  dispatchKinds?: AiDispatchToolKind[];
}
export type AiChatPreflightReason = null | "quota_exhausted" | "search_quota_insufficient" | "quota_insufficient" | "request_in_progress";
/** Conservative quota reservations, not actual provider usage or currency prices. */
export interface AiChatBudget {
  /** Message, attachment, persona and protocol input; excludes searchInputReserve. */
  inputReserve: number;
  searchInputReserve: number;
  convertedReserve: number;
  minOutputTokens: number;
  minimumRequiredTokens: number;
  availableOutputTokens: number;
  maxOutputTokens: number;
}
/** Advisory only. Sending revalidates atomically; a preflight never reserves or sends. */
export interface AiChatPreflight {
  canSend: boolean;
  reason: AiChatPreflightReason;
  quota: AiQuota;
  budget: AiChatBudget;
  /** An explicit user choice is required before sending without search. */
  withoutWebSearch?: { canSend: boolean; reason: AiChatPreflightReason; budget: AiChatBudget };
}
/** Exact UTF-16 spans into canonical content; never a second copy of model output. */
export interface AiRichContentV1 {
  version: 1;
  blocks: Array<{ id: string; kind: "markdown"; start: number; end: number }>;
}
export interface AiChatResponse {
  requestId: string;
  attempt?: { runId: string; attemptId: string; parentAttemptId?: string };
  completion?: { state: "partial"; reason: "output_limit" | "stream_interrupted"; canContinue: boolean };
  content: string;
  /** Optional until every installed client understands the v1 rich projection. */
  richContent?: AiRichContentV1;
  /** Optional model-authored public explanation extracted from an explicit
   * <analysis_summary> block. Never populated from hidden reasoning fields. */
  analysisSummary?: string;
  model: string;
  usage: AiUsage;
  quota: AiQuota;
  presentation?: AiPresentation;
  toolPlan?: AiToolPlan;
  /** A question is not a tool plan and never authorizes generation. */
  toolClarification?: string;
  /** Server-model routing decision. A tool value is only a proposal and has
   * not called the corresponding tool. */
  dispatch?: AiDispatchDecision;
  computerPlan?: AiComputerPlan;
  sources?: AiSource[];
  /** Optional: omitted whenever provider positions cannot be verified against `content`. */
  citations?: AiCitation[];
  trace?: AiHarnessTrace;
}
export type AiImageMimeType = "image/png" | "image/jpeg" | "image/webp";
export interface AiImageRequest {
  requestId: string;
  conversationId?: string;
  prompt: string;
  planRequestId?: string;
  /** Must match the untrusted project/attachment context used for the approved image plan. */
  projectContext?: string;
  attachments?: AiAttachment[];
}
export interface AiImageResponse {
  requestId: string;
  model: string;
  images: Array<{ assetId: string; mimeType: AiImageMimeType }>;
  usage: AiUsage;
  quota: AiQuota;
}
export interface AiImageAsset { assetId: string; mimeType: AiImageMimeType; base64: string }
export interface AiRequestResult {
  requestId: string;
  status: "pending" | "completed" | "failed" | "uncertain";
  result?: AiChatResponse;
  imageResult?: AiImageResponse;
  error?: { status: number; code: string; message: string; diagnostic?: AiProviderDiagnostic };
}
export interface AiProviderTestResult {
  ok: boolean;
  models: string[];
  message: string;
  /** Present only for the B.AI quick Agent allowlist check. */
  availableModels?: string[];
  /** True only when the result was persisted against the saved key and config. */
  modelsVerified?: boolean;
  modelsVerifiedAt?: string;
}
export interface AiProviderTestInput {
  /** Omit after saving to force use of the encrypted credential and saved origin. */
  baseUrl?: string;
  apiKey?: string;
  protocol?: AiProtocol;
  target?: "chat" | "image";
}
