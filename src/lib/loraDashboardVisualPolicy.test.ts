import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function dashboardCss(): string {
  const css = readFileSync(
    fileURLToPath(new URL("../styles.css", import.meta.url)),
    "utf8",
  );
  const start = css.indexOf("/* LORA_DASHBOARD_VISUAL_START */");
  const end = css.indexOf("/* LORA_DASHBOARD_VISUAL_END */");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return css.slice(start, end);
}

describe("LORA dashboard visual policy", () => {
  it("uses no gradients or page-level horizontal overflow", () => {
    const css = dashboardCss();
    expect(css).not.toMatch(/gradient\s*\(/i);
    expect(css).not.toMatch(/overflow-x\s*:\s*(?:visible|auto|scroll)/i);
  });

  it("uses only yellow, white and the existing dark ink", () => {
    const css = dashboardCss();
    const hexColors = css.match(/#[0-9a-f]{3,8}\b/gi) ?? [];
    expect(new Set(hexColors.map((color) => color.toLowerCase()))).toEqual(
      new Set(["#ffd84d", "#fffdf7", "#17233c"]),
    );
    const rgbColors = css.match(/rgba?\([^)]*\)/gi) ?? [];
    expect(rgbColors).toEqual([]);
  });
});
