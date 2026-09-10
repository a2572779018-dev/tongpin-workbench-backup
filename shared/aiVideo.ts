import type { AiProviderDiagnostic, AiQuota } from "./ai";
export interface AiVideoSettings { enabled: boolean; quotaPoints: number; apiKeyConfigured: boolean }
export type AiVideoJobStatus = "submitting" | "queued" | "processing" | "completed" | "failed" | "uncertain";
export interface AiVideoJob {
  id: string; prompt: string; seconds: number; resolution: "480p" | "768p"; aspectRatio: "16:9" | "9:16";
  status: AiVideoJobStatus; progress: number; createdAt: string; updatedAt: string;
  quotaPoints: number; reserved: boolean; error?: string; diagnostic?: AiProviderDiagnostic;
}
export interface AiVideoList { settings: AiVideoSettings; jobs: AiVideoJob[]; quota: AiQuota }
