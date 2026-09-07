import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const theme = read("../ai-metal-theme.css");

describe("AI material integration guardrails", () => {
  it("retains the existing light palette without overriding the document", () => {
    expect(theme).toMatch(/\.tp-ai-page\s*\{\s*color-scheme: light;/);
    expect(theme).not.toMatch(/(?:^|\n)body\s*\{/);
    expect(theme).not.toContain("color-scheme: dark");
    expect(theme).not.toContain('data-app-view="ai"');
    expect(theme).not.toContain("--tp-ai-white:");
    expect(theme).not.toContain('data-app-view="home"');
    expect(theme).not.toContain('data-app-view="relations"');
  });

  it("keeps the decorative beam from clipping composer menus", () => {
    expect(theme).toMatch(
      /\.tp-ai-page \.tp-ai-beam-wrap\s*\{[^}]*overflow: visible;/,
    );
    expect(read("../ChatWorkspace.tsx")).toContain(
      'className="tp-ai-beam-wrap"',
    );
  });

  it("does not activate thinking based on focus or selected mode", () => {
    expect(read("../ChatWorkspace.tsx")).toContain("active={responding}");
    expect(read("./TongpinOrb.tsx")).toContain("active = false");
  });

  it("does not render hidden zero-sized GPU targets", () => {
    const orb = read("./TongpinOrb.tsx");
    expect(orb).toContain("entry.boundingClientRect.width > 0");
    expect(orb).toContain("entry.boundingClientRect.height > 0");
    expect(orb).toContain("!document.hidden");
    expect(orb).toContain("!motionPreference.matches");
  });

  it("does not initialize expensive material renderers before explicit opt-in", () => {
    const orb = read("./TongpinOrb.tsx");
    const identity = read("./TongpinMetalIdentity.tsx");
    expect(orb).toContain("richMotion = false");
    expect(orb).toContain("if (!richMotion || !canvas || !host || !navigator.gpu) return;");
    expect(identity).not.toContain('import { MetalFx } from "metal-fx"');
    expect(identity).toContain('lazy(() => import("metal-fx")');
    expect(read("../ChatWorkspace.tsx")).toContain("active={visualEffects && ambientMotion");
    const renderer = read("./vendor/orb/src/orb-renderer.ts");
    expect(renderer).not.toContain("device.createRenderPipeline({");
    expect(renderer.match(/createRenderPipelineAsync\(/g)).toHaveLength(3);
  });
});
