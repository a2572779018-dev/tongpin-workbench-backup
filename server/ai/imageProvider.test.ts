import { describe, expect, it } from "vitest";
import { imageProviderBody, prepareImageProviderRequest, readImageProviderResponse } from "./imageProvider";
import type { AiAttachment } from "../../shared/ai";
import type { AiImageEditCapability, AiImageGenerationCapability } from "../../shared/aiImageCapabilities";
import { AiError } from "./security";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
// Tiny actual image fixtures: JPEG/rectangular PNG encoded locally with ffmpeg;
// WEBP decoded successfully with ffmpeg. They do not represent provider generation results.
const JPEG = "/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYzLjEuMTAxAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAEwAAQEAAAAAAAAAAAAAAAAAAAAGAQEBAAAAAAAAAAAAAAAAAAAGBxABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAIAAgMBIgACEQADEQD/2gAMAwEAAhEDEQA/AIsATX9//9k=";
const WEBP = "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA";
const RECTANGULAR_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEElEQVR4nGP8w4AALEhsBgAZBAECEOg4BgAAAABJRU5ErkJggg==";
const event = (type: string, fields: Record<string, unknown> = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
const complete = event("image_generation.completed", { b64_json: PNG });
const response = (text: string) => new Response(text, { headers: { "content-type": "text/event-stream; charset=utf-8" } });

const baseUrl = "https://images.example.com/v1";
const editCapability: AiImageEditCapability = { baseUrl, modelId: "custom-image-alias", profile: "openai-gpt-image-edits-v1" };
const attachment = (data = PNG, mime = "image/png"): AiAttachment => ({ name: "原始人物.png", mediaType: mime, dataUrl: `data:${mime};base64,${data}` });
const prepare = (overrides: Partial<Parameters<typeof prepareImageProviderRequest>[0]> = {}) => prepareImageProviderRequest({ baseUrl, modelId: editCapability.modelId, prompt: "保留人物，换成蓝色背景", stream: false, attachments: [attachment()], editCapability, ...overrides });
async function multipart(request: ReturnType<typeof prepareImageProviderRequest>) {
  expect(request.endpoint).toBe("/images/edits");
  expect(request.body).toBeUndefined();
  expect(request.binaryBody).toBeInstanceOf(Uint8Array);
  return new Response(request.binaryBody!.slice().buffer as ArrayBuffer, { headers: { "content-type": request.contentType } }).formData();
}

describe("Administrator-declared image generation profiles", () => {
  const generationCapability: AiImageGenerationCapability = {
    baseUrl, modelId: "relay-alias-with-no-gpt-name", profile: "openai-gpt-image-generations-v1", size: "1536x1024",
  };
  const generate = (overrides: Partial<Parameters<typeof prepareImageProviderRequest>[0]> = {}) => prepareImageProviderRequest({
    baseUrl, modelId: generationCapability.modelId, prompt: "画一个蓝色方形徽标", stream: true,
    generationCapability, ...overrides,
  });
  it("uses the selected GPT-compatible wire shape and size for an alias regardless of its name", () => {
    const request = generate();
    expect(request.endpoint).toBe("/images/generations");
    expect(JSON.parse(request.body!)).toEqual({
      model: generationCapability.modelId, prompt: "画一个蓝色方形徽标", n: 1, size: "1536x1024",
      output_format: "jpeg", stream: true, partial_images: 0,
    });
  });
  it.each([
    ["openai-dall-e-2-generations-v1", "256x256"],
    ["openai-dall-e-3-generations-v1", "1024x1792"],
  ] as const)("uses %s b64 contract without unsupported GPT-only streaming fields", (profile, size) => {
    const request = generate({ generationCapability: { ...generationCapability, profile, size } });
    expect(JSON.parse(request.body!)).toEqual({
      model: generationCapability.modelId, prompt: "画一个蓝色方形徽标", n: 1, size, response_format: "b64_json",
    });
  });
  it.each([
    { modelId: "different-model" }, { baseUrl: "https://other.example.com/v1" },
    { generationCapability: { ...generationCapability, profile: "unknown" } },
    { generationCapability: { ...generationCapability, size: "4096x4096" } },
  ])("rejects mismatched or unknown configurations before any network request: %j", change => {
    expect(() => generate(change as never)).toThrowError(expect.objectContaining({ definitelyNotSent: true }));
  });
  it("enforces the selected protocol's prompt bound before generation", () => {
    expect(() => generate({ generationCapability: { ...generationCapability, profile: "openai-dall-e-2-generations-v1", size: "1024x1024" }, prompt: "x".repeat(1001) }))
      .toThrowError(expect.objectContaining({ code: "AI_IMAGE_PROMPT_INVALID", definitelyNotSent: true }));
  });
});

describe("Explicitly configured reference image request", () => {
  it.each(["gpt-image-1", "legacy-image"])("preserves existing text-only generation for %s", modelId => {
    const result = prepare({ modelId, attachments: [], editCapability: undefined, stream: true });
    expect(result).toEqual({ endpoint: "/images/generations", contentType: "application/json", body: JSON.stringify(imageProviderBody({ imageModel: modelId, imageStream: true } as never, "保留人物，换成蓝色背景")) });
  });
  it("keeps text attachments in the previously bound plan context without requiring an edit adapter", () => {
    const request = prepare({ attachments: [{ name: "brief.txt", text: "品牌采用蓝色" }], editCapability: undefined });
    expect(request.endpoint).toBe("/images/generations");
    expect(JSON.parse(request.body!)).toMatchObject({ prompt: "保留人物，换成蓝色背景" });
  });
  it("sends original binary reference bytes with a configured alias, never a text description substitute", async () => {
    const form = await multipart(prepare({ stream: true }));
    expect(form.get("model")).toBe("custom-image-alias");
    expect(form.get("prompt")).toBe("保留人物，换成蓝色背景");
    expect(form.get("output_format")).toBe("jpeg");
    expect(form.get("response_format")).toBeNull();
    expect(form.get("stream")).toBe("true");
    expect(form.get("partial_images")).toBe("0");
    const file = form.get("image[]") as File;
    expect(file.name).toBe("reference-1.png");
    expect(file.type).toBe("image/png");
    expect(Buffer.from(await file.arrayBuffer()).toString("base64")).toBe(PNG);
  });
  it("retains multipart image order and never interpolates original filenames into headers", async () => {
    const second = { ...attachment(RECTANGULAR_PNG), name: 'x.png"\r\nX-Injected: true\r\n' };
    const request = prepare({ attachments: [attachment(), second] });
    expect(new TextDecoder().decode(request.binaryBody)).not.toContain("X-Injected");
    const files = (await multipart(request)).getAll("image[]") as File[];
    expect(files.map(file => file.name)).toEqual(["reference-1.png", "reference-2.png"]);
    expect(await Promise.all(files.map(async file => Buffer.from(await file.arrayBuffer()).toString("base64")))).toEqual([PNG, RECTANGULAR_PNG]);
  });
  it.each([[JPEG, "image/jpeg", "jpg"], [WEBP, "image/webp", "webp"]])("sends actual %s bytes with the correct multipart media type", async (bytes, mime, extension) => {
    const form = await multipart(prepare({ attachments: [attachment(bytes, mime)] }));
    const file = form.get("image[]") as File;
    expect(file.type).toBe(mime);
    expect(file.name).toBe(`reference-1.${extension}`);
    expect(Buffer.from(await file.arrayBuffer()).toString("base64")).toBe(bytes);
  });
  it("rejects PNG corruption, JPEG header-only fakes, and wrong WebP RIFF length", () => {
    const corruptPng = Buffer.from(PNG, "base64"); corruptPng[44] ^= 1;
    const headerOnlyJpeg = Buffer.from([255, 216, 255, 192, 0, 17, 8, 0, 1, 0, 1, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0, 0, 0, 255, 217]);
    const corruptWebp = Buffer.from(WEBP, "base64"); corruptWebp[4] += 2;
    for (const image of [attachment(corruptPng.toString("base64")), attachment(headerOnlyJpeg.toString("base64"), "image/jpeg"), attachment(corruptWebp.toString("base64"), "image/webp")]) {
      expect(() => prepare({ attachments: [image] })).toThrowError(expect.objectContaining({ code: "AI_IMAGE_REFERENCE_INVALID", definitelyNotSent: true }));
    }
  });
  it.each([
    { editCapability: undefined },
    { baseUrl: "https://another.example.com/v1" },
    { modelId: "gpt-image-1" },
  ])("fails closed when no exact provider/model editing capability applies: %j", overrides => {
    expect(() => prepare(overrides)).toThrowError(expect.objectContaining({ code: "AI_IMAGE_EDIT_UNSUPPORTED", definitelyNotSent: true }));
  });
  it("supports a trailing slash without matching a different URL path", () => {
    expect(prepare({ baseUrl: `${baseUrl}/` }).endpoint).toBe("/images/edits");
    expect(() => prepare({ baseUrl: `${baseUrl}/other` })).toThrowError(expect.objectContaining({ code: "AI_IMAGE_EDIT_UNSUPPORTED" }));
  });
  it.each([
    attachment(PNG, "image/jpeg"),
    attachment(Buffer.from("not an image").toString("base64")),
    { name: "source.png", mediaType: "image/png", text: "人物照片" },
    { name: "source.png", dataUrl: "https://private.example.com/image.png" },
    { name: "empty.txt" },
    { ...attachment(), mediaType: "image/webp" },
    attachment(PNG.slice(0, -8)),
  ])("rejects invalid or unread image attachments before submission: %j", image => {
    expect(() => prepare({ attachments: [image] })).toThrowError(expect.objectContaining({ code: "AI_IMAGE_REFERENCE_INVALID", definitelyNotSent: true }));
  });
  it("rejects more references than the explicit protocol supports", () => {
    expect(() => prepare({ attachments: Array.from({ length: 17 }, () => attachment()) })).toThrowError(expect.objectContaining({ code: "AI_IMAGE_REFERENCE_LIMIT" }));
  });
  it("keeps the app's existing 1 MiB aggregate reference limit before decoding", () => {
    expect(() => prepare({ attachments: [attachment("A".repeat(1_398_104))] })).toThrowError(expect.objectContaining({ code: "AI_IMAGE_REFERENCE_LIMIT" }));
  });
  it("uses one image and b64_json for the DALL-E 2 profile, without GPT-only fields", async () => {
    const form = await multipart(prepare({ stream: true, editCapability: { ...editCapability, profile: "openai-dall-e-2-edits-v1" } }));
    expect(form.get("image")).toBeInstanceOf(File);
    expect(form.get("image[]")).toBeNull();
    expect(form.get("response_format")).toBe("b64_json");
    expect(form.get("output_format")).toBeNull();
    expect(form.get("stream")).toBeNull();
    expect(form.get("partial_images")).toBeNull();
  });
  it("enforces profile prompt length and single-image limits", () => {
    const dallE = { ...editCapability, profile: "openai-dall-e-2-edits-v1" as const };
    expect(() => prepare({ editCapability: dallE, attachments: [attachment(), attachment()] })).toThrowError(expect.objectContaining({ code: "AI_IMAGE_REFERENCE_LIMIT" }));
    expect(() => prepare({ editCapability: dallE, prompt: "a".repeat(1001) })).toThrowError(expect.objectContaining({ code: "AI_IMAGE_PROMPT_INVALID" }));
    expect(() => prepare({ prompt: "a".repeat(32001) })).toThrowError(expect.objectContaining({ code: "AI_IMAGE_PROMPT_INVALID" }));
    for (const image of [attachment(RECTANGULAR_PNG), attachment(JPEG, "image/jpeg"), attachment(WEBP, "image/webp")]) {
      expect(() => prepare({ editCapability: dallE, attachments: [image] })).toThrowError(expect.objectContaining({ code: "AI_IMAGE_REFERENCE_INVALID" }));
    }
  });
  it("roundtrips adversarial field text without creating extra multipart headers or fields", async () => {
    const prompt = '修改背景\r\nContent-Disposition: form-data; name="injected"\r\n\r\nvalue';
    const form = await multipart(prepare({ prompt }));
    expect(form.get("prompt")).toBe(prompt);
    expect(form.get("injected")).toBeNull();
  });
  it("reads an edit stream final and never delivers a partial edit", async () => {
    const partial = event("image_edit.partial_image", { b64_json: PNG });
    expect(await readImageProviderResponse(response(partial + event("image_edit.completed", { b64_json: PNG })))).toEqual({ data: [{ b64_json: PNG }] });
    await expect(readImageProviderResponse(response(partial))).rejects.toMatchObject({ code: "AI_IMAGE_STREAM_INTERRUPTED" });
    await expect(readImageProviderResponse(response(event("image_edit.failed")))).rejects.toMatchObject({ code: "AI_IMAGE_STREAM_FAILED" });
  });
});

describe("Bounded standard Images JSON/SSE parsing", () => {
  it("keeps the complete JSON contract", async () => {
    expect(await readImageProviderResponse(Response.json({ data: [{ b64_json: PNG }] }))).toEqual({ data: [{ b64_json: PNG }] });
  });
  it.each([complete, `: heartbeat\n\n${complete}data: [DONE]\n\n`, complete.replace(/\n/g, "\r\n"), complete.trimEnd()])("accepts exactly one explicit completed image and harmless framing", async value => {
    expect(await readImageProviderResponse(response(value))).toEqual({ data: [{ b64_json: PNG }] });
  });
  it("detects SSE with a generic content type and handles network chunk splits", async () => {
    const bytes = new TextEncoder().encode(complete);
    const body = new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); } });
    expect(await readImageProviderResponse(new Response(body))).toEqual({ data: [{ b64_json: PNG }] });
  });
  it("never delivers a partial preview as final, but accepts a later completed image", async () => {
    const partial = event("image_generation.partial_image", { partial_image_index: 0, b64_json: "not-a-final-image" });
    expect(await readImageProviderResponse(response(partial + complete))).toEqual({ data: [{ b64_json: PNG }] });
    await expect(readImageProviderResponse(response(partial + "data: [DONE]\n\n"))).rejects.toMatchObject({ code: "AI_IMAGE_STREAM_INTERRUPTED" });
  });
  it.each(["data: [DONE]\n\n", ": heartbeat\n\n", 'data: {"data":[{"b64_json":"unknown-legacy-event"}]}\n\n'])("requires a real completed terminal event", async text => {
    await expect(readImageProviderResponse(response(text))).rejects.toMatchObject({ code: "AI_IMAGE_STREAM_INTERRUPTED" });
  });
  it.each([complete + complete, event("image_generation.completed", { url: "https://example.com/private" }), 'event: image_generation.completed\ndata: {"type":"image_generation.partial_image","b64_json":"x"}\n\n', 'data: {broken\n\n'])("rejects duplicates, URL-only finals, mismatched types and broken JSON", async text => {
    await expect(readImageProviderResponse(response(text))).rejects.toMatchObject({ code: "AI_IMAGE_STREAM_INVALID" });
  });
  it.each([event("error", { message: "private-api-key" }), complete + event("image_generation.failed", { error: { message: "private-api-key" } })])("fails closed on provider stream errors even after a completed event without echoing body", async text => {
    const error = await readImageProviderResponse(response(text)).catch(error => error);
    expect(error).toBeInstanceOf(AiError);
    if (!(error instanceof AiError)) throw new Error("Expected safe image stream error");
    expect(error.code).toBe("AI_IMAGE_STREAM_FAILED");
    expect(error.message).not.toContain("private-api-key");
  });
  it("bounds all stream bytes, including comments and previews", async () => {
    await expect(readImageProviderResponse(response(`:${"x".repeat(6_000_001)}\n\n${complete}`))).rejects.toMatchObject({ code: "AI_PROVIDER_RESPONSE" });
  });
});
