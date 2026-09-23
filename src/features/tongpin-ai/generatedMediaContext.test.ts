import { beforeEach, describe, expect, it, vi } from "vitest";
import { videoBlobCache } from "./mediaCache";
import { generatedMediaForFollowup, readGeneratedMedia } from "./generatedMediaContext";
import type { TongpinAIArtifact, TongpinAIConversation } from "./types";
const video: TongpinAIArtifact = { id: "v", conversationId: "c", title: "视频", kind: "视频", summary: "", updatedLabel: "", sections: [], data: { videoJobId: "job" } };
const picture: TongpinAIArtifact = { ...video, id: "p", kind: "图片", data: { images: [{ assetId: "image" }] } };
const conversation: TongpinAIConversation = { id: "c", title: "", timeLabel: "", messages: [{ id: "m", role: "assistant", content: "视频生成任务", artifactId: "v", time: "" }] };
const sample = vi.fn(async () => ({ name: "video", mediaType: "video/mp4", text: "", warnings: [], media: { kind: "video" as const, durationSeconds: 15, frames: [{ dataUrl: "data:image/jpeg;base64,YQ==", timeSeconds: 0 }, { dataUrl: "data:image/jpeg;base64,Yg==", timeSeconds: 14.95 }] } }));
describe("generated media continuity", () => {
  beforeEach(() => videoBlobCache.clear());
  it("binds the source picture when the requested output is a video", () => {
    const c = { ...conversation, messages: [{ ...conversation.messages[0], artifactId: "p" }] };
    expect(generatedMediaForFollowup(c, [video, picture], "用刚才同一个人物做视频")).toBe(picture);
    expect(generatedMediaForFollowup(c, [picture], "把她动起来")).toBe(picture);
  });
  it("inherits a concrete pending image reference on yes, but not unrelated confirmations", () => {
    const c = { ...conversation, messages: [{ ...conversation.messages[0], artifactId: "p" }, { id: "question", role: "assistant" as const, content: "沿用刚才这张人物图，生成竖屏视频？", time: "" }] };
    expect(generatedMediaForFollowup(c, [picture], "是的")).toBe(picture);
    expect(generatedMediaForFollowup({ ...c, messages: [{ ...c.messages[1], content: "要写一封邮件吗？" }] }, [picture], "是的")).toBeUndefined();
    expect(generatedMediaForFollowup(c, [{ ...picture, data: { images: [{ assetId: "first" }, { assetId: "second" }] } }], "是的")?.id).toBe("p");
  });
  it("does not try to watch an unfinished video when discussing its prompt", () => {
    expect(generatedMediaForFollowup(conversation, [video], "你能把上面的视频生成提示词优化一下吗？")).toBeUndefined();
    expect(generatedMediaForFollowup(conversation, [video], "看看实际画面，提示词该怎么改？")).toBe(video);
  });
  it("resolves the actual result in the current conversation, not another account/project's latest artifact", () => {
    expect(generatedMediaForFollowup(conversation, [{ ...video, conversationId: "other" }], "好看吗")).toBeUndefined();
    expect(generatedMediaForFollowup(conversation, [video], "好看吗")).toBe(video);
    expect(generatedMediaForFollowup(conversation, [video], "修改一下")).toBeUndefined();
    expect(generatedMediaForFollowup(conversation, [video], "修改一下刚才生成的视频")).toBe(video);
    expect(generatedMediaForFollowup(conversation, [video], "你好")).toBeUndefined();
    expect(generatedMediaForFollowup(conversation, [video], "帮我写一封邮件")).toBeUndefined();
    expect(generatedMediaForFollowup(null, [video], "评价视频")).toBeUndefined();
  });
  it("uses the requested media kind and survives history restore", () => {
    const c = { ...conversation, messages: [...conversation.messages, { ...conversation.messages[0], id: "m2", artifactId: "p" }] };
    expect(generatedMediaForFollowup(JSON.parse(JSON.stringify(c)), [video, picture], "评价视频")).toBe(video);
    expect(generatedMediaForFollowup(c, [video, picture], "这张好看吗")).toBe(picture);
  });
  it("does not duplicate frames after the same generated video was manually uploaded", () => {
    const c = { ...conversation, messages: [...conversation.messages, { id: "upload", role: "user" as const, content: "评价", time: "", attachments: [{ id: "upload", name: "同频视频-job.mp4", content: "", mimeType: "video/mp4", media: { kind: "video" as const, durationSeconds: 15, frames: [{ dataUrl: "data:image/jpeg;base64,YQ==", timeSeconds: 0 }] } }] }] };
    expect(generatedMediaForFollowup(c, [video], "视频好看吗")).toBeUndefined();
  });
  it("only GETs original video and supplies timestamped visual evidence, never audio claims", async () => {
    const calls: string[] = [];
    const api = vi.fn(async (route, init) => {
      calls.push(route); expect(init.headers["X-Tongpin-Account"]).toBe("member"); expect(init.method).toBeUndefined();
      return route.endsWith("/content") ? new Blob(["fixture"]) : { job: { status: "completed" } };
    });
    const result = await readGeneratedMedia(video, api as never, "member", "tenant-a-session", new AbortController().signal, sample);
    expect(calls).toEqual(["/api/ai/videos/job", "/api/ai/videos/job/content"]);
    expect(result).toHaveLength(2); expect(result[1].text).toContain("14.95");
    expect(result[0].text).toContain("不含音频"); expect(result[0].dataUrl).toContain("base64");
  });
  it("does not reuse a same-ID video from another authenticated session", async () => {
    const first = vi.fn(async (route: string) => route.endsWith("/content") ? new Blob(["tenant-a"]) : { job: { status: "completed" } });
    const second = vi.fn(async (route: string) => route.endsWith("/content") ? new Blob(["tenant-b"]) : { job: { status: "completed" } });
    await readGeneratedMedia(video, first as never, "member", "tenant-a-session", new AbortController().signal, sample);
    await readGeneratedMedia(video, second as never, "member", "tenant-b-session", new AbortController().signal, sample);
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);
    expect(videoBlobCache.get("tenant-a-session", "job")?.size).toBe(8);
    expect(videoBlobCache.get("tenant-b-session", "job")?.size).toBe(8);
  });
  it.each(["queued", "processing", "failed", "uncertain"])("does not read or recreate a %s video", async status => {
    const api = vi.fn(async () => ({ job: { status } }));
    await expect(readGeneratedMedia(video, api as never, "member", "tenant-a-session", new AbortController().signal, sample)).rejects.toThrow("视频任务尚未完成，暂不能继续对话");
    expect(api).toHaveBeenCalledTimes(1);
  });
  it("propagates denied/deleted media and cancellation without a provider POST", async () => {
    const api = vi.fn(async () => { throw Error("404"); });
    await expect(readGeneratedMedia(video, api as never, "member", "tenant-a-session", new AbortController().signal, sample)).rejects.toThrow("404");
    const controller = new AbortController(); controller.abort();
    const success = vi.fn(async (route: string) => route.endsWith("content") ? new Blob(["x"]) : { job: { status: "completed" } });
    await expect(readGeneratedMedia(video, success as never, "member", "tenant-a-session", controller.signal, sample)).rejects.toThrow();
  });
  it("reads generated images by owned asset ID, ignoring arbitrary artifact URLs", async () => {
    const api = vi.fn(async () => ({ assetId: "image", mimeType: "image/png", base64: "YQ==" }));
    const extract = vi.fn(async () => ({ name: "image", text: "", mediaType: "image/jpeg", warnings: [], media: { kind: "image" as const, frames: [{ dataUrl: "data:image/jpeg;base64,YQ==" }] } }));
    const result = await readGeneratedMedia(picture, api as never, "member", "tenant-a-session", new AbortController().signal, extract);
    expect(api.mock.calls).toHaveLength(1); expect(result[0].text).toContain("生成的图片");
    await expect(readGeneratedMedia({ ...picture, data: { images: [{ assetId: "image", deleted: true }] } }, api as never, "member", "tenant-a-session", new AbortController().signal, extract)).rejects.toThrow("已删除");
  });
});
