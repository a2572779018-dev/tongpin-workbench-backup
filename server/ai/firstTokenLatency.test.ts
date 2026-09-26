import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createVisibleStream } from "./visibleStream";
import { needsOnlineEvidence } from "./autoRouting";

function collect(chunks: string[]) {
  const answers: string[] = [], summaries: string[] = [];
  const stream = createVisibleStream("quick", value => answers.push(value), value => summaries.push(value));
  const afterEach: string[] = [];
  for (const chunk of chunks) { stream.feed(chunk); afterEach.push(answers.join("")); }
  return { answers, summaries, afterEach };
}

describe("quick-tier first visible text", () => {
  it("releases an ordinary '<' immediately instead of holding the rest of the answer for a later '>'", () => {
    const { afterEach } = collect(["如果 a < b", " 那么返回 b", "，否则返回 a。"]);
    expect(afterEach).toEqual(["如果 a < b", "如果 a < b 那么返回 b", "如果 a < b 那么返回 b，否则返回 a。"]);
    expect(collect(["用 <br", "> 换行"]).afterEach).toEqual(["用 <br", "用 <br> 换行"]);
    expect(collect(["x <thinking about it"]).answers.join("")).toBe("x <thinking about it");
  });

  it("still holds only an ambiguous control-tag prefix and hides every control tag split across chunks", () => {
    const partial = collect(["正文 <", "thi"]);
    expect(partial.afterEach).toEqual(["正文 ", "正文 "]);
    const hidden = collect(["答案<", "tool_", "request>{\"kind\":\"image\",\"prompt\":\"x\"}</tool_request>"]);
    expect(hidden.answers.join("")).toBe("答案");
    const privateText = collect(["<", "think>私密</", "think>可见"]);
    expect(privateText.answers.join("")).toBe("可见");
    const summary = collect(["<analysis_", "summary>公开依据</analysis_summary>正文"]);
    expect(summary.answers.join("")).toBe("正文");
    expect(summary.summaries).toEqual(["公开依据"]);
  });

  it("streams inline code and non-JSON fences live but keeps legacy JSON envelopes terminal-only", () => {
    expect(collect(["`npm", " install` 即可"]).afterEach).toEqual(["`npm", "`npm install` 即可"]);
    expect(collect(["``", "`ts\nconst a = 1;\n```"]).afterEach).toEqual(["", "```ts\nconst a = 1;\n```"]);
    expect(collect(["```js", "on\n{\"kind\":\"image\",\"prompt\":\"x\"}\n```"]).answers).toEqual([]);
    expect(collect(["```\n", "{\"kind\":\"video\",\"prompt\":\"x\"}"]).answers).toEqual([]);
    expect(collect(["  {\"kind\":\"text\",\"content\":\"x\"}"]).answers).toEqual([]);
  });

  it("does not turn ordinary quick-tier chat into a search/Astra turn on generic words", () => {
    for (const text of ["当前这段代码为什么报错", "帮我写一个 SQL 查询", "实现一个搜索算法", "解释一下版本号语义", "现在开始写一篇发布会文案", "What is the current design?", "I know the price is fixed"]) {
      expect(needsOnlineEvidence(text), text).toBe(false);
    }
    for (const text of ["今天有什么新闻", "请上网查一下最新版本", "黄金现在的价格是多少", "What is the current price of BTC?", "look up the weather", "查找官方资料"]) {
      expect(needsOnlineEvidence(text), text).toBe(true);
    }
  });

  it("overlaps a text turn's first save with the read-only preflight, and awaits it before any model call", () => {
    const page = readFileSync(new URL("../../src/pages/TongpinAIPage.tsx", import.meta.url), "utf8");
    const submit = page.slice(page.indexOf("async function submitToolTask("), page.indexOf("async function sendMessage("));
    expect(submit).toContain("const recorded = persistenceRef.current.saveNow(next);");
    expect(submit.indexOf("await sendMessage(undefined, { ...continuation, recorded })")).toBeLessThan(submit.indexOf("if (!await recorded)"));
    const send = page.slice(page.indexOf("async function sendMessage("), page.indexOf("async function retryReply"));
    const awaitRecorded = send.indexOf("!await continuation.recorded");
    expect(awaitRecorded).toBeGreaterThan(send.indexOf('"/api/ai/preflight"'));
    expect(awaitRecorded).toBeLessThan(send.indexOf("persistenceRef.current.saveNow(nextState)"));
    expect(awaitRecorded).toBeLessThan(send.indexOf("await performChat("));
  });
});
