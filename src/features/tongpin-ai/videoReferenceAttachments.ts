import type { AiWorkspaceDocument } from "../../../shared/aiWorkspace";

export interface LocalVideoReferenceImage {
  name: string;
  dataUrl: string;
  sourceVideo?: { documentId: string; name: string; timeSeconds: number };
}

export type VideoReferenceMigration =
  | { ok: true; images: LocalVideoReferenceImage[] }
  | { ok: false; message: string };

/**
 * Reuse images or an explicitly selected video sample. Never silently choose
 * the first sample: selecting the identity reference is a user decision.
 */
export function videoReferencesFromAttachments(
  attachments: readonly AiWorkspaceDocument[],
): VideoReferenceMigration {
  if (!attachments.length) return { ok: true, images: [] };
  const images: LocalVideoReferenceImage[] = [];
  for (const attachment of attachments) {
    const frames = attachment.media?.frames;
    if (attachment.media?.kind === "video") {
      const selected = attachment.media.selectedFrameIndex;
      const frame = Number.isInteger(selected) && selected! >= 0 ? frames?.[selected!] : undefined;
      if (!frame || !Number.isFinite(frame.timeSeconds) || frame.timeSeconds! < 0 || frame.timeSeconds! >= attachment.media.durationSeconds! || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(frame.dataUrl)) {
        return { ok: false, message: "请先在视频附件中选择一个采样画面作为角色参考；仅使用所选静态画面，不含音频。" };
      }
      images.push({ name: `${attachment.name} · ${frame.timeSeconds!.toFixed(2)} 秒`, dataUrl: frame.dataUrl,
        sourceVideo: { documentId: attachment.id, name: attachment.name, timeSeconds: frame.timeSeconds! } });
      continue;
    }
    if (
      attachment.media?.kind !== "image"
      || frames?.length !== 1
      || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(frames[0].dataUrl)
    ) {
      return {
        ok: false,
        message: "视频参考只能使用图片或已选择的采样画面；请移除文字文件后再试。",
      };
    }
    images.push({ name: attachment.name, dataUrl: frames[0].dataUrl });
  }
  return { ok: true, images };
}

/**
 * Keep a clarification-time video reference recoverable in the ordinary
 * workspace draft container. These records are inert media drafts: they do
 * not contain a provider reference id, plan id, trace, or execution grant.
 */
export function videoReferenceDraftAttachments(
  images: readonly LocalVideoReferenceImage[],
  idPrefix: string,
  sources: readonly AiWorkspaceDocument[] = [],
): AiWorkspaceDocument[] {
  return images.map((image, index) => {
    if (image.sourceVideo) {
      const source = sources.find(item => item.id === image.sourceVideo!.documentId && item.media?.kind === "video");
      const selectedFrameIndex = source?.media?.frames.findIndex(frame => frame.timeSeconds === image.sourceVideo!.timeSeconds && frame.dataUrl === image.dataUrl) ?? -1;
      if (source?.media && selectedFrameIndex >= 0) return { ...source, media: { ...source.media, selectedFrameIndex } };
    }
    const mimeType = image.dataUrl.slice(5, image.dataUrl.indexOf(";"));
    return {
      id: `${idPrefix}-${index + 1}`,
      name: image.name,
      mimeType,
      content: "视频参考图片",
      media: { kind: "image", frames: [{ dataUrl: image.dataUrl }] },
    };
  });
}
