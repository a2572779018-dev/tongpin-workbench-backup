import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComputerQuestionActions, ComputerRunPanel, popupText } from "./ComputerRunPanel";

describe("computer run view", () => {
  it("renders the live instruction, status, Stop and the safety boundary before the run starts", () => {
    const html = renderToStaticMarkup(createElement(ComputerRunPanel, {
      request: { id: "computer-11111111-1111-4111-8111-111111111111", conversationId: "conversation-a", mode: "deep", instruction: "@computer 用微信给姐姐发中秋快乐" },
      accountId: "member-a",
      api: async () => { throw new Error("not called during render"); },
      onQuota: () => undefined,
      onFinish: () => undefined,
      onClose: () => undefined,
    }));
    expect(html).toContain("电脑操作 · Jev 逐步决策");
    expect(html).toContain("用微信给姐姐发中秋快乐");
    expect(html).not.toContain("@computer");
    expect(html).toContain("正在用当前档位模型整理任务");
    expect(html).toContain("aria-label=\"停止电脑操作\"");
    expect(html).toContain("不接收截图");
    expect(html).toContain("按 Esc 可随时停止");
  });

  it("offers the send confirmation only when the question carries one, before guidance and stop", () => {
    const noop = () => undefined;
    const offered = renderToStaticMarkup(createElement(ComputerQuestionActions, { confirmLabel: "已核对，按回车发送「中秋快乐」（前台）", canSubmit: false, onConfirm: noop, onStop: noop }));
    expect(offered.indexOf("已核对，按回车发送「中秋快乐」（前台）")).toBeGreaterThan(-1);
    expect(offered.indexOf("已核对")).toBeLessThan(offered.indexOf("补充后继续"));
    expect(offered).toContain("停止任务");
    const plain = renderToStaticMarkup(createElement(ComputerQuestionActions, { canSubmit: true, onConfirm: noop, onStop: noop }));
    expect(plain).not.toContain("已核对");
    expect(plain).toContain("补充后继续");
  });

  it("shows where a floating window hangs and whether it is the search list", () => {
    const base = { app: "微信", title: "微信", elementCount: 147, axSparse: false, screenshotUsed: true };
    expect(popupText(base)).toBe("");
    expect(popupText({ ...base, popupCount: 1, popupElementCount: 1, searchListShown: true, floating: { popups: [{ x: 48, y: 35, w: 368, h: 922, list: true }], searchBox: { x: -73, y: 1004, w: 342, h: 26 } } }))
      .toBe(" · 搜索列表 1 项〔列表 48,35 368×922；搜索框 -73,1004 342×26〕");
    expect(popupText({ ...base, popupCount: 1, popupElementCount: 0, floating: { popups: [{ x: 300, y: 500, w: 300, h: 70, list: false }], searchBox: null } }))
      .toBe(" · 浮层窗口（读不到内容）〔浮层 300,500 300×70〕");
  });
});
