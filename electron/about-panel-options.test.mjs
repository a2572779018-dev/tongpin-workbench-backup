import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { LIMEZU_CREDIT, buildAboutPanelOptions } = require("./about-panel-options.cjs");

describe("buildAboutPanelOptions", () => {
  it("defaults to 同频 with the LimeZu credit line", () => {
    expect(buildAboutPanelOptions()).toEqual({
      applicationName: "同频",
      applicationVersion: "",
      credits: LIMEZU_CREDIT,
    });
  });

  it("carries through an explicit application name and version", () => {
    expect(buildAboutPanelOptions({ applicationName: "同频快捷待办预览", applicationVersion: "1.2.3" })).toEqual({
      applicationName: "同频快捷待办预览",
      applicationVersion: "1.2.3",
      credits: LIMEZU_CREDIT,
    });
  });

  it("keeps the LimeZu itch.io URL in the credit text", () => {
    expect(LIMEZU_CREDIT).toContain("limezu.itch.io");
  });
});

describe("desktop wiring", () => {
  it("sets the About panel from main.cjs using app.getVersion()", () => {
    const main = readFileSync(new URL("./main.cjs", import.meta.url), "utf8");
    expect(main).toContain("require(\"./about-panel-options.cjs\")");
    expect(main).toContain("app.setAboutPanelOptions(buildAboutPanelOptions(");
    expect(main).toContain("app.getVersion()");
  });
});
