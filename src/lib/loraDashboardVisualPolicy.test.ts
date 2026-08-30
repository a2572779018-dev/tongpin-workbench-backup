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
  it("keeps the page vertically scrollable and horizontal overflow contained", () => {
    const css = dashboardCss();
    expect(css).toMatch(/\.lora-dashboard-page\s*\{[\s\S]*overflow-x:\s*hidden;[\s\S]*overflow-y:\s*auto;/);
    expect(css).toMatch(/\.lora-table-scroll\s*\{[\s\S]*overflow-x:\s*auto;/);
    expect(css).not.toMatch(/gradient\s*\(/i);
  });

  it("uses the selected neo-brutalist palette and hard-shadow tokens", () => {
    const css = dashboardCss();
    const hexColors = css.match(/#[0-9a-f]{3,8}\b/gi) ?? [];
    expect(new Set(hexColors.map((color) => color.toLowerCase()))).toEqual(
      new Set([
        "#141414",
        "#fffdf4",
        "#ffd02f",
        "#ff9ecd",
        "#7de2d1",
        "#b1a2ff",
        "#9ee37d",
        "#ff5c5c",
      ]),
    );
    expect(css).toContain("--lora-border: 2.5px solid #141414");
    expect(css).toContain("--lora-shadow: 5px 5px 0 #141414");
    expect(css).toContain("box-shadow: 7px 7px 0 #141414");
  });

  it("keeps the target typography, five-card desktop grid and responsive steps", () => {
    const css = dashboardCss();
    expect(css).toContain('--lora-font-ui: "Archivo"');
    expect(css).toContain('--lora-font-mono: "Space Mono"');
    expect(css).toContain("grid-template-columns: repeat(5, minmax(0, 1fr))");
    expect(css).toContain("@media (max-width: 1080px)");
    expect(css).toContain("grid-template-columns: repeat(3, minmax(0, 1fr))");
    expect(css).toContain("@media (max-width: 700px)");
    expect(css).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
