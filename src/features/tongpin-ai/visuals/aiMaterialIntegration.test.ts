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
    const chat = read("../ChatWorkspace.tsx");
    expect(chat).toContain("const characterActivity: CharacterActivity = currentReplyPending");
    expect(chat).not.toContain("setVisualEffects");
  });

  it("contains every character SVG in its layout slot, including the header", () => {
    const refinements = read("../ai-refinements.css");
    expect(refinements).toMatch(/\.tp-ai-character\s*\{[^}]*grid-template: minmax\(0, 1fr\) \/ minmax\(0, 1fr\);/);
    expect(refinements).toMatch(/\.tp-ai-character__figure\s*\{[^}]*min-width: 0; min-height: 0;/);
    expect(refinements).toMatch(/\.tp-ai-character--header\s*\{[^}]*margin: 0;/);
  });

  it("starts empty conversations at the top instead of scrolling their welcome character away", () => {
    const chat = read("../ChatWorkspace.tsx");
    expect(chat.match(/list\.scrollTop = isEmpty \? 0 : list\.scrollHeight;/g)).toHaveLength(2);
    expect(read("../ai-refinements.css")).toMatch(/@media \(max-height: 850px\)[\s\S]*\.tp-ai-page \.tp-ai-chat\.is-empty \.tp-ai-composer-wrap\s*\{ flex: 0 0 auto;/);
  });

  it("does not render hidden zero-sized GPU targets", () => {
    const orb = read("./TongpinOrb.tsx");
    expect(orb).toContain("entry.boundingClientRect.width > 0");
    expect(orb).toContain("entry.boundingClientRect.height > 0");
    expect(orb).toContain("!document.hidden");
    expect(orb).toContain("!motionPreference.matches");
  });

  it("isolates decorative character failures from chat and persona forms", () => {
    const character = read("./TongpinAICharacter.tsx");
    expect(character).toContain("class CharacterBoundary extends Component");
    expect(character).toContain("static getDerivedStateFromError()");
    expect(character).toContain("<CharacterBoundary><Suspense");
    expect(character).toContain('this.state.failed ? <span className="tp-ai-character-placeholder"');
  });

  it("does not initialize expensive material renderers before explicit opt-in", () => {
    const orb = read("./TongpinOrb.tsx");
    const identity = read("./TongpinMetalIdentity.tsx");
    expect(orb).toContain("richMotion = false");
    expect(orb).toContain("if (!richMotion || !canvas || !host || !navigator.gpu) return;");
    expect(identity).not.toContain('import { MetalFx } from "metal-fx"');
    expect(identity).toContain('lazy(() => import("metal-fx")');
    const chat = read("../ChatWorkspace.tsx");
    expect(chat).not.toContain("TongpinOrb");
    expect(chat).not.toContain("TongpinMetalIdentity");
    expect(chat).not.toContain("BorderBeam");
    expect(read("./TongpinAICharacter.tsx")).toContain('lazy(() => import("./fleur/FleurCharacter")');
    const renderer = read("./vendor/orb/src/orb-renderer.ts");
    expect(renderer).not.toContain("device.createRenderPipeline({");
    expect(renderer.match(/createRenderPipelineAsync\(/g)).toHaveLength(3);
  });
});
