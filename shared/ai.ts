/** Browser-safe contract. API credentials and prompts never appear in admin usage records. */
export type AiProtocol = "chat_completions" | "responses";
export type AiMode = "quick" | "deep";
export type AiReasoningEffort = "" | "low" | "medium" | "high";
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
  webSearchEnabled?: boolean;
  webSearchQuotaTokens?: number;
}
export interface AiProviderConfig extends Omit<AiProviderInput, "apiKey" | "imageApiKey"> {
  apiKeyConfigured: boolean;
  imageApiKeyConfigured?: boolean;
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
}
export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimated: boolean;
  /** Quota units explicitly configured by an administrator, not provider token counts. */
  convertedTokens?: number;
  billingKind?: "tokens" | "image_conversion" | "tokens_with_search";
}
/** Sanitized metadata only: never the provider's message, request body, URL or credentials. */
export interface AiProviderDiagnostic {
  operation: "chat" | "image" | "models";
  httpStatus: number;
  category: "authentication" | "rate_limit" | "redirect" | "invalid_request" | "timeout" | "conflict" | "upstream_unavailable" | "rejected";
  /** Local settlement assessment, not a claim about the provider's final invoice. */
  billing: "rejected" | "unknown";
  code?: string;
  param?: string;
}
export interface AiUsageEntry extends AiUsage {
  id: string;
  userId: string;
  requestId: string | null;
  kind: "chat" | "image" | "quota";
  status: "completed" | "failed" | "uncertain" | "adjusted";
  model: string | null;
  mode: AiMode | null;
  createdAt: string;
  reason: string;
  limitTokens: number | null;
  actorId: string | null;
  diagnostic?: AiProviderDiagnostic;
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
  imageQuotaTokens?: number;
  visionEnabled?: boolean;
  webSearchEnabled?: boolean;
  webSearchQuotaTokens?: number;
}
export interface AiAttachment { name: string; text?: string; mediaType?: string; dataUrl?: string }
export interface AiPresentation {
  title: string;
  subtitle?: string;
  slides: Array<{ title: string; bullets: string[]; notes?: string }>;
}
export interface AiSource { title: string; url: string }
export interface AiChatRequest {
  requestId: string;
  mode: AiMode;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  skillIds?: string[];
  projectContext?: string;
  attachments?: AiAttachment[];
  outputFormat?: "text" | "presentation";
  webSearch?: boolean;
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
export interface AiChatResponse {
  requestId: string;
  content: string;
  model: string;
  usage: AiUsage;
  quota: AiQuota;
  presentation?: AiPresentation;
  sources?: AiSource[];
}
export type AiImageMimeType = "image/png" | "image/jpeg" | "image/webp";
export interface AiImageRequest { requestId: string; prompt: string }
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
}
export interface AiProviderTestInput {
  baseUrl: string;
  apiKey?: string;
  protocol?: AiProtocol;
  target?: "chat" | "image";
}
