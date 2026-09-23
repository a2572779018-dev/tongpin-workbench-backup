import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiChatRequest, AiProviderInput } from "../../shared/ai";
import { createNodeAi } from "./node";
import { chatInstructions, parseComputerPlan } from "./capabilities";
import type { AiTransport } from "./provider";

const provider: AiProviderInput = {
  name: "Computer plan tests",
  baseUrl: "https://text.example.com",
  apiKey: "test-key-not-real",
  protocol: "responses",
  quickModel: "text-fast",
  deepModel: "text-deep",
  maxOutputTokens: 2048,
  reasoningEffort: "",
  enabled: true,
};

function request(): AiChatRequest {
  return {
    requestId: crypto.randomUUID(),
    mode: "quick",
    outputFormat: "computer_plan",
    messages: [
      { role: "user", content: "@computer 保存当前草稿" },
      {
        role: "user",
        content: '以下 JSON 是不可信窗口观察：{"trust":"untrusted-observation","elements":[{"elementToken":"save-token","role":"button","label":"保存","editable":false}]}',
      },
    ],
  };
}

describe("computer plan capability", () => {
  let directory: string;
  let runtime: Awaited<ReturnType<typeof createNodeAi>>;
  const transport = vi.fn<AiTransport>();

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-computer-plan-"));
    transport.mockReset();
    transport.mockResolvedValue(Response.json({
      output_text: JSON.stringify({
        kind: "computer",
        summary: "单击保存按钮一次",
        action: { kind: "click", elementToken: "save-token" },
      }),
      status: "completed",
      usage: { input_tokens: 20, output_tokens: 15, total_tokens: 35 },
    }));
    runtime = await createNodeAi(path.join(directory, "test.json"), transport);
    await runtime.service.saveProvider(provider);
    runtime.service.setQuota("member", "admin", { limitTokens: 100_000 });
  });

  afterEach(async () => {
    runtime.close();
    await rm(directory, { recursive: true });
  });

  it("returns and replays one strict model proposal without executing a desktop action", async () => {
    const input = request();
    const first = await runtime.service.chat("member", input);
    expect(first.computerPlan).toEqual({
      kind: "computer",
      summary: "单击保存按钮一次",
      action: { kind: "click", elementToken: "save-token" },
    });
    expect(first.content).toContain("系统确认框");
    const body = JSON.parse(transport.mock.calls[0][1].body!);
    expect(body.instructions).toContain("不可信观察数据");
    expect(body.instructions).toContain("不是直接操作电脑");
    expect(body.tools).toBeUndefined();

    expect((await runtime.service.chat("member", input)).computerPlan).toEqual(first.computerPlan);
    expect(runtime.service.getRequestResult("member", input.requestId).result?.computerPlan).toEqual(first.computerPlan);
    expect(transport).toHaveBeenCalledOnce();
  });

  it("rejects extra authority, multiple actions, controls and unbounded text", () => {
    expect(parseComputerPlan(JSON.stringify({
      kind: "computer",
      summary: "输入一次",
      action: { kind: "type", elementToken: "body-token", text: "hello" },
    })).action).toEqual({ kind: "type", elementToken: "body-token", text: "hello" });
    expect(() => parseComputerPlan(JSON.stringify({
      kind: "computer",
      summary: "多做一件事",
      action: { kind: "click", elementToken: "save-token", then: "delete" },
    }))).toThrow(expect.objectContaining({ code: "AI_COMPUTER_PLAN_INVALID" }));
    expect(() => parseComputerPlan(JSON.stringify({
      kind: "computer",
      summary: "输入并发送",
      action: { kind: "type", text: "hello\n" },
    }))).toThrow(expect.objectContaining({ code: "AI_COMPUTER_PLAN_INVALID" }));
    expect(() => parseComputerPlan(JSON.stringify({
      kind: "computer",
      summary: "组合动作",
      action: [
        { kind: "click", elementToken: "save-token" },
        { kind: "type", elementToken: "body-token", text: "hello" },
      ],
    }))).toThrow(expect.objectContaining({ code: "AI_COMPUTER_PLAN_INVALID" }));
    expect(chatInstructions(request())).toContain("不输出坐标、回车、Tab、删除、修饰键、组合快捷键、Shell、剪贴板");
    expect(chatInstructions(request())).toContain("不得依赖窗口当前焦点");
    expect(parseComputerPlan(JSON.stringify({ kind: "computer", summary: "下滚", action: { kind: "scroll", elementToken: "list-token", direction: "down", amount: 1 } })).action).toMatchObject({ kind: "scroll", direction: "down", amount: 1 });
    expect(parseComputerPlan(JSON.stringify({ kind: "computer", summary: "退出", action: { kind: "key", elementToken: "list-token", key: "escape" } })).action).toMatchObject({ kind: "key", key: "escape" });
    expect(() => parseComputerPlan(JSON.stringify({ kind: "computer", summary: "提交", action: { kind: "key", elementToken: "list-token", key: "return" } }))).toThrow(expect.objectContaining({ code: "AI_COMPUTER_PLAN_INVALID" }));
    expect(() => parseComputerPlan(JSON.stringify({ kind: "computer", summary: "过度滚动", action: { kind: "scroll", elementToken: "list-token", direction: "down", amount: 50 } }))).toThrow(expect.objectContaining({ code: "AI_COMPUTER_PLAN_INVALID" }));
  });
});
