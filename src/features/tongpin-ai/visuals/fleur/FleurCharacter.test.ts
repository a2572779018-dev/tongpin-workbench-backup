import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { applyFlush, FleurCharacter, fleurViewBox, heldImpression, FLEUR_MOODS, FLEUR_SAYS, isFleurMood, isFleurSays } from "./FleurCharacter";
import { bodyPaint, computeFrame, computeStaticFrame, contentExtent, createAvatar, EYE_STYLE_BY_ID, impressionFrame, impressionReach, MOTION_BY_ID, play, svgFrame, svgImpression, topperById } from "./character-runtime.js";
import type { CharacterConfig, CharacterSpec, ImpressionPlan, SvgFrame } from "./character-runtime.js";

const source = readFileSync(new URL("./FleurCharacter.tsx", import.meta.url), "utf8");
const specSource = source.match(/const SPEC = ([\s\S]*?);/)![1];
const spec: CharacterSpec = JSON.parse(specSource);
const config: CharacterConfig = JSON.parse(source.match(/const CONFIG: CharacterConfig = ([\s\S]*?);/)![1]);
const impressionSource = source.match(/const IMPRESSIONS:[^\n]*? = (.*);/)![1];
const impressions: Record<string, { plan: ImpressionPlan }> = JSON.parse(impressionSource);
const frameInput = { config, style: EYE_STYLE_BY_ID[config.eyeStyleId], topper: topperById("none", 3) };
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

describe("purchased Fleur SVG component boundary", () => {
  it("preserves the exported character and impression geometry byte-for-byte", () => {
    expect(hash(specSource)).toBe("af9186512c189e10cb6e949a2098bf5fb7a8a82f899e6bb5be393b1d23c20b26");
    expect(hash(impressionSource)).toBe("c9e8df1815974f7f67c49e5eaaf2428b674d6ae127cb07ae3e58b50228d79468");
  });
  it("accepts only fixed mood/says values, never raw markup or prototype property names", () => {
    expect(FLEUR_MOODS.every(isFleurMood)).toBe(true);
    expect(FLEUR_SAYS.every(isFleurSays)).toBe(true);
    for (const bad of ["<script>alert(1)</script>", "__proto__", "constructor", "toString", "", null, {}, 42]) {
      expect(isFleurMood(bad)).toBe(false); expect(isFleurSays(bad)).toBe(false);
    }
    expect(source).not.toMatch(/dangerouslySetInnerHTML|innerHTML|\beval\(/);
  });
  it("uses SVG, inherits its container size, and does not block touch scroll when non-interactive", () => {
    const markup = renderToStaticMarkup(createElement(FleurCharacter, { mood: "idle", says: "none", paused: true }));
    expect(markup).toContain("<svg");
    expect(markup).toContain("touch-action:auto");
    expect(markup).toContain("width:100%;height:100%");
    expect(markup).toContain('preserveAspectRatio="xMidYMid meet"');
    expect(markup).not.toContain("<canvas");
    expect(source).not.toMatch(/WebGL|webgpu|ts-nocheck|:\s*any\b|useRef<any>/);
  });
  it("removes unused impression headroom for none but safely reserves every fixed symbol", () => {
    const dimensions = (says: (typeof FLEUR_SAYS)[number]) => {
      const html = renderToStaticMarkup(createElement(FleurCharacter, { mood: "idle", says, paused: true }));
      return html.match(/viewBox="([^"]+)"/)![1].split(" ").map(Number);
    };
    const none = dimensions("none");
    expect(none[2]).toBeCloseTo(none[3]);
    for (const says of FLEUR_SAYS.filter(s => s !== "none")) {
      const box = dimensions(says);
      const reach = impressionReach({ rim: 106, size: 1, height: 1 });
      expect(box[2]).toBeGreaterThan(none[2]);
      expect(box[0]).toBeLessThanOrEqual(-reach);
      expect(box[1]).toBeLessThanOrEqual(-reach);
      expect(box[0] + box[2]).toBeGreaterThanOrEqual(reach);
      expect(box[1] + box[3]).toBeGreaterThanOrEqual(reach);
    }
  });
  it("keeps the purchased content private-source rather than claiming an MIT license", () => {
    const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
    expect(readme).toContain("用户购买");
    expect(readme).toContain("不标记为 MIT");
    expect(readme).toContain("不要将独立付费源码");
  });
  it("keeps the flower above 60px in a 100x134 compact task-avatar card", () => {
    const motion = MOTION_BY_ID.happy;
    const frame = computeStaticFrame(spec, motion, frameInput);
    const xs = frame.body.pts.filter((_, index) => index % 2 === 0);
    const bodyWidth = Math.max(...xs) - Math.min(...xs);
    const extent = contentExtent(spec, config, null, motion);
    for (const { plan } of Object.values(impressions)) {
      const box = fleurViewBox(extent, plan, "compact");
      const scale = Math.min(100 / box[2], 134 / box[3]);
      expect(bodyWidth * scale).toBeGreaterThan(60);
      expect(box[3]).toBeGreaterThan(box[2]);
    }
    const heart = fleurViewBox(extent, impressions.smitten.plan, "compact");
    expect(bodyWidth * Math.min(100 / heart[2], 134 / heart[3])).toBeGreaterThan(70);
  });
  it("defaults to safe framing and retains safe margins for flipping moods even when compact is requested", () => {
    for (const mood of ["spin", "tumble"] as const) {
      const html = renderToStaticMarkup(createElement(FleurCharacter, { mood, says: "smitten", framing: "compact" }));
      const box = html.match(/viewBox="([^"]+)"/)![1].split(" ").map(Number);
      expect(box[2]).toBe(box[3]);
    }
  });
  it("contains held symbols during the app's task moods without taking a full four-sided square", () => {
    const taskMoods = ["idle", "thinking", "listening", "happy", "confused", "curious", "sleepy", "alert", "surprised", "shakeNo", "bored", "angry", "excited", "dizzy"] as const;
    const glyphs = Object.values(impressions).map(({ plan }) => ({ plan, glyph: impressionFrame(plan, { rim: 106, size: 1, height: 1, drops: 1, t: plan.setT + 400 }).glyph! }));
    for (const mood of taskMoods) {
      const motion = MOTION_BY_ID[mood];
      const avatar = createAvatar(spec, motion, true, 4.3, 3);
      const extent = contentExtent(spec, config, null, motion);
      for (let now = 0; now <= 3000; now += 100) {
        const frame = computeFrame(avatar, now, frameInput);
        const t = frame.transform;
        const angle = t.rot * Math.PI / 180;
        for (const { plan, glyph } of glyphs) {
          const box = fleurViewBox(extent, plan, "compact");
          let overflow = 0;
          for (let i = 0; i < glyph.pts.length; i += 2) {
            const x = glyph.pts[i] * t.sx, y = glyph.pts[i + 1] * t.sy;
            const px = x * Math.cos(angle) - y * Math.sin(angle) + t.tx;
            const py = x * Math.sin(angle) + y * Math.cos(angle) + t.ty;
            overflow = Math.max(overflow, box[0] - px, px - box[0] - box[2], box[1] - py, py - box[1] - box[3]);
          }
          expect(overflow, `${mood} ${plan.word || plan.kind} at ${now}`).toBe(0);
        }
      }
    }
  });
});

