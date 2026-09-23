import { describe, expect, it } from "vitest";
import type { AiVideoSettings } from "../../../shared/aiVideo";
import { naturalVideoRequest } from "./naturalVideoRequest";

const settings: AiVideoSettings = { enabled: true, apiKeyConfigured: true, quotaPoints: 300, availableModels: ["minimax_h3"], defaultModel: "minimax_h3", modelsVerified: true };

describe("direct video creation defaults", () => {
  it("uses an authorized model and the smallest supported duration and resolution", () => {
    const result = naturalVideoRequest("request-a", "生成视频", settings, undefined);
    expect(result).toMatchObject({ requestId: "request-a", model: "minimax_h3", resolution: "480p", seconds: 5, aspectRatio: "16:9" });
  });
  it("retains only valid previous settings and never guesses an unavailable model", () => {
    const result = naturalVideoRequest("request-b", "生成视频", settings,
      { model: "sd-2-c6", resolution: "1080p", seconds: 60, aspectRatio: "9:16" });
    expect(result).toMatchObject({ model: "minimax_h3", resolution: "480p", seconds: 5, aspectRatio: "9:16" });
  });
  it("rejects a missing verified route", () => {
    expect(() => naturalVideoRequest("request-c", "生成视频", { ...settings, availableModels: [] }, undefined)).toThrow("没有与参考图匹配的视频模型");
  });
  it("uses a compatible configured model when the default requires a missing reference", () => {
    const availableModels: AiVideoSettings["availableModels"] = ["minimax_h3_no_audios_1080", "minimax_h3"];
    const result = naturalVideoRequest("request-d", "生成视频", { ...settings, defaultModel: "minimax_h3_no_audios_1080", availableModels }, undefined);
    expect(result.model).toBe("minimax_h3");
  });
});
