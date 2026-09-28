import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAiDispatchDecision } from "./dispatch";
import { createNodeAi } from "./node";
import type { AiTransport } from "./provider";

// Emoji ZWJ sequences (U+200D) and a tag-sequence flag: all \p{Cf} joiners.
const EMOJI = "开发者 👨‍💻、举手 🙋‍♀️、一家人 👨‍👩‍👧、苏格兰 🏴󠁧󠁢󠁳󠁣󠁴󠁿";

describe("AI server dispatcher", () => {
  it("keeps a multiline Markdown answer as the same charged model response", () => {
    const content = "结论如下：\n\n| 方案 | 风险 |\n| --- | --- |\n| A | 低 |\n\n- 保留现状\n- 继续验证";
    expect(parseAiDispatchDecision(JSON.stringify({ kind: "text", content }), "quick")).toEqual({ kind: "text", content });
  });

  it("returns only a non-executing tool proposal and optional clarification", () => {
    expect(parseAiDispatchDecision(JSON.stringify({
      kind: "video",
      prompt: "制作一段品牌短片\n保持 Logo 原样",
      clarification: "需要横屏还是竖屏？",
    }), "deep")).toEqual({ kind: "video", prompt: "制作一段品牌短片\n保持 Logo 原样", clarification: "需要横屏还是竖屏？" });
  });

  it("accepts only a tier-bounded public summary on text dispatch", () => {
    expect(parseAiDispatchDecision(JSON.stringify({ kind: "text", content: "正式答复", analysisSummary: "根据风险与成本比较。" }), "quick"))
      .toEqual({ kind: "text", content: "正式答复", analysisSummary: "根据风险与成本比较。" });
    expect(parseAiDispatchDecision(JSON.stringify({ kind: "text", content: "正式答复", analysisSummary: "据".repeat(81) }), "quick"))
      .toEqual({ kind: "text", content: "正式答复" });
  });

  it("rejects extra fields, hidden reasoning and unsafe controls", () => {
    expect(() => parseAiDispatchDecision('{"kind":"image","prompt":"海报","reasoning":"private"}', "pro")).toThrow(expect.objectContaining({ code: "AI_DISPATCH_INVALID" }));
    expect(() => parseAiDispatchDecision('{"kind":"text","content":"answer","reasoning_content":"private"}', "pro")).toThrow(expect.objectContaining({ code: "AI_DISPATCH_INVALID" }));
    expect(() => parseAiDispatchDecision(JSON.stringify({ kind: "text", content: "before\u0000after" }), "pro")).toThrow(expect.objectContaining({ code: "AI_DISPATCH_INVALID" }));
  });

  it("keeps emoji ZWJ sequences, soft hyphens and zero-width characters in replies and tool requests", () => {
    const content = `${EMOJI}\n\n软\u00ad连字符、零宽\u200b空格与\u200c分隔`;
    expect(parseAiDispatchDecision(content, "quick", { allowPlainText: true })).toEqual({ kind: "text", content });
    expect(parseAiDispatchDecision(JSON.stringify({ kind: "text", content }), "quick")).toEqual({ kind: "text", content });
    const tool = { kind: "image", prompt: `程序员头像 👨‍💻\n保留表情 🙋‍♀️`, clarification: "要加上一家人 👨‍👩‍👧 吗？" };
    expect(parseAiDispatchDecision(`<tool_request>${JSON.stringify(tool)}</tool_request>`, "quick")).toEqual(tool);
    // A leading byte-order mark is dropped, not treated as a broken reply.
    expect(parseAiDispatchDecision(`\ufeff${EMOJI}`, "quick", { allowPlainText: true })).toEqual({ kind: "text", content: EMOJI });
  });

  it("still rejects C0/C1 controls, bidi overrides/isolates and lone surrogates", () => {
    for (const unsafe of ["\u0000", "\u0007", "\u001b", "\u007f", "\u0085", "\u202a", "\u202e", "\u2066", "\u2069", "\ud83d"]) {
      const content = `before${unsafe}after`;
      expect(() => parseAiDispatchDecision(content, "quick", { allowPlainText: true })).toThrow(expect.objectContaining({ code: "AI_DISPATCH_INVALID" }));
      expect(() => parseAiDispatchDecision(JSON.stringify({ kind: "text", content }), "quick")).toThrow(expect.objectContaining({ code: "AI_DISPATCH_INVALID" }));
      expect(() => parseAiDispatchDecision(JSON.stringify({ kind: "image", prompt: content }), "quick")).toThrow(expect.objectContaining({ code: "AI_DISPATCH_INVALID" }));
    }
    // A clarification stays a single line.
    expect(() => parseAiDispatchDecision(JSON.stringify({ kind: "image", prompt: "海报", clarification: "第一行\n第二行" }), "quick"))
      .toThrow(expect.objectContaining({ code: "AI_DISPATCH_INVALID" }));
  });
});

describe("dispatch through the real chat service", () => {
  let directory: string;
  let runtime: Awaited<ReturnType<typeof createNodeAi>>;
  const transport = vi.fn<AiTransport>();
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-dispatch-"));
    transport.mockReset();
    runtime = await createNodeAi(path.join(directory, "fixture.json"), transport);
    await runtime.service.saveProvider({ name: "fixture", baseUrl: "https://api.example.com/v1", apiKey: "fixture-not-real", protocol: "chat_completions", quickModel: "quick", deepModel: "deep", maxOutputTokens: 1024, reasoningEffort: "", enabled: true });
    runtime.service.setQuota("member", "admin", { limitTokens: 100000 });
  });
  afterEach(async () => { runtime.close(); await rm(directory, { recursive: true }); });

  it("delivers a charged plain reply with emoji ZWJ sequences instead of failing it after streaming", async () => {
    const content = `给你几个头像：${EMOJI}`;
    transport.mockResolvedValueOnce(Response.json({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 } }));
    const request = { requestId: crypto.randomUUID(), conversationId: "conversation-a", mode: "quick", outputFormat: "dispatch", messages: [{ role: "user", content: "推荐几个头像表情" }] };
    const result = await runtime.service.chat("member", request, { stream: true });
    expect(result).toMatchObject({ content, dispatch: { kind: "text", content } });
    expect(runtime.service.getRequestResult("member", request.requestId)).toMatchObject({ status: "completed", result: { content } });
    expect(runtime.store.usage("member").find(item => item.requestId === request.requestId)).toMatchObject({ status: "completed", totalTokens: 50 });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
