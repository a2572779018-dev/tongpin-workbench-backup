import { describe, expect, it } from "vitest";
import { BASE_CAPABILITIES, CAPABILITY_HUBS, hubIsActive, hubSkillNames } from "./capabilityCatalog";

describe("AI capability center catalogue", () => {
  it("separates base capabilities from composable workflow hubs", () => {
    expect(BASE_CAPABILITIES.map(item => item.id)).toEqual(["chat", "attachments", "image", "video", "presentation", "computer"]);
    expect(BASE_CAPABILITIES.find(item => item.id === "computer")?.availability).toBe("macOS 与 Windows 桌面端");
    expect(CAPABILITY_HUBS.length).toBeGreaterThanOrEqual(3);
  });

  it("only references reviewed skills and stays inside the three-skill limit", () => {
    for (const hub of CAPABILITY_HUBS) {
      expect(hub.skillIds.length).toBeGreaterThan(0);
      expect(hub.skillIds.length).toBeLessThanOrEqual(3);
      expect(hubSkillNames(hub)).toHaveLength(hub.skillIds.length);
      expect(hub.steps.map(step => step.id)).toHaveLength(3);
      expect(new Set(hub.steps.map(step => step.id)).size).toBe(hub.steps.length);
    }
  });

  it("recognizes an exact active hub", () => {
    const hub = CAPABILITY_HUBS[0];
    expect(hubIsActive(hub, new Set(hub.skillIds))).toBe(true);
    expect(hubIsActive(hub, new Set(hub.skillIds.slice(1)))).toBe(false);
  });
});
