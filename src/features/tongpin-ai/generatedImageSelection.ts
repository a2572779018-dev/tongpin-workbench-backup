import type { AiWorkspaceVideoDraftSettings } from "../../../shared/aiWorkspace";
import type { TongpinAIArtifact, TongpinAIMode } from "./types";
import type { VideoChatRequest } from "./videoChat";

export type ImageSelectionEntrypoint = "natural" | "mention_image" | "mention_video" | "menu";
export interface GeneratedImageSelection {
  requestId: string;
  sourceArtifactId: string;
  assetIds: string[];
  mode: TongpinAIMode;
  entrypoint: ImageSelectionEntrypoint;
  status: "awaiting_selection" | "cancelled";
  videoOptions?: Pick<VideoChatRequest, "model" | "seconds" | "resolution" | "aspectRatio">;
  previousSettings?: AiWorkspaceVideoDraftSettings;
}

/** Workspace JSON is untrusted after reload. This is a pending user choice,
 * never an authorization to spend or to retrieve an arbitrary image. */
export function readGeneratedImageSelection(artifact: TongpinAIArtifact | undefined): GeneratedImageSelection | undefined {
  const raw = artifact?.data?.generatedImageSelection;
  if (artifact?.kind !== "参考图片选择" || !raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const id = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{8,160}$/.test(value);
  const assetIds = raw.assetIds;
  if (!id(raw.requestId) || !id(raw.sourceArtifactId) || !Array.isArray(assetIds) || assetIds.length < 2 || assetIds.length > 20
    || !assetIds.every(id) || new Set(assetIds).size !== assetIds.length
    || !["quick", "standard", "deep", "pro"].includes(String(raw.mode))
    || !["natural", "mention_image", "mention_video", "menu"].includes(String(raw.entrypoint))
    || !["awaiting_selection", "cancelled"].includes(String(raw.status))) return undefined;
  const options = raw.videoOptions;
  if (options !== undefined && (!options || typeof options !== "object" || Array.isArray(options)
    || typeof options.seconds !== "number" || !Number.isSafeInteger(options.seconds) || options.seconds < 1 || options.seconds > 120
    || typeof options.resolution !== "string" || !["16:9", "9:16"].includes(String(options.aspectRatio))
    || options.model !== undefined && typeof options.model !== "string")) return undefined;
  const previous = raw.previousSettings;
  if (previous !== undefined && (!previous || typeof previous !== "object" || Array.isArray(previous)
    || typeof previous.seconds !== "number" || !Number.isSafeInteger(previous.seconds) || previous.seconds < 1 || previous.seconds > 120
    || typeof previous.resolution !== "string" || !["16:9", "9:16", "1:1"].includes(String(previous.aspectRatio))
    || previous.model !== undefined && typeof previous.model !== "string")) return undefined;
  return raw as unknown as GeneratedImageSelection;
}
