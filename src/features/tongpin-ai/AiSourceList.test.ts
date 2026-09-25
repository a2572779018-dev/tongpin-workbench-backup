import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AiSourceList } from "./AiSourceLink";

const mdn = "https://developer.mozilla.org/zh-CN/docs/Web/API/Window/requestAnimationFrame";

describe("AiSourceList", () => {
  it("renders one link for a flood of duplicate citations", () => {
    const flood = Array.from({ length: 12 }, (_, index) => ({ title: "developer.mozilla.org", url: `${mdn}#r${index}` }));
    const html = renderToStaticMarkup(createElement(AiSourceList, { sources: flood }));
    expect(html.match(/<li>/g)).toHaveLength(1);
    expect(html).toContain("developer.mozilla.org · Window/requestAnimationFrame");
    expect(html).not.toContain("展开其余");
  });
  it("folds sources past the limit behind a toggle", () => {
    const many = Array.from({ length: 8 }, (_, index) => ({ title: `来源 ${index}`, url: `https://example.com/p${index}` }));
    const html = renderToStaticMarkup(createElement(AiSourceList, { sources: many }));
    expect(html.match(/<li>/g)).toHaveLength(5);
    expect(html).toContain("展开其余 3 个来源");
  });
  it("renders nothing without usable sources", () => {
    expect(renderToStaticMarkup(createElement(AiSourceList, { sources: [] }))).toBe("");
  });
});
