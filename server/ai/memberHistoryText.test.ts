import { describe, expect, it } from "vitest";
import {
  detectHistoryRecallCue, HISTORY_CHUNK_CHARACTERS, HISTORY_MESSAGE_CHARACTERS, historyChunks, historyDate, historyExcerpt, historyFingerprint,
  historyIndexText, historyMatchExpression, historyOwnerKey, historyQuery, scoreHistoryText,
} from "./memberHistoryText";

describe("history index text", () => {
  it("keeps only the visible question or answer: no rich-block JSON, tool envelopes, images or base64", () => {
    const content = [
      "季度汇报模板：一、完成情况；二、问题；三、计划。",
      "```chart\n{\"type\":\"bar\",\"title\":\"营收\",\"labels\":[\"Q1\"],\"series\":[{\"name\":\"a\",\"values\":[1]}]}\n```",
      "```followups\n[\"再细一点\"]\n```",
      "<tool_request>{\"kind\":\"image\",\"prompt\":\"画一只猫\"}</tool_request>",
      "<analysis_summary>先看数据再下结论</analysis_summary>",
      "![图](https://example.com/a.png) 以及 data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "A".repeat(260),
      "## 结论\n**先给结论**再展开",
    ].join("\n");
    const text = historyIndexText(content);
    expect(text).toContain("季度汇报模板：一、完成情况；二、问题；三、计划。");
    expect(text).toContain("结论\n先给结论再展开");
    for (const leaked of ["\"type\":\"bar\"", "再细一点", "tool_request", "画一只猫", "先看数据再下结论", "example.com/a.png", "base64", "AAAAAAAAAA"]) expect(text).not.toContain(leaked);
  });

  it("redacts credentials with the member-memory filter and bounds long messages without half tokens", () => {
    expect(historyIndexText("部署时 api key 是 sk-proj-abcdefghijklmnopqrstuvwxyz123456，验证码 482913")).not.toMatch(/sk-proj|482913/);
    const long = `开头${"甲".repeat(HISTORY_MESSAGE_CHARACTERS * 3)}结尾`;
    const text = historyIndexText(long);
    expect(Array.from(text).length).toBeLessThanOrEqual(HISTORY_MESSAGE_CHARACTERS + 5);
    expect(text.startsWith("开头")).toBe(true);
    expect(text.endsWith("结尾")).toBe(true);
    // A key cut at the truncation edge is dropped rather than kept half-visible.
    const edge = historyIndexText(`${"乙".repeat(2390)}ghp_${"A1b2".repeat(20)}${"丙".repeat(4000)}`);
    expect(edge).not.toMatch(/ghp_|A1b2A1b2/);
  });

  it("chunks with overlap and sentence boundaries", () => {
    expect(historyChunks("")).toEqual([]);
    expect(historyChunks("短句。")).toEqual(["短句。"]);
    const chunks = historyChunks("这是一句完整的话。".repeat(200));
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) expect(Array.from(chunk).length).toBeLessThanOrEqual(HISTORY_CHUNK_CHARACTERS);
    expect(chunks.slice(0, -1).every(chunk => chunk.endsWith("。"))).toBe(true);
    // A phrase across a boundary still appears whole in one chunk (overlap).
    const text = `${"甲".repeat(690)}季度汇报模板${"乙".repeat(690)}`;
    expect(historyChunks(text).some(chunk => chunk.includes("季度汇报模板"))).toBe(true);
  });

  it("fingerprints and owner keys are stable, fixed-length and distinct", () => {
    expect(historyFingerprint("a", "b")).toBe(historyFingerprint("a", "b"));
    expect(historyFingerprint("ab", "")).not.toBe(historyFingerprint("a", "b"));
    const key = historyOwnerKey("default", "member-a");
    expect(key).toMatch(/^k[0-9a-f]{16}k$/);
    expect(historyOwnerKey("default", "member-b")).not.toBe(key);
    expect(historyOwnerKey("org-2", "member-a")).not.toBe(key);
  });
});

