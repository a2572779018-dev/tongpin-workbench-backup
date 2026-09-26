import { describe, expect, it } from "vitest";
import type { AiVideoSettings } from "../../../shared/aiVideo";
import type { VideoModelId } from "../../../shared/aiVideoModels";
import { explicitVideoChoice, naturalVideoRequest, savedVideoChoice } from "./naturalVideoRequest";
import { selectableVideoProfiles, videoProfileFor } from "./videoProfiles";

const settings: AiVideoSettings = { enabled: true, apiKeyConfigured: true, quotaPoints: 300, availableModels: ["minimax_h3"], defaultModel: "minimax_h3", modelsVerified: true };
const image = [{ name: "a.jpg", dataUrl: "data:image/jpeg;base64,/9j/AAAA" }];
// A gateway rename this client's bundled catalogue has never heard of.
const RENAMED = "minimax_h4_新模板" as VideoModelId;
const renamedProfile = { label: "MiniMax H4 · 新模板", resolutions: ["1080p" as const], seconds: { "1080p": [6, 10] }, maxImages: 4, requiresImage: false };
const fastProfile = { label: "SD 2.0 Fast", resolutions: ["480p" as const, "720p" as const], seconds: { "480p": [5, 6], "720p": [5] }, maxImages: 9, requiresImage: false };

