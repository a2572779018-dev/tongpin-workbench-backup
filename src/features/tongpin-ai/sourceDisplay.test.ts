import { describe, expect, it } from "vitest";
import { displaySources, sourceIdentity, sourceLabel, VISIBLE_SOURCE_COUNT } from "./sourceDisplay";

const mdn = "https://developer.mozilla.org/zh-CN/docs/Web/API/Window/requestAnimationFrame";

describe("reply source display", () => {
  it("treats fragments, trailing slashes, www and tracking params as the same page", () => {
    expect(sourceIdentity(`${mdn}#syntax`)).toBe(sourceIdentity(mdn));
    expect(sourceIdentity(`${mdn}/?utm_source=chatgpt.com`)).toBe(sourceIdentity(mdn));
    expect(sourceIdentity("https://www.example.com/a")).toBe(sourceIdentity("https://example.com/a"));
    expect(sourceIdentity("https://example.com/a?id=1")).not.toBe(sourceIdentity("https://example.com/a?id=2"));
  });
  it("collapses the repeated-citation flood into one entry per page", () => {
    const flood = Array.from({ length: 12 }, (_, index) => ({ title: "developer.mozilla.org", url: `${mdn}${index % 2 ? "#example" : "?utm_source=x"}` }));
    const { visible, folded } = displaySources([...flood, { title: "Window: requestAnimationFrame() 方法 - Web API | MDN", url: mdn }]);
    expect(visible).toHaveLength(1);
    expect(folded).toHaveLength(0);
  });
  it("keeps a later real title when the first duplicate had none", () => {
    expect(displaySources([{ title: "", url: mdn }, { title: "MDN 文档", url: `${mdn}#x` }]).visible[0].title).toBe("MDN 文档");
  });
  it("folds everything past the visible limit", () => {
    const many = Array.from({ length: 9 }, (_, index) => ({ title: `来源 ${index}`, url: `https://example.com/p${index}` }));
    const { visible, folded } = displaySources(many);
    expect(visible).toHaveLength(VISIBLE_SOURCE_COUNT);
    expect(folded).toHaveLength(9 - VISIBLE_SOURCE_COUNT);
  });
  it("ignores empty and malformed entries without throwing", () => {
    expect(displaySources([{ title: "x", url: "" }, { title: "y", url: "not a url" }]).visible).toHaveLength(1);
    expect(displaySources(undefined).visible).toEqual([]);
  });
  it("labels bare-domain titles with a readable path", () => {
    expect(sourceLabel({ title: "developer.mozilla.org", url: mdn })).toBe("developer.mozilla.org · Window/requestAnimationFrame");
    expect(sourceLabel({ title: "MDN 文档", url: mdn })).toBe("MDN 文档");
    expect(sourceLabel({ title: "", url: "https://example.com/" })).toBe("example.com");
  });
});
