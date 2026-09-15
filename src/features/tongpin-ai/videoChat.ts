import type { VideoModelId, VideoResolution } from "../../../shared/aiVideoModels";
export interface VideoChatRequest {
  requestId: string;
  prompt: string;
  seconds: number;
  model?: VideoModelId;
  resolution: VideoResolution;
  aspectRatio: "16:9" | "9:16";
  referenceIds?: string[];
  /** Local-only; uploaded after the conversation is persisted, never sent in the generation JSON. */
  referenceImages?: Array<{ name: string; dataUrl: string }>;
}

/** Only offer the tool for explicit requests; recognizing intent never charges. */
export function isVideoGenerationRequest(text: string): boolean {
  if (/(?:视频|短片|动画)(?:的)?(?:提示词|脚本|文案|分镜|教程|方法|方案)|video\s+(?:prompt|script|storyboard)/i.test(text)) return false;
  return /^(?:(?:请|麻烦|帮我|给我|替我|请你|可以帮我|能帮我)\s*)*(?:生成|制作|做|创建).{0,60}(?:视频|短片|动画)/u.test(text.trim()) ||
    /^(?:please\s+)?(?:create|generate|make)\s+.{0,60}\bvideo\b/i.test(text.trim());
}
