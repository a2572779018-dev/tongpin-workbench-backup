import { describe, expect, it } from "vitest";
import { mediaTaskFailureText } from "./mediaTaskFailure";

describe("media task failure text", () => {
  it("explains known codes and keeps the code for admins", () => {
    expect(mediaTaskFailureText("AI_VIDEO_SETTINGS_INVALID")).toBe("视频时长、清晰度或画幅不被当前模型支持（AI_VIDEO_SETTINGS_INVALID）");
  });
  it("shows unknown codes verbatim and handles a missing code", () => {
    expect(mediaTaskFailureText("AI_SOMETHING_NEW")).toBe("错误代码 AI_SOMETHING_NEW");
    expect(mediaTaskFailureText(undefined)).toBe("未返回具体原因");
  });
});
