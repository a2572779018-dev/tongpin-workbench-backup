import { describe, expect, it } from "vitest";
import type { AiWorkspaceDocument } from "../../../shared/aiWorkspace";
import { videoReferencesFromAttachments } from "./videoReferenceAttachments";

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
});
