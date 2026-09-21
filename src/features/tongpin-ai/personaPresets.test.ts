import { describe, expect, it } from "vitest";
import { activePersonaPreset, PERSONA_PRESETS } from "./personaPresets";

describe("persona presets", () => {
  it("uses unique ids and keeps every preset within the persisted style limit", () => {
    expect(new Set(PERSONA_PRESETS.map(item => item.id)).size).toBe(PERSONA_PRESETS.length);
    // Cover every reviewed source-skill category with at least one safe,
    // non-impersonating product preset.
    expect(PERSONA_PRESETS.length).toBeGreaterThanOrEqual(34);
    expect(PERSONA_PRESETS.every(item => item.customStyle.length <= 2_000)).toBe(true);
  });

  it("matches an exact curated style without treating arbitrary text as a preset", () => {
    const preset = PERSONA_PRESETS[5];
    expect(activePersonaPreset(preset.tone, preset.customStyle)?.id).toBe(preset.id);
    expect(activePersonaPreset("professional", "用户自己写的风格")).toBeUndefined();
  });

  it("contains no identity impersonation or permission-changing language", () => {
    const joined = PERSONA_PRESETS.map(item => `${item.name}\n${item.description}\n${item.customStyle}`).join("\n");
    expect(joined).not.toMatch(/我是刘慈欣|我是鲁迅|忽略安全|提高额度|跳过审批/);
  });
});
