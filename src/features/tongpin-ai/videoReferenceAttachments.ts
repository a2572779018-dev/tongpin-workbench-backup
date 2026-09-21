import type { AiWorkspaceDocument } from "../../../shared/aiWorkspace";

export interface LocalVideoReferenceImage {
  name: string;
  dataUrl: string;
}

export type VideoReferenceMigration =
  | { ok: true; images: LocalVideoReferenceImage[] }
  | { ok: false; message: string };

/**
 * Reuse images already read by the chat composer. Text documents and sampled
 * videos are deliberately rejected: forwarding either as a video reference
 * would change the meaning of the user's attachment without consent.
 */
export function videoReferencesFromAttachments(
  attachments: readonly AiWorkspaceDocument[],
): VideoReferenceMigration {
  if (!attachments.length) return { ok: true, images: [] };
  const images: LocalVideoReferenceImage[] = [];
  for (const attachment of attachments) {
    const frames = attachment.media?.frames;
    if (
      attachment.media?.kind !== "image"
      || frames?.length !== 1
      || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(frames[0].dataUrl)
    ) {
      return {
        ok: false,
        message: "视频参考只能使用图片；请移除文件或视频附件后再试。",
      };
    }
    images.push({ name: attachment.name, dataUrl: frames[0].dataUrl });
  }
  return { ok: true, images };
}
