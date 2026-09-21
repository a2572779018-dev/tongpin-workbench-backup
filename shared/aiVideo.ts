import type { AiProviderDiagnostic, AiQuota } from "./ai";
import type { VideoModelId, VideoResolution } from "./aiVideoModels";
export interface AiVideoSettings {
  enabled: boolean;
  quotaPoints: number;
  apiKeyConfigured: boolean;
  defaultModel?: VideoModelId;
  /** Server-authorized intersection of provider-listed and locally enabled models. */
  availableModels: VideoModelId[];
  /** False means no provider model-list verification is current for this view. */
  modelsVerified: boolean;
  /** Member-safe constraints for the selected business tier; contains no provider or model ID. */
  profile?: {
    resolutions: VideoResolution[];
    seconds: Partial<Record<VideoResolution, number[]>>;
    maxImages: number;
    requiresImage: boolean;
  };
}
export interface AiVideoModelCheck {
  ok: true;
  message: string;
  models: Array<{ id: VideoModelId; label: string; listed: boolean }>;
  availableModels: VideoModelId[];
}
export type AiVideoJobStatus = "submitting" | "queued" | "processing" | "completed" | "failed" | "uncertain";
export interface AiVideoJob {
  id: string; prompt: string; model?: VideoModelId; seconds: number; resolution: VideoResolution; aspectRatio: "16:9" | "9:16";
  status: AiVideoJobStatus; progress: number; createdAt: string; updatedAt: string;
  quotaPoints: number; reserved: boolean; error?: string; diagnostic?: AiProviderDiagnostic;
  referenceIds?: string[];
  planRequestId?: string;
  /** Stable workspace conversation scope used for single-flight execution. */
  conversationId?: string;
}
/** Minimal cross-account view used only for manual billing reconciliation. */
export interface AiAdminVideoReconciliationJob {
  id: string;
  userId: string;
  providerTaskId?: string;
  status: "uncertain";
  createdAt: string;
  updatedAt: string;
  quotaPoints: number;
  reserved: boolean;
}
export interface AiVideoList { settings: AiVideoSettings; jobs: AiVideoJob[]; quota: AiQuota }
