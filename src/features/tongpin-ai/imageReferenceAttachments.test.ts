import { describe, expect, it } from "vitest";
import { imageReferencesForGeneration } from "./imageReferenceAttachments";
import type { AiWorkspaceDocument } from "../../../shared/aiWorkspace";
const image: AiWorkspaceDocument = { id: "image", name: "reference.jpg", mimeType: "image/jpeg", content: "图", media: { kind: "image", frames: [{ dataUrl: "data:image/jpeg;base64,YQ==" }] } };
describe("task-specific image input capability", () => {
  it("preserves reference bytes when this tier supports edits without requiring text vision", () => {
    expect(imageReferencesForGeneration([image], ["deep"], "deep")).toEqual([{ name: "reference.jpg", mediaType: "image/jpeg", dataUrl: image.media!.frames[0].dataUrl, text: "图片附件：reference.jpg" }]);
  });
  it("rejects unsupported tiers and non-image inputs instead of dropping references", () => {
    expect(() => imageReferencesForGeneration([image], ["quick"], "deep")).toThrow("档位");
    expect(() => imageReferencesForGeneration([{ id: "text", name: "brief.txt", mimeType: "text/plain", content: "brief" }], ["deep"], "deep")).toThrow("图片");
    expect(imageReferencesForGeneration([], [], "deep")).toEqual([]);
  });
});
