import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { permissionLabel } from "./ComputerUsePanel";

describe("@computer permission guidance (#9)", () => {
  it("shows plain-language permission states", () => {
    expect(permissionLabel("granted")).toBe("已开启");
    expect(permissionLabel("denied")).toBe("未开启");
    expect(permissionLabel("not-required")).toBe("无需开启");
    expect(permissionLabel("unknown")).toBe("未知");
  });
  it("offers one button per missing macOS permission and explains reinstall re-grants", () => {
    const source = readFileSync(new URL("./ComputerUsePanel.tsx", import.meta.url), "utf8");
    expect(source).toContain('openPrivacySettings?.("accessibility")');
    expect(source).toContain('openPrivacySettings?.("screenRecording")');
    expect(source).toContain("安装新版同频后");
  });
});
