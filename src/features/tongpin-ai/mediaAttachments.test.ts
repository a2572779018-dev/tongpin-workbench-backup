import { describe, expect, it } from "vitest";
import { AI_MEDIA_LIMITS, mediaFrameByteLength, videoSampleTimes } from "../../../shared/aiMedia";
import { AI_WORKSPACE_LIMITS, type AiWorkspaceDocument } from "../../../shared/aiWorkspace";
import { documentAttachments, ensureAttachmentWorkspaceCapacity, extractAttachment, validateAttachments, workspaceAttachment, WorkspaceCapacityError } from "./attachments";
import { imageDimensions } from "./mediaAttachments";
import { hydrateWorkspace, serializeWorkspace } from "./workspaceState";
import { parseChatCapabilities } from "../../../server/ai/capabilities";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const dataUrl = `data:image/png;base64,${png}`;
const document = (): AiWorkspaceDocument => ({ id: "image-a", name: "截图.png", mimeType: "image/png", content: "图片", media: { kind: "image", frames: [{ dataUrl }] } });

describe("bounded visual attachments", () => {
  it("retains actual visual data through workspace serialization and API payload", () => {
    const session = hydrateWorkspace(null);
    session.draftAttachments = { "new-conversation": [document()] };
    const restored = hydrateWorkspace(JSON.parse(JSON.stringify(serializeWorkspace(session))));
    expect(restored.draftAttachments).toEqual(session.draftAttachments);
    const payload = documentAttachments(restored.draftAttachments!["new-conversation"]);
    expect(payload[0].dataUrl).toBe(dataUrl);
    expect(parseChatCapabilities({ attachments: payload }).attachments?.[0].dataUrl).toBe(dataUrl);
    expect(payload[0]).not.toHaveProperty("media");
    expect(payload[0]).not.toHaveProperty("id");
  });
  it("expands a video into ordered, timestamped visual frames with honest scope", () => {
    const video: AiWorkspaceDocument = { ...document(), name: "测试.mp4", mimeType: "video/mp4", media: { kind: "video", durationSeconds: 8, frames: videoSampleTimes(8).map(timeSeconds => ({ dataUrl, timeSeconds })) } };
    const result = documentAttachments([video]);
    expect(result).toHaveLength(4);
    expect(result.map(item => item.dataUrl)).toEqual([dataUrl, dataUrl, dataUrl, dataUrl]);
    expect(result[0].text).toContain("0.00 秒");
    expect(result[3].text).toContain("7.95 秒");
    for (const item of result) { expect(item.text).toContain("不包含音频"); expect(item.text).toContain("未采样部分未知"); }
    expect(parseChatCapabilities({ attachments: result }).attachments).toHaveLength(4);
  });
  it("samples short clips sparingly and refuses invalid/long duration", () => {
    expect(videoSampleTimes(1)).toHaveLength(1); expect(videoSampleTimes(3)).toHaveLength(2);
    expect(videoSampleTimes(120)).toHaveLength(4);
    for (const duration of [0, -1, Infinity, NaN, 120.001]) expect(() => videoSampleTimes(duration)).toThrow();
  });
  it("bounds both logical files and flattened frames, instead of silently dropping history", () => {
    expect(() => documentAttachments(Array.from({ length: 6 }, document))).toThrow("5 个附件");
    const video: AiWorkspaceDocument = { ...document(), media: { kind: "video", durationSeconds: 8, frames: videoSampleTimes(8).map(timeSeconds => ({ dataUrl, timeSeconds })) } };
    expect(() => documentAttachments([video, document(), { id: "text", name: "说明.txt", mimeType: "text/plain", content: "说明" }])).toThrow("合计最多 5");
    expect(() => documentAttachments([video, video])).toThrow("5 张图片");
    expect(documentAttachments([video, document()])).toHaveLength(5);
  });
  it("rejects invalid URLs, excessive frame size or timestamps", () => {
    expect(mediaFrameByteLength("https://example.com/a.jpg")).toBe(Infinity);
    expect(mediaFrameByteLength("data:image/svg+xml;base64,AAAA")).toBe(Infinity);
    expect(mediaFrameByteLength(dataUrl)).toBe(Buffer.from(png, "base64").length);
    const attachment = workspaceAttachment(document());
    for (const url of ["file:///secret", "https://example.com/a.jpg", `data:image/jpeg;base64,${"A".repeat(Math.ceil(AI_MEDIA_LIMITS.frameBytes / 3) * 4 + 4)}`]) {
      expect(() => validateAttachments([{ ...attachment, media: { kind: "image", frames: [{ dataUrl: url }] } }])).toThrow();
    }
    expect(() => validateAttachments([{ ...attachment, media: { kind: "video", durationSeconds: 1, frames: [{ dataUrl, timeSeconds: 2 }] } }])).toThrow("采样时间");
  });
  it("checks image dimensions before browser decoding, including decompression-size bounds", () => {
    expect(imageDimensions(new Uint8Array(Buffer.from(png, "base64")))).toEqual({ width: 1, height: 1 });
    const oversized = new Uint8Array(Buffer.from(png, "base64")); new DataView(oversized.buffer).setUint32(16, 8193);
    expect(() => imageDimensions(oversized)).toThrow("分辨率过大");
    expect(() => imageDimensions(new Uint8Array([1, 2, 3]))).toThrow("图片格式");
  });
  it("rejects unsupported project media, oversized input and cancellation without decoder use", async () => {
    await expect(extractAttachment(new File([Buffer.from(png, "base64")], "x.png"), { allowMedia: false })).rejects.toThrow("项目资料");
    await expect(extractAttachment(new File([new Uint8Array(AI_MEDIA_LIMITS.imageFileBytes + 1)], "big.jpg"))).rejects.toThrow("12 MB");
    await expect(extractAttachment(new File([new Uint8Array(AI_MEDIA_LIMITS.videoFileBytes + 1)], "big.mp4"))).rejects.toThrow("50 MB");
    const controller = new AbortController(); controller.abort();
    await expect(extractAttachment(new File(["test"], "x.mp4"), { signal: controller.signal })).rejects.toHaveProperty("name", "AbortError");
  });
  it("refuses new attachments before exhausting snapshot space and never edits the old state", () => {
    const state = { notes: "x".repeat(AI_WORKSPACE_LIMITS.stateBytes) };
    const before = state.notes;
    expect(() => ensureAttachmentWorkspaceCapacity(state)).toThrow("本次附件未添加");
    expect(() => ensureAttachmentWorkspaceCapacity(state)).toThrow(WorkspaceCapacityError);
    expect(state.notes).toBe(before);
    expect(() => ensureAttachmentWorkspaceCapacity({ attachments: [document()] })).not.toThrow();
    expect(() => ensureAttachmentWorkspaceCapacity({ oldHistory: "x".repeat(AI_WORKSPACE_LIMITS.stateBytes - 400000) }, "reply")).toThrow("草稿已保留，本次未发送、未扣费");
    expect(() => ensureAttachmentWorkspaceCapacity({ oldHistory: "x".repeat(AI_WORKSPACE_LIMITS.stateBytes - 100000) }, "video")).not.toThrow();
    try { ensureAttachmentWorkspaceCapacity(state, "reply"); }
    catch (error) { expect(error).toBeInstanceOf(WorkspaceCapacityError); expect((error as WorkspaceCapacityError).phase).toBe("reply"); }
    // A 96 KiB reply must fit after an accepted near-boundary media state.
    const nearBoundary = { oldHistory: "x".repeat(1000000), attachments: [document()] };
    expect(() => ensureAttachmentWorkspaceCapacity(nearBoundary)).not.toThrow();
    expect(new TextEncoder().encode(JSON.stringify({ ...nearBoundary, reply: "x".repeat(96000) })).length).toBeLessThan(AI_WORKSPACE_LIMITS.stateBytes);
  });
});
