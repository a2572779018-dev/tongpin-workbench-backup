import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ChatWorkspace } from "./ChatWorkspace";
import type { TongpinAIMessage } from "./types";

const noop = () => {};
export const syntheticHistory: TongpinAIMessage[] = Array.from({ length: 1_000 }, (_, index) => ({
  id: String(index), role: index % 2 ? "assistant" : "user",
  content: `合成测试消息 ${index}。` + "这是合成的性能测试消息。".repeat(20),
  time: "12:00", status: "ready",
}));

describe("chat rendering performance boundaries", () => {
  it("keeps draft updates from invalidating every history row", () => {
    const source = readFileSync(new URL("./ChatWorkspace.tsx", import.meta.url), "utf8");
    expect(source).toContain("const editVideo = useCallback(");
    expect(source).toContain("onEditVideo={isVideoArtifact && onSubmitVideo ? editVideo : undefined}");
    expect(source).toContain("onVideoSettled={isVideoArtifact ? videoSettled : undefined}");
    expect(source).not.toContain("onEditVideo={onSubmitVideo ? request =>");
  });

  it("does not queue smooth scrolling for every streamed reply resize", () => {
    const refinements = readFileSync(new URL("./ai-refinements.css", import.meta.url), "utf8");
    expect(refinements).toContain(".tp-ai-page .tp-ai-messages { scroll-behavior: auto; }");
    expect(refinements).not.toContain(".tp-ai-page .tp-ai-messages { scroll-behavior: smooth; }");
  });

  it("bounds the initial message DOM without discarding the earlier history", () => {
    const props = { artifactById: new Map(), composerFocusRequest: 0, draft: "", enabledSkills: [],
      messages: syntheticHistory, mode: "quick" as const, notificationUnread: 0,
      quotaInsufficient: false, responding: false, onDraftChange: noop, onModeChange: noop,
      onOpenArtifact: noop, onSubmit: noop };
    const samples: number[] = [];
    let markup = "";
    for (let index = 0; index < 7; index += 1) {
      const start = performance.now();
      markup = renderToStaticMarkup(createElement(ChatWorkspace, props));
      samples.push(Number((performance.now() - start).toFixed(2)));
    }
    console.info("Synthetic 1000-message SSR", JSON.stringify({ samples,
      medianMs: samples.slice(2).sort((a, b) => a - b)[2], articles: markup.match(/<article/g)?.length, bytes: markup.length }));
    expect(markup).toContain("合成测试消息 999");
    // A DOM budget is deterministic; wall time is logged, not a flaky hardware assertion.
    expect(markup.match(/<article/g)).toHaveLength(40);
    expect(markup).toContain("加载更早的消息（还有 960 条）");
    expect(markup).not.toContain("合成测试消息 0。");
    expect(syntheticHistory).toHaveLength(1_000);
    expect(markup).not.toContain("<canvas");
    expect(markup).not.toContain('aria-label="视觉动效"');
    expect(markup).not.toContain("app-icon.svg");
    expect(markup.match(/class="tp-ai-character /g)).toHaveLength(1);
  });

  it("does not pretend a text reasoning mode controls image generation", () => {
    const props = { artifactById: new Map(), composerFocusRequest: 0, draft: "一只猫", enabledSkills: [],
      messages: [], mode: "deep" as const, notificationUnread: 0, composerTool: "image" as const, imageEnabled: true,
      quotaInsufficient: false, responding: false, onDraftChange: noop, onModeChange: noop,
      onOpenArtifact: noop, onSubmit: noop };
    const markup = renderToStaticMarkup(createElement(ChatWorkspace, props));
    expect(markup).toContain("图片生成");
    expect(markup).not.toContain('aria-label="思考模式"');
    expect(markup.match(/class="tp-ai-character /g)).toHaveLength(1);
    const textMarkup = renderToStaticMarkup(createElement(ChatWorkspace, { ...props, composerTool: "text" }));
    expect(textMarkup).toContain('aria-label="思考模式"');
    expect(textMarkup).toMatch(/value="deep" selected=""/);
  });
});
