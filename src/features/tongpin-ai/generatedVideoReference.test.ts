import { describe, expect, it, vi } from "vitest";
import { generatedVideoReference, videoReferenceUploadBody } from "./generatedVideoReference";
import type { TongpinAIArtifact, TongpinAIConversation } from "./types";
const conversation: TongpinAIConversation = { id: "conversation-a", title: "A", timeLabel: "", messages: [{ id: "reply", role: "assistant", artifactId: "artifact", content: "图片", time: "" }] };
const artifact: TongpinAIArtifact = { id: "artifact", conversationId: conversation.id, title: "图片", kind: "图片", summary: "", sections: [], updatedLabel: "", data: { images: [{ assetId: "asset-original" }] } };
const source = { assetId: "asset-original", conversationId: conversation.id, mimeType: "image/png", base64: btoa("image-bytes"), sourceFingerprint: "source-hash" };
const extract = vi.fn(async () => ({ name: "reference.jpg", text: "", mediaType: "image/jpeg", warnings: [], media: { kind: "image" as const, frames: [{ dataUrl: "data:image/jpeg;base64,YWJj" }] } }));
describe("generated image becomes a bound video reference", () => {
  it("binds a plain uploaded image to the target conversation", () => {
    expect(videoReferenceUploadBody({ name: "portrait.jpg", dataUrl: "data:image/jpeg;base64,YQ==" }, "conversation-a"))
      .toEqual({ dataUrl: "data:image/jpeg;base64,YQ==", conversationId: "conversation-a" });
  });
  it("carries the selected video's provenance to the actual reference upload", () => {
    const ref = { name: "clip 4.5s", dataUrl: "data:image/jpeg;base64,Yg==", sourceVideo: { documentId: "clip-source", name: "actor.mp4", timeSeconds: 4.5 } };
    expect(videoReferenceUploadBody(ref, "conversation-a")).toEqual({ dataUrl: ref.dataUrl, conversationId: "conversation-a", sourceVideo: { ...ref.sourceVideo, conversationId: "conversation-a" } });
  });
  it("authorizes the exact source then carries its binding into the actual reference upload", async () => {
    const api = vi.fn(async (_path: string, _init?: RequestInit) => source);
    const ref = await generatedVideoReference(conversation, [artifact], "沿用这张图片做视频", api as never, "member-a", new AbortController().signal, extract);
    expect(JSON.parse(api.mock.calls[0]?.[1]?.body as string)).toEqual({ conversationId: conversation.id, assetId: source.assetId });
    expect(videoReferenceUploadBody(ref!, conversation.id)).toEqual({ dataUrl: "data:image/jpeg;base64,YWJj", conversationId: conversation.id, generatedAsset: { conversationId: conversation.id, assetId: source.assetId, sourceFingerprint: "source-hash" } });
  });
  it("never silently downgrades an unavailable or wrong-conversation reference to text-only", async () => {
    const denied = vi.fn(async () => { throw Error("asset unavailable"); });
    await expect(generatedVideoReference(conversation, [artifact], "沿用这张图片做视频", denied, "member-a", new AbortController().signal, extract)).rejects.toThrow("asset unavailable");
    await expect(generatedVideoReference(conversation, [artifact], "沿用这张图片做视频", (async () => ({ ...source, conversationId: "b" })) as never, "member-a", new AbortController().signal, extract)).rejects.toThrow("不匹配");
  });
  it("does not guess a source across conversations or multiple images", async () => {
    const api = vi.fn(async () => source);
    expect(await generatedVideoReference(conversation, [{ ...artifact, conversationId: "b" }], "沿用这张图片做视频", api as never, "member-a", new AbortController().signal, extract)).toBeUndefined();
    await expect(generatedVideoReference(conversation, [{ ...artifact, data: { images: [{ assetId: "a" }, { assetId: "b" }] } }], "沿用这张图片做视频", api as never, "member-a", new AbortController().signal, extract)).rejects.toThrow("多张图片");
    expect(api).not.toHaveBeenCalled();
  });
});
