import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMessageRow, retryButtonLabel } from "./ChatMessageRow";
import type { TongpinAIMessage } from "./types";

const rowProps = { assistantName: "同频 AI", copied: false, retryable: true, retryDisabled: false, onCopy: () => undefined, onOpenArtifact: () => undefined, onRetry: () => undefined };
const failed = (extra: Partial<TongpinAIMessage> = {}): TongpinAIMessage => ({
  id: "reply", requestId: "request-1", role: "assistant", time: "12:00", status: "error",
  content: "记录尚未保存，请恢复同步后重新获取回复。本次尚未调用模型。", ...extra,
});

describe("failed reply retry label", () => {
  it("names what the retry actually does for each disposition", () => {
    expect(retryButtonLabel(undefined)).toBe("重新获取回复");
    expect(retryButtonLabel("recover")).toBe("查询原任务");
    expect(retryButtonLabel("regenerate")).toBe("重新生成");
  });
  it("offers「重新获取回复」when the record was never saved and no model call happened", () => {
    const html = renderToStaticMarkup(createElement(ChatMessageRow, { ...rowProps, message: failed() }));
    expect(html).toContain("重新获取回复</button>");
    expect(html).not.toContain("查询原任务");
  });
  it("still offers「查询原任务」for a task the server may hold", () => {
    const html = renderToStaticMarkup(createElement(ChatMessageRow, { ...rowProps, message: failed({ retryDisposition: "recover", content: "上次等待已中断" }) }));
    expect(html).toContain("查询原任务</button>");
  });
});
