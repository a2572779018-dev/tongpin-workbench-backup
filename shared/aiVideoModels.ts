/** 75api model-specific catalog, checked against its public pricing and linked API guide on 2026-09-15. */
export type VideoResolution = "480p" | "720p" | "768p" | "1080p";
export const VIDEO_MODELS = [
  { id: "minimax_h3", label: "MiniMax H3", resolutions: ["480p", "768p"], minSeconds: 5, maxSeconds: 15, maxImages: 8, requiresImage: false },
  { id: "minimax_h3_no_audios_1080", label: "MiniMax H3 · 1080p", resolutions: ["1080p"], minSeconds: 1, maxSeconds: 10, maxImages: 9, requiresImage: true },
  { id: "sd-2-c6", label: "SD 2.0", resolutions: ["720p"], minSeconds: 5, maxSeconds: 15, maxImages: 9, requiresImage: false },
  { id: "sd-2.0-fast", label: "SD 2.0 Fast", resolutions: ["480p", "720p"], minSeconds: 5, maxSeconds: 15, maxImages: 9, requiresImage: false },
  { id: "sd-2.5-c1", label: "SD 2.5", resolutions: ["720p"], minSeconds: 30, maxSeconds: 30, maxImages: 9, requiresImage: false },
] as const;
export type VideoModelId = typeof VIDEO_MODELS[number]["id"];
export function videoModel(id: string = "minimax_h3") { return VIDEO_MODELS.find(model => model.id === id); }
export function videoSeconds(id: VideoModelId, resolution: VideoResolution): number[] {
  const model = videoModel(id)!;
  const max = id === "sd-2.0-fast" && resolution === "720p" ? 12 : model.maxSeconds;
  return Array.from({ length: max - model.minSeconds + 1 }, (_, i) => model.minSeconds + i);
}
