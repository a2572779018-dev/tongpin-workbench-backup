import { describe, expect, it } from "vitest";
import { parseImageEditCapability } from "./imageCapabilities";

const valid = { baseUrl: "https://images.example.com/v1", modelId: "custom-edit-alias", profile: "openai-gpt-image-edits-v1" };

describe("Image editing capability configuration", () => {
  it("leaves absent configuration disabled without guessing from the model name", () => {
    expect(parseImageEditCapability(undefined)).toBeUndefined();
  });
  it("parses exact provider, model and known protocol profile with normalized trailing slash", () => {
    expect(parseImageEditCapability({ ...valid, baseUrl: `${valid.baseUrl}/` })).toEqual(valid);
    expect(parseImageEditCapability({ ...valid, profile: "openai-dall-e-2-edits-v1" })?.profile).toBe("openai-dall-e-2-edits-v1");
  });
  it.each([
    null, [], true, {}, { ...valid, profile: "guess-from-model" }, { ...valid, modelId: "" },
    { ...valid, modelId: "model\r\nAuthorization: injected" }, { ...valid, baseUrl: "http://images.example.com/v1" },
    { ...valid, baseUrl: "https://user:secret@images.example.com/v1" }, { ...valid, baseUrl: "https://images.example.com/v1?key=secret" },
    { ...valid, baseUrl: "https://images.example.com/v1/images/edits" }, { ...valid, extra: true },
  ])("rejects unsafe, unknown or malformed declarations: %j", input => {
    expect(() => parseImageEditCapability(input)).toThrowError(expect.objectContaining({ code: "AI_IMAGE_EDIT_CAPABILITY_INVALID" }));
  });
});
