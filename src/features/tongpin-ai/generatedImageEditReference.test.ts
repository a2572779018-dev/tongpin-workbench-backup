import { describe, expect, it } from "vitest";
import type { TongpinAIArtifact, TongpinAIConversation } from "./types";
import { generatedImageEditReferenceIds } from "./generatedImageEditReference";

const conversation: TongpinAIConversation = { id: "conversation-a", title: "A", timeLabel: "", messages: [{ id: "reply", role: "assistant", content: "图片", time: "", artifactId: "image-a" }] };
const image: TongpinAIArtifact = { id: "image-a", conversationId: "conversation-a", title: "图片", kind: "图片", updatedLabel: "", summary: "", sections: [], data: { images: [{ assetId: "asset-a" }] } };

describe("generated image edit source", () => {
  it("binds a single original asset only when the user explicitly refers back to it", () => {
    expect(generatedImageEditReferenceIds(conversation, [image], "按刚才那张修改背景")).toEqual(["asset-a"]);
    expect(generatedImageEditReferenceIds(conversation, [image], "生成一张蓝色图片")).toEqual([]);
  });
  it("rejects missing, foreign, deleted or ambiguous sources before generation", () => {
    expect(() => generatedImageEditReferenceIds(conversation, [{ ...image, conversationId: "conversation-b" }], "修改这张")).toThrow("没有找到");
    expect(() => generatedImageEditReferenceIds(conversation, [{ ...image, data: { images: [{ assetId: "a" }, { assetId: "b" }] } }], "修改这张")).toThrow("多张");
    expect(() => generatedImageEditReferenceIds(conversation, [{ ...image, data: { images: [{ assetId: "a", deleted: true }] } }], "修改这张")).toThrow("已删除");
  });
});
