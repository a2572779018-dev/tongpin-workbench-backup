import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownReply } from "./MarkdownReply";
import { nextRevealLength, STREAM_REVEAL_FRAME_MS } from "./streamReveal";

function framesToCatchUp(content: string, from: number, streaming: boolean): number {
  let shown = from, frames = 0;
  while (shown < content.length) { shown = nextRevealLength(content, shown, streaming); frames += 1; }
  return frames;
}

describe("streamed reply reveal pace", () => {
  it("reveals a burst over a few frames instead of all at once", () => {
    const burst = "这是一段一次性到达的较长回复。".repeat(18); // 270 characters, about one server flush
    const first = nextRevealLength(burst, 0, true);
    expect(first).toBeGreaterThan(2);
    expect(first).toBeLessThan(burst.length / 3);
    const frames = framesToCatchUp(burst, 0, true);
    // Visibly progressive, yet caught up well within a second.
    expect(frames).toBeGreaterThanOrEqual(8);
    expect(frames * STREAM_REVEAL_FRAME_MS).toBeLessThan(1_000);
  });

  it("keeps trickling small deltas and finishes faster once the stream has ended", () => {
    expect(nextRevealLength("你好", 0, true)).toBe(2);
    const backlog = "收尾的内容".repeat(80);
    expect(framesToCatchUp(backlog, 0, false)).toBeLessThan(framesToCatchUp(backlog, 0, true));
    expect(framesToCatchUp(backlog, 0, false) * STREAM_REVEAL_FRAME_MS).toBeLessThan(600);
  });

  it("never splits an emoji in half", () => {
    const text = "a😀😀😀😀😀😀😀😀😀😀";
    for (let shown = 0; shown < text.length;) {
      shown = nextRevealLength(text, shown, true);
      const last = text.charCodeAt(shown - 1);
      expect(shown === text.length || !(last >= 0xd800 && last <= 0xdbff)).toBe(true);
    }
  });

  it("renders what has arrived at mount, marked live while streaming", () => {
    const live = renderToStaticMarkup(createElement(MarkdownReply, { content: "第一段已经到达。", streaming: true }));
    expect(live).toContain('class="tp-ai-markdown is-live"');
    expect(live).toContain("第一段已经到达。");
    const settled = renderToStaticMarkup(createElement(MarkdownReply, { content: "历史回复。" }));
    expect(settled).toContain('class="tp-ai-markdown"');
    expect(settled).toContain("历史回复。");
  });
});
