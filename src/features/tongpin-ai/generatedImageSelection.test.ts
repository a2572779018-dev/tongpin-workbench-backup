import { describe, expect, it } from "vitest";
import { readGeneratedImageSelection } from "./generatedImageSelection";
import type { TongpinAIArtifact } from "./types";

const artifact: TongpinAIArtifact = { id: "artifact-request", conversationId: "conversation-a", kind: "参考图片选择", title: "选择参考图片", summary: "用刚才的人物做视频", updatedLabel: "刚刚", sections: [], data: {
  generatedImageSelection: { requestId: "request-1234", sourceArtifactId: "source-1234", assetIds: ["asset-1111", "asset-2222"], mode: "quick", entrypoint: "natural", status: "awaiting_selection" },
} };

describe("generated image selection intent", () => {
  it("rehydrates a bounded, same-conversation choice without treating it as a paid grant", () => {
    expect(readGeneratedImageSelection(JSON.parse(JSON.stringify(artifact)))).toMatchObject({ requestId: "request-1234", assetIds: ["asset-1111", "asset-2222"], status: "awaiting_selection" });
  });
  it("fails closed on malformed or duplicated choices", () => {
    expect(readGeneratedImageSelection({ ...artifact, kind: "图片" })).toBeUndefined();
    expect(readGeneratedImageSelection({ ...artifact, data: { generatedImageSelection: { ...(artifact.data?.generatedImageSelection as object), assetIds: ["asset-1111", "asset-1111"] } } })).toBeUndefined();
    expect(readGeneratedImageSelection({ ...artifact, data: { generatedImageSelection: { ...(artifact.data?.generatedImageSelection as object), videoOptions: { seconds: -2, resolution: "720p", aspectRatio: "16:9" } } } })).toBeUndefined();
  });
});
