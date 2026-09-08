/** One bounded visual request works with either supported provider protocol. */
export const AI_MEDIA_LIMITS = {
  imageFileBytes: 12 * 1024 * 1024,
  videoFileBytes: 50 * 1024 * 1024,
  videoSeconds: 120,
  videoFrames: 4,
  requestFrames: 5,
  frameBytes: 160 * 1024,
  requestBytes: 1024 * 1024,
  imagePixels: 24 * 1024 * 1024,
  imageDimension: 8192,
  frameDimension: 1024,
} as const;

export const AI_IMAGE_ACCEPT = ".png,.jpg,.jpeg,.webp";
export const AI_VIDEO_ACCEPT = ".mp4,.webm,.mov,.m4v";

export function mediaFrameByteLength(dataUrl: string): number {
  const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[1].length % 4 !== 0) return Infinity;
  return match[1].length / 4 * 3 - (match[1].endsWith("==") ? 2 : match[1].endsWith("=") ? 1 : 0);
}

/** Short clips need fewer frames. Sample endpoints too; never imply full video/audio analysis. */
export function videoSampleTimes(duration: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0 || duration > AI_MEDIA_LIMITS.videoSeconds) {
    throw new Error("视频时长需在 2 分钟以内，请截取片段后添加");
  }
  const count = Math.min(AI_MEDIA_LIMITS.videoFrames, Math.max(1, Math.ceil(duration / 2)));
  const end = Math.max(0, duration - Math.min(0.05, duration / 10));
  return Array.from({ length: count }, (_, index) => Number((count === 1 ? end / 2 : index * end / (count - 1)).toFixed(3)));
}