describe("direct video creation defaults", () => {
  it("uses an authorized model and the smallest supported duration and resolution", () => {
    const { request, choice } = naturalVideoRequest("request-a", "生成视频", settings, undefined);
    expect(request).toMatchObject({ requestId: "request-a", model: "minimax_h3", resolution: "480p", seconds: 5, aspectRatio: "16:9" });
    expect(choice).toEqual({ model: "minimax_h3", label: "MiniMax H3", seconds: 5, resolution: "480p", aspectRatio: "16:9" });
  });
  it("retains only valid previous settings and never guesses an unavailable model", () => {
    const { request } = naturalVideoRequest("request-b", "生成视频", settings,
      { model: "sd-2-c6", resolution: "1080p", seconds: 60, aspectRatio: "9:16" });
    expect(request).toMatchObject({ model: "minimax_h3", resolution: "480p", seconds: 5, aspectRatio: "9:16" });
  });
  it("rejects a missing verified route", () => {
    expect(() => naturalVideoRequest("request-c", "生成视频", { ...settings, availableModels: [] }, undefined)).toThrow("没有与参考图匹配的视频模型");
  });

  it("chooses a tier default unknown to this client through the server profile, never another model", () => {
    const server: AiVideoSettings = { ...settings, availableModels: [RENAMED, "sd-2.0-fast"], defaultModel: RENAMED,
      profiles: { [RENAMED]: renamedProfile, "sd-2.0-fast": fastProfile } };
    const { request, choice } = naturalVideoRequest("request-e", "生成视频", server, undefined);
    expect(request).toMatchObject({ model: RENAMED, resolution: "1080p", seconds: 6 });
    expect(choice).toEqual({ model: RENAMED, label: "MiniMax H4 · 新模板", seconds: 6, resolution: "1080p", aspectRatio: "16:9" });
  });
  it("uses an older server's default profile for a default this client does not know", () => {
    const older: AiVideoSettings = { ...settings, availableModels: [RENAMED, "sd-2.0-fast"], defaultModel: RENAMED,
      profile: { resolutions: ["1080p"], seconds: { "1080p": [6, 10] }, maxImages: 4, requiresImage: false } };
    const { request, choice } = naturalVideoRequest("request-f", "生成视频", older, undefined);
    expect(request.model).toBe(RENAMED);
    expect(choice.notice).toBeUndefined();
    // Without any profile the default is still not skipped silently.
    const bare: AiVideoSettings = { ...older, profile: undefined };
    const fallback = naturalVideoRequest("request-g", "生成视频", bare, undefined);
    expect(fallback.request.model).toBe("sd-2.0-fast");
    expect(fallback.choice.notice).toContain("档位默认模型");
    expect(fallback.choice.notice).toContain("本次改用「SD 2.0 Fast」");
  });
  it("falls back from a default that requires a reference image and tells the member why", () => {
    const server: AiVideoSettings = { ...settings, availableModels: ["minimax_h3_内置提示词优化", "sd-2.0-fast"], defaultModel: "minimax_h3_内置提示词优化",
      profiles: { "minimax_h3_内置提示词优化": { label: "MiniMax H3 · 提示词优化（需参考图）", resolutions: ["480p", "768p"], seconds: { "480p": [5], "768p": [5] }, maxImages: 8, requiresImage: true }, "sd-2.0-fast": fastProfile } };
    const { request, choice } = naturalVideoRequest("request-d", "生成视频", server, undefined);
    expect(request.model).toBe("sd-2.0-fast");
    expect(choice).toMatchObject({ model: "sd-2.0-fast", label: "SD 2.0 Fast", seconds: 5, resolution: "480p" });
    expect(choice.notice).toBe("档位默认模型「MiniMax H3 · 提示词优化（需参考图）」需要至少一张参考图片，本次改用「SD 2.0 Fast」");
    // With a reference the tier default is used as configured.
    expect(naturalVideoRequest("request-h", "生成视频", server, undefined, image).request.model).toBe("minimax_h3_内置提示词优化");
    // With no valid alternative the member is told instead of switching.
    expect(() => naturalVideoRequest("request-i", "生成视频", { ...server, availableModels: ["minimax_h3_内置提示词优化"] }, undefined))
      .toThrow("需要至少一张参考图片，当前档位没有其他可用模型");
  });
  it("surfaces the server's reason when it replaced the tier default", () => {
    const { choice } = naturalVideoRequest("request-j", "生成视频", { ...settings, defaultNotice: "档位默认模型「X」当前不可用，本次将使用「MiniMax H3」" }, undefined);
    expect(choice.notice).toContain("当前不可用");
  });
  it("honors the member's explicit model selection exactly", () => {
    const server: AiVideoSettings = { ...settings, availableModels: [RENAMED, "sd-2.0-fast"], defaultModel: RENAMED,
      profiles: { [RENAMED]: renamedProfile, "sd-2.0-fast": fastProfile } };
    expect(selectableVideoProfiles(server).map(item => [item.id, item.label])).toEqual([[RENAMED, "MiniMax H4 · 新模板"], ["sd-2.0-fast", "SD 2.0 Fast"]]);
    const explicit = { requestId: "request-k", prompt: "生成视频", model: "sd-2.0-fast" as const, seconds: 6, resolution: "480p" as const, aspectRatio: "9:16" as const };
    expect(explicitVideoChoice(server, explicit)).toEqual({ model: "sd-2.0-fast", label: "SD 2.0 Fast", seconds: 6, resolution: "480p", aspectRatio: "9:16" });
    // A natural follow-up keeps the member's previous explicit choice over the default.
    expect(naturalVideoRequest("request-l", "再来一段", server, { model: "sd-2.0-fast", seconds: 6, resolution: "480p", aspectRatio: "9:16" }).request)
      .toMatchObject({ model: "sd-2.0-fast", seconds: 6, resolution: "480p", aspectRatio: "9:16" });
    expect(() => explicitVideoChoice(server, { ...explicit, resolution: "720p", seconds: 12 })).toThrow("不适用于「SD 2.0 Fast」");
    expect(() => explicitVideoChoice({ ...server, availableModels: [RENAMED] }, explicit)).toThrow("当前不可用");
  });
  it("prefers server profiles over the bundled catalogue and validates them", () => {
    const server: AiVideoSettings = { ...settings, profiles: { minimax_h3: { ...renamedProfile, label: "服务端标签" } } };
    expect(videoProfileFor(server, "minimax_h3")?.label).toBe("服务端标签");
    expect(videoProfileFor({ ...settings, profiles: { minimax_h3: { resolutions: [], seconds: {}, maxImages: 1, requiresImage: false } } }, "minimax_h3")).toBeUndefined();
    expect(savedVideoChoice({ model: "m", label: "L", seconds: 5, resolution: "480p", aspectRatio: "16:9", notice: "原因" })).toMatchObject({ notice: "原因" });
    expect(savedVideoChoice({ model: "m", label: "L", seconds: 0, resolution: "480p", aspectRatio: "16:9" })).toBeUndefined();
  });
});
