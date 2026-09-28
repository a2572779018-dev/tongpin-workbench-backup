import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { shouldApplyVideoDefault } from "./videoModelSettings";

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

  it("saves only the switch and price, and checks the models of the connections the tiers use", () => {
    const source = readFileSync(new URL("./AdminAiVideoSettings.tsx", import.meta.url), "utf8");
    // No legacy key, address or default-model field is sent any more: four-tier routing picks the model.
    expect(source).toContain('body: JSON.stringify({ enabled, quotaPoints: price.value })');
    expect(source).not.toMatch(/apiKey|defaultModel|75api/);
    expect(source).toContain('"/api/admin/ai/video/test"');
    expect(source).toContain("这些档位会自动换用可用的视频模型并告诉成员");
  });
});