describe("recall cues and queries", () => {
  it("detects explicit searches and references to earlier conversations, not ordinary deadlines", () => {
    expect(detectHistoryRecallCue("查一下我之前问过的季度汇报模板")).toBe("explicit");
    expect(detectHistoryRecallCue("翻翻聊天记录里那个报价")).toBe("explicit");
    expect(detectHistoryRecallCue("search my previous conversations for the pricing page")).toBe("explicit");
    for (const text of ["上次那个汇报模板再发我一下", "还记得我说的周报格式吗", "我们之前聊过的那个方案", "继续上次的 LORA 生态合作方案", "跟上次一样的格式", "what did we decide last time"]) {
      expect(detectHistoryRecallCue(text), text).toBe("reference");
    }
    for (const text of ["帮我写一封邮件", "在周五之前完成这件事", "开会之前提醒我", "月底之前发给我", "你好"]) expect(detectHistoryRecallCue(text), text).toBeNull();
  });

  it("strips recall wording and grammar, keeping topic phrases", () => {
    expect(historyQuery("上次那个汇报模板").segments).toEqual(["汇报模板"]);
    expect(historyQuery("帮我找一下上次那个季度汇报模板的格式").segments).toEqual(["季度汇报模板", "格式"]);
    expect(historyQuery("继续上次的 LORA 生态合作方案").segments).toEqual(["lora", "生态合作方案"]);
    expect(historyQuery("我之前写了一份周报，按那个格式再写一份").segments).toEqual(["周报", "格式"]);
    expect(historyQuery("what did we decide about the pricing page last time").segments).toEqual(["decide", "pricing", "page"]);
    expect(historyQuery("你好呀").units).toEqual([]);
    const query = historyQuery("上次说的季度方案");
    expect(query.ftsTerms).toEqual(["季度方", "度方案"]);
    expect(query.units.map(unit => unit.text)).toEqual(["季度", "度方", "方案"]);
    expect(historyQuery("上次说的方案").shortTerms).toEqual(["方案"]);
    // Long runs without particles are windowed, never one unbounded segment.
    expect(historyQuery("甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未").segments.every(segment => Array.from(segment).length <= 10)).toBe(true);
  });

  it("scores CJK coverage: '上次那个汇报模板' finds the 季度汇报模板 conversation, not near misses", () => {
    const query = historyQuery("上次那个汇报模板再发我一下");
    const hit = scoreHistoryText(query, "我们定的季度汇报模板：一、本季度完成情况；二、问题；三、下季度计划。");
    expect(hit.coverage).toBe(1);
    expect(hit.longest).toBe(4);
    for (const miss of ["这周的汇报已经写完了", "模板库里有很多模板", "今天天气不错"]) expect(scoreHistoryText(query, miss).coverage).toBeLessThan(0.5);
    const latin = historyQuery("what did we decide about the pricing page");
    expect(scoreHistoryText(latin, "We agreed the Pricing Page shows three plans.").coverage).toBeGreaterThan(0.6);
  });

  it("quotes FTS phrases and builds an owner-scoped expression", () => {
    expect(historyMatchExpression("k0123456789abcdefk", ["汇报模", "lora"])).toBe('owner:"k0123456789abcdefk" AND body:("汇报模" OR "lora")');
    expect(historyMatchExpression("kx", ['a"b'])).toBe('owner:"kx" AND body:("a""b")');
  });

  it("cuts a bounded one-line excerpt around the match", () => {
    const text = `${"前文。".repeat(100)}季度汇报模板：一、完成情况；二、问题。\n${"后文。".repeat(100)}`;
    const score = scoreHistoryText(historyQuery("汇报模板"), text);
    const excerpt = historyExcerpt(text, score.anchor, 120);
    expect(excerpt).toContain("季度汇报模板");
    expect(excerpt.startsWith("…")).toBe(true);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(Array.from(excerpt).length).toBeLessThanOrEqual(122);
    expect(historyExcerpt("第一行\n第二行", 0, 120)).toBe("第一行 / 第二行");
  });

  it("dates in China Standard Time", () => {
    expect(historyDate(Date.parse("2026-09-26T17:30:00Z"))).toBe("2026-09-27");
    expect(historyDate(0)).toBeNull();
  });
});