describe("Fleur frame fixes", () => {
  it.each(FLEUR_MOODS)("draws finite original geometry for %s both static and moving", mood => {
    const motion = MOTION_BY_ID[mood];
    const input = { ...frameInput, config: { ...config, motionId: mood } };
    const avatar = createAvatar(spec, motion, true, 4.3, 3);
    const still = svgFrame(computeStaticFrame(spec, motion, input));
    expect(still.bodyD).toMatch(/^M/);
    expect(JSON.stringify(still)).not.toMatch(/NaN|Infinity/);
    const first = svgFrame(computeFrame(avatar, 0, input));
    const next = svgFrame(computeFrame(avatar, 100, input));
    expect(first.bodyD).toMatch(/^M/); expect(next.bodyD).toMatch(/^M/);
    expect(JSON.stringify(next)).not.toMatch(/NaN|Infinity/);
    play(avatar, MOTION_BY_ID.happy);
    expect(avatar.motion).toBe(MOTION_BY_ID.happy);
  });
  it("shows actual symbols in a paused snapshot without advancing the live avatar", () => {
    const avatar = createAvatar(spec, MOTION_BY_ID.idle, true, 4.3, 3);
    computeFrame(avatar, 0, frameInput);
    computeStaticFrame(spec, MOTION_BY_ID.shy, frameInput);
    expect(avatar.clock).toBe(0);
    for (const { plan } of Object.values(impressions)) {
      const frame = svgImpression(impressionFrame(plan, { rim: 106, size: 1, height: 1, drops: 1, t: plan.setT }));
      expect(frame.glyphD).toMatch(/^M/);
      expect(JSON.stringify(frame)).not.toMatch(/NaN|Infinity/);
    }
  });
  it("holds a fully formed, cached symbol from the first paint instead of cycling back to empty", () => {
    for (const { plan } of Object.values(impressions)) {
      const first = heldImpression(plan);
      expect(first.glyphD).toMatch(/^M/);
      expect(Number(first.glyphOpacity)).toBeGreaterThan(0);
      expect(first.drops).toEqual([]);
      expect(heldImpression(plan)).toBe(first);
      expect(first.glyphD).toBe(svgImpression(impressionFrame(plan, { rim: 106, size: 1, height: 1, drops: 1, t: plan.setT + 400 })).glyphD);
    }
    expect(source).toContain('still || latest.impressionPlayback === "hold"');
  });
  it("passes the instance-specific blush filter ID instead of reading an out-of-scope name", () => {
    const attributes: Record<string, string> = {};
    const node = { setAttribute(name: string, value: string) { attributes[name] = value; } } as unknown as SVGElement;
    const paint = bodyPaint(config, spec);
    const frame: SvgFrame = { bodyD: "M0 0", groupTransform: "", eyeL: null, eyeR: null, eyeC: null, ramp: null, texture: [], overlays: [{ id: "blush", d: "M1 1Z", fill: "#ffaaaa", op: "0.5", blur: 4.5 }] };
    expect(() => applyFlush({ ov0: node }, frame, paint, "instance-a-blush")).not.toThrow();
    expect(attributes.filter).toBe("url(#instance-a-blush)");
    applyFlush({ ov0: node }, frame, paint, "instance-b-blush");
    expect(attributes.filter).toBe("url(#instance-b-blush)");
  });
  it("reads current paint and impression refs inside the persistent drawing loop and wires every pause source", () => {
    const loop = source.slice(source.indexOf("const loop = createVisibleFrameLoop"), source.indexOf("const onPointerDown"));
    expect(loop).toContain("const latest = visualRef.current");
    expect(loop).toContain("applyFlush(e, frame, latest.paint, latest.blushId)");
    expect(loop).toContain("applyImpression(e, latest.impPlan");
    expect(loop).not.toContain("applyImpression(e, impPlan,");
    expect(loop).toContain("!visualRef.current.paused && !document.hidden && !reducedMotion.matches && inView");
    expect(loop).toContain("loop.redraw()");
    expect(loop).toContain("observer?.disconnect()");
    expect(loop).toContain('removeEventListener("visibilitychange"');
    expect(loop).toContain('removeEventListener("change"');
  });
});
