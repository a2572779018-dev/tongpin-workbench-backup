import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { checkedVideoModelNotice, shouldApplyVideoDefault } from "./videoModelSettings";

const result = {
  ok: true as const,
  message: "已读取密钥的模型列表；不代表生成请求一定成功。",
  models: [
    { id: "minimax_h3" as const, label: "MiniMax H3", listed: true },
    { id: "sd-2.5-c1" as const, label: "SD 2.5", listed: false },
  ],
  availableModels: ["minimax_h3" as const],
};

describe("video model settings feedback", () => {
  it("applies a valid server default only before the member touches video settings", () => {
    expect(shouldApplyVideoDefault(false, "sd-2-c6")).toBe(true);
    expect(shouldApplyVideoDefault(true, "sd-2-c6")).toBe(false);
    expect(shouldApplyVideoDefault(false, "sd-2.5-c1")).toBe(true);
    expect(shouldApplyVideoDefault(false, "unknown-model")).toBe(false);
    expect(shouldApplyVideoDefault(false, "sd-2-c6", ["minimax_h3"])).toBe(false);
    expect(shouldApplyVideoDefault(false, "sd-2-c6", ["sd-2-c6"])).toBe(true);
    const composer = readFileSync(new URL("./AiVideoComposer.tsx", import.meta.url), "utf8");
    // The tier default wins until the member explicitly picks a model (#31);
    // options and constraints come from server profiles, not the bundled list.
    expect(composer).toContain("(modelTouched.current ? pickable.find(item => item.id === model) : undefined)");
    expect(composer).toContain("pickable.find(item => item.id === result.settings.defaultModel)");
    expect(composer).toContain("profile?.seconds[resolution]");
    expect(composer).toContain("<label>模型<select");
    expect(composer).toContain("selectableVideoProfiles(data.settings)");
    expect(composer).not.toContain("VIDEO_MODELS");
    expect(composer).toContain("model: profile.id, resolution, aspectRatio");
  });

  it("keeps the non-generating probe disclaimer and confirms a listed default", () => {
    const notice = checkedVideoModelNotice(result, "minimax_h3");
    expect(notice).toContain("不代表生成请求一定成功");
    expect(notice).toContain("已开放给成员");
  });

  it("warns clearly when the saved default is absent from the key model list", () => {
    expect(checkedVideoModelNotice(result, "sd-2.5-c1")).toContain("未被开放给成员");
  });

  it("checks the newly saved key and model list without asking the administrator for a second action", () => {
    const source = readFileSync(new URL("./AdminAiVideoSettings.tsx", import.meta.url), "utf8");
    const save = source.slice(source.indexOf('const selected ='), source.indexOf('</form>'));
    expect(save.indexOf('method: "PUT"')).toBeLessThan(save.indexOf('"/api/admin/ai/video/test"'));
    expect(save).toContain('setSettings(r.settings)');
    expect(save).toContain('视频配置已保存，但模型权限检查失败');
    expect(save).toContain('checkedVideoModelNotice(checked, selected)');
  });
});
