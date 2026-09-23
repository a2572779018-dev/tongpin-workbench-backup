import { describe, expect, it } from "vitest";
import type { AiWorkspaceDocument } from "../../../shared/aiWorkspace";
import { videoReferenceDraftAttachments, videoReferencesFromAttachments } from "./videoReferenceAttachments";

const image = (name: string, dataUrl = "data:image/png;base64,aGVsbG8="): AiWorkspaceDocument => ({
  id: `image-${name}`,
  name,
  mimeType: "image/png",
  content: "",
  media: { kind: "image", frames: [{ dataUrl }] },
});

describe("video reference attachment migration", () => {
  it("preserves the selected image order without decoding or copying bytes", () => {
    const first = image("first.png");
    const second = image("second.webp", "data:image/webp;base64,d29ybGQ=");
    expect(videoReferencesFromAttachments([first, second])).toEqual({
      ok: true,
      images: [
        { name: "first.png", dataUrl: first.media!.frames[0].dataUrl },
        { name: "second.webp", dataUrl: second.media!.frames[0].dataUrl },
      ],
    });
  });

  it("round-trips clarification references as inert draft media without execution metadata", () => {
    const references = [
      { name: "first.png", dataUrl: "data:image/png;base64,aGVsbG8=" },
      { name: "second.webp", dataUrl: "data:image/webp;base64,d29ybGQ=" },
    ];
    const drafts = videoReferenceDraftAttachments(references, "video-conversation-a");
    expect(videoReferencesFromAttachments(drafts)).toEqual({ ok: true, images: references });
    expect(drafts).toEqual([
      expect.objectContaining({ id: "video-conversation-a-1", mimeType: "image/png" }),
      expect.objectContaining({ id: "video-conversation-a-2", mimeType: "image/webp" }),
    ]);
    for (const draft of drafts) {
      expect(draft).not.toHaveProperty("planRequestId");
      expect(draft).not.toHaveProperty("trace");
      expect(draft).not.toHaveProperty("referenceId");
    }
  });

  it("fails closed for text and sampled-video attachments", () => {
    const text: AiWorkspaceDocument = { id: "doc", name: "brief.md", mimeType: "text/markdown", content: "brief" };
    const video: AiWorkspaceDocument = {
      id: "video",
      name: "clip.mp4",
      mimeType: "video/mp4",
      content: "",
      media: { kind: "video", durationSeconds: 1, frames: [{ dataUrl: "data:image/jpeg;base64,aGVsbG8=", timeSeconds: 0 }] },
    };
    expect(videoReferencesFromAttachments([text]).ok).toBe(false);
    expect(videoReferencesFromAttachments([video]).ok).toBe(false);
  });

  it("rejects malformed image frames", () => {
    expect(videoReferencesFromAttachments([image("bad.png", "javascript:alert(1)")]).ok).toBe(false);
  });

  it("uses only the explicitly selected video frame and preserves its source", () => {
    const video: AiWorkspaceDocument = { id: "clip-source", name: "actor.mp4", mimeType: "video/mp4", content: "sampled only", media: {
      kind: "video", durationSeconds: 9, selectedFrameIndex: 1,
      frames: [{ dataUrl: "data:image/jpeg;base64,YQ==", timeSeconds: 0.001 }, { dataUrl: "data:image/jpeg;base64,Yg==", timeSeconds: 4.5 }],
    } };
    expect(videoReferencesFromAttachments([video])).toEqual({ ok: true, images: [{ name: "actor.mp4 · 4.50 秒", dataUrl: "data:image/jpeg;base64,Yg==", sourceVideo: { documentId: "clip-source", name: "actor.mp4", timeSeconds: 4.5 } }] });
    expect(video.media!.frames).toHaveLength(2);
    for (const selectedFrameIndex of [-1, 2, 0.5, undefined]) {
      expect(videoReferencesFromAttachments([{ ...video, media: { ...video.media!, selectedFrameIndex } }]).ok).toBe(false);
    }
  });
});
