import type { VideoModelId, VideoResolution } from "../../../shared/aiVideoModels";
import type { AiHarnessTrace } from "../../../shared/ai";
import { naturalGenerationToolId } from "./skillMentions";
export interface VideoChatRequest {
  requestId: string;
  prompt: string;
  /** What the member originally asked before the assistant prepared a tool prompt. */
  originalPrompt?: string;
  planSummary?: string;
  planRequestId?: string;
  /** Public planning trace persisted for the generated-video message only. */
  planTrace?: AiHarnessTrace;
  seconds: number;
  model?: VideoModelId;
  resolution: VideoResolution;
  aspectRatio: "16:9" | "9:16";
  referenceIds?: string[];
  /** Local-only; converted to account-bound reference IDs before persistence, never sent in the generation JSON. */
  referenceImages?: Array<{ name: string; dataUrl: string }>;
}

/** Persist only retry inputs. The public, schema-validated trace belongs on
 * the assistant message and must not be duplicated inside generic artifact
 * JSON, where it would bypass the workspace trace validator. */
export function persistedVideoChatRequest(request: VideoChatRequest): Omit<VideoChatRequest, "planTrace"> {
  const { planTrace: _planTrace, ...persisted } = request;
  return persisted;
}

/** Only offer the tool for explicit requests; recognizing intent never charges. */
export function isVideoGenerationRequest(text: string): boolean {
  return naturalGenerationToolId(text) === "video";
}
