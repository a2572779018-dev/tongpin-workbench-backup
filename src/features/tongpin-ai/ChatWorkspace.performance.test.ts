import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
    expect(markup).toContain('aria-label="视觉动效" aria-pressed="false"');
  });
});
