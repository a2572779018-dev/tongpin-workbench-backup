import type { AiProviderDiagnostic, AiQuota } from "./ai";
import type { VideoModelId, VideoResolution } from "./aiVideoModels";
export interface AiVideoSettings { enabled: boolean; quotaPoints: number; apiKeyConfigured: boolean }
export type AiVideoJobStatus = "submitting" | "queued" | "processing" | "completed" | "failed" | "uncertain";
export interface AiVideoJob {
  id: string; prompt: string; model?: VideoModelId; seconds: number; resolution: VideoResolution; aspectRatio: "16:9" | "9:16";
  status: AiVideoJobStatus; progress: number; createdAt: string; updatedAt: string;
  quotaPoints: number; reserved: boolean; error?: string; diagnostic?: AiProviderDiagnostic;
  referenceIds?: string[];
}
export interface AiVideoList { settings: AiVideoSettings; jobs: AiVideoJob[]; quota: AiQuota }
