import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComputerRunPanel } from "./ComputerRunPanel";

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
});
