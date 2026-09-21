import { describe, expect, it, vi } from "vitest";
import { h3VideoContentUrl, parseH3VideoInput, parseH3VideoTask, queryH3Video, submitH3Video } from "./videoProvider";
import type { AiTransport } from "./provider";
import { VIDEO_MODELS, videoSeconds } from "../../shared/aiVideoModels";

const connection = { baseUrl: "https://www.75api.com/v1", apiKey: "fixture-private-video-key" };
const input = { prompt: "雨后的花园，镜头缓慢前移", seconds: 15, resolution: "768p", aspectRatio: "9:16" };
const id = "task_9XxxSYXrZjnpkVdPgIvNm0YHkqmGDYyj";
const task = { id, task_id: id, status: "queued", progress: 0 };

describe("75api MiniMax H3 documented protocol", () => {
  it.each(VIDEO_MODELS.filter(model => model.generationEnabled))("uses the real model ID for $label", async model => {
    const resolution = model.resolutions[0];
    const seconds = videoSeconds(model.id, resolution)[0];
    const transport = vi.fn<AiTransport>().mockResolvedValue(Response.json(task));
    await submitH3Video(transport, connection, { ...input, model: model.id, resolution, seconds,
      ...(model.requiresImage ? { images: [`https://notify.samhubs.com/api/video-reference/${"a".repeat(64)}`] } : {}) });
    expect(JSON.parse(transport.mock.calls[0][1].body!)).toMatchObject({ model: model.id, seconds: String(seconds), resolution });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("enforces model-specific limits before contacting the provider", () => {
    expect(() => parseH3VideoInput({ ...input, model: "minimax_h3_no_audios_1080", seconds: 10, resolution: "1080p" })).toThrow("参考图片");
    expect(() => parseH3VideoInput({ ...input, model: "sd-2.0-fast", resolution: "720p" })).toThrow("时长");
    expect(parseH3VideoInput({ ...input, model: "sd-2.5-c1", seconds: 30, resolution: "720p" })).toMatchObject({ model: "sd-2.5-c1", seconds: 30, resolution: "720p" });
    expect(() => parseH3VideoInput({ ...input, model: "unknown" })).toThrow("模型");
  });
  it("keeps the existing SD 2.5 30-second provider contract unchanged", async () => {
    const model = VIDEO_MODELS.find(item => item.id === "sd-2.5-c1")!;
    expect(videoSeconds(model.id, "720p")).toEqual([30]);
    const transport = vi.fn<AiTransport>().mockResolvedValue(Response.json(task));
    await submitH3Video(transport, connection, { ...input, model: model.id, seconds: 30, resolution: "720p" });
    expect(JSON.parse(transport.mock.calls[0][1].body!)).toMatchObject({ model: model.id, seconds: "30", resolution: "720p" });
  });
  it("submits 15 seconds as a STRING to /v1/videos, not the text-chat API", async () => {
    const transport = vi.fn<AiTransport>().mockResolvedValue(Response.json(task));
    expect(await submitH3Video(transport, connection, input)).toEqual({ id, status: "queued", progress: 0 });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe("https://www.75api.com/v1/videos");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body!)).toEqual({ model: "minimax_h3", prompt: input.prompt, seconds: "15", resolution: "768p", aspect_ratio: "9:16" });
  });
  it.each([
    ["processing", "processing"],
    ["in_progress", "processing"],
    ["succeeded", "completed"],
    ["completed", "completed"],
  ] as const)("normalizes documented New API status %s to %s", (providerStatus, status) => {
    expect(parseH3VideoTask({ id: "video_123", status: providerStatus, progress: status === "completed" ? 100 : 25, seconds: "5", size: "1920x1080" })).toEqual({ id: "video_123", status, progress: status === "completed" ? 100 : 25 });
  });
  it("queries and downloads with the documented video_ task ID without trusting response URLs", async () => {
    const videoId = "video_123";
    const transport = vi.fn<AiTransport>().mockResolvedValue(Response.json({ id: videoId, status: "succeeded", progress: 100, seconds: "5", size: "1920x1080", url: "https://attacker.invalid/private.mp4" }));
    expect(await queryH3Video(transport, connection, videoId)).toEqual({ id: videoId, status: "completed", progress: 100 });
    expect(transport.mock.calls[0][0]).toBe(`https://www.75api.com/v1/videos/${videoId}`);
    expect(h3VideoContentUrl(connection.baseUrl, videoId)).toBe(`https://www.75api.com/v1/videos/${videoId}/content`);
  });
  it.each([0, 4, 16, 5.5, "15", null])("rejects unsupported duration %s before a request", async seconds => {
    const transport = vi.fn<AiTransport>();
    await expect(submitH3Video(transport, connection, { ...input, seconds })).rejects.toMatchObject({ code: "AI_VIDEO_INPUT_INVALID", definitelyNotSent: true });
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([{ resolution: "720p" }, { aspectRatio: "1:1" }, { prompt: "" }, { prompt: "x".repeat(4001) }, { prompt: "x\0y" }])("rejects invalid parameters", patch => {
    expect(() => parseH3VideoInput({ ...input, ...patch })).toThrow();
  });
  it.each(["audios", "attachments", "firstFrame", "lastFrame"])("does not silently discard unsupported %s", name => {
    expect(() => parseH3VideoInput({ ...input, [name]: [] })).toThrow("不支持");
  });
  it("sends the documented images array with managed reference URLs", async () => {
    const images = [`https://notify.samhubs.com/api/video-reference/${"a".repeat(64)}`];
    const transport = vi.fn<AiTransport>().mockResolvedValue(Response.json(task));
    await submitH3Video(transport, connection, { ...input, images });
    expect(JSON.parse(transport.mock.calls[0][1].body!).images).toEqual(images);
    expect(() => parseH3VideoInput({ ...input, images: Array(9).fill(images[0]) })).toThrow();
    expect(() => parseH3VideoInput({ ...input, images: ["http://localhost/private.jpg"] })).toThrow();
  });
  it.each([403, 502, 503])("does not retry paid POST on HTTP %i", async status => {
    const transport = vi.fn<AiTransport>().mockResolvedValue(Response.json({ error: { code: "upstream_error", message: connection.apiKey } }, { status }));
    const error = await submitH3Video(transport, connection, input).catch(error => error);
    expect(error.diagnostic).toMatchObject({ operation: "video", httpStatus: status, billing: status === 403 ? "rejected" : "unknown" });
    expect(JSON.stringify(error)).not.toContain(connection.apiKey);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("does not resubmit when a successful HTTP response is unrecognizable", async () => {
    const transport = vi.fn<AiTransport>().mockResolvedValue(Response.json({ private: connection.apiKey }));
    await expect(submitH3Video(transport, connection, input)).rejects.toMatchObject({ code: "AI_VIDEO_RESPONSE_INVALID" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("queries the canonical ID and ignores unsafe URLs and arbitrary upstream fields", async () => {
    const transport = vi.fn<AiTransport>().mockResolvedValue(Response.json({ ...task, task_id: "task_a_different_documented_alias", status: "completed", progress: 100, video_url: "https://attacker.invalid/key", fail_reason: connection.apiKey }));
    expect(await queryH3Video(transport, connection, id)).toEqual({ id, status: "completed", progress: 100 });
    expect(transport.mock.calls[0][0]).toBe(`https://www.75api.com/v1/videos/${id}`);
    expect(transport.mock.calls[0][1].method).toBe("GET");
    expect(h3VideoContentUrl(connection.baseUrl, id)).toBe(`https://www.75api.com/v1/videos/${id}/content`);
  });
  it.each(["../../internal", "task_12345678?key=private", "task_12345678/../../foo", "video_12", "https://attacker.invalid/"])("rejects malicious or unsupported task ID %s", async badId => {
    const transport = vi.fn<AiTransport>();
    await expect(queryH3Video(transport, connection, badId)).rejects.toMatchObject({ code: "AI_VIDEO_RESPONSE_INVALID" });
    expect(transport).not.toHaveBeenCalled();
    expect(() => h3VideoContentUrl(connection.baseUrl, badId)).toThrow();
  });
  it.each([{ id: "task_wrong_resource" }, { status: "unknown" }, { progress: 101 }, { progress: "100%" }, { progress: Number.NaN }])("fails closed on invalid task responses", patch => {
    expect(() => parseH3VideoTask({ ...task, ...patch }, id)).toThrow();
  });
});
