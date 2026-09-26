import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AiHarnessStep, AiHarnessTrace } from "../../../../shared/ai";
import { ChatMessageRow } from "../ChatMessageRow";
import { ReplyProcessDetailsContext } from "../ReplyProcess";
import { hasReplyProcess, replyProcessRoutePart, replyProcessSummary, replyProcessView } from "../replyProcessModel";
import type { TongpinAIMessage } from "../types";

const step = (kind: AiHarnessStep["kind"], title: string, summary: string): AiHarnessStep =>
  ({ id: `${kind}-1`, kind, capability: "chat", title, summary, status: "succeeded", createdAt: "2026-09-27T10:00:00.000Z", updatedAt: "2026-09-27T10:00:00.000Z" });
const trace = (route: AiHarnessStep): AiHarnessTrace => ({
  runId: "run-quick", tier: "quick", strategy: "direct", status: "succeeded", reasoningSummary: "已完成安全路由，正在处理这条消息。", nextAction: "none",
  toolBudget: { used: 0, max: 1, remaining: 1 },
  steps: [step("strategy", "执行策略", "直接完成当前请求"), route, step("model", "模型响应", "已返回结果")],
});
const openSquilla = trace(step("route", "路由：OpenSquilla v4.2 → C1 均衡", "快速模型直接回答 · R1 · 置信 64%"));
const builtin = trace(step("route", "快速档位", "未收到本机 OpenSquilla 路由结果（网页端、旧版客户端或本机路由未就绪），已按内置规则处理。"));
const assistant = (extra: Partial<TongpinAIMessage> = {}): TongpinAIMessage => ({ id: "reply", role: "assistant", content: "好的。", time: "12:00", status: "ready", ...extra });
const rowProps = { assistantName: "同频 AI", copied: false, retryable: false, retryDisabled: false, onCopy: () => undefined, onOpenArtifact: () => undefined, onRetry: () => undefined };
const row = (message: TongpinAIMessage, expanded = false) => {
  const element = createElement(ChatMessageRow, { ...rowProps, message });
  return renderToStaticMarkup(expanded ? createElement(ReplyProcessDetailsContext.Provider, { value: { expanded: true, revision: 1 } }, element) : element);
};

describe("quick-tier route line in the reply process", () => {
  it("reads only route steps written by the quick-tier router", () => {
    expect(replyProcessRoutePart(openSquilla)).toEqual({ kind: "route", key: "route", label: "OpenSquilla v4.2 → C1 均衡", detail: "快速模型直接回答 · R1 · 置信 64%", state: "done" });
    // Built-in fallbacks (web build, older clients), older traces and other
    // tiers keep their boilerplate route step hidden: no process chrome.
    const older = trace(step("route", "快速档位", "已按管理员配置选择业务档位；具体服务商与模型仅管理员可见。"));
    for (const hidden of [builtin, older]) {
      expect(replyProcessRoutePart(hidden)).toBeUndefined();
      expect(hasReplyProcess(assistant({ trace: hidden }))).toBe(false);
    }
    expect(replyProcessRoutePart(undefined)).toBeUndefined();
  });

  it("puts the route first and names it in the one-line summary", () => {
    const view = replyProcessView({ message: assistant({ trace: openSquilla, analysisSummary: "先确认需求", process: { version: 1, outcome: "completed", durationMs: 5_400, steps: [{ kind: "thinking" }] } }) })!;
    expect(view.parts.map(part => part.kind)).toEqual(["route", "thinking"]);
    expect(replyProcessSummary(view)).toBe("OpenSquilla C1 均衡 · 已思考 · 用时 5 秒");
  });

  it("renders the route row with its explanation when expanded", () => {
    const collapsed = row(assistant({ trace: openSquilla }));
    expect(collapsed).toContain("OpenSquilla C1 均衡");
    expect(collapsed).not.toContain("tp-ai-process__parts");
    const expanded = row(assistant({ trace: openSquilla }), true);
    expect(expanded).toContain("<strong>路由</strong><span>OpenSquilla v4.2 → C1 均衡</span>");
    expect(expanded).toContain("快速模型直接回答 · R1 · 置信 64%");
    expect(expanded.indexOf("tp-ai-process")).toBeLessThan(expanded.indexOf("tp-ai-markdown"));
  });
});
