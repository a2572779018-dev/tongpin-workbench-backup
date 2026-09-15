import { describe, expect, it, vi } from "vitest";
import { generatedMediaForFollowup, readGeneratedMedia } from "./generatedMediaContext";
import type { TongpinAIArtifact, TongpinAIConversation } from "./types";
const video: TongpinAIArtifact = { id: "v", conversationId: "c", title: "视频", kind: "视频", summary: "", updatedLabel: "", sections: [], data: { videoJobId: "job" } };
const picture: TongpinAIArtifact = { ...video, id: "p", kind: "图片", data: { images: [{ assetId: "image" }] } };
const conversation: TongpinAIConversation = { id: "c", title: "", timeLabel: "", messages: [{ id: "m", role: "assistant", content: "视频生成任务", artifactId: "v", time: "" }] };
const sample = vi.fn(async () => ({ name: "video", mediaType: "video/mp4", text: "", warnings: [], media: { kind: "video" as const, durationSeconds: 15, frames: [{ dataUrl: "data:image/jpeg;base64,YQ==", timeSeconds: 0 }, { dataUrl: "data:image/jpeg;base64,Yg==", timeSeconds: 14.95 }] } }));
describe("generated media continuity", () => {
  it("resolves the actual result in the current conversation, not another account/project's latest artifact", () => {
    expect(generatedMediaForFollowup(conversation, [{ ...video, conversationId: "other" }], "好看吗")).toBeUndefined();
    expect(generatedMediaForFollowup(conversation, [video], "好看吗")).toBe(video);
    expect(generatedMediaForFollowup(conversation, [video], "修改一下")).toBe(video);
    expect(generatedMediaForFollowup(null, [video], "评价视频")).toBeUndefined();
  });
  it("uses the requested media kind and survives history restore", () => {
    const c = { ...conversation, messages: [...conversation.messages, { ...conversation.messages[0], id: "m2", artifactId: "p" }] };
    expect(generatedMediaForFollowup(JSON.parse(JSON.stringify(c)), [video, picture], "评价视频")).toBe(video);
    expect(generatedMediaForFollowup(c, [video, picture], "这张好看吗")).toBe(picture);
  });
  it("only GETs original video and supplies timestamped visual evidence, never audio claims", async () => {
    const calls: string[] = [];
    const api = vi.fn(async (route, init) => {
      calls.push(route); expect(init.headers["X-Tongpin-Account"]).toBe("member"); expect(init.method).toBeUndefined();
      return route.endsWith("/content") ? new Blob(["fixture"]) : { job: { status: "completed" } };
    });
    const result = await readGeneratedMedia(video, api as never, "member", new AbortController().signal, sample);
    expect(calls).toEqual(["/api/ai/videos/job", "/api/ai/videos/job/content"]);
    expect(result).toHaveLength(2); expect(result[1].text).toContain("14.95");
    expect(result[0].text).toContain("不含音频"); expect(result[0].dataUrl).toContain("base64");
  });
  it.each(["queued", "processing", "failed", "uncertain"])("does not read or recreate a %s video", async status => {
    const api = vi.fn(async () => ({ job: { status } }));
    await expect(readGeneratedMedia(video, api as never, "member", new AbortController().signal, sample)).rejects.toThrow("尚未生成成功");
    expect(api).toHaveBeenCalledTimes(1);
  });
  it("propagates denied/deleted media and cancellation without a provider POST", async () => {
    const api = vi.fn(async () => { throw Error("404"); });
    await expect(readGeneratedMedia(video, api as never, "member", new AbortController().signal, sample)).rejects.toThrow("404");
    const controller = new AbortController(); controller.abort();
    const success = vi.fn(async (route: string) => route.endsWith("content") ? new Blob(["x"]) : { job: { status: "completed" } });
    await expect(readGeneratedMedia(video, success as never, "member", controller.signal, sample)).rejects.toThrow();
  });
  it("reads generated images by owned asset ID, ignoring arbitrary artifact URLs", async () => {
    const api = vi.fn(async () => ({ assetId: "image", mimeType: "image/png", base64: "YQ==" }));
    const extract = vi.fn(async () => ({ name: "image", text: "", mediaType: "image/jpeg", warnings: [], media: { kind: "image" as const, frames: [{ dataUrl: "data:image/jpeg;base64,YQ==" }] } }));
    const result = await readGeneratedMedia(picture, api as never, "member", new AbortController().signal, extract);
    expect(api.mock.calls).toHaveLength(1); expect(result[0].text).toContain("生成的图片");
    await expect(readGeneratedMedia({ ...picture, data: { images: [{ assetId: "image", deleted: true }] } }, api as never, "member", new AbortController().signal, extract)).rejects.toThrow("已删除");
  });
});
