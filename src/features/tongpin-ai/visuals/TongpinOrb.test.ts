import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TongpinOrb } from "./TongpinOrb";

describe("TongpinOrb", () => {
  it("starts as a decorative idle identity with the existing icon, before GPU readiness", () => {
    const markup = renderToStaticMarkup(createElement(TongpinOrb));

    expect(markup).toContain('data-orb-state="idle"');
    expect(markup).toContain('data-orb-renderer="fallback"');
    expect(markup).toContain('src="./app-icon.svg"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain("<canvas");
  });

  it("does not request a GPU canvas without an explicit visual-effects choice", () => {
    const markup = renderToStaticMarkup(createElement(TongpinOrb, { active: true }));
    expect(markup).not.toContain("<canvas");
    expect(renderToStaticMarkup(createElement(TongpinOrb, { richMotion: true }))).toContain("<canvas");
  });

  it("only requests the thinking appearance when its caller marks a request active", () => {
    const markup = renderToStaticMarkup(
      createElement(TongpinOrb, { active: true, className: "composer-orb" }),
    );

    expect(markup).toContain('data-orb-state="thinking"');
    expect(markup).toContain('class="tp-ai-orb composer-orb"');
    expect(markup).toContain('data-orb-renderer="fallback"');
  });

  it("bounds canvas layout dimensions without allowing invalid sizes", () => {
    expect(
      renderToStaticMarkup(createElement(TongpinOrb, { size: Number.NaN })),
    ).toContain("width:48px;height:48px");
    expect(
      renderToStaticMarkup(createElement(TongpinOrb, { size: -12 })),
    ).toContain("width:16px;height:16px");
    expect(
      renderToStaticMarkup(createElement(TongpinOrb, { size: 900 })),
    ).toContain("width:320px;height:320px");
  });
});
