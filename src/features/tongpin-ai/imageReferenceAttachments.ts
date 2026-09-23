import type { AiAttachment, AiMode } from "../../../shared/ai";
import type { AiWorkspaceDocument } from "../../../shared/aiWorkspace";
import { documentAttachments } from "./attachments";

/** Reference images belong to the selected image route. Planning and execution
 * receive identical bytes even when the chat model has no vision capability. */
export function imageReferencesForGeneration(
  documents: readonly AiWorkspaceDocument[],
  imageEditTiers: readonly AiMode[] | undefined,
  tier: AiMode,
): AiAttachment[] {
  if (!documents.length) return [];
  if (!imageEditTiers?.includes(tier)) throw new Error("当前档位尚未配置参考图编辑，请移除附件或切换档位");
  if (documents.some(item => item.media?.kind !== "image" || item.media.frames.length !== 1)) {
    throw new Error("图片生成只接受图片参考附件，请移除文字文件或视频");
  }
  return documentAttachments(documents).map(item => ({
    ...item,
    mediaType: item.dataUrl?.slice(5, item.dataUrl.indexOf(";")) || item.mediaType,
  }));
}
